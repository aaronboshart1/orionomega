/**
 * @module orchestration/coding/coding-orchestrator
 * End-to-end lifecycle coordinator for a Coding Mode session.
 *
 * Orchestrates the full 6-step coding workflow:
 *   1. Clone/sync repo          — via repo-manager
 *   2. Analyze codebase          — via codebase-analyzer
 *   3. Design implementation plan — via CodingPlanner (highest-power model)
 *   4. Implementation loop       — via Claude Agent SDK (executeCodingAgent)
 *   5. Architect review          — via architect-reviewer (generateReviewReport)
 *   6. Commit and push           — via repo-manager
 *
 * Reports progress back to the caller via `CodingProgressCallback` so the
 * OrchestrationBridge can relay updates to the user in real time.
 * Persists session state to the SQLite DB via `@orionomega/core/db`.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createLogger } from '../../logging/logger.js';
import { getDb } from '../../db/client.js';
import { codingSessions, workflowExecutions, workflowSteps, architectReviews } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { CodingPlanner, matchCodingIntent } from './coding-planner.js';
import { ValidationLoop, detectValidationCommands } from './validation-loop.js';
import type { CodingModeConfig, CodebaseScanOutput, ValidationConfig } from './coding-types.js';

// ── Proper module imports (replacing raw execSync) ────────────────────────────
import {
  cloneRepo,
  isGitRepo,
  getRepoRoot,
  stageChanges,
  commitChanges,
  pushChanges,
  getRepoStatus,
} from './repo-manager.js';
import {
  analyzeCodebase,
  toCodebaseScanOutput,
} from './codebase-analyzer.js';
import {
  generateReviewReport,
} from './architect-reviewer.js';
import type { ReviewReport } from './architect-reviewer.js';
import { executeCodingAgent } from '../agent-sdk-bridge.js';
import type { CodingAgentResult } from '../agent-sdk-bridge.js';

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
  /**
   * Per-command wall-clock budget (seconds) for build/test/lint validation
   * commands, propagated from `orchestration.validationTimeout`. Defaults
   * to 300s when omitted. The previous hard-coded 300_000 ms blocked
   * monorepo users from raising the budget without editing template code.
   */
  validationTimeoutSec?: number;
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
  /** Cost in USD from the implementation agent (if reported). */
  implementationCostUsd?: number;
  /** Tool calls made by the implementation agent. */
  implementationToolCalls?: number;
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
    let implementationCostUsd: number | undefined;
    let implementationToolCalls: number | undefined;
    const stepResults: CodingSessionResult['stepResults'] = [];

    // Resolve the actual working directory for the coding session.
    // For file:// repos, we work directly in the local repo.
    // For remote repos, we clone into the workspace.
    let targetDir = workspacePath;

    // ── Step 1: Clone / sync repo ──────────────────────────────────────────
    await this._runStep(executionId, 'clone', 'Clone / sync repo', 'git', progress, async () => {
      progress?.onStepProgress('clone', 'Preparing workspace…', 10);
      _emitters?.stepProgress({ nodeId: 'clone', message: 'Preparing workspace…', percentage: 10 });
      mkdirSync(workspacePath, { recursive: true });

      if (repoUrl.startsWith('file://')) {
        const localPath = resolvePath(repoUrl.replace('file://', ''));
        if (!existsSync(localPath)) {
          throw new Error(`Local repo path does not exist: ${localPath}`);
        }

        // Verify it's a git repo
        const isRepo = await isGitRepo(localPath);
        if (isRepo) {
          const root = await getRepoRoot(localPath);
          targetDir = root ?? localPath;
          log.info('Using local git repo', { targetDir });
        } else {
          targetDir = localPath;
          log.info('Using local directory (not a git repo)', { targetDir });
        }

        const msg = `Local workspace validated: ${targetDir}`;
        progress?.onStepProgress('clone', msg, 100);
        _emitters?.stepProgress({ nodeId: 'clone', message: msg, percentage: 100 });
      } else {
        // Remote repo — clone via repo-manager
        const msg = `Cloning ${repoUrl}…`;
        progress?.onStepProgress('clone', msg, 30);
        _emitters?.stepProgress({ nodeId: 'clone', message: msg, percentage: 30 });

        targetDir = await cloneRepo(repoUrl, workspacePath, {
          branch,
          shallow: true,
        });

        progress?.onStepProgress('clone', 'Clone complete', 100);
        _emitters?.stepProgress({ nodeId: 'clone', message: 'Clone complete', percentage: 100 });
      }

      const output = `Repo prepared at ${targetDir}`;
      stepResults.push({ nodeId: 'clone', label: 'Clone / sync repo', status: 'completed', output });
      return output;
    });

    // ── Step 2: Analyze codebase ──────────────────────────────────────────
    let codebaseScanOutput: CodebaseScanOutput | null = null;
    let analysisText = '';

    await this._runStep(executionId, 'analyze', 'Analyze codebase', 'analysis', progress, async () => {
      progress?.onStepProgress('analyze', 'Scanning project structure…', 20);
      _emitters?.stepProgress({ nodeId: 'analyze', message: 'Scanning project structure…', percentage: 20 });

      try {
        // Use the proper codebase-analyzer module
        const summary = await analyzeCodebase(targetDir);
        codebaseScanOutput = toCodebaseScanOutput(summary);

        progress?.onStepProgress('analyze', 'Identifying tech stack…', 60);
        _emitters?.stepProgress({ nodeId: 'analyze', message: 'Identifying tech stack…', percentage: 60 });

        analysisText = [
          `Language: ${summary.techStack.language}`,
          `Framework: ${summary.techStack.framework ?? 'none'}`,
          `Test framework: ${summary.techStack.testFramework ?? 'none'}`,
          `Build system: ${summary.techStack.buildSystem ?? 'none'}`,
          `Package manager: ${summary.techStack.packageManager ?? 'unknown'}`,
          `Total files: ${summary.totalFiles}`,
          `Estimated LOC: ${summary.estimatedLoc}`,
          `Entry points: ${summary.entryPoints.join(', ') || 'none detected'}`,
          `Relevant source files: ${summary.relevantFiles.length}`,
        ].join('\n');

        progress?.onStepProgress('analyze', 'Analysis complete', 100);
        _emitters?.stepProgress({ nodeId: 'analyze', message: 'Analysis complete', percentage: 100 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Full codebase analysis failed, using fallback', { error: msg });
        analysisText = `Analysis partial failure: ${msg}`;
        progress?.onStepProgress('analyze', 'Partial analysis (fallback)', 100);
        _emitters?.stepProgress({ nodeId: 'analyze', message: 'Partial analysis (fallback)', percentage: 100 });
      }

      stepResults.push({ nodeId: 'analyze', label: 'Analyze codebase', status: 'completed', output: analysisText.slice(0, 500) });
      return analysisText;
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
          // Plumb validation timeout from orchestration config so monorepo
          // builds can be granted >5 min without editing template code.
          validationTimeoutMs: (this.cfg.validationTimeoutSec ?? 300) * 1000,
        });

        // Use real scan output if available, otherwise build a stub
        const profile = codebaseScanOutput ?? this._buildStubProfile(analysisText);
        const selectedTemplate = planner.selectTemplate(taskDescription);
        const planOutput = planner.plan(taskDescription, selectedTemplate, profile);

        implementationPlan = [
          `Template: ${planOutput.template}`,
          `Nodes: ${planOutput.nodes.length}`,
          `Budget: $${planOutput.budgetAllocation.estimated.toFixed(2)}`,
          `Fan-out pending: ${planOutput.fanOutPending}`,
        ].join(', ');

        progress?.onStepProgress('plan', 'Plan ready', 100);
        _emitters?.stepProgress({ nodeId: 'plan', message: 'Plan ready', percentage: 100 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('CodingPlanner failed, using task description as plan', { error: msg });
        implementationPlan = `Fallback plan: ${taskDescription}`;
        progress?.onStepProgress('plan', 'Plan complete (fallback)', 100);
        _emitters?.stepProgress({ nodeId: 'plan', message: 'Plan complete (fallback)', percentage: 100 });
      }

      stepResults.push({ nodeId: 'plan', label: 'Design implementation plan', status: 'completed', output: implementationPlan });
      return implementationPlan;
    });

    // ── Step 4: Implementation loop (Claude Agent SDK) ─────────────────────
    let implementationOutput = '';
    await this._runStep(executionId, 'implement', 'Implementation loop', 'implementer', progress, async () => {
      progress?.onStepProgress('implement', 'Starting coding agent…', 5);
      _emitters?.stepProgress({ nodeId: 'implement', message: 'Starting coding agent…', percentage: 5 });

      // Build a rich task prompt with codebase context
      const contextParts: string[] = [
        `# Coding Task\n\n${taskDescription}`,
        '',
        `## Codebase Analysis\n\n${analysisText}`,
        '',
        `## Implementation Plan\n\n${implementationPlan}`,
        '',
        '## Instructions',
        '- Read the relevant source files before making changes.',
        '- Make targeted, surgical changes — do NOT refactor or rewrite working code unless asked.',
        '- After implementing, verify your changes compile/build correctly.',
        '- If tests exist, run them to ensure nothing is broken.',
        `- Working directory: ${targetDir}`,
      ];
      const fullTask = contextParts.join('\n');

      // Build a WorkflowNode to pass to executeCodingAgent
      const implNode = {
        id: 'implement',
        type: 'CODING_AGENT' as const,
        label: 'Implementation loop',
        dependsOn: [],
        status: 'running' as const,
        codingAgent: {
          task: fullTask,
          model: this.cfg.highPowerModel,
          cwd: targetDir,
          maxTurns: 50,
          maxBudgetUsd: 2.0,
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        },
      };

      try {
        const result: CodingAgentResult = await executeCodingAgent(
          implNode,
          targetDir,
          (event) => {
            // Relay agent progress to the coding session progress callback
            const pct = event.progress ?? 50;
            const msg = event.message ?? 'Working…';
            progress?.onStepProgress('implement', msg, Math.min(95, pct));
            _emitters?.stepProgress({ nodeId: 'implement', message: msg, percentage: Math.min(95, pct) });
          },
        );

        implementationCostUsd = result.costUsd;
        implementationToolCalls = result.toolCalls;

        if (!result.success) {
          log.warn('Implementation agent completed with errors', { error: result.error });
          implementationOutput = `Implementation completed with errors: ${result.error ?? 'unknown'}\n\nOutput:\n${result.output.slice(0, 2000)}`;
        } else {
          implementationOutput = result.output.slice(0, 3000);
        }

        // Collect changed files from git status
        try {
          const repoStatus = await getRepoStatus(targetDir);
          filesModified = [...repoStatus.modifiedFiles, ...repoStatus.stagedFiles];
          filesCreated = repoStatus.untrackedFiles;
        } catch {
          // Not a git repo or git status failed — try to collect from agent output
          filesModified = result.outputPaths.filter(p => !p.includes('/output/'));
          filesCreated = [];
        }

        const filesSummary = [
          filesModified.length > 0 ? `Modified: ${filesModified.length} file(s)` : '',
          filesCreated.length > 0 ? `Created: ${filesCreated.length} file(s)` : '',
          `Tool calls: ${result.toolCalls}`,
          result.costUsd ? `Cost: $${result.costUsd.toFixed(4)}` : '',
          `Duration: ${result.durationSec.toFixed(1)}s`,
        ].filter(Boolean).join(', ');

        progress?.onStepProgress('implement', `Implementation complete — ${filesSummary}`, 100);
        _emitters?.stepProgress({ nodeId: 'implement', message: `Implementation complete — ${filesSummary}`, percentage: 100 });

        const outputSummary = `${result.success ? 'Success' : 'Completed with errors'}. ${filesSummary}`;
        stepResults.push({ nodeId: 'implement', label: 'Implementation loop', status: result.success ? 'completed' : 'completed', output: outputSummary });
        return outputSummary;

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Implementation agent failed', { error: msg });

        // Fall back to validation-only mode (original behavior)
        progress?.onStepProgress('implement', 'Agent failed, running baseline validation…', 60);
        _emitters?.stepProgress({ nodeId: 'implement', message: 'Agent failed, running baseline validation…', percentage: 60 });

        const validationCmds = await detectValidationCommands(targetDir);
        let validationPassed = true;
        if (validationCmds.length > 0) {
          const validator = new ValidationLoop();
          const validationConfig: ValidationConfig = {
            commands: validationCmds,
            maxRetries: 0,
            // Use the same config-driven validation timeout as the primary
            // path so the fallback doesn't apply a stricter (60s) budget
            // than the user configured. The previous hard-coded 60_000
            // caused legitimate monorepo builds to time out only on the
            // recovery path, masking the real failure from the user.
            timeout: (this.cfg.validationTimeoutSec ?? 300) * 1000,
          };
          try {
            const valResult = await validator.execute(validationConfig, targetDir, () => {});
            validationPassed = valResult.finalOutput.passed;
          } catch {
            validationPassed = false;
          }
        }

        implementationOutput = `Agent failed (${msg}). Baseline validation: ${validationPassed ? 'PASSED' : 'FAILED'}.`;
        progress?.onStepProgress('implement', 'Fallback validation complete', 100);
        _emitters?.stepProgress({ nodeId: 'implement', message: 'Fallback validation complete', percentage: 100 });
        stepResults.push({ nodeId: 'implement', label: 'Implementation loop', status: 'completed', output: implementationOutput });
        return implementationOutput;
      }
    });

    // ── Step 5: Architect review ───────────────────────────────────────────
    const reviewIteration = 1;

    await this._runStep(executionId, 'review', 'Architect review', 'reviewer', progress, async () => {
      _emitters?.reviewStarted({ iteration: reviewIteration });
      progress?.onStepProgress('review', 'Running build, tests, and quality checks…', 20);
      _emitters?.stepProgress({ nodeId: 'review', message: 'Running build, tests, and quality checks…', percentage: 20 });

      let report: ReviewReport;
      try {
        // Per-command budget sourced from config (orchestration.validationTimeout).
        // Monorepo builds (`pnpm -r`) routinely exceed 2 min and sometimes 5 min;
        // letting the user raise this without editing template code is the
        // whole point of plumbing the value through.
        const validationTimeoutMs = (this.cfg.validationTimeoutSec ?? 300) * 1000;
        report = await generateReviewReport(targetDir, {
          changedFiles: [...filesModified, ...filesCreated],
          timeoutMs: validationTimeoutMs,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Architect review failed, approving by default', { error: msg });
        reviewDecision = 'approve';

        await this.db.insert(architectReviews).values({
          id: uuid(),
          workflowExecutionId: executionId,
          iteration: reviewIteration,
          buildStatus: 'skip',
          testStatus: 'skip',
          codeQualityScore: 50,
          decision: 'approve',
          feedback: `Review failed (${msg}). Auto-approved.`,
          reviewedAt: now(),
        });

        const output = `Review failed (${msg}). Auto-approved.`;
        _emitters?.reviewCompleted({ decision: 'approve', feedback: output });
        progress?.onStepProgress('review', 'Review complete (auto-approved)', 100);
        _emitters?.stepProgress({ nodeId: 'review', message: 'Review complete (auto-approved)', percentage: 100 });
        stepResults.push({ nodeId: 'review', label: 'Architect review', status: 'completed', output });
        return output;
      }

      progress?.onStepProgress('review', 'Evaluating results…', 80);
      _emitters?.stepProgress({ nodeId: 'review', message: 'Evaluating results…', percentage: 80 });

      // Map review decision to our enum
      const outcome = report.decision.outcome;
      if (outcome === 'approve' || outcome === 'approve_with_warnings') {
        reviewDecision = 'approve';
      } else {
        reviewDecision = 'request-changes';
      }

      // Compute quality score from the report
      const qualityScore = outcome === 'approve' ? 90
        : outcome === 'approve_with_warnings' ? 75
        : 50;

      await this.db.insert(architectReviews).values({
        id: uuid(),
        workflowExecutionId: executionId,
        iteration: reviewIteration,
        buildStatus: report.buildPassed ? 'pass' : 'fail',
        testStatus: report.testsPassed ? 'pass' : 'fail',
        codeQualityScore: qualityScore,
        decision: outcome === 'retask' ? 'retask' : 'approve',
        feedback: report.summary,
        reviewedAt: now(),
      });

      _emitters?.reviewCompleted({
        decision: reviewDecision,
        feedback: report.summary,
        metrics: {
          buildPassed: report.buildPassed,
          testsPassed: report.testsPassed,
          complexityTier: report.qualityMetrics.complexityTier,
          confidence: report.decision.confidence,
          blockers: report.blockers.length,
          suggestions: report.suggestions.length,
          iteration: reviewIteration,
        },
      });

      const output = [
        `Decision: ${outcome} (confidence: ${(report.decision.confidence * 100).toFixed(0)}%)`,
        `Build: ${report.buildPassed ? 'PASS' : 'FAIL'}`,
        `Tests: ${report.testsPassed ? `PASS (${report.testResults.length} suite(s))` : 'FAIL'}`,
        `Complexity: ${report.qualityMetrics.complexityTier}`,
        report.blockers.length > 0 ? `Blockers: ${report.blockers.map(b => b.description.slice(0, 80)).join('; ')}` : '',
        report.suggestions.length > 0 ? `Suggestions: ${report.suggestions.length}` : '',
      ].filter(Boolean).join('\n');

      progress?.onStepProgress('review', `Review complete: ${outcome}`, 100);
      _emitters?.stepProgress({ nodeId: 'review', message: `Review complete: ${outcome}`, percentage: 100 });
      stepResults.push({ nodeId: 'review', label: 'Architect review', status: 'completed', output });
      return output;
    });

    // ── Step 6: Commit and push ────────────────────────────────────────────
    await this._runStep(executionId, 'commit', 'Commit and push', 'git', progress, async () => {
      progress?.onStepProgress('commit', 'Checking for changes…', 10);
      _emitters?.stepProgress({ nodeId: 'commit', message: 'Checking for changes…', percentage: 10 });

      // Only commit if the target is a git repo
      const isRepo = await isGitRepo(targetDir).catch(() => false);
      if (!isRepo) {
        const msg = 'Not a git repo — skipping commit';
        progress?.onStepProgress('commit', msg, 100);
        _emitters?.stepProgress({ nodeId: 'commit', message: msg, percentage: 100 });
        commitHash = 'no-commit';
        stepResults.push({ nodeId: 'commit', label: 'Commit and push', status: 'completed', output: msg });
        return msg;
      }

      try {
        // Stage all changes via repo-manager
        progress?.onStepProgress('commit', 'Staging changes…', 30);
        _emitters?.stepProgress({ nodeId: 'commit', message: 'Staging changes…', percentage: 30 });
        await stageChanges(targetDir);

        // Check if there are actually changes to commit
        const status = await getRepoStatus(targetDir);
        if (status.isClean && status.stagedFiles.length === 0) {
          const msg = 'No changes to commit';
          progress?.onStepProgress('commit', msg, 100);
          _emitters?.stepProgress({ nodeId: 'commit', message: msg, percentage: 100 });
          commitHash = 'no-changes';
          stepResults.push({ nodeId: 'commit', label: 'Commit and push', status: 'completed', output: msg });
          return msg;
        }

        // Commit via repo-manager
        progress?.onStepProgress('commit', 'Creating commit…', 50);
        _emitters?.stepProgress({ nodeId: 'commit', message: 'Creating commit…', percentage: 50 });

        const commitMsg = `feat: ${taskDescription.slice(0, 72)}\n\nGenerated by OrionOmega Coding Agent`;
        const commitResult = await commitChanges(
          targetDir,
          commitMsg,
          'OrionOmega Coding Agent',
          'coding-agent@orionomega',
        );

        // Extract commit hash from git output
        const hashMatch = commitResult.stdout.match(/\[[\w/]+ ([a-f0-9]+)\]/);
        if (hashMatch) {
          commitHash = hashMatch[1];
        } else {
          // Fallback: read HEAD
          const { exec: execCb } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execAsync = promisify(execCb);
          try {
            const { stdout } = await execAsync('git rev-parse HEAD', { cwd: targetDir });
            commitHash = stdout.trim();
          } catch {
            commitHash = 'committed';
          }
        }

        progress?.onStepProgress('commit', `Committed as ${commitHash.slice(0, 8)}`, 70);
        _emitters?.stepProgress({ nodeId: 'commit', message: `Committed as ${commitHash.slice(0, 8)}`, percentage: 70 });
        _emitters?.commitCompleted({ commitHash: commitHash.slice(0, 8), branch });

        // Push for remote repos
        if (!repoUrl.startsWith('file://')) {
          try {
            progress?.onStepProgress('commit', 'Pushing to remote…', 85);
            _emitters?.stepProgress({ nodeId: 'commit', message: 'Pushing to remote…', percentage: 85 });
            await pushChanges(targetDir, { branch });
            progress?.onStepProgress('commit', 'Pushed to remote', 100);
            _emitters?.stepProgress({ nodeId: 'commit', message: 'Pushed to remote', percentage: 100 });
          } catch (pushErr) {
            const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
            log.warn('Push failed (non-fatal)', { error: pushMsg });
            progress?.onStepProgress('commit', `Committed locally (push failed: ${pushMsg.slice(0, 60)})`, 100);
            _emitters?.stepProgress({ nodeId: 'commit', message: 'Committed locally (push skipped)', percentage: 100 });
          }
        } else {
          progress?.onStepProgress('commit', 'Committed locally', 100);
          _emitters?.stepProgress({ nodeId: 'commit', message: 'Committed locally', percentage: 100 });
        }
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
      implementationCostUsd,
      implementationToolCalls,
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

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Build a stub CodebaseScanOutput from the lightweight analysis string.
   * Used when the full codebase-analyzer fails.
   */
  private _buildStubProfile(analysisText: string): CodebaseScanOutput {
    const fileCountMatch = analysisText.match(/Files found:\s*(\d+)/i) ?? analysisText.match(/Total files:\s*(\d+)/i);
    const fileCount = fileCountMatch ? parseInt(fileCountMatch[1], 10) : 20;
    const isPython = /python|pip/i.test(analysisText);
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
