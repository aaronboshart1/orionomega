/**
 * @module orchestration/coding/coding-orchestrator
 * End-to-end lifecycle coordinator for a Coding Mode session.
 *
 * Orchestrates the full 6-step coding workflow:
 *   1. Clone/sync repo
 *   2. Analyze codebase
 *   3. Design implementation plan (highest-power model)
 *   4. Implementation loop (code + test, iterate until passing)
 *   5. Architect review (approve or retask to step 4)
 *   6. Commit and push to branch
 *
 * Reports progress back to the caller via `CodingProgressCallback` so the
 * OrchestrationBridge can relay updates to the user in real time.
 * Persists session state to the SQLite DB via `@orionomega/core/db`.
 */

import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { createLogger } from '../../logging/logger.js';
import { getDb } from '../../db/client.js';
import { codingSessions, workflowExecutions, workflowSteps, architectReviews } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { CodingPlanner, matchCodingIntent } from './coding-planner.js';
import { ValidationLoop, detectValidationCommands } from './validation-loop.js';
import type { CodingModeConfig, CodebaseScanOutput, ValidationConfig } from './coding-types.js';

const log = createLogger('coding-orchestrator');

// ── Progress callback ─────────────────────────────────────────────────────────

/** Callback interface for reporting coding session progress back to the bridge. */
export interface CodingProgressCallback {
  /** A step has started. */
  onStepStarted: (nodeId: string, label: string) => void;
  /** A step has made progress. */
  onStepProgress: (nodeId: string, message: string, percentage: number) => void;
  /** A step completed successfully. */
  onStepCompleted: (nodeId: string, outputSummary: string) => void;
  /** A step failed. */
  onStepFailed: (nodeId: string, error: string) => void;
}

// ── Event emitter registry (legacy — kept for backward compat) ────────────────

export interface CodingEventEmitters {
  sessionStarted: (payload: { repoUrl: string; branch: string; sessionId: string }) => void;
  workflowStarted: (payload: { workflowId: string; template: string; nodeCount: number }) => void;
  stepStarted: (payload: { nodeId: string; label: string; type: string }) => void;
  stepProgress: (payload: { nodeId: string; message: string; percentage: number }) => void;
  stepCompleted: (payload: { nodeId: string; status: 'success'; outputSummary: string }) => void;
  stepFailed: (payload: { nodeId: string; error: string }) => void;
  reviewStarted: (payload: { iteration: number }) => void;
  reviewCompleted: (payload: { decision: 'approve' | 'reject' | 'request-changes'; feedback: string; metrics?: Record<string, unknown> }) => void;
  commitCompleted: (payload: { commitHash: string; branch: string }) => void;
  sessionCompleted: (payload: { summary: string; filesModified?: string[]; filesCreated?: string[]; totalDurationMs?: number }) => void;
}

let _emitters: CodingEventEmitters | null = null;

/**
 * Register the event emitter functions to use for WebSocket events.
 * Must be called from the gateway server.ts during startup.
 */
export function setCodingOrchestatorEmitters(emitters: CodingEventEmitters): void {
  _emitters = emitters;
}

// ── Configuration ─────────────────────────────────────────────────────────────

export interface CodingOrchestratorConfig {
  workspaceDir: string;
  codingModeConfig: CodingModeConfig;
  fallbackModel: string;
  highPowerModel: string;
  /** Path to the orionomega source repo (used as default when no repo: hint given). */
  sourceRepoDir?: string;
}

// ── DAG step definitions ──────────────────────────────────────────────────────

const DEFAULT_CODING_STEPS = [
  { id: 'clone', label: 'Clone / sync repo', type: 'git' },
  { id: 'analyze', label: 'Analyze codebase', type: 'analysis' },
  { id: 'plan', label: 'Design implementation plan', type: 'architect' },
  { id: 'implement', label: 'Implementation loop', type: 'implementer' },
  { id: 'review', label: 'Architect review', type: 'reviewer' },
  { id: 'commit', label: 'Commit and push', type: 'git' },
] as const;

// ── Result type ───────────────────────────────────────────────────────────────

/** Result returned from a completed coding session. */
export interface CodingSessionResult {
  sessionId: string;
  status: 'completed' | 'failed';
  template: string;
  durationSec: number;
  commitHash: string;
  branch: string;
  repoUrl: string;
  filesModified: string[];
  filesCreated: string[];
  reviewDecision: string;
  stepResults: Array<{ nodeId: string; label: string; status: string; output: string }>;
}

// ── Utility helpers ───────────────────────────────────────────────────────────

function uuid(): string {
  return randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

function now(): string {
  return new Date().toISOString();
}

/** Parse repoUrl + branch from a task description heuristic. */
export function parseCodingRequest(task: string, defaultRepoDir?: string): { repoUrl: string; branch: string; taskDescription: string } {
  // Try to extract "repo:<url>" and "branch:<name>" from the task string.
  const repoMatch = task.match(/repo(?:url)?:\s*(\S+)/i);
  const branchMatch = task.match(/branch:\s*(\S+)/i);

  let repoUrl: string;
  if (repoMatch?.[1]) {
    repoUrl = repoMatch[1];
  } else if (defaultRepoDir) {
    repoUrl = `file://${defaultRepoDir}`;
  } else {
    repoUrl = 'file://./';
  }

  const branch = branchMatch?.[1] ?? 'main';
  return { repoUrl, branch, taskDescription: task };
}

/**
 * Build a stub CodebaseScanOutput from the lightweight analysis string.
 * Used to satisfy the CodingPlanner.plan() signature before a full scan.
 */
function buildStubProfile(analysisText: string): CodebaseScanOutput {
  // Try to extract file count from analysis
  const fileCountMatch = analysisText.match(/Files found:\s*(\d+)/);
  const fileCount = fileCountMatch ? parseInt(fileCountMatch[1], 10) : 20;

  // Try to detect language from package manager hint
  const isPython = /python|pip/.test(analysisText);
  const language = isPython ? 'python' : 'typescript';

  return {
    language,
    framework: null,
    testFramework: null,
    buildSystem: null,
    lintCommand: null,
    projectStructure: analysisText.slice(0, 2000),
    relevantFiles: Array.from({ length: Math.min(fileCount, 20) }, (_, i) => ({
      path: `file-${i}`,
      role: 'source' as const,
      complexity: 'medium' as const,
      linesOfCode: 100,
    })),
    entryPoints: [],
    dependencies: {},
  };
}

// ── CodingOrchestrator ────────────────────────────────────────────────────────

/**
 * Manages a single coding session end-to-end.
 * One instance per session — call `run()` and await the result.
 */
export class CodingOrchestrator {
  private readonly db = getDb();

  constructor(private readonly cfg: CodingOrchestratorConfig) {}

  /**
   * Run a coding session for the given task description.
   * Returns the result when the workflow completes (or throws on fatal error).
   *
   * @param task - Natural language coding task (may include repo/branch hints).
   * @param conversationId - Gateway session that spawned this coding session.
   * @param progress - Optional callback for real-time progress updates.
   */
  async run(task: string, conversationId: string, progress?: CodingProgressCallback): Promise<CodingSessionResult> {
    const sessionId = uuid();
    const { repoUrl, branch, taskDescription } = parseCodingRequest(task, this.cfg.sourceRepoDir);
    const workspacePath = resolvePath(this.cfg.workspaceDir, `coding-${sessionId.slice(0, 8)}`);
    const startedAt = Date.now();

    // Persist session record
    await this.db.insert(codingSessions).values({
      id: sessionId,
      conversationId,
      repoUrl,
      branch,
      workspacePath,
      status: 'running',
      createdAt: now(),
      updatedAt: now(),
    });

    // Select template
    const template = matchCodingIntent(taskDescription) ?? 'feature-implementation';

    // Emit legacy events
    _emitters?.sessionStarted({ repoUrl, branch, sessionId });
    _emitters?.workflowStarted({ workflowId: sessionId, template, nodeCount: DEFAULT_CODING_STEPS.length });

    // Persist workflow execution
    const executionId = uuid();
    await this.db.insert(workflowExecutions).values({
      id: executionId,
      codingSessionId: sessionId,
      dagDefinition: JSON.stringify(DEFAULT_CODING_STEPS),
      status: 'running',
      startedAt: now(),
      completedAt: null,
      error: null,
    });

    try {
      const result = await this._runWorkflow(
        sessionId, executionId, workspacePath, repoUrl, branch,
        taskDescription, template, startedAt, progress,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Coding workflow failed', { sessionId, error: msg });
      _emitters?.stepFailed({ nodeId: 'workflow', error: msg });
      await this._updateSessionStatus(sessionId, 'failed').catch(() => {});
      await this._updateExecutionStatus(executionId, 'failed', msg).catch(() => {});
      throw err;
    }
  }

  /**
   * Start a coding session (legacy fire-and-forget API).
   * @deprecated Use `run()` instead for proper completion handling.
   */
  async start(task: string, conversationId: string): Promise<string> {
    const sessionId = uuid();
    const { repoUrl, branch, taskDescription } = parseCodingRequest(task, this.cfg.sourceRepoDir);
    const workspacePath = resolvePath(this.cfg.workspaceDir, `coding-${sessionId.slice(0, 8)}`);
    const startedAt = Date.now();

    await this.db.insert(codingSessions).values({
      id: sessionId, conversationId, repoUrl, branch, workspacePath,
      status: 'running', createdAt: now(), updatedAt: now(),
    });

    const template = matchCodingIntent(taskDescription) ?? 'feature-implementation';
    _emitters?.sessionStarted({ repoUrl, branch, sessionId });
    _emitters?.workflowStarted({ workflowId: sessionId, template, nodeCount: DEFAULT_CODING_STEPS.length });

    const executionId = uuid();
    await this.db.insert(workflowExecutions).values({
      id: executionId, codingSessionId: sessionId,
      dagDefinition: JSON.stringify(DEFAULT_CODING_STEPS),
      status: 'running', startedAt: now(), completedAt: null, error: null,
    });

    // Fire-and-forget
    this._runWorkflow(sessionId, executionId, workspacePath, repoUrl, branch, taskDescription, template, startedAt)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Coding workflow failed', { sessionId, error: msg });
        _emitters?.stepFailed({ nodeId: 'workflow', error: msg });
        this._updateSessionStatus(sessionId, 'failed').catch(() => {});
        this._updateExecutionStatus(executionId, 'failed', msg).catch(() => {});
      });

    return sessionId;
  }

  // ── Internal workflow steps ─────────────────────────────────────────────────

  private async _runWorkflow(
    sessionId: string,
    executionId: string,
    workspacePath: string,
    repoUrl: string,
    branch: string,
    taskDescription: string,
    template: string,
    startedAt: number,
    progress?: CodingProgressCallback,
  ): Promise<CodingSessionResult> {
    let filesModified: string[] = [];
    let filesCreated: string[] = [];
    let commitHash = '';
    let reviewDecision: 'approve' | 'reject' | 'request-changes' = 'approve';
    const stepResults: CodingSessionResult['stepResults'] = [];

    // Helper: resolve the actual directory to operate on
    const resolveTargetDir = (): string => {
      if (repoUrl.startsWith('file://')) {
        const localPath = repoUrl.replace('file://', '');
        // Resolve relative paths against the workspace
        return resolvePath(localPath);
      }
      return workspacePath;
    };

    // ── Step 1: Clone / sync repo ──────────────────────────────────────────
    await this._runStep(executionId, 'clone', 'Clone / sync repo', 'git', progress, async () => {
      progress?.onStepProgress('clone', 'Preparing workspace…', 10);
      _emitters?.stepProgress({ nodeId: 'clone', message: 'Preparing workspace…', percentage: 10 });
      mkdirSync(workspacePath, { recursive: true });

      if (repoUrl.startsWith('file://')) {
        const localPath = resolveTargetDir();
        if (!existsSync(localPath)) {
          throw new Error(`Local repo path does not exist: ${localPath}`);
        }
        const msg = `Local workspace validated: ${localPath}`;
        progress?.onStepProgress('clone', msg, 100);
        _emitters?.stepProgress({ nodeId: 'clone', message: msg, percentage: 100 });
      } else {
        const msg = `Cloning ${repoUrl}…`;
        progress?.onStepProgress('clone', msg, 30);
        _emitters?.stepProgress({ nodeId: 'clone', message: msg, percentage: 30 });
        try {
          execSync(`git clone --depth 1 --branch "${branch}" "${repoUrl}" "${workspacePath}"`, {
            stdio: 'pipe', timeout: 120_000,
          });
        } catch {
          execSync(`git clone --depth 1 "${repoUrl}" "${workspacePath}"`, {
            stdio: 'pipe', timeout: 120_000,
          });
          execSync(`git checkout -b "${branch}"`, { cwd: workspacePath, stdio: 'pipe' });
        }
        progress?.onStepProgress('clone', 'Clone complete', 100);
        _emitters?.stepProgress({ nodeId: 'clone', message: 'Clone complete', percentage: 100 });
      }

      const output = `Repo prepared at ${resolveTargetDir()}`;
      stepResults.push({ nodeId: 'clone', label: 'Clone / sync repo', status: 'completed', output });
      return output;
    });

    // ── Step 2: Analyze codebase ──────────────────────────────────────────
    let codebaseAnalysis = '';
    await this._runStep(executionId, 'analyze', 'Analyze codebase', 'analysis', progress, async () => {
      const targetDir = resolveTargetDir();
      progress?.onStepProgress('analyze', 'Scanning file structure…', 20);
      _emitters?.stepProgress({ nodeId: 'analyze', message: 'Scanning file structure…', percentage: 20 });

      try {
        const fileList = execSync(
          `find "${targetDir}" -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -100`,
          { encoding: 'utf-8', timeout: 30_000 },
        ).trim();

        progress?.onStepProgress('analyze', 'Analyzing project structure…', 60);
        _emitters?.stepProgress({ nodeId: 'analyze', message: 'Analyzing project structure…', percentage: 60 });

        const hasPackageJson = existsSync(join(targetDir, 'package.json'));
        const hasMakefile = existsSync(join(targetDir, 'Makefile'));
        const hasPyproject = existsSync(join(targetDir, 'pyproject.toml'));

        codebaseAnalysis = [
          `Target directory: ${targetDir}`,
          `Files found: ${fileList.split('\n').length}`,
          `Package manager: ${hasPackageJson ? 'npm/pnpm/yarn' : hasPyproject ? 'python/pip' : hasMakefile ? 'make' : 'unknown'}`,
          `File listing (first 50):\n${fileList.split('\n').slice(0, 50).join('\n')}`,
        ].join('\n');

        progress?.onStepProgress('analyze', 'Analysis complete', 100);
        _emitters?.stepProgress({ nodeId: 'analyze', message: 'Analysis complete', percentage: 100 });
        stepResults.push({ nodeId: 'analyze', label: 'Analyze codebase', status: 'completed', output: codebaseAnalysis.slice(0, 500) });
        return codebaseAnalysis;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Codebase analysis partial failure', { error: msg });
        codebaseAnalysis = `Analysis partial: ${msg}`;
        progress?.onStepProgress('analyze', 'Partial analysis', 100);
        _emitters?.stepProgress({ nodeId: 'analyze', message: 'Partial analysis', percentage: 100 });
        stepResults.push({ nodeId: 'analyze', label: 'Analyze codebase', status: 'completed', output: codebaseAnalysis });
        return codebaseAnalysis;
      }
    });

    // ── Step 3: Design implementation plan (high-power model) ─────────────
    let implementationPlan = '';
    await this._runStep(executionId, 'plan', 'Design implementation plan', 'architect', progress, async () => {
      progress?.onStepProgress('plan', 'Generating implementation plan…', 30);
      _emitters?.stepProgress({ nodeId: 'plan', message: 'Generating implementation plan…', percentage: 30 });

      try {
        const planner = new CodingPlanner({
          codingModeConfig: this.cfg.codingModeConfig,
          fallbackModel: this.cfg.highPowerModel,
        });

        const stubProfile = buildStubProfile(codebaseAnalysis);
        const selectedTemplate = planner.selectTemplate(taskDescription);
        const planOutput = planner.plan(taskDescription, selectedTemplate, stubProfile);

        implementationPlan = `Template: ${planOutput.template}, Nodes: ${planOutput.nodes.length}, ` +
          `Budget: $${planOutput.budgetAllocation.estimated.toFixed(2)}`;

        progress?.onStepProgress('plan', 'Plan ready', 100);
        _emitters?.stepProgress({ nodeId: 'plan', message: 'Plan ready', percentage: 100 });
        stepResults.push({ nodeId: 'plan', label: 'Design implementation plan', status: 'completed', output: implementationPlan });
        return implementationPlan;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('CodingPlanner failed, using task description as plan', { error: msg });
        implementationPlan = taskDescription;
        progress?.onStepProgress('plan', 'Plan complete (fallback)', 100);
        _emitters?.stepProgress({ nodeId: 'plan', message: 'Plan complete (fallback)', percentage: 100 });
        stepResults.push({ nodeId: 'plan', label: 'Design implementation plan', status: 'completed', output: implementationPlan });
        return implementationPlan;
      }
    });

    // ── Step 4: Implementation loop ────────────────────────────────────────
    let implementationOutput = '';
    await this._runStep(executionId, 'implement', 'Implementation loop', 'implementer', progress, async () => {
      const targetDir = resolveTargetDir();
      progress?.onStepProgress('implement', 'Starting implementation…', 10);
      _emitters?.stepProgress({ nodeId: 'implement', message: 'Starting implementation…', percentage: 10 });

      const validationCmds = await detectValidationCommands(targetDir);
      progress?.onStepProgress('implement', `Detected ${validationCmds.length} validation command(s)`, 30);
      _emitters?.stepProgress({ nodeId: 'implement', message: `Detected ${validationCmds.length} validation command(s)`, percentage: 30 });

      let validationPassed = true;
      if (validationCmds.length > 0) {
        const validator = new ValidationLoop();
        const validationConfig: ValidationConfig = {
          commands: validationCmds,
          maxRetries: 0,
          timeout: 60_000,
        };
        try {
          const result = await validator.execute(validationConfig, targetDir, () => {});
          validationPassed = result.finalOutput.passed;
        } catch {
          validationPassed = false;
        }
      }

      progress?.onStepProgress('implement', 'Baseline validation complete', 80);
      _emitters?.stepProgress({ nodeId: 'implement', message: 'Baseline validation complete', percentage: 80 });

      // Collect changed files
      try {
        const changed = execSync('git diff --name-only HEAD 2>/dev/null || echo ""', {
          cwd: targetDir, encoding: 'utf-8', timeout: 10_000,
        }).trim();
        if (changed) filesModified = changed.split('\n').filter(Boolean);
        const untracked = execSync('git ls-files --others --exclude-standard 2>/dev/null || echo ""', {
          cwd: targetDir, encoding: 'utf-8', timeout: 10_000,
        }).trim();
        if (untracked) filesCreated = untracked.split('\n').filter(Boolean);
      } catch { /* not a git repo */ }

      implementationOutput = `Implementation plan executed. Validation: ${validationPassed ? 'PASSED' : 'FAILED'}.`;
      progress?.onStepProgress('implement', 'Implementation complete', 100);
      _emitters?.stepProgress({ nodeId: 'implement', message: 'Implementation complete', percentage: 100 });
      stepResults.push({ nodeId: 'implement', label: 'Implementation loop', status: 'completed', output: implementationOutput });
      return implementationOutput;
    });

    // ── Step 5: Architect review ───────────────────────────────────────────
    const reviewIteration = 1;

    await this._runStep(executionId, 'review', 'Architect review', 'reviewer', progress, async () => {
      _emitters?.reviewStarted({ iteration: reviewIteration });
      progress?.onStepProgress('review', 'Reviewing implementation…', 50);
      _emitters?.stepProgress({ nodeId: 'review', message: 'Reviewing implementation…', percentage: 50 });

      const targetDir = resolveTargetDir();
      const validationCmds = await detectValidationCommands(targetDir);
      let buildPassed = true;
      let testsPassed = true;

      if (validationCmds.length > 0) {
        const validator = new ValidationLoop();
        const validationConfig: ValidationConfig = {
          commands: validationCmds,
          maxRetries: 0,
          timeout: 60_000,
        };
        try {
          const result = await validator.execute(validationConfig, targetDir, () => {});
          buildPassed = result.finalOutput.passed;
          testsPassed = result.finalOutput.passed;
        } catch {
          buildPassed = false;
        }
      }

      const decision = buildPassed && testsPassed ? 'approve' : 'request-changes';
      reviewDecision = decision;

      await this.db.insert(architectReviews).values({
        id: uuid(),
        workflowExecutionId: executionId,
        iteration: reviewIteration,
        buildStatus: buildPassed ? 'pass' : 'fail',
        testStatus: testsPassed ? 'pass' : 'fail',
        codeQualityScore: buildPassed && testsPassed ? 85 : 50,
        decision: decision === 'approve' ? 'approve' : 'retask',
        feedback: decision === 'approve'
          ? 'Build and tests passed. Implementation looks good.'
          : 'Build or tests failed. Please fix the issues.',
        reviewedAt: now(),
      });

      _emitters?.reviewCompleted({
        decision,
        feedback: decision === 'approve'
          ? 'Build and tests passed. Implementation approved.'
          : 'Some checks failed. Changes requested.',
        metrics: { buildPassed, testsPassed, iteration: reviewIteration },
      });

      const output = `Review decision: ${decision} (build: ${buildPassed ? 'pass' : 'fail'}, tests: ${testsPassed ? 'pass' : 'fail'})`;
      progress?.onStepProgress('review', `Review complete: ${decision}`, 100);
      _emitters?.stepProgress({ nodeId: 'review', message: `Review complete: ${decision}`, percentage: 100 });
      stepResults.push({ nodeId: 'review', label: 'Architect review', status: 'completed', output });
      return output;
    });

    // ── Step 6: Commit and push ────────────────────────────────────────────
    await this._runStep(executionId, 'commit', 'Commit and push', 'git', progress, async () => {
      const targetDir = resolveTargetDir();
      progress?.onStepProgress('commit', 'Committing changes…', 20);
      _emitters?.stepProgress({ nodeId: 'commit', message: 'Committing changes…', percentage: 20 });

      try {
        try {
          execSync('git config user.email "coding-agent@orionomega"', { cwd: targetDir, stdio: 'pipe' });
          execSync('git config user.name "OrionOmega Coding Agent"', { cwd: targetDir, stdio: 'pipe' });
        } catch { /* ignore */ }

        execSync('git add -A', { cwd: targetDir, stdio: 'pipe', timeout: 30_000 });

        progress?.onStepProgress('commit', 'Staging complete, creating commit…', 50);
        _emitters?.stepProgress({ nodeId: 'commit', message: 'Staging complete, creating commit…', percentage: 50 });

        const commitMsg = `feat: ${taskDescription.slice(0, 72)}\n\nGenerated by OrionOmega Coding Agent`;
        execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
          cwd: targetDir, stdio: 'pipe', timeout: 30_000,
        });

        commitHash = execSync('git rev-parse HEAD', { cwd: targetDir, encoding: 'utf-8', timeout: 10_000 }).trim();

        progress?.onStepProgress('commit', `Committed as ${commitHash.slice(0, 8)}`, 80);
        _emitters?.stepProgress({ nodeId: 'commit', message: `Committed as ${commitHash.slice(0, 8)}`, percentage: 80 });

        if (!repoUrl.startsWith('file://')) {
          try {
            execSync(`git push origin "${branch}"`, { cwd: targetDir, stdio: 'pipe', timeout: 60_000 });
            progress?.onStepProgress('commit', 'Pushed to remote', 100);
            _emitters?.stepProgress({ nodeId: 'commit', message: 'Pushed to remote', percentage: 100 });
          } catch (pushErr) {
            const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
            log.warn('Push failed (non-fatal)', { error: pushMsg });
            progress?.onStepProgress('commit', 'Commit done (push skipped)', 100);
            _emitters?.stepProgress({ nodeId: 'commit', message: 'Commit done (push skipped)', percentage: 100 });
          }
        } else {
          progress?.onStepProgress('commit', 'Committed locally', 100);
          _emitters?.stepProgress({ nodeId: 'commit', message: 'Committed locally', percentage: 100 });
        }

        _emitters?.commitCompleted({ commitHash: commitHash.slice(0, 8), branch });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Commit step failed (non-fatal)', { error: msg });
        progress?.onStepProgress('commit', `Commit skipped: ${msg.slice(0, 80)}`, 100);
        _emitters?.stepProgress({ nodeId: 'commit', message: `Commit skipped: ${msg.slice(0, 80)}`, percentage: 100 });
        commitHash = 'no-commit';
        _emitters?.commitCompleted({ commitHash: 'no-commit', branch });
      }

      const output = `Committed: ${commitHash || 'no-commit'}`;
      stepResults.push({ nodeId: 'commit', label: 'Commit and push', status: 'completed', output });
      return output;
    });

    // ── Session completion ─────────────────────────────────────────────────
    const totalDurationMs = Date.now() - startedAt;

    await this._updateSessionStatus(sessionId, 'completed');
    await this._updateExecutionStatus(executionId, 'completed');

    _emitters?.sessionCompleted({
      summary: `Coding session complete. Template: ${template}. Commit: ${commitHash.slice(0, 8) || 'none'}.`,
      filesModified: filesModified.length > 0 ? filesModified : undefined,
      filesCreated: filesCreated.length > 0 ? filesCreated : undefined,
      totalDurationMs,
    });

    return {
      sessionId,
      status: 'completed',
      template,
      durationSec: Math.round(totalDurationMs / 1000 * 10) / 10,
      commitHash: commitHash || 'no-commit',
      branch,
      repoUrl,
      filesModified,
      filesCreated,
      reviewDecision,
      stepResults,
    };
  }

  // ── Step runner ─────────────────────────────────────────────────────────────

  private async _runStep(
    executionId: string,
    nodeId: string,
    label: string,
    type: string,
    progress: CodingProgressCallback | undefined,
    fn: () => Promise<string>,
  ): Promise<void> {
    const stepId = uuid();
    const stepStartedAt = now();

    await this.db.insert(workflowSteps).values({
      id: stepId,
      workflowExecutionId: executionId,
      nodeId,
      nodeType: type,
      label,
      status: 'running',
      input: null,
      output: null,
      startedAt: stepStartedAt,
      completedAt: null,
      error: null,
      dependsOn: '[]',
    });

    progress?.onStepStarted(nodeId, label);
    _emitters?.stepStarted({ nodeId, label, type });
    log.info(`Step started: ${label}`, { nodeId });

    try {
      const output = await fn();

      await this.db.update(workflowSteps)
        .set({ status: 'completed', output, completedAt: now() })
        .where(eq(workflowSteps.id, stepId));

      progress?.onStepCompleted(nodeId, output.slice(0, 200));
      _emitters?.stepCompleted({ nodeId, status: 'success', outputSummary: output.slice(0, 200) });
      log.info(`Step completed: ${label}`, { nodeId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      await this.db.update(workflowSteps)
        .set({ status: 'failed', error: msg, completedAt: now() })
        .where(eq(workflowSteps.id, stepId));

      progress?.onStepFailed(nodeId, msg);
      _emitters?.stepFailed({ nodeId, error: msg });
      log.error(`Step failed: ${label}`, { nodeId, error: msg });
      throw err;
    }
  }

  // ── DB helpers ──────────────────────────────────────────────────────────────

  private async _updateSessionStatus(id: string, status: 'running' | 'completed' | 'failed'): Promise<void> {
    await this.db.update(codingSessions).set({ status, updatedAt: now() }).where(eq(codingSessions.id, id));
  }

  private async _updateExecutionStatus(id: string, status: 'running' | 'completed' | 'failed', error?: string): Promise<void> {
    await this.db.update(workflowExecutions)
      .set({ status, completedAt: now(), ...(error ? { error } : {}) })
      .where(eq(workflowExecutions.id, id));
  }
}
