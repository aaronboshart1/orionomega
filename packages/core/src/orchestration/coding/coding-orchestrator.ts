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
import type {
  CodingModeConfig,
  CodebaseScanOutput,
  CodingPlannerOutput,
  ValidationConfig,
  Requirement,
  RequirementVerdict,
} from './coding-types.js';
import type { MemoryBridge } from '../../agent/memory-bridge.js';
import type { AnthropicClient } from '../../anthropic/client.js';

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

/**
 * Every event-emitter function in this interface accepts the
 * CodingOrchestrator's internal sessionId as a second `codingSessionId`
 * argument. The gateway uses this id to look up the originating
 * gateway sessionId via the binding map populated by `bindSession()`.
 * Threading the id through every call (rather than relying on a
 * "currently active" fallback) is REQUIRED for correct routing when
 * multiple coding sessions run concurrently across distinct gateway
 * sessions.
 */
export interface CodingEventEmitters {
  sessionStarted: (payload: { repoUrl: string; branch: string; sessionId: string }, codingSessionId?: string) => void;
  workflowStarted: (payload: { workflowId: string; template: string; nodeCount: number }, codingSessionId?: string) => void;
  stepStarted: (payload: { nodeId: string; label: string; type: string }, codingSessionId?: string) => void;
  stepProgress: (payload: { nodeId: string; message: string; percentage: number }, codingSessionId?: string) => void;
  stepCompleted: (payload: { nodeId: string; status: 'success'; outputSummary: string; metadata?: Record<string, unknown> }, codingSessionId?: string) => void;
  stepFailed: (payload: { nodeId: string; error: string }, codingSessionId?: string) => void;
  reviewStarted: (payload: { iteration: number }, codingSessionId?: string) => void;
  reviewCompleted: (payload: { decision: 'approve' | 'reject' | 'request-changes'; feedback: string; metrics?: Record<string, unknown> }, codingSessionId?: string) => void;
  commitCompleted: (payload: { commitHash: string; branch: string }, codingSessionId?: string) => void;
  sessionCompleted: (payload: { summary: string; filesModified?: string[]; filesCreated?: string[]; totalDurationMs?: number }, codingSessionId?: string) => void;
  /**
   * Bind a coding-orchestrator sessionId to the originating gateway/conversation
   * sessionId. Called by `run()`/`start()` immediately before `sessionStarted`
   * so downstream gateways can scope subsequent step/review/commit events
   * (which carry no IDs in their payloads) back to the correct session.
   * Optional for backward compatibility with non-multi-session emitters.
   */
  bindSession?: (codingSessionId: string, gatewaySessionId: string) => void;
  /**
   * Drop the binding registered by {@link bindSession}. Called when a coding
   * session terminates (success, failure, or cancel) so the binding map does
   * not grow unboundedly. Optional for backward compatibility.
   */
  unbindSession?: (codingSessionId: string) => void;
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
  /**
   * Optional Hindsight-backed memory bridge. When provided, the architect
   * step recalls prior decisions before planning, and the end of each run
   * persists the plan + per-requirement verdicts back to the project bank.
   */
  memoryBridge?: MemoryBridge;
  /**
   * Optional Anthropic client used for (a) extracting concrete requirements
   * from the task during the plan step, and (b) the per-requirement
   * goal-verification check inside the architect-reviewer. When omitted,
   * the orchestrator gracefully degrades: planning falls back to a single
   * synthetic requirement, and goal verification produces `unknown`
   * verdicts (which are non-blocking).
   */
  anthropic?: AnthropicClient;
  /**
   * Cheap/fast Claude model used for requirement extraction and
   * goal-verification. Defaults to `highPowerModel` when omitted, but
   * passing a smaller model here meaningfully cuts cost on these short,
   * structured-output calls.
   */
  cheapModel?: string;
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

    // Bind coding sessionId → conversation/gateway sessionId BEFORE emitting
    // any events so the downstream resolver can scope them correctly.
    _emitters?.bindSession?.(sessionId, conversationId);

    // Emit legacy events
    _emitters?.sessionStarted({ repoUrl, branch, sessionId }, sessionId);
    _emitters?.workflowStarted({ workflowId: sessionId, template, nodeCount: DEFAULT_CODING_STEPS.length }, sessionId);

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
        taskDescription, template, startedAt, conversationId, progress,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Coding workflow failed', { sessionId, error: msg });
      _emitters?.stepFailed({ nodeId: 'workflow', error: msg }, sessionId);
      await this._updateSessionStatus(sessionId, 'failed').catch((updErr) => {
        log.warn('Failed to mark coding session as failed', {
          sessionId,
          error: updErr instanceof Error ? updErr.message : String(updErr),
        });
      });
      await this._updateExecutionStatus(executionId, 'failed', msg).catch((updErr) => {
        log.warn('Failed to mark workflow execution as failed', {
          executionId,
          error: updErr instanceof Error ? updErr.message : String(updErr),
        });
      });
      throw err;
    } finally {
      // Always release the binding so the resolver map does not grow.
      _emitters?.unbindSession?.(sessionId);
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
    // Bind coding sessionId → conversation/gateway sessionId BEFORE emitting
    // any events so the downstream resolver can scope them correctly.
    _emitters?.bindSession?.(sessionId, conversationId);
    _emitters?.sessionStarted({ repoUrl, branch, sessionId }, sessionId);
    _emitters?.workflowStarted({ workflowId: sessionId, template, nodeCount: DEFAULT_CODING_STEPS.length }, sessionId);

    const executionId = uuid();
    await this.db.insert(workflowExecutions).values({
      id: executionId, codingSessionId: sessionId,
      dagDefinition: JSON.stringify(DEFAULT_CODING_STEPS),
      status: 'running', startedAt: now(), completedAt: null, error: null,
    });

    // Fire-and-forget
    this._runWorkflow(sessionId, executionId, workspacePath, repoUrl, branch, taskDescription, template, startedAt, conversationId)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Coding workflow failed', { sessionId, error: msg });
        _emitters?.stepFailed({ nodeId: 'workflow', error: msg }, sessionId);
        this._updateSessionStatus(sessionId, 'failed').catch((updErr) => {
          log.warn('Failed to mark coding session as failed', {
            sessionId,
            error: updErr instanceof Error ? updErr.message : String(updErr),
          });
        });
        this._updateExecutionStatus(executionId, 'failed', msg).catch((updErr) => {
          log.warn('Failed to mark workflow execution as failed', {
            executionId,
            error: updErr instanceof Error ? updErr.message : String(updErr),
          });
        });
      })
      .finally(() => {
        // Always release the binding so the resolver map does not grow.
        _emitters?.unbindSession?.(sessionId);
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
    conversationId: string,
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
    await this._runStep(sessionId, executionId, 'clone', 'Clone / sync repo', 'git', progress, async () => {
      progress?.onStepProgress('clone', 'Preparing workspace…', 10);
      _emitters?.stepProgress({ nodeId: 'clone', message: 'Preparing workspace…', percentage: 10 }, sessionId);
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
        _emitters?.stepProgress({ nodeId: 'clone', message: msg, percentage: 100 }, sessionId);
      } else {
        // Remote repo — clone via repo-manager
        const msg = `Cloning ${repoUrl}…`;
        progress?.onStepProgress('clone', msg, 30);
        _emitters?.stepProgress({ nodeId: 'clone', message: msg, percentage: 30 }, sessionId);

        targetDir = await cloneRepo(repoUrl, workspacePath, {
          branch,
          shallow: true,
        });

        progress?.onStepProgress('clone', 'Clone complete', 100);
        _emitters?.stepProgress({ nodeId: 'clone', message: 'Clone complete', percentage: 100 }, sessionId);
      }

      const output = `Repo prepared at ${targetDir}`;
      stepResults.push({ nodeId: 'clone', label: 'Clone / sync repo', status: 'completed', output });
      return output;
    });

    // ── Step 2: Analyze codebase ──────────────────────────────────────────
    let codebaseScanOutput: CodebaseScanOutput | null = null;
    let analysisText = '';

    await this._runStep(sessionId, executionId, 'analyze', 'Analyze codebase', 'analysis', progress, async () => {
      progress?.onStepProgress('analyze', 'Scanning project structure…', 20);
      _emitters?.stepProgress({ nodeId: 'analyze', message: 'Scanning project structure…', percentage: 20 }, sessionId);

      try {
        // Use the proper codebase-analyzer module
        const summary = await analyzeCodebase(targetDir);
        codebaseScanOutput = toCodebaseScanOutput(summary);

        progress?.onStepProgress('analyze', 'Identifying tech stack…', 60);
        _emitters?.stepProgress({ nodeId: 'analyze', message: 'Identifying tech stack…', percentage: 60 }, sessionId);

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
        _emitters?.stepProgress({ nodeId: 'analyze', message: 'Analysis complete', percentage: 100 }, sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Full codebase analysis failed, using fallback', { error: msg });
        analysisText = `Analysis partial failure: ${msg}`;
        progress?.onStepProgress('analyze', 'Partial analysis (fallback)', 100);
        _emitters?.stepProgress({ nodeId: 'analyze', message: 'Partial analysis (fallback)', percentage: 100 }, sessionId);
      }

      stepResults.push({ nodeId: 'analyze', label: 'Analyze codebase', status: 'completed', output: analysisText.slice(0, 500) });
      return analysisText;
    });

    // ── Step 3: Design implementation plan (high-power model) ─────────────
    let implementationPlan = '';
    let priorDecisions: string[] = [];
    let requirements: Requirement[] = [];
    // Captured planner output for end-of-run Hindsight retention. Stays
    // null when the planner falls back to the prose-only path.
    let capturedPlanOutput: CodingPlannerOutput | null = null;
    await this._runStep(sessionId, executionId, 'plan', 'Design implementation plan', 'architect', progress, async () => {
      // 3a. Recall prior decisions from Hindsight (best-effort).
      if (this.cfg.memoryBridge) {
        progress?.onStepProgress('plan', 'Recalling prior architecture decisions…', 10);
        _emitters?.stepProgress({ nodeId: 'plan', message: 'Recalling prior architecture decisions…', percentage: 10 }, sessionId);
        try {
          priorDecisions = await this.cfg.memoryBridge.recallForArchitect(taskDescription);
        } catch (err) {
          // recallForArchitect already swallows individual recall failures,
          // but defend against future regressions so planning never aborts
          // because memory was unavailable.
          log.warn('Architect memory recall failed', { error: err instanceof Error ? err.message : String(err) });
          priorDecisions = [];
        }
      }

      progress?.onStepProgress('plan', 'Generating implementation plan…', 30);
      _emitters?.stepProgress({ nodeId: 'plan', message: 'Generating implementation plan…', percentage: 30 }, sessionId);

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
        const planOutput = planner.plan(taskDescription, selectedTemplate, profile, {
          priorDecisions,
        });
        capturedPlanOutput = planOutput;

        implementationPlan = [
          `Template: ${planOutput.template}`,
          `Nodes: ${planOutput.nodes.length}`,
          `Budget: $${planOutput.budgetAllocation.estimated.toFixed(2)}`,
          `Fan-out pending: ${planOutput.fanOutPending}`,
        ].join(', ');

        progress?.onStepProgress('plan', 'Plan ready', 70);
        _emitters?.stepProgress({ nodeId: 'plan', message: 'Plan ready', percentage: 70 }, sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('CodingPlanner failed, using task description as plan', { error: msg });
        implementationPlan = `Fallback plan: ${taskDescription}`;
        progress?.onStepProgress('plan', 'Plan complete (fallback)', 70);
        _emitters?.stepProgress({ nodeId: 'plan', message: 'Plan complete (fallback)', percentage: 70 }, sessionId);
      }

      // 3b. Extract requirements from the user's task. We deliberately do
      // this *outside* the architect template (which only runs in DAG mode)
      // so the linear orchestrator path also enforces goal coverage.
      progress?.onStepProgress('plan', 'Extracting concrete requirements…', 85);
      _emitters?.stepProgress({ nodeId: 'plan', message: 'Extracting concrete requirements…', percentage: 85 }, sessionId);
      requirements = await this._extractRequirements(taskDescription, priorDecisions);

      // 3c. Coverage check — every requirement must have at least one
      // chunk/file change "covering" it. The linear orchestrator does not
      // produce explicit chunks (the architect template does), so the
      // implicit covering "chunk" is the single implementation step.
      // We mark each requirement as covered by `implement`. The check is
      // primarily a guardrail against the future: if a downstream change
      // returns a requirement with `coveredBy: []`, fail loudly.
      const uncovered = requirements.filter(
        (r) => Array.isArray(r.coveredBy) && r.coveredBy.length === 0,
      );
      if (uncovered.length > 0) {
        const msg = `Plan-coverage check failed: ${uncovered.length} requirement(s) have no covering chunk: ` +
          uncovered.map((r) => `[${r.id}] ${r.description}`).join('; ');
        log.error(msg);
        throw new Error(msg);
      }
      // Default-cover any requirement that came back without an explicit
      // coveredBy list (the linear path only has one implementer step).
      for (const r of requirements) {
        if (!Array.isArray(r.coveredBy) || r.coveredBy.length === 0) {
          r.coveredBy = ['implement'];
        }
      }

      const summary = [
        implementationPlan,
        `Prior decisions: ${priorDecisions.length}`,
        `Requirements: ${requirements.length}`,
      ].join(', ');

      progress?.onStepProgress('plan', `Plan ready (${requirements.length} requirement(s))`, 100);
      _emitters?.stepProgress({
        nodeId: 'plan',
        message: `Plan ready (${requirements.length} requirement(s), ${priorDecisions.length} prior decision(s))`,
        percentage: 100,
      }, sessionId);

      stepResults.push({ nodeId: 'plan', label: 'Design implementation plan', status: 'completed', output: summary });
      return summary;
    },
    // metadataProvider — attaches structured plan visibility (recalled
    // prior-decision snippets, full requirement objects, template/nodes/
    // budget) to the standard stepCompleted emit. We pass this through
    // _runStep instead of emitting a second stepCompleted to avoid any
    // event-counting consumers double-counting completion.
    () => {
      const po = capturedPlanOutput as CodingPlannerOutput | null;
      return {
        priorDecisions: priorDecisions.slice(0, 8).map((d) => d.length > 600 ? d.slice(0, 600) + '…' : d),
        priorDecisionsCount: priorDecisions.length,
        requirements: requirements.map((r) => ({
          id: r.id,
          description: r.description,
          acceptance: r.acceptance,
          coveredBy: r.coveredBy ?? [],
        })),
        template: po?.template,
        nodeCount: po?.nodes.length,
        estimatedBudgetUsd: po?.budgetAllocation.estimated,
        fanOutPending: po?.fanOutPending ?? false,
      };
    });

    // ── Step 4: Implementation loop (Claude Agent SDK) ─────────────────────
    let implementationOutput = '';
    await this._runStep(sessionId, executionId, 'implement', 'Implementation loop', 'implementer', progress, async () => {
      progress?.onStepProgress('implement', 'Starting coding agent…', 5);
      _emitters?.stepProgress({ nodeId: 'implement', message: 'Starting coding agent…', percentage: 5 }, sessionId);

      // Build a rich task prompt with codebase context. Prior decisions
      // and the explicit requirements list are appended so the implementer
      // is operating from the same goals the reviewer will grade against.
      const priorDecisionsBlock = priorDecisions.length === 0
        ? ''
        : '\n\n## Prior Architecture Decisions (from memory)\n' +
          priorDecisions
            .slice(0, 6)
            .map((d, i) => {
              const trimmed = d.length > 1200 ? d.slice(0, 1200) + '\n...[truncated]' : d;
              return `### Decision ${i + 1}\n${trimmed}`;
            })
            .join('\n\n');

      const requirementsBlock = requirements.length === 0
        ? ''
        : '\n\n## Requirements (each must be satisfied)\n' +
          requirements
            .map((r) => `- **[${r.id}]** ${r.description}\n  - Acceptance: ${r.acceptance}`)
            .join('\n');

      const contextParts: string[] = [
        `# Coding Task\n\n${taskDescription}`,
        priorDecisionsBlock,
        '',
        `## Codebase Analysis\n\n${analysisText}`,
        '',
        `## Implementation Plan\n\n${implementationPlan}`,
        requirementsBlock,
        '',
        '## Instructions',
        '- Read the relevant source files before making changes.',
        '- Make targeted, surgical changes — do NOT refactor or rewrite working code unless asked.',
        '- Ensure every requirement above is satisfied; the reviewer will grade them individually and force a retry if any is unmet.',
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
            _emitters?.stepProgress({ nodeId: 'implement', message: msg, percentage: Math.min(95, pct) }, sessionId);
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
        _emitters?.stepProgress({ nodeId: 'implement', message: `Implementation complete — ${filesSummary}`, percentage: 100 }, sessionId);

        const outputSummary = `${result.success ? 'Success' : 'Completed with errors'}. ${filesSummary}`;
        stepResults.push({ nodeId: 'implement', label: 'Implementation loop', status: result.success ? 'completed' : 'completed', output: outputSummary });
        return outputSummary;

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Implementation agent failed', { error: msg });

        // Fall back to validation-only mode (original behavior)
        progress?.onStepProgress('implement', 'Agent failed, running baseline validation…', 60);
        _emitters?.stepProgress({ nodeId: 'implement', message: 'Agent failed, running baseline validation…', percentage: 60 }, sessionId);

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
        _emitters?.stepProgress({ nodeId: 'implement', message: 'Fallback validation complete', percentage: 100 }, sessionId);
        stepResults.push({ nodeId: 'implement', label: 'Implementation loop', status: 'completed', output: implementationOutput });
        return implementationOutput;
      }
    });

    // ── Step 5: Architect review ───────────────────────────────────────────
    const reviewIteration = 1;
    let goalVerdicts: RequirementVerdict[] = [];

    await this._runStep(sessionId, executionId, 'review', 'Architect review', 'reviewer', progress, async () => {
      _emitters?.reviewStarted({ iteration: reviewIteration }, sessionId);
      progress?.onStepProgress('review', 'Running build, tests, and quality checks…', 20);
      _emitters?.stepProgress({ nodeId: 'review', message: 'Running build, tests, and quality checks…', percentage: 20 }, sessionId);

      let report: ReviewReport;
      try {
        // Per-command budget sourced from config (orchestration.validationTimeout).
        // Monorepo builds (`pnpm -r`) routinely exceed 2 min and sometimes 5 min;
        // letting the user raise this without editing template code is the
        // whole point of plumbing the value through.
        const validationTimeoutMs = (this.cfg.validationTimeoutSec ?? 300) * 1000;

        // Read bounded content snippets from changed files so the goal
        // verifier can grade requirements against actual code, not just
        // filenames. Filename-only evidence is not strict enough to catch
        // "build passes but feature missing" — see review critique #3.
        const fileSnippets = await this._readFileSnippets(
          targetDir,
          [...filesModified, ...filesCreated],
        );

        report = await generateReviewReport(targetDir, {
          changedFiles: [...filesModified, ...filesCreated],
          timeoutMs: validationTimeoutMs,
          // Goal-verification context: when both `requirements` and
          // `anthropic` are present, the reviewer LLM-grades each goal
          // against the build/test evidence and forces a `retask` if any
          // requirement comes back `unmet`.
          requirements,
          fileSnippets,
          anthropic: this.cfg.anthropic,
          model: this.cfg.cheapModel ?? this.cfg.highPowerModel,
          taskDescription,
          implementationOutput,
        });
        goalVerdicts = report.goalVerdicts ?? [];
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
          // Persist the goal-tracking fields on this branch too so that
          // every architect_reviews row carries a consistent shape — the
          // requirements list (if extraction had succeeded) and the
          // priorDecisionsCount remain useful audit data even when the
          // mechanical review itself crashed; verdicts are simply absent.
          requirements: requirements.length > 0 ? JSON.stringify(requirements) : null,
          goalVerdicts: null,
          priorDecisionsCount: priorDecisions.length,
        });

        const output = `Review failed (${msg}). Auto-approved.`;
        _emitters?.reviewCompleted({ decision: 'approve', feedback: output }, sessionId);
        progress?.onStepProgress('review', 'Review complete (auto-approved)', 100);
        _emitters?.stepProgress({ nodeId: 'review', message: 'Review complete (auto-approved)', percentage: 100 }, sessionId);
        stepResults.push({ nodeId: 'review', label: 'Architect review', status: 'completed', output });
        return output;
      }

      progress?.onStepProgress('review', 'Evaluating results…', 80);
      _emitters?.stepProgress({ nodeId: 'review', message: 'Evaluating results…', percentage: 80 }, sessionId);

      // Map review decision to our enum. The reviewer already converts an
      // unmet requirement into outcome=retask via makeDecision, so we only
      // need to forward the decision here.
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

      const unmetCount = goalVerdicts.filter((v) => v.status === 'unmet').length;
      const partialCount = goalVerdicts.filter((v) => v.status === 'partially-met').length;
      const metCount = goalVerdicts.filter((v) => v.status === 'met').length;

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
        // Persisted for downstream UIs and for cross-run analysis. JSON
        // strings keep the schema additive — no migrations of existing
        // rows needed because the columns are nullable.
        requirements: requirements.length > 0 ? JSON.stringify(requirements) : null,
        goalVerdicts: goalVerdicts.length > 0 ? JSON.stringify(goalVerdicts) : null,
        priorDecisionsCount: priorDecisions.length,
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
          requirementsCount: requirements.length,
          goalsMet: metCount,
          goalsPartial: partialCount,
          goalsUnmet: unmetCount,
          priorDecisionsCount: priorDecisions.length,
          // Trimmed verdict list — keeps the websocket payload bounded
          // while still surfacing per-goal status to the UI.
          goalVerdicts: goalVerdicts.map((v) => ({
            requirementId: v.requirementId,
            status: v.status,
            confidence: v.confidence,
            evidence: v.evidence.slice(0, 240),
          })),
        },
      }, sessionId);

      const goalsLine = requirements.length > 0
        ? `Goals: ${metCount}/${requirements.length} met` +
          (partialCount > 0 ? `, ${partialCount} partial` : '') +
          (unmetCount > 0 ? `, ${unmetCount} unmet` : '')
        : '';

      const output = [
        `Decision: ${outcome} (confidence: ${(report.decision.confidence * 100).toFixed(0)}%)`,
        `Build: ${report.buildPassed ? 'PASS' : 'FAIL'}`,
        `Tests: ${report.testsPassed ? `PASS (${report.testResults.length} suite(s))` : 'FAIL'}`,
        `Complexity: ${report.qualityMetrics.complexityTier}`,
        goalsLine,
        report.blockers.length > 0 ? `Blockers: ${report.blockers.map(b => b.description.slice(0, 80)).join('; ')}` : '',
        report.suggestions.length > 0 ? `Suggestions: ${report.suggestions.length}` : '',
      ].filter(Boolean).join('\n');

      progress?.onStepProgress('review', `Review complete: ${outcome}`, 100);
      _emitters?.stepProgress({ nodeId: 'review', message: `Review complete: ${outcome}`, percentage: 100 }, sessionId);
      stepResults.push({ nodeId: 'review', label: 'Architect review', status: 'completed', output });
      return output;
    });

    // ── Step 6: Commit and push ────────────────────────────────────────────
    await this._runStep(sessionId, executionId, 'commit', 'Commit and push', 'git', progress, async () => {
      progress?.onStepProgress('commit', 'Checking for changes…', 10);
      _emitters?.stepProgress({ nodeId: 'commit', message: 'Checking for changes…', percentage: 10 }, sessionId);

      // Only commit if the target is a git repo
      const isRepo = await isGitRepo(targetDir).catch(() => false);
      if (!isRepo) {
        const msg = 'Not a git repo — skipping commit';
        progress?.onStepProgress('commit', msg, 100);
        _emitters?.stepProgress({ nodeId: 'commit', message: msg, percentage: 100 }, sessionId);
        commitHash = 'no-commit';
        stepResults.push({ nodeId: 'commit', label: 'Commit and push', status: 'completed', output: msg });
        return msg;
      }

      try {
        // Stage all changes via repo-manager
        progress?.onStepProgress('commit', 'Staging changes…', 30);
        _emitters?.stepProgress({ nodeId: 'commit', message: 'Staging changes…', percentage: 30 }, sessionId);
        await stageChanges(targetDir);

        // Check if there are actually changes to commit
        const status = await getRepoStatus(targetDir);
        if (status.isClean && status.stagedFiles.length === 0) {
          const msg = 'No changes to commit';
          progress?.onStepProgress('commit', msg, 100);
          _emitters?.stepProgress({ nodeId: 'commit', message: msg, percentage: 100 }, sessionId);
          commitHash = 'no-changes';
          stepResults.push({ nodeId: 'commit', label: 'Commit and push', status: 'completed', output: msg });
          return msg;
        }

        // Commit via repo-manager
        progress?.onStepProgress('commit', 'Creating commit…', 50);
        _emitters?.stepProgress({ nodeId: 'commit', message: 'Creating commit…', percentage: 50 }, sessionId);

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
        _emitters?.stepProgress({ nodeId: 'commit', message: `Committed as ${commitHash.slice(0, 8)}`, percentage: 70 }, sessionId);
        _emitters?.commitCompleted({ commitHash: commitHash.slice(0, 8), branch }, sessionId);

        // Push for remote repos
        if (!repoUrl.startsWith('file://')) {
          try {
            progress?.onStepProgress('commit', 'Pushing to remote…', 85);
            _emitters?.stepProgress({ nodeId: 'commit', message: 'Pushing to remote…', percentage: 85 }, sessionId);
            await pushChanges(targetDir, { branch });
            progress?.onStepProgress('commit', 'Pushed to remote', 100);
            _emitters?.stepProgress({ nodeId: 'commit', message: 'Pushed to remote', percentage: 100 }, sessionId);
          } catch (pushErr) {
            const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
            log.warn('Push failed (non-fatal)', { error: pushMsg });
            progress?.onStepProgress('commit', `Committed locally (push failed: ${pushMsg.slice(0, 60)})`, 100);
            _emitters?.stepProgress({ nodeId: 'commit', message: 'Committed locally (push skipped)', percentage: 100 }, sessionId);
          }
        } else {
          progress?.onStepProgress('commit', 'Committed locally', 100);
          _emitters?.stepProgress({ nodeId: 'commit', message: 'Committed locally', percentage: 100 }, sessionId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Commit step failed (non-fatal)', { error: msg });
        progress?.onStepProgress('commit', `Commit skipped: ${msg.slice(0, 80)}`, 100);
        _emitters?.stepProgress({ nodeId: 'commit', message: `Commit skipped: ${msg.slice(0, 80)}`, percentage: 100 }, sessionId);
        commitHash = 'no-commit';
        _emitters?.commitCompleted({ commitHash: 'no-commit', branch }, sessionId);
      }

      const output = `Committed: ${commitHash || 'no-commit'}`;
      stepResults.push({ nodeId: 'commit', label: 'Commit and push', status: 'completed', output });
      return output;
    });

    // ── Session completion ─────────────────────────────────────────────────
    const totalDurationMs = Date.now() - startedAt;

    await this._updateSessionStatus(sessionId, 'completed');
    await this._updateExecutionStatus(executionId, 'completed');

    // Persist the run to Hindsight so a future architect step can recall it.
    // Best-effort — the helper itself swallows failures, but defend against
    // a missing memory bridge so this stays a no-op when memory is disabled.
    // We persist the FULL plan structure (template, nodes, budget, file
    // changes if any, fan-out chunks if any) plus the actual files that
    // were modified/created, so a future architect call can recall both
    // what was decided and how the work decomposed.
    if (this.cfg.memoryBridge) {
      // Enrich each requirement's coveredBy with the actual files the
      // implementation touched. The linear path's only "chunk" is the
      // single implementation step, so before this enrichment every
      // requirement claimed `coveredBy: ['implement']` — useful as a
      // structural marker but uninformative for forensic recall. We keep
      // the structural marker and append a bounded list of real files so
      // future architect calls can answer "which files relate to this
      // goal?" without re-deriving the mapping.
      const allChangedFiles = [...filesModified, ...filesCreated];
      const requirementsForRetain = requirements.map((r) => ({
        ...r,
        coveredBy: allChangedFiles.length > 0
          ? Array.from(new Set([...(r.coveredBy ?? ['implement']), ...allChangedFiles.slice(0, 20)]))
          : (r.coveredBy ?? ['implement']),
      }));

      await this.cfg.memoryBridge.retainCodingRun({
        task: taskDescription,
        requirements: requirementsForRetain,
        verdicts: goalVerdicts,
        decision: reviewDecision,
        priorDecisionsCount: priorDecisions.length,
        sessionId: conversationId,
        plan: ((): {
          template?: string;
          approach: string;
          nodes?: Array<{ id: string; type: string; label: string }>;
          fanOut?: undefined;
          filesModified: string[];
          filesCreated: string[];
          budgetEstimateUsd?: number;
        } => {
          // Cast widens the type back: TS narrows `capturedPlanOutput` to
          // `null` after the closure-bound assignment in the plan step
          // (control-flow analysis doesn't follow callbacks), which would
          // make the truthy branch `never`. The cast restores the union.
          const po = capturedPlanOutput as CodingPlannerOutput | null;
          if (po) {
            return {
              template: po.template,
              approach: implementationPlan,
              nodes: po.nodes.map((n) => ({
                id: n.id,
                type: n.type,
                label: n.label,
              })),
              fanOut: undefined,
              filesModified,
              filesCreated,
              budgetEstimateUsd: po.budgetAllocation.estimated,
            };
          }
          return {
            approach: implementationPlan,
            filesModified,
            filesCreated,
          };
        })(),
      }).catch((err) => {
        log.warn('retainCodingRun failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    _emitters?.sessionCompleted({
      summary: `Coding session complete. Template: ${template}. Commit: ${commitHash.slice(0, 8) || 'none'}.`,
      filesModified: filesModified.length > 0 ? filesModified : undefined,
      filesCreated: filesCreated.length > 0 ? filesCreated : undefined,
      totalDurationMs,
    }, sessionId);

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
    sessionId: string,
    executionId: string,
    nodeId: string,
    label: string,
    type: string,
    progress: CodingProgressCallback | undefined,
    fn: () => Promise<string>,
    /**
     * Optional lambda that supplies a structured metadata object to attach
     * to the stepCompleted emit. Runs only on successful completion. Lets
     * a caller enrich the standard event with structured data (e.g. the
     * full plan, prior decisions, requirements) without emitting a second
     * stepCompleted event — which would risk double-counting in any
     * consumer that aggregates by event arrival rather than by nodeId.
     */
    metadataProvider?: () => Record<string, unknown>,
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
    _emitters?.stepStarted({ nodeId, label, type }, sessionId);
    log.info(`Step started: ${label}`, { nodeId });

    try {
      const output = await fn();

      await this.db.update(workflowSteps)
        .set({ status: 'completed', output, completedAt: now() })
        .where(eq(workflowSteps.id, stepId));

      progress?.onStepCompleted(nodeId, output.slice(0, 200));
      let extraMetadata: Record<string, unknown> | undefined;
      if (metadataProvider) {
        try {
          extraMetadata = metadataProvider();
        } catch (metaErr) {
          // The structured metadata is informational; never let a builder
          // bug fail the whole step. Log and continue with the unenriched
          // event so consumers still receive completion.
          log.warn('stepCompleted metadata provider threw, emitting without metadata', {
            nodeId,
            error: metaErr instanceof Error ? metaErr.message : String(metaErr),
          });
        }
      }
      _emitters?.stepCompleted({
        nodeId,
        status: 'success',
        outputSummary: output.slice(0, 200),
        ...(extraMetadata ? { metadata: extraMetadata } : {}),
      }, sessionId);
      log.info(`Step completed: ${label}`, { nodeId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      await this.db.update(workflowSteps)
        .set({ status: 'failed', error: msg, completedAt: now() })
        .where(eq(workflowSteps.id, stepId));

      progress?.onStepFailed(nodeId, msg);
      _emitters?.stepFailed({ nodeId, error: msg }, sessionId);
      log.error(`Step failed: ${label}`, { nodeId, error: msg });
      throw err;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * LLM-extract a concrete requirements list from the user's task. Used by
   * the linear orchestrator path (the DAG architect template embeds an
   * equivalent prompt inline).
   *
   * Failure semantics (the user explicitly asked for goal coverage to gate
   * planning):
   *   - No Anthropic client configured → emit a single synthetic requirement
   *     covering the task itself. This is the only acceptable degraded mode:
   *     the orchestrator is configured to run without an LLM extractor.
   *   - Anthropic client present but the LLM call, JSON parse, or shape
   *     validation fails → THROW. The plan step will surface this as a
   *     proper failure rather than silently approving with a synthetic
   *     requirement that always passes coverage.
   */
  private async _extractRequirements(
    task: string,
    priorDecisions: string[],
  ): Promise<Requirement[]> {
    if (!this.cfg.anthropic) {
      log.warn(
        'No Anthropic client configured — emitting a single synthetic requirement; ' +
        'goal verification will be degraded (non-blocking unknown verdicts)',
      );
      return [
        {
          id: 'req-task',
          description: task.length > 200 ? task.slice(0, 200) + '…' : task,
          acceptance: 'The user-described task is implemented and the build/tests pass.',
          coveredBy: ['implement'],
        },
      ];
    }

    const model = this.cfg.cheapModel ?? this.cfg.highPowerModel;
    const priorBlock = priorDecisions.length === 0
      ? '(no prior decisions recalled)'
      : priorDecisions
          .slice(0, 4)
          .map((d, i) => {
            const trimmed = d.length > 600 ? d.slice(0, 600) + '...' : d;
            return `Decision ${i + 1}:\n${trimmed}`;
          })
          .join('\n\n');

    const system =
      'You extract a list of independently-checkable requirements from a ' +
      "user's coding task. Each requirement must have: a stable id (e.g. " +
      '"req-1"), a one-sentence description of what must be done, and a ' +
      'concrete acceptance criterion (an observable signal a reviewer can ' +
      'use to decide it was satisfied). Respond with JSON only — no prose, ' +
      'no code fences. Aim for 1–6 requirements.';

    const user =
      `# User task\n${task}\n\n` +
      `# Prior architecture decisions (context only — do not invent goals from these)\n${priorBlock}\n\n` +
      `# Output schema\n` +
      `{ "requirements": [ { "id": "req-1", "description": "...", "acceptance": "..." } ] }`;

    let resp;
    try {
      resp = await this.cfg.anthropic.createMessage({
        model,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 2048,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Requirement extraction LLM call failed: ${msg}`);
    }

    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
      .trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Requirement extraction returned no parseable JSON');
    }

    let parsed: { requirements?: Array<Partial<Requirement>> };
    try {
      parsed = JSON.parse(jsonMatch[0]) as { requirements?: Array<Partial<Requirement>> };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Requirement extraction JSON parse failed: ${msg}`);
    }

    const raw = Array.isArray(parsed.requirements) ? parsed.requirements : [];
    const cleaned: Requirement[] = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      if (!r || typeof r.description !== 'string' || r.description.length === 0) continue;
      cleaned.push({
        id: typeof r.id === 'string' && r.id.length > 0 ? r.id : `req-${i + 1}`,
        description: r.description,
        acceptance: typeof r.acceptance === 'string' && r.acceptance.length > 0
          ? r.acceptance
          : 'Implementation matches the requirement description and the build/tests pass.',
        coveredBy: Array.isArray(r.coveredBy) ? r.coveredBy.map(String) : ['implement'],
      });
    }

    if (cleaned.length === 0) {
      throw new Error('Requirement extraction returned zero valid requirements');
    }

    log.info(`Extracted ${cleaned.length} requirement(s) from task`);
    return cleaned;
  }

  /**
   * Read bounded content snippets from a list of file paths so the
   * architect-reviewer's goal verifier can grade requirements against
   * actual code (not just filenames). Bounds are intentionally
   * conservative: at most 12 files, ~6KB each, totalling ~72KB worst-case
   * — well under any reasonable model context window when combined with
   * build/test logs. Files larger than the per-file cap are truncated and
   * marked `truncated: true`. Read failures (missing file, permission
   * denied, binary contents) are silently skipped — the verifier already
   * tolerates an empty snippets list.
   */
  private async _readFileSnippets(
    cwd: string,
    files: string[],
  ): Promise<Array<{ path: string; content: string; truncated: boolean }>> {
    if (files.length === 0) return [];
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const MAX_FILES = 12;
    const MAX_BYTES_PER_FILE = 6 * 1024;
    // Deduplicate (filesModified ∩ filesCreated can overlap if the
    // implementer reports the same path twice) and cap.
    const unique = Array.from(new Set(files)).slice(0, MAX_FILES);

    const out: Array<{ path: string; content: string; truncated: boolean }> = [];
    for (const rel of unique) {
      try {
        // Defence-in-depth against path traversal: refuse any path that
        // resolves outside cwd. This shouldn't happen in practice (the
        // implementer reports relative paths it actually wrote into cwd)
        // but the cost of the check is trivial and the failure mode of
        // skipping a malicious entry is benign.
        const abs = path.resolve(cwd, rel);
        const cwdResolved = path.resolve(cwd);
        if (!abs.startsWith(cwdResolved + path.sep) && abs !== cwdResolved) {
          continue;
        }
        const stat = await fs.stat(abs);
        if (!stat.isFile()) continue;
        const truncated = stat.size > MAX_BYTES_PER_FILE;
        if (truncated) {
          const handle = await fs.open(abs, 'r');
          try {
            const buf = Buffer.alloc(MAX_BYTES_PER_FILE);
            await handle.read(buf, 0, MAX_BYTES_PER_FILE, 0);
            out.push({ path: rel, content: buf.toString('utf8'), truncated: true });
          } finally {
            await handle.close();
          }
        } else {
          const content = await fs.readFile(abs, 'utf8');
          out.push({ path: rel, content, truncated: false });
        }
      } catch {
        // Missing/binary/permission-denied files are skipped — verifier
        // already handles a partial or empty snippets list.
      }
    }
    return out;
  }

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
