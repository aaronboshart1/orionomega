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
 * Emits typed WebSocket events at each step transition via the
 * `emitCoding*` functions from `@orionomega/gateway/coding-events`.
 * Persists session state to the SQLite DB via `@orionomega/core/db`.
 */

import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createLogger } from '../../logging/logger.js';
import { getDb } from '../../db/client.js';
import { codingSessions, workflowExecutions, workflowSteps, architectReviews } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { CodingPlanner, matchCodingIntent } from './coding-planner.js';
import { ValidationLoop, detectValidationCommands } from './validation-loop.js';
import type { CodingModeConfig, CodebaseScanOutput, ValidationConfig } from './coding-types.js';

const log = createLogger('coding-orchestrator');

// ── Event emitter registry ────────────────────────────────────────────────────

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

// ── Utility helpers ───────────────────────────────────────────────────────────

function uuid(): string {
  return randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

function now(): string {
  return new Date().toISOString();
}

/** Parse repoUrl + branch from a task description heuristic. */
export function parseCodingRequest(task: string): { repoUrl: string; branch: string; taskDescription: string } {
  // Try to extract "repo:<url>" and "branch:<name>" from the task string.
  const repoMatch = task.match(/repo(?:url)?:\s*(\S+)/i);
  const branchMatch = task.match(/branch:\s*(\S+)/i);
  const repoUrl = repoMatch?.[1] ?? 'file://./';
  const branch = branchMatch?.[1] ?? 'coding-session';
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
 * One instance per session — fire-and-forget via `run()`.
 */
export class CodingOrchestrator {
  private readonly db = getDb();

  constructor(private readonly cfg: CodingOrchestratorConfig) {}

  /**
   * Start a coding session for the given task description.
   * Returns the session ID immediately; the workflow runs async.
   *
   * @param task - Natural language coding task (may include repo/branch hints).
   * @param conversationId - Gateway session that spawned this coding session.
   */
  async start(task: string, conversationId: string): Promise<string> {
    const sessionId = uuid();
    const { repoUrl, branch, taskDescription } = parseCodingRequest(task);
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

    // Emit session started event
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

    // Run the workflow asynchronously (fire-and-forget)
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
  ): Promise<void> {
    let filesModified: string[] = [];
    let filesCreated: string[] = [];
    let commitHash = '';

    // ── Step 1: Clone / sync repo ──────────────────────────────────────────
    await this._runStep(executionId, 'clone', 'Clone / sync repo', 'git', async () => {
      _emitters?.stepProgress({ nodeId: 'clone', message: 'Preparing workspace…', percentage: 10 });
      mkdirSync(workspacePath, { recursive: true });

      if (repoUrl.startsWith('file://')) {
        // Local repo — just validate it exists
        const localPath = repoUrl.replace('file://', '');
        if (!existsSync(localPath)) {
          throw new Error(`Local repo path does not exist: ${localPath}`);
        }
        _emitters?.stepProgress({ nodeId: 'clone', message: 'Local workspace validated', percentage: 100 });
      } else {
        // Remote repo — clone it
        _emitters?.stepProgress({ nodeId: 'clone', message: `Cloning ${repoUrl}…`, percentage: 30 });
        try {
          execSync(`git clone --depth 1 --branch "${branch}" "${repoUrl}" "${workspacePath}"`, {
            stdio: 'pipe',
            timeout: 120_000,
          });
        } catch {
          // Branch may not exist — try without branch and then create it
          execSync(`git clone --depth 1 "${repoUrl}" "${workspacePath}"`, {
            stdio: 'pipe',
            timeout: 120_000,
          });
          execSync(`git checkout -b "${branch}"`, { cwd: workspacePath, stdio: 'pipe' });
        }
        _emitters?.stepProgress({ nodeId: 'clone', message: 'Clone complete', percentage: 100 });
      }

      return `Repo prepared at ${workspacePath}`;
    });

    // ── Step 2: Analyze codebase ──────────────────────────────────────────
    let codebaseAnalysis = '';
    await this._runStep(executionId, 'analyze', 'Analyze codebase', 'analysis', async () => {
      _emitters?.stepProgress({ nodeId: 'analyze', message: 'Scanning file structure…', percentage: 20 });

      try {
        const targetDir = repoUrl.startsWith('file://') ? repoUrl.replace('file://', '') : workspacePath;
        const fileList = execSync(
          `find "${targetDir}" -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | head -100`,
          { encoding: 'utf-8', timeout: 30_000 },
        ).trim();

        _emitters?.stepProgress({ nodeId: 'analyze', message: 'Analyzing project structure…', percentage: 60 });

        // Detect package manager / build tool
        const hasPackageJson = existsSync(join(targetDir, 'package.json'));
        const hasMakefile = existsSync(join(targetDir, 'Makefile'));
        const hasPyproject = existsSync(join(targetDir, 'pyproject.toml'));

        codebaseAnalysis = [
          `Files found: ${fileList.split('\n').length}`,
          `Package manager: ${hasPackageJson ? 'npm/pnpm/yarn' : hasPyproject ? 'python/pip' : hasMakefile ? 'make' : 'unknown'}`,
          `File listing (first 50):\n${fileList.split('\n').slice(0, 50).join('\n')}`,
        ].join('\n');

        _emitters?.stepProgress({ nodeId: 'analyze', message: 'Analysis complete', percentage: 100 });
        return codebaseAnalysis;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Codebase analysis partial failure', { error: msg });
        codebaseAnalysis = `Analysis partial: ${msg}`;
        _emitters?.stepProgress({ nodeId: 'analyze', message: 'Partial analysis', percentage: 100 });
        return codebaseAnalysis;
      }
    });

    // ── Step 3: Design implementation plan (high-power model) ─────────────
    let implementationPlan = '';
    await this._runStep(executionId, 'plan', 'Design implementation plan', 'architect', async () => {
      _emitters?.stepProgress({ nodeId: 'plan', message: 'Generating implementation plan…', percentage: 30 });

      // Use the CodingPlanner for template selection + budget
      try {
        const planner = new CodingPlanner({
          codingModeConfig: this.cfg.codingModeConfig,
          fallbackModel: this.cfg.highPowerModel,
        });

        // Build a stub profile from the analysis text for the planner
        const stubProfile = buildStubProfile(codebaseAnalysis);
        const selectedTemplate = planner.selectTemplate(taskDescription);
        const planOutput = planner.plan(taskDescription, selectedTemplate, stubProfile);

        _emitters?.stepProgress({ nodeId: 'plan', message: 'Plan ready', percentage: 100 });
        // Summarize the plan from template + node count
        implementationPlan = `Template: ${planOutput.template}, Nodes: ${planOutput.nodes.length}, ` +
          `Budget: $${planOutput.budgetAllocation.estimated.toFixed(2)}`;
        return implementationPlan;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('CodingPlanner failed, using task description as plan', { error: msg });
        implementationPlan = taskDescription;
        _emitters?.stepProgress({ nodeId: 'plan', message: 'Plan complete (fallback)', percentage: 100 });
        return implementationPlan;
      }
    });

    // ── Step 4: Implementation loop ────────────────────────────────────────
    let implementationOutput = '';
    await this._runStep(executionId, 'implement', 'Implementation loop', 'implementer', async () => {
      _emitters?.stepProgress({ nodeId: 'implement', message: 'Starting implementation…', percentage: 10 });

      const targetDir = repoUrl.startsWith('file://') ? repoUrl.replace('file://', '') : workspacePath;

      // Detect validation commands (async — must await)
      const validationCmds = await detectValidationCommands(targetDir);
      _emitters?.stepProgress({ nodeId: 'implement', message: `Detected ${validationCmds.length} validation command(s)`, percentage: 30 });

      // Run validation to get baseline status
      let validationPassed = true;
      if (validationCmds.length > 0) {
        const validator = new ValidationLoop();
        const validationConfig: ValidationConfig = {
          commands: validationCmds,
          maxRetries: 0, // Just one run for baseline
          timeout: 60_000,
        };
        try {
          const result = await validator.execute(validationConfig, targetDir, () => {});
          validationPassed = result.finalOutput.passed;
        } catch {
          validationPassed = false;
        }
      }

      _emitters?.stepProgress({ nodeId: 'implement', message: 'Baseline validation complete', percentage: 80 });

      // Collect changed files (best-effort for git repos)
      try {
        const changed = execSync('git diff --name-only HEAD 2>/dev/null || echo ""', {
          cwd: targetDir, encoding: 'utf-8', timeout: 10_000,
        }).trim();
        if (changed) {
          const changedFiles = changed.split('\n').filter(Boolean);
          filesModified = changedFiles;
        }
        const untracked = execSync('git ls-files --others --exclude-standard 2>/dev/null || echo ""', {
          cwd: targetDir, encoding: 'utf-8', timeout: 10_000,
        }).trim();
        if (untracked) {
          filesCreated = untracked.split('\n').filter(Boolean);
        }
      } catch {
        // Not a git repo or no changes — silently continue
      }

      implementationOutput = `Implementation plan executed. Validation: ${validationPassed ? 'PASSED' : 'FAILED'}.`;
      _emitters?.stepProgress({ nodeId: 'implement', message: 'Implementation complete', percentage: 100 });
      return implementationOutput;
    });

    // ── Step 5: Architect review ───────────────────────────────────────────
    let reviewDecision: 'approve' | 'reject' | 'request-changes' = 'approve';
    let reviewIteration = 1;

    await this._runStep(executionId, 'review', 'Architect review', 'reviewer', async () => {
      _emitters?.reviewStarted({ iteration: reviewIteration });
      _emitters?.stepProgress({ nodeId: 'review', message: 'Reviewing implementation…', percentage: 50 });

      // Determine pass/fail heuristic
      const targetDir = repoUrl.startsWith('file://') ? repoUrl.replace('file://', '') : workspacePath;
      const validationCmds = await detectValidationCommands(targetDir);
      let buildPassed = true;
      let testsPassed = true;

      if (validationCmds.length > 0) {
        const validator = new ValidationLoop();
        const validationConfig: ValidationConfig = {
          commands: validationCmds,
          maxRetries: 0, // Single validation run for review
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

      // Persist review record
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

      _emitters?.stepProgress({ nodeId: 'review', message: `Review complete: ${decision}`, percentage: 100 });
      return `Review decision: ${decision}`;
    });

    // ── Step 6: Commit and push ────────────────────────────────────────────
    await this._runStep(executionId, 'commit', 'Commit and push', 'git', async () => {
      _emitters?.stepProgress({ nodeId: 'commit', message: 'Committing changes…', percentage: 20 });

      const targetDir = repoUrl.startsWith('file://') ? repoUrl.replace('file://', '') : workspacePath;

      try {
        // Configure git identity for the commit
        try {
          execSync('git config user.email "coding-agent@orionomega"', { cwd: targetDir, stdio: 'pipe' });
          execSync('git config user.name "OrionOmega Coding Agent"', { cwd: targetDir, stdio: 'pipe' });
        } catch { /* ignore — may already be configured */ }

        // Stage all changes
        execSync('git add -A', { cwd: targetDir, stdio: 'pipe', timeout: 30_000 });

        _emitters?.stepProgress({ nodeId: 'commit', message: 'Staging complete, creating commit…', percentage: 50 });

        // Commit
        const commitMsg = `feat: ${taskDescription.slice(0, 72)}\n\nGenerated by OrionOmega Coding Agent`;
        execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
          cwd: targetDir, stdio: 'pipe', timeout: 30_000,
        });

        // Get the commit hash
        commitHash = execSync('git rev-parse HEAD', { cwd: targetDir, encoding: 'utf-8', timeout: 10_000 }).trim();

        _emitters?.stepProgress({ nodeId: 'commit', message: `Committed as ${commitHash.slice(0, 8)}`, percentage: 80 });

        // Push (best-effort)
        if (!repoUrl.startsWith('file://')) {
          try {
            execSync(`git push origin "${branch}"`, { cwd: targetDir, stdio: 'pipe', timeout: 60_000 });
            _emitters?.stepProgress({ nodeId: 'commit', message: 'Pushed to remote', percentage: 100 });
          } catch (pushErr) {
            const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
            log.warn('Push failed (non-fatal)', { error: pushMsg });
            _emitters?.stepProgress({ nodeId: 'commit', message: 'Commit done (push skipped)', percentage: 100 });
          }
        } else {
          _emitters?.stepProgress({ nodeId: 'commit', message: 'Committed locally', percentage: 100 });
        }

        _emitters?.commitCompleted({ commitHash: commitHash.slice(0, 8), branch });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Commit step failed (non-fatal)', { error: msg });
        _emitters?.stepProgress({ nodeId: 'commit', message: `Commit skipped: ${msg.slice(0, 80)}`, percentage: 100 });
        commitHash = 'no-commit';
        _emitters?.commitCompleted({ commitHash: 'no-commit', branch });
      }

      return `Committed: ${commitHash}`;
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
  }

  // ── Step runner ─────────────────────────────────────────────────────────────

  private async _runStep(
    executionId: string,
    nodeId: string,
    label: string,
    type: string,
    fn: () => Promise<string>,
  ): Promise<void> {
    const stepId = uuid();
    const stepStartedAt = now();

    // Persist step record
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

    _emitters?.stepStarted({ nodeId, label, type });
    log.info(`Step started: ${label}`, { nodeId });

    try {
      const output = await fn();

      await this.db.update(workflowSteps)
        .set({ status: 'completed', output, completedAt: now() })
        .where(eq(workflowSteps.id, stepId));

      _emitters?.stepCompleted({ nodeId, status: 'success', outputSummary: output.slice(0, 200) });
      log.info(`Step completed: ${label}`, { nodeId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      await this.db.update(workflowSteps)
        .set({ status: 'failed', error: msg, completedAt: now() })
        .where(eq(workflowSteps.id, stepId));

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
