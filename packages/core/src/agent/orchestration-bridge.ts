/**
 * @module agent/orchestration-bridge
 * Bridges the main agent to the orchestration engine (Planner → Executor).
 *
 * Handles plan generation, execution, worker event relay, and completion processing.
 * Supports concurrent workflows — multiple plans can be pending and multiple
 * executors can run simultaneously without interfering with one another.
 */

import { Planner } from '../orchestration/planner.js';
// Coding mode uses the standard Planner → Executor pipeline with a coding-specific task preamble.
import { GraphExecutor } from '../orchestration/executor.js';
import type { ExecutorConfig } from '../orchestration/executor.js';
import { prepareCodingDispatch, type SessionRepoSelection } from './coding-dispatch.js';
import { parseCodingRequest, RemoteResolutionError } from '../orchestration/coding/coding-orchestrator.js';
import { addWorktree, removeWorktree, mergeBranchInto, pushChanges } from '../orchestration/coding/repo-manager.js';
import type { StagedAttachment } from './attachment-staging.js';
import { renderStagedAttachmentsBlock } from './attachment-staging.js';
import { EventBus } from '../orchestration/event-bus.js';
import { OrchestratorCommands } from '../orchestration/commands.js';
import { CheckpointManager } from '../orchestration/checkpoint.js';
import { WorkflowState } from '../orchestration/state.js';
import type {
  PlannerOutput,
  WorkerEvent,
  ExecutionResult,
  WorkflowCheckpoint,
  DAGDispatchInfo,
  DAGCompleteInfo,
  DAGConfirmInfo,
} from '../orchestration/types.js';
import type { MemoryBridge } from './memory-bridge.js';
import type { MainAgentCallbacks, ThinkingStep, ThinkingStepStatus, MemoryEvent } from './main-agent.js';
import { createLogger } from '../logging/logger.js';
import { randomBytes } from 'node:crypto';
import { collectRunArtifacts } from '../memory/run-artifact-collector.js';

const log = createLogger('orchestration-bridge');

/** Configuration for the orchestration bridge. */
export interface OrchestrationConfig {
  workspaceDir: string;
  checkpointDir: string;
  workerTimeout: number;
  /** Per-CODING_AGENT-node wall-clock budget (seconds). Defaults to workerTimeout. */
  codingAgentTimeout?: number;
  maxRetries: number;
  /** Path to the source repo for coding mode (default working directory). */
  codingRepoDir?: string;
  /**
   * Default remote URL for code-mode runs when the user doesn't include
   * a `repo:<url>` hint. Plumbed from `coding.defaultRemote` in
   * `config.yaml`. Used by the resolver inside
   * {@link prepareCodingDispatch} after `codingRepoDir`.
   */
  codingDefaultRemote?: string;
  /** Dedicated directory for storing run artifacts. Defaults to ~/.orionomega/runs. */
  runsDir?: string;
}

/**
 * Per-dispatch override for the executor config. Code-mode dispatches
 * use this to pin every CODING_AGENT node's cwd to the per-run checkout
 * path even when the planner LLM forgets to include `cwd` on a node.
 *
 * Kept extremely narrow (only the fields code mode needs to override) so
 * future overrides are added intentionally rather than by accident.
 */
type ExecutorOverrides = Pick<ExecutorConfig, 'codingRepoDir' | 'stagedAttachments'> & {
  /**
   * Optional cleanup hook invoked AFTER `executor.execute()` returns
   * (regardless of success / failure) and BEFORE `cleanupWorkflow`.
   * Used by Task #196 to merge per-CODING_AGENT-node worktree branches
   * back into the session clone's base branch on success and to prune
   * the worktrees on either outcome. Errors thrown here are caught and
   * surfaced to the user but do not re-throw.
   */
  postExecute?: (success: boolean) => Promise<void>;
};

/** An active, running workflow. */
interface ActiveWorkflow {
  id: string;
  name: string;
  executor: GraphExecutor;
  /** Unsubscribes the event listener for this workflow. */
  eventUnsubscribe: () => void;
  /** Periodic state snapshot timer. */
  stateSnapshotTimer: ReturnType<typeof setInterval>;
  startedAt: string;
  task: string;
}

/** A plan that has been generated and is awaiting user approval. */
interface PendingPlan {
  id: string;
  plan: PlannerOutput;
  task: string;
  createdAt: string;
}

/** A human gate approval request waiting for user input. */
interface HumanGateRequest {
  gateId: string;
  workflowId: string;
  workflowName: string;
  action: string;
  description: string;
  resolve: (approved: boolean) => void;
  timestamp: string;
}

/**
 * Manages the lifecycle of workflow planning and execution.
 *
 * Owns: planner, executor map, pending plan map, event subscriptions.
 * Delegates: memory recall to MemoryBridge, UI updates to callbacks.
 */
export class OrchestrationBridge {
  private readonly planner: Planner;
  readonly eventBus: EventBus;
  readonly commands: OrchestratorCommands;

  /** Plans currently awaiting user approval, keyed by plan (graph) ID. */
  private readonly pendingPlans = new Map<string, PendingPlan>();

  /** Currently running executors, keyed by workflow ID. */
  private readonly activeWorkflows = new Map<string, ActiveWorkflow>();

  /** Human gate requests awaiting approval, keyed by gate ID. */
  private readonly pendingGates = new Map<string, HumanGateRequest>();

  /** Guarded DAG confirmations awaiting user approval, keyed by workflow ID. */
  private readonly pendingConfirmations = new Map<string, {
    plan: PlannerOutput;
    task: string;
    pushHistory: (entry: { role: string; content: string }) => void;
    /**
     * Per-dispatch executor overrides captured at confirmation time and
     * replayed verbatim on approval. Without this, code-mode dispatches
     * that hit `requireConfirmation` would lose their per-run
     * `codingRepoDir` override and fall back to the bridge's persistent
     * config — silently dropping the agent into the install tree.
     */
    executorOverrides?: ExecutorOverrides;
  }>();

  constructor(
    private readonly config: OrchestrationConfig,
    private readonly callbacks: MainAgentCallbacks,
    private readonly memory: MemoryBridge,
    private readonly availableSkills: string[],
    model: string,
  ) {
    this.planner = new Planner({ model });
    this.eventBus = new EventBus();
    this.commands = new OrchestratorCommands();
  }

  // ── Public getters ──────────────────────────────────────────────

  /** Whether there is at least one plan awaiting user approval. */
  get hasPendingPlans(): boolean { return this.pendingPlans.size > 0; }

  /**
   * ID of the most recently added pending plan, or null.
   * Used for single-plan approval flows (backward-compat).
   */
  get latestPendingPlanId(): string | null {
    if (this.pendingPlans.size === 0) return null;
    return [...this.pendingPlans.keys()].pop()!;
  }

  /** Whether any workflow is currently running. */
  get hasActiveWorkflow(): boolean { return this.activeWorkflows.size > 0; }

  /** Number of currently running workflows. */
  get workflowCount(): number { return this.activeWorkflows.size; }

  /** Check if a specific workflow is currently active. */
  isWorkflowActive(workflowId: string): boolean { return this.activeWorkflows.has(workflowId); }

  /** Whether there are any human gate requests awaiting approval. */
  get hasPendingGates(): boolean { return this.pendingGates.size > 0; }

  /** Whether there are any guarded DAG confirmations awaiting approval. */
  get hasPendingConfirmations(): boolean { return this.pendingConfirmations.size > 0; }

  // ── Thinking step helper ─────────────────────────────────────────

  private _stepTimers = new Map<string, number>();

  private emitStep(id: string, name: string, status: ThinkingStepStatus, detail?: string): void {
    const now = Date.now();
    if (status === 'active') {
      this._stepTimers.set(id, now);
    }
    const startedAt = this._stepTimers.get(id);
    const step: ThinkingStep = {
      id,
      name,
      status,
      startedAt,
      ...(status === 'done' ? { completedAt: now, elapsedMs: startedAt ? now - startedAt : undefined } : {}),
      ...(detail ? { detail } : {}),
    };
    if (status === 'done') {
      this._stepTimers.delete(id);
    }
    this.callbacks.onThinkingStep?.(step);
  }

  // ── Full DAG dispatch (ORCHESTRATE tier) ──────────────────────────

  /**
   * Generate a full planner DAG and dispatch it.
   * If `requireConfirmation` is set, pause for user approval before executing.
   */
  async dispatchFullDAG(
    task: string,
    pushHistory: (entry: { role: string; content: string }) => void,
    opts: {
      requireConfirmation?: boolean;
      executorOverrides?: ExecutorOverrides;
      /**
       * Pre-minted workflow ID. When provided, overrides the planner's
       * randomly-generated `plan.graph.id` so the executor's
       * `getRunDir()` (which is keyed off `graph.id`) and any pre-clone
       * folder share the same identifier. Code mode uses this so the
       * pre-clone path `<workspaceDir>/output/<runId>/<repoName>` and
       * the executor artifacts dir `<workspaceDir>/output/<runId>` live
       * under the same `runId`, giving operators one folder per run.
       */
      workflowId?: string;
      /**
       * Task #192: chat attachments already staged to disk by
       * `MainAgent.handleMessage`. Prepended to the planner task and
       * forwarded to the executor so every AGENT/CODING_AGENT/TOOL
       * worker is told the absolute paths.
       */
      stagedAttachments?: StagedAttachment[];
      /**
       * Hook invoked AFTER planning, BEFORE dispatch. Receives the
       * generated plan so callers can mutate node configs in-place
       * (e.g. Task #196 worktree allocation per CODING_AGENT node) and
       * optionally return a `postExecute` callback that runs after the
       * executor finishes (used to merge worktree branches back).
       */
      onPlanReady?: (plan: PlannerOutput) => Promise<{ postExecute?: (success: boolean) => Promise<void> } | void>;
    } = {},
  ): Promise<void> {
    // Prepend the staged-attachments block to the task so the planner's
    // preamble lists every file with its absolute path, MIME, and size.
    const stagedBlock = renderStagedAttachmentsBlock(opts.stagedAttachments ?? []);
    const taskWithAttachments = stagedBlock ? `${stagedBlock}\n\n${task}` : task;
    // Defense-in-depth: also forward the staged list via the executor
    // overrides so per-worker context injection works even when the
    // planner LLM elides the preamble in the worker tasks it emits.
    const mergedOverrides: ExecutorOverrides | undefined = (opts.executorOverrides || opts.stagedAttachments?.length)
      ? {
          ...(opts.executorOverrides ?? {}),
          ...(opts.stagedAttachments?.length ? { stagedAttachments: opts.stagedAttachments } : {}),
        }
      : undefined;
    return this.dispatchFullDAGInternal(taskWithAttachments, pushHistory, {
      ...(opts.requireConfirmation !== undefined ? { requireConfirmation: opts.requireConfirmation } : {}),
      ...(mergedOverrides ? { executorOverrides: mergedOverrides } : {}),
      ...(opts.workflowId ? { workflowId: opts.workflowId } : {}),
      ...(opts.onPlanReady ? { onPlanReady: opts.onPlanReady } : {}),
    });
  }

  private async dispatchFullDAGInternal(
    task: string,
    pushHistory: (entry: { role: string; content: string }) => void,
    opts: {
      requireConfirmation?: boolean;
      executorOverrides?: ExecutorOverrides;
      workflowId?: string;
      onPlanReady?: (plan: PlannerOutput) => Promise<{ postExecute?: (success: boolean) => Promise<void> } | void>;
    } = {},
  ): Promise<void> {
    this.emitStep('memory', 'Recalling memory', 'active');
    this.callbacks.onThinking('Planning…', true, false);

    try {
      const memories = await this.memory.recallForPlanning(task);
      this.emitStep('memory', 'Recalling memory', 'done', `${memories.length} source${memories.length !== 1 ? 's' : ''} found`);
      this.emitStep('planning', 'Generating plan', 'active');
      const preRecalledContext = memories.length ? memories.join('\n') : undefined;
      const plan = await this.planner.plan(task, {
        ...(memories.length ? { memories } : {}),
        ...(this.availableSkills.length ? { availableSkills: this.availableSkills } : {}),
      }, preRecalledContext);
      const nodeCount = plan.graph?.nodes ? (plan.graph.nodes instanceof Map ? plan.graph.nodes.size : Object.keys(plan.graph.nodes).length) : 0;
      this.emitStep('planning', 'Generating plan', 'done', `${nodeCount} node${nodeCount !== 1 ? 's' : ''} in DAG`);
      this.callbacks.onThinking('', true, true);

      // Override the planner's random graph.id with the caller's
      // pre-minted workflowId (used by code mode — see opts docs).
      // Safe because `Graph` is a plain mutable object literal and
      // nothing has consumed `plan.graph.id` yet at this point.
      if (opts.workflowId) {
        plan.graph.id = opts.workflowId;
      }

      // Task #196: give the caller a chance to mutate plan nodes
      // (e.g. allocate per-CODING_AGENT-node git worktrees and pin each
      // node's cwd). Any returned `postExecute` is folded into the
      // executor overrides so executePlan() can run it in finally.
      let postExecuteFromPlan: ((success: boolean) => Promise<void>) | undefined;
      if (opts.onPlanReady) {
        try {
          const hookResult = await opts.onPlanReady(plan);
          if (hookResult && hookResult.postExecute) postExecuteFromPlan = hookResult.postExecute;
        } catch (hookErr) {
          const hmsg = hookErr instanceof Error ? hookErr.message : String(hookErr);
          log.error('onPlanReady hook failed — aborting dispatch', { error: hmsg });
          this.callbacks.onText(`Failed to prepare workflow: ${hmsg}`, false, true);
          return;
        }
      }
      const effectiveOverrides: ExecutorOverrides | undefined = postExecuteFromPlan
        ? { ...(opts.executorOverrides ?? {}), postExecute: postExecuteFromPlan }
        : opts.executorOverrides;

      if (opts.requireConfirmation) {
        // Store for confirmation and emit confirm event. Carry the
        // per-dispatch executor overrides through the confirmation
        // round-trip so approval replays them verbatim — code mode
        // relies on this to keep `codingRepoDir` pinned to the per-run
        // checkout under guarded execution.
        this.pendingConfirmations.set(plan.graph.id, {
          plan,
          task,
          pushHistory,
          ...(effectiveOverrides ? { executorOverrides: effectiveOverrides } : {}),
        });

        const confirmInfo: DAGConfirmInfo = {
          workflowId: plan.graph.id,
          summary: plan.summary,
          reasoning: plan.reasoning,
          estimatedCost: plan.estimatedCost,
          estimatedTime: plan.estimatedTime,
          nodes: [...plan.graph.nodes.values()].map((n) => ({ id: n.id, label: n.label, type: n.type, dependsOn: n.dependsOn })),
          guardedActions: [],
        };
        this.callbacks.onDAGConfirm?.(confirmInfo);
        // Also send a text message for TUI/backward compat
        this.callbacks.onText(
          `This task involves potentially destructive operations. ${plan.summary}\nSay **yes** to approve or **no** to cancel.`,
          false, true,
        );
        pushHistory({ role: 'assistant', content: `[Awaiting confirmation] ${plan.summary}` });
        return;
      }

      await this.dispatchAsync(plan, pushHistory, effectiveOverrides);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('dispatchFullDAG error', { error: msg });
      this.callbacks.onThinking('', true, true);
      this.callbacks.onText(`Failed to plan: ${msg}`, false, true);
    }
  }

  // ── Coding mode dispatch ──────────────────────────────────────────

  /**
   * Dispatch a Coding Mode workflow.
   *
   * Code mode is a specialized orchestration that uses the standard
   * Planner → GraphExecutor → EventBus pipeline with a coding-specific
   * task preamble. This guarantees the DAG includes:
   *   1. Clone/sync the repo to workspace/repo/{reponame-branch}
   *   2. Analyze the codebase structure
   *   3. Implement changes using CODING_AGENT nodes
   *   4. Run tests and validation
   *   5. Commit and push to the remote repo
   *
   * All standard orchestration features work automatically:
   * - DAG visualizer with real-time node progress
   * - Worker event feed (tool calls, thinking, status)
   * - Pause/resume/stop controls
   * - Checkpoint recovery
   * - Memory recall per worker
   * - Cost and token tracking
   */
  async dispatchCodingWorkflow(
    task: string,
    pushHistory: (entry: { role: string; content: string }) => void,
    opts: { stagedAttachments?: StagedAttachment[]; sessionRepo?: SessionRepoSelection } = {},
  ): Promise<void> {
    // Per Task #172: every code-mode call is its own run.
    //   1. Resolve the remote URL up-front (fail fast on unresolvable).
    //   2. Clone into `<workspaceDir>/output/<runId>/<repoName>` BEFORE the
    //      planner sees the task, so the preamble can name the exact
    //      checkout path + HEAD commit.
    //   3. Pin every downstream CODING_AGENT node's cwd to that path via
    //      the executor override, defending against the planner LLM
    //      occasionally forgetting to set `node.codingAgent.cwd`.
    //   4. Drop the legacy `repoDir = codingRepoDir ?? workspaceDir` path
    //      that silently put the agent in the gateway's process cwd when
    //      no repo was configured — that produced "not a git repo" errors
    //      deep inside the DAG instead of a clear up-front message.
    const { repoUrl: repoHint, branch } = parseCodingRequest(task);

    // Visible per-turn sync notice for session-repo dispatches. Surfaces
    // the implicit `ensureSessionClone` step that prepareCodingDispatch
    // performs so the user sees the fetch+ff happen before planning.
    if (opts.sessionRepo) {
      this.callbacks.onText(
        `Sync repo: fetching ${opts.sessionRepo.remoteUrl} (${opts.sessionRepo.branch || 'default branch'}) → ${opts.sessionRepo.localPath}`,
        false, true,
      );
    }
    let prepared: Awaited<ReturnType<typeof prepareCodingDispatch>>;
    try {
      prepared = await prepareCodingDispatch({
        userTask: task,
        workspaceDir: this.config.workspaceDir,
        ...(branch ? { branch } : {}),
        // Task #196: when the Git tab has selected a repo for this
        // session, prefer the session-scoped persistent clone — skips the
        // per-run `git clone` AND the resolver, so the historical
        // "Could not resolve a git remote" failure mode disappears for
        // any session whose user has clicked a repo in the UI.
        ...(opts.sessionRepo ? { sessionRepo: opts.sessionRepo } : {}),
        remote: {
          ...(repoHint !== undefined ? { repoHint } : {}),
          ...(this.config.codingRepoDir !== undefined ? { sourceRepoDir: this.config.codingRepoDir } : {}),
          ...(this.config.codingDefaultRemote !== undefined ? { defaultRemote: this.config.codingDefaultRemote } : {}),
          cwdForFallback: process.cwd(),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Surface the verbatim resolver / clone error to the user so they
      // can pick the easiest remediation path. RemoteResolutionError's
      // message lists every config knob; clone errors carry the real
      // git output (auth, network, branch mismatch, etc.).
      log.error('dispatchCodingWorkflow setup failed', {
        error: msg,
        kind: err instanceof RemoteResolutionError ? 'remote-resolution' : 'clone-or-other',
      });
      // Task #196: when no session repo is selected AND the legacy
      // resolver chain failed, point the user at the Git tab — that's
      // the lowest-friction fix for the common case.
      const userMsg = err instanceof RemoteResolutionError && !opts.sessionRepo
        ? `Code mode setup failed: ${msg}\n\nTip: open the Git tab in the orchestration pane and select a repository for this session — the next code-mode message will use it automatically without any \`repo:<url>\` hint.`
        : `Code mode setup failed: ${msg}`;
      this.callbacks.onText(userMsg, false, true);
      pushHistory({ role: 'assistant', content: `[Code mode setup failed] ${msg}` });
      return;
    }

    log.info('Dispatching coding workflow via standard orchestration pipeline', {
      runId: prepared.runId,
      remoteUrl: prepared.remoteUrl,
      branch: prepared.branch,
      checkoutPath: prepared.checkoutPath,
      headCommit: prepared.headCommit,
      taskPreview: task.slice(0, 120),
    });

    // Surface the prepared run to the user so they can see the clone
    // landed where they expect (and which commit the agent forked from).
    const shortHead = prepared.headCommit ? prepared.headCommit.slice(0, 8) : 'unknown';
    this.callbacks.onText(
      `Code mode prepared: cloned ${prepared.remoteUrl} (${prepared.branch}) → ${prepared.checkoutPath} @ ${shortHead}`,
      false, true,
    );

    // Delegate to the standard DAG dispatch — full pipeline (Planner →
    // GraphExecutor → EventBus → DAG visualiser) — but:
    //   * pass the per-run checkout path as an executor override so every
    //     CODING_AGENT node inherits it as `cwd`.
    //   * pin the workflow id to our pre-minted runId so the executor's
    //     run-artifacts dir (`<workspaceDir>/output/<workflowId>`) is the
    //     SAME folder as the pre-clone parent dir
    //     (`<workspaceDir>/output/<runId>` containing the `<repoName>`
    //     checkout). One folder per run, single inspection point.
    // Task #196: per-CODING_AGENT-node worktree allocation. Only
    // engaged when ≥2 CODING_AGENT nodes exist in the plan AND the
    // dispatch is using a session repo (the per-run-clone legacy path
    // doesn't benefit — that clone already lives in `output/<runId>`).
    // Each parallel implementer gets its own worktree off the same
    // base commit, on a fresh `wt-<runId>-<nodeId>` branch. After
    // execution succeeds, branches are merged back to the base branch
    // sequentially in topological order. Worktrees are pruned on
    // either outcome.
    const baseClonePath = prepared.checkoutPath;
    const baseBranch = prepared.branch;
    const useWorktrees = !!opts.sessionRepo;
    const onPlanReady = useWorktrees
      ? async (plan: PlannerOutput) => {
          const codingNodes = [...plan.graph.nodes.values()].filter((n) => n.type === 'CODING_AGENT');
          if (codingNodes.length < 2) return; // single-agent — no benefit, skip
          // Strip any planner-emitted git push from CODING_AGENT task bodies
          // when worktrees will engage. Push happens centrally in
          // postExecute AFTER merge-back so the remote always reflects the
          // consolidated state. We only neutralize push (commit stays — we
          // need committed work on the wt-* branches to merge from).
          const stripPushFromTask = (task: string) =>
            task
              .replace(/^[ \t]*git[ \t]+push[^\n]*\n?/gim, '')
              .replace(/(`{1,3})git push[^`\n]*\1/gi, '');
          // Scope worktrees to TRUE PARALLEL IMPLEMENTERS only: nodes that
          // share an identical `dependsOn` set with at least one sibling.
          // This naturally excludes single-instance control-flow CODING_AGENT
          // nodes (sync/clone, validate, commit/push) which sit alone in
          // their layer and must run on the session branch so the final
          // push reflects the merged state.
          const groupKey = (n: { dependsOn?: string[] }) =>
            JSON.stringify([...(n.dependsOn ?? [])].sort());
          const groups = new Map<string, typeof codingNodes>();
          for (const n of codingNodes) {
            const k = groupKey(n);
            const arr = groups.get(k) ?? [];
            arr.push(n);
            groups.set(k, arr);
          }
          const parallelImplementers = codingNodes.filter((n) => (groups.get(groupKey(n))?.length ?? 0) >= 2);
          if (parallelImplementers.length < 2) return; // no parallel fan-out, skip
          // Strip push from EVERY coding-agent task body — push is centralised.
          for (const n of codingNodes) {
            if (n.codingAgent?.task) n.codingAgent.task = stripPushFromTask(n.codingAgent.task);
          }
          const allocations: { nodeId: string; worktreePath: string; branch: string }[] = [];
          const worktreesRoot = `${baseClonePath}/.worktrees`;
          for (const node of parallelImplementers) {
            const safeNodeId = node.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
            const wtBranch = `wt-${prepared.runId}-${safeNodeId}`;
            const wtPath = `${worktreesRoot}/${safeNodeId}`;
            try {
              await addWorktree(baseClonePath, wtPath, wtBranch, baseBranch);
            } catch (e) {
              const em = e instanceof Error ? e.message : String(e);
              log.warn('worktree allocation failed — falling back to shared clone', { nodeId: node.id, error: em });
              continue; // this node will use the base clone (codingRepoDir override)
            }
            // Pin the node's cwd. The executor's existing fallback chain
            // (`node.codingAgent?.cwd ?? config.codingRepoDir ?? …`)
            // means setting cwd here wins over the override.
            if (node.codingAgent) {
              node.codingAgent.cwd = wtPath;
            }
            allocations.push({ nodeId: node.id, worktreePath: wtPath, branch: wtBranch });
          }
          if (!allocations.length) return;
          log.info('Allocated per-node worktrees', { count: allocations.length, runId: prepared.runId });
          this.callbacks.onText(
            `Allocated ${allocations.length} parallel worktree${allocations.length === 1 ? '' : 's'} off ${baseBranch} for isolation.`,
            false, true,
          );
          return {
            postExecute: async (success: boolean) => {
              const mergeFailures: { branch: string; error: string }[] = [];
              if (success) {
                // Sequential merge keeps history clean and isolates conflicts.
                // mergeBranchInto throws on conflict; we collect failures and
                // surface them as a unified error after pruning so the
                // workflow result reflects partial-integration as a failure
                // rather than silently succeeding.
                for (const alloc of allocations) {
                  try {
                    await mergeBranchInto(
                      baseClonePath,
                      alloc.branch,
                      `Merge worktree ${alloc.nodeId} (${alloc.branch})`,
                    );
                  } catch (mErr) {
                    const em = mErr instanceof Error ? mErr.message : String(mErr);
                    log.error('Worktree merge failed', { branch: alloc.branch, error: em });
                    mergeFailures.push({ branch: alloc.branch, error: em });
                  }
                }
              }
              // Always prune the worktrees so the next dispatch starts clean.
              for (const alloc of allocations) {
                try {
                  await removeWorktree(baseClonePath, alloc.worktreePath);
                } catch (rmErr) {
                  log.warn('Failed to remove worktree', { path: alloc.worktreePath, error: rmErr instanceof Error ? rmErr.message : String(rmErr) });
                }
              }
              if (mergeFailures.length > 0) {
                const summary = mergeFailures
                  .map((f) => `  • ${f.branch}: ${f.error}`)
                  .join('\n');
                const msg =
                  `Coding workflow integration FAILED — ${mergeFailures.length} worktree branch(es) ` +
                  `did not merge cleanly into ${baseBranch}:\n${summary}\n\n` +
                  `The session clone (${baseClonePath}) is left in its current state for manual resolution. ` +
                  `Final push was not performed.`;
                this.callbacks.onText(msg, false, true);
                throw new Error(`Worktree merge-back failed for ${mergeFailures.length} branch(es)`);
              }
              // Centralised push: now that base branch contains the merged
              // work from every parallel implementer, push it once. This
              // replaces the planner-emitted push (which we stripped above)
              // and guarantees the remote reflects the consolidated state.
              if (success) {
                try {
                  await pushChanges(baseClonePath, { branch: baseBranch });
                  this.callbacks.onText(`Pushed ${baseBranch} to origin (consolidated from ${allocations.length} worktree(s)).`, false, true);
                } catch (pushErr) {
                  const em = pushErr instanceof Error ? pushErr.message : String(pushErr);
                  this.callbacks.onText(`Final push to origin/${baseBranch} failed: ${em}`, false, true);
                  throw new Error(`Final consolidated push failed: ${em}`);
                }
              }
            },
          };
        }
      : undefined;

    await this.dispatchFullDAG(prepared.codingTaskPreamble, pushHistory, {
      executorOverrides: { codingRepoDir: prepared.checkoutPath },
      workflowId: prepared.runId,
      ...(opts.stagedAttachments?.length ? { stagedAttachments: opts.stagedAttachments } : {}),
      ...(onPlanReady ? { onPlanReady } : {}),
    });
  }

  /**
   * @deprecated Replaced by `buildCodingTaskPreamble` in
   * `./coding-dispatch.ts`, which is invoked from
   * {@link dispatchCodingWorkflow} after the repo has been pre-cloned.
   * Kept exported as a private to avoid a noisy diff for any in-flight
   * callers; can be removed once nothing references it.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private buildCodingTask(userTask: string, repoDir: string): string {
    return `## CODING MODE — Structured Software Engineering Workflow

You are planning a **coding workflow**. The user wants code changes made to a repository.
You MUST structure the DAG to follow this coding workflow:

### Required Workflow Structure

1. **Clone / Sync Repo** (first node, no dependencies)
   - Use a CODING_AGENT node that clones or syncs the repository
   - Working directory: \`${repoDir}\`
   - If the repo is already local, verify it's clean and pull latest
   - Use \`git pull\` to sync, or \`git clone\` if needed

2. **Analyze Codebase** (depends on step 1)
   - Use a CODING_AGENT node to scan the project structure
   - Identify: language, framework, test framework, build system, entry points
   - Read key files (package.json, tsconfig.json, etc.) to understand the project
   - Produce a summary of the codebase architecture

3. **Implement Changes** (depends on step 2)
   - Use one or more CODING_AGENT nodes for the actual implementation
   - Parallelise independent implementation tasks where possible
   - Each CODING_AGENT gets the codebase analysis as upstream context
   - Working directory MUST be: \`${repoDir}\`
   - Use Read, Write, Edit, Bash, Glob, Grep tools

4. **Test & Validate** (depends on step 3)
   - Use a CODING_AGENT node to run the project's test suite and build
   - Run: build/compile, lint, type-check, unit tests
   - Report results clearly (pass/fail with details)
   - Working directory: \`${repoDir}\`

5. **Commit & Push** (depends on step 4, LAST node)
   - Use a CODING_AGENT node to stage, commit, and push changes
   - Commit message should describe what was implemented
   - Push to the remote repository
   - Working directory: \`${repoDir}\`
   - Use \`git add -A && git commit -m "..." && git push\`

### Critical Rules for Coding Mode
- ALL CODING_AGENT nodes MUST set \`cwd\` to \`${repoDir}\`
- Use CODING_AGENT (not AGENT) for all coding tasks — they get the full Claude Code toolset
- The workflow MUST start with repo sync and end with commit & push
- Prefer LOOP nodes for build-test-fix cycles if the implementation is complex
- Maximise parallelism for independent implementation sub-tasks

### User's Task
${userTask}`;
  }

  // ── Async dispatch (shared by micro and full DAGs) ────────────────

  /**
   * Dispatch a plan for background execution. Returns the workflow ID immediately.
   * The agent loop is freed — execution happens asynchronously.
   */
  private async dispatchAsync(
    plan: PlannerOutput,
    pushHistory: (entry: { role: string; content: string }) => void,
    executorOverrides?: ExecutorOverrides,
  ): Promise<string> {
    const workflowId = plan.graph.id;

    // Emit dispatch info
    const dispatchInfo: DAGDispatchInfo = {
      workflowId,
      workflowName: plan.graph.name,
      nodeCount: plan.graph.nodes.size,
      estimatedTime: plan.estimatedTime,
      estimatedCost: plan.estimatedCost,
      summary: plan.summary,
      nodes: [...plan.graph.nodes.values()].map((n) => ({ id: n.id, label: n.label, type: n.type, dependsOn: n.dependsOn })),
    };
    this.callbacks.onDAGDispatched?.(dispatchInfo);
    pushHistory({ role: 'assistant', content: `[Dispatched] ${plan.summary}` });

    // Fire-and-forget: execute in the background
    void this.executeBackground(plan, pushHistory, executorOverrides).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Background execution failed', { error: msg, workflowId });
      this.callbacks.onText(`Workflow failed: ${msg}`, false, true);
    });

    return workflowId;
  }

  /**
   * Execute a plan in the background via the GraphExecutor.
   * Identical to executePlan but designed to be called via fire-and-forget.
   */
  private async executeBackground(
    plan: PlannerOutput,
    pushHistory: (entry: { role: string; content: string }) => void,
    executorOverrides?: ExecutorOverrides,
  ): Promise<void> {
    await this.executePlan(plan, pushHistory, undefined, undefined, executorOverrides);
  }

  // ── Confirmation resolution ───────────────────────────────────────

  /**
   * Resolve a pending guarded DAG confirmation.
   * Called when the user says "yes"/"no" to a guarded operation.
   * If workflowId is provided, resolves that specific confirmation.
   * Otherwise resolves the most recent one.
   */
  resolveConfirmation(approved: boolean, workflowId?: string): void {
    const targetId = workflowId ?? [...this.pendingConfirmations.keys()].pop();
    if (!targetId) return;

    const pending = this.pendingConfirmations.get(targetId);
    if (!pending) return;

    this.pendingConfirmations.delete(targetId);

    if (approved) {
      this.callbacks.onText('Approved. Starting execution…', false, true);
      // Replay the captured executor overrides on approval — see the
      // pendingConfirmations comment for why this matters for code mode.
      void this.dispatchAsync(pending.plan, pending.pushHistory, pending.executorOverrides);
    } else {
      this.callbacks.onText('Cancelled.', false, true, targetId);
      pending.pushHistory({ role: 'assistant', content: '[Cancelled by user]' });
    }
  }

  // ── Plan generation ─────────────────────────────────────────────

  /**
   * Generate a plan and present it to the user (without executing).
   */
  async planOnly(
    task: string,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
    this.emitStep('memory', 'Recalling memory', 'active');
    this.callbacks.onThinking('Analysing your request and building an execution plan…', true, false);

    try {
      const memories = await this.memory.recallForPlanning(task);
      this.emitStep('memory', 'Recalling memory', 'done', `${memories.length} source${memories.length !== 1 ? 's' : ''} found`);
      this.emitStep('planning', 'Generating plan', 'active');
      const preRecalledContext = memories.length ? memories.join('\n') : undefined;
      const plan = await this.planner.plan(task, {
        ...(memories.length ? { memories } : {}),
        ...(this.availableSkills.length ? { availableSkills: this.availableSkills } : {}),
      }, preRecalledContext);

      const nodeCount = plan.graph?.nodes ? (plan.graph.nodes instanceof Map ? plan.graph.nodes.size : Object.keys(plan.graph.nodes).length) : 0;
      this.emitStep('planning', 'Generating plan', 'done', `${nodeCount} node${nodeCount !== 1 ? 's' : ''} in DAG`);

      this.pendingPlans.set(plan.graph.id, {
        id: plan.graph.id,
        plan,
        task,
        createdAt: new Date().toISOString(),
      });

      this.callbacks.onThinking('', true, true);
      this.callbacks.onPlan(plan);
      pushHistory({ role: 'assistant', content: `[Plan presented] ${plan.summary}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Planning error', { error: msg });
      this.callbacks.onThinking('', true, true);
      this.callbacks.onText(`Failed to generate a plan: ${msg}`, false, true);
    }
  }

  /**
   * Generate a plan and immediately execute it (no approval step).
   */
  async planAndExecute(
    task: string,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
    this.emitStep('memory', 'Recalling memory', 'active');
    this.callbacks.onThinking('Planning and executing immediately…', true, false);

    try {
      const memories = await this.memory.recallForPlanning(task);
      this.emitStep('memory', 'Recalling memory', 'done', `${memories.length} source${memories.length !== 1 ? 's' : ''} found`);
      this.emitStep('planning', 'Generating plan', 'active');
      const preRecalledContext = memories.length ? memories.join('\n') : undefined;
      const plan = await this.planner.plan(task, {
        ...(memories.length ? { memories } : {}),
        ...(this.availableSkills.length ? { availableSkills: this.availableSkills } : {}),
      }, preRecalledContext);
      const nodeCount = plan.graph?.nodes ? (plan.graph.nodes instanceof Map ? plan.graph.nodes.size : Object.keys(plan.graph.nodes).length) : 0;
      this.emitStep('planning', 'Generating plan', 'done', `${nodeCount} node${nodeCount !== 1 ? 's' : ''} in DAG`);
      this.callbacks.onThinking('', true, true);
      this.callbacks.onPlan(plan);
      pushHistory({ role: 'assistant', content: `[Plan auto-approved] ${plan.summary}` });
      await this.executePlan(plan, pushHistory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Plan-and-execute error', { error: msg });
      this.callbacks.onText(`Failed to plan or execute: ${msg}`, false, true);
    }
  }

  // ── Plan response handling ──────────────────────────────────────

  /**
   * Handle a plan response (approve, modify, reject) for a specific plan ID.
   */
  async handlePlanResponse(
    planId: string,
    action: string,
    pushHistory: (entry: { role: string; content: string }) => void,
    modification?: string,
  ): Promise<void> {
    const pending = this.pendingPlans.get(planId);
    if (!pending) {
      this.callbacks.onText(
        'That plan is no longer available. It may have expired or been superseded.',
        false, true,
      );
      return;
    }

    switch (action) {
      case 'approve':
        if (this.memory.banks && pending.task) {
          await this.memory.ensureProjectBank(pending.task);
        }
        await this.executePlan(pending.plan, pushHistory);
        break;

      case 'modify': {
        if (!modification) {
          // No modification text — treat as approve
          if (this.memory.banks && pending.task) {
            await this.memory.ensureProjectBank(pending.task);
          }
          await this.executePlan(pending.plan, pushHistory);
          break;
        }

        // Classify the modification: is it approval-with-context or a genuine change?
        const isApprovalWithContext = await this.classifyModification(modification, pending.task);

        if (isApprovalWithContext) {
          // User is approving with additional instructions — execute the plan as-is
          // and inject the additional context into the task description for workers
          log.verbose('Modification classified as approval-with-context', { modification });
          pending.task = `${pending.task}\n\nAdditional instructions: ${modification}`;
          if (this.memory.banks && pending.task) {
            await this.memory.ensureProjectBank(pending.task);
          }
          await this.executePlan(pending.plan, pushHistory);
        } else {
          // Genuine modification — re-plan with the changes
          log.verbose('Modification classified as change request', { modification });
          const modifiedTask = `${pending.task}\n\nModification: ${modification}`;
          this.pendingPlans.delete(planId);
          this.callbacks.onText('Re-planning with your modifications…', true, true);
          await this.planOnly(modifiedTask, pushHistory);
        }
        break;
      }

      case 'reject':
        this.pendingPlans.delete(planId);
        this.callbacks.onText('Plan rejected. What would you like instead?', false, true);
        break;

      default:
        this.callbacks.onText(
          `Unknown plan action: '${action}'. Use approve, modify, or reject.`,
          false, true,
        );
    }
  }

  // ── Execution ───────────────────────────────────────────────────

  /**
   * Classify whether a user's modification text is:
   * - Approval with additional context ("this is correct, just do X")
   * - A genuine change to the plan ("actually, remove step 3 and add Y")
   *
   * Uses fast heuristics first, falls back to LLM for ambiguous cases.
   */
  private async classifyModification(modification: string, _task: string): Promise<boolean> {
    const lower = modification.toLowerCase().trim();

    // Fast-path: clear approval signals
    const approvalSignals = [
      /\b(this is correct|that'?s? (correct|right|perfect|good|great))\b/i,
      /\b(looks? good|sounds? good|exactly|perfect|go ahead|do it|proceed|get .* (setup|started|going|done))\b/i,
      /\b(yes|yep|yeah|correct|approved?|lgtm)\b/i,
      /^(ok|okay)\b/i,
    ];
    const hasApprovalSignal = approvalSignals.some((re) => re.test(lower));

    // Fast-path: clear change signals
    const changeSignals = [
      /\b(instead|change|replace|remove|delete|swap|don'?t|shouldn'?t|actually no|wait)\b/i,
      /\b(add (a |another )?step|reorder|different)\b/i,
    ];
    const hasChangeSignal = changeSignals.some((re) => re.test(lower));

    // If only approval signals, it's approval-with-context
    if (hasApprovalSignal && !hasChangeSignal) return true;
    // If only change signals, it's a modification
    if (hasChangeSignal && !hasApprovalSignal) return false;

    // Ambiguous — default to approval-with-context
    // Rationale: rejecting a plan is more disruptive than executing with extra context.
    // If the user wanted to reject, they'd say "no", "reject", "cancel", etc.
    log.verbose('Modification classification ambiguous, defaulting to approval-with-context', {
      modification: lower.slice(0, 100),
      hasApprovalSignal,
      hasChangeSignal,
    });
    return true;
  }

  /**
   * Execute an approved plan via the GraphExecutor.
   * Registers the workflow in both the active map and the commands registry.
   */
  private async executePlan(
    plan: PlannerOutput,
    pushHistory: (entry: { role: string; content: string }) => void,
    startLayer?: number,
    restoredState?: WorkflowState,
    executorOverrides?: ExecutorOverrides,
  ): Promise<void> {
    const workflowId = plan.graph.id;
    const workflowName = plan.graph.name;

    this.pendingPlans.delete(workflowId);

    // Per-dispatch overrides win over the bridge's persistent config.
    // Currently only `codingRepoDir` is overridable — see
    // {@link ExecutorOverrides}. Code-mode dispatches set this to the
    // per-run checkout path so the executor's CODING_AGENT cwd fallback
    // chain (`node.codingAgent?.cwd ?? this.config.codingRepoDir ?? …`)
    // can never accidentally land in the install tree.
    const effectiveCodingRepoDir = executorOverrides?.codingRepoDir ?? this.config.codingRepoDir;

    const executorConfig: ExecutorConfig = {
      workspaceDir: this.config.workspaceDir,
      checkpointDir: this.config.checkpointDir,
      workerTimeout: this.config.workerTimeout,
      codingAgentTimeout: this.config.codingAgentTimeout,
      maxRetries: this.config.maxRetries,
      checkpointInterval: 1,
      codingRepoDir: effectiveCodingRepoDir,
      ...(executorOverrides?.stagedAttachments?.length
        ? { stagedAttachments: executorOverrides.stagedAttachments }
        : {}),
      humanGateCallback: async (action: string, description: string, signal: AbortSignal): Promise<boolean> => {
        const gateId = randomBytes(8).toString('hex');
        const timestamp = new Date().toISOString();
        return new Promise<boolean>((resolve) => {
          this.pendingGates.set(gateId, {
            gateId,
            workflowId,
            workflowName,
            action,
            description,
            resolve,
            timestamp,
          });
          // The policy aborts this signal whenever it stops waiting for the
          // human (timeout, SDK abort, callback error). Drop the pending
          // entry so stale prompts can't be resolved later via text-mode
          // "allow/deny" commands or a late websocket reply.
          const cleanup = (): void => {
            if (this.pendingGates.delete(gateId)) {
              resolve(false);
              // Notify clients so any rendered approval card can clear
              // itself instead of sitting stale on screen waiting for a
              // response the backend will never accept.
              this.callbacks.onGateResolved?.({
                gateId,
                workflowId,
                resolution: 'expired',
                timestamp: new Date().toISOString(),
              });
            }
          };
          if (signal.aborted) {
            cleanup();
            return;
          }
          signal.addEventListener('abort', cleanup, { once: true });
          // Structured event for clients that render approval prompts
          // (Web UI, future TUI). The plain-text fallback below keeps the
          // existing "reply allow/deny" command flow working for clients
          // that don't render the structured event.
          this.callbacks.onGateRequest?.({
            gateId,
            workflowId,
            workflowName,
            action,
            description,
            timestamp,
          });
          this.callbacks.onText(
            `⚠️ [${workflowName}] Approval needed: ${action} — ${description}\nGate ID: ${gateId}\nReply allow or deny`,
            false, true,
          );
        });
      },
      onMemoryIO: this.memory.onMemoryEvent
        ? (event) => this.memory.onMemoryEvent?.(event.op as MemoryEvent['op'], event.detail, event.bank, event.meta)
        : undefined,
    };

    const executor = new GraphExecutor(plan.graph, this.eventBus, executorConfig, restoredState);

    // Subscribe to '*' and filter to only this workflow's events
    const eventUnsub = this.eventBus.subscribe('*', (event) => {
      if (event.workflowId === workflowId) {
        this.handleWorkerEvent(event, workflowId);
      }
    });

    // Periodic state snapshot for this workflow
    const stateSnapshotTimer = setInterval(() => {
      const wf = this.activeWorkflows.get(workflowId);
      if (wf) this.callbacks.onGraphState(wf.executor.getState());
    }, 2_000);

    const workflow: ActiveWorkflow = {
      id: workflowId,
      name: workflowName,
      executor,
      eventUnsubscribe: eventUnsub,
      stateSnapshotTimer,
      startedAt: new Date().toISOString(),
      task: plan.summary,
    };

    this.activeWorkflows.set(workflowId, workflow);
    this.callbacks.onWorkflowStart?.(workflowId, workflowName);
    this.commands.addWorkflow(workflowId, executor, workflowName);

    if (this.memory.retention && this.memory.projectBank) {
      this.memory.retention.registerWorkflowBank(workflowId, this.memory.projectBank);
    }

    this.callbacks.onText('Workflow started. I\'ll keep you posted on progress.', false, true, workflowId);
    pushHistory({ role: 'assistant', content: '[Workflow execution started]' });

    let executeSucceeded = false;
    try {
      const result = await executor.execute(startLayer);
      executeSucceeded = result.status === 'complete';
      await this.onExecutionComplete(result, workflowId, pushHistory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Execution error', { error: msg });
      this.callbacks.onText(`Workflow failed: ${msg}`, false, true);
    } finally {
      // Task #196: per-CODING_AGENT-node worktree merge-back &
      // teardown. Fired once per dispatch, regardless of outcome. Errors
      // here surface verbatim but never re-throw, so a stuck worktree
      // can't block normal cleanup.
      if (executorOverrides?.postExecute) {
        try {
          await executorOverrides.postExecute(executeSucceeded);
        } catch (postErr) {
          const pmsg = postErr instanceof Error ? postErr.message : String(postErr);
          log.error('postExecute hook failed', { error: pmsg, workflowId });
          // Treat consolidation/merge/push failures as a TERMINAL workflow
          // failure: downgrade executeSucceeded so anything downstream that
          // checks the workflow outcome (status snapshots, schedules, the
          // user-facing chat result) sees a failure rather than a silent
          // success. The hook already emitted a detailed user-facing
          // explanation; we add the canonical "Workflow failed" line here.
          if (executeSucceeded) {
            executeSucceeded = false;
            this.callbacks.onText(`Workflow failed: ${pmsg}`, false, true);
          }
        }
      }
      this.cleanupWorkflow(workflowId);
    }
  }

  // ── Event handling ──────────────────────────────────────────────

  /** Per-node progress throttle timestamps for DAG progress events. */
  private readonly progressThrottleMap = new Map<string, number>();

  /** Relay a worker event to callbacks, also triggering a state snapshot and inline progress. */
  private handleWorkerEvent(event: WorkerEvent, workflowId: string): void {
    this.callbacks.onEvent(event);

    if (event.type === 'done' || event.type === 'error' || event.type === 'status') {
      const wf = this.activeWorkflows.get(workflowId);
      if (wf) this.callbacks.onGraphState(wf.executor.getState());
    }

    // Emit throttled inline DAG progress
    this.emitThrottledDAGProgress(event, workflowId);
  }

  /**
   * Emit throttled DAG progress events from worker events.
   * Max 1 update per node per 5 seconds to prevent flooding.
   * Terminal events (done/error) always pass through.
   */
  private emitThrottledDAGProgress(event: WorkerEvent, workflowId: string): void {
    if (!this.callbacks.onDAGProgress) return;

    const nodeId = event.nodeId;
    const throttleKey = `${workflowId}:${nodeId}`;
    const now = Date.now();
    const lastEmit = this.progressThrottleMap.get(throttleKey) ?? 0;

    const isTerminal = event.type === 'done' || event.type === 'error';
    if (!isTerminal && now - lastEmit < 5_000) return;

    this.progressThrottleMap.set(throttleKey, now);
    // Cleanup old entries
    if (isTerminal) this.progressThrottleMap.delete(throttleKey);

    const wf = this.activeWorkflows.get(workflowId);
    const state = wf?.executor.getState();
    const nodeState = state?.nodes?.[nodeId];

    let status: 'started' | 'progress' | 'done' | 'error' = 'progress';
    if (event.type === 'done') status = 'done';
    else if (event.type === 'error') status = 'error';
    else if (lastEmit === 0) status = 'started';

    this.callbacks.onDAGProgress({
      workflowId,
      nodeId,
      nodeLabel: nodeState?.label ?? nodeId,
      status,
      message: event.message ?? event.thinking?.slice(0, 100),
      progress: event.progress ?? nodeState?.progress,
      layerProgress: state ? {
        completed: state.completedLayers,
        total: state.totalLayers,
      } : undefined,
    });
  }

  // ── Completion ──────────────────────────────────────────────────

  /** Process workflow completion, emit summary text. */
  private async onExecutionComplete(
    result: ExecutionResult,
    workflowId: string,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
    const wf = this.activeWorkflows.get(workflowId);

    if (this.memory.retention && this.memory.projectBank) {
      this.memory.retention.retainWorkflowOutcome({
        bankId: this.memory.projectBank,
        workflowId: result.workflowId,
        taskSummary: result.taskSummary,
        workerCount: result.workerCount,
        durationSec: result.durationSec,
        outputPaths: result.outputPaths,
        nodeOutputPaths: result.nodeOutputPaths,
        decisions: result.decisions,
        findings: result.findings,
        errors: result.errors,
        infraChanges: result.infraChanges,
      }).catch(() => {});
    }

    // ── Collect and store all .md artifacts from the run to Hindsight ──
    // This ensures the memory system retains the full detail of every run,
    // not just the summary. When a user replies to a run or asks about past
    // work, the system can recall complete findings, analysis, and reports.
    if (this.memory.client && this.memory.projectBank) {
      const runDir = `${this.config.workspaceDir}/output/${result.workflowId}`;
      // Look up the originating gateway session via the retention engine's
      // workflow→session map so collected artifacts are tagged with
      // `session:<sessionId>` for provenance. Recall stays cross-session.
      const sessionIdForRun = this.memory.retention?.getWorkflowSession(result.workflowId);
      collectRunArtifacts(
        this.memory.client,
        this.memory.projectBank,
        result.workflowId,
        runDir,
        result.taskSummary,
        sessionIdForRun,
      ).then((collectionResult) => {
        if (collectionResult.itemsStored > 0) {
          log.info('Run artifacts stored to memory', {
            workflowId: result.workflowId,
            filesFound: collectionResult.filesFound,
            itemsStored: collectionResult.itemsStored,
            totalTokens: collectionResult.totalTokens,
            budgetExhausted: collectionResult.budgetExhausted,
          });
        }
      }).catch((err) => {
        log.warn('Failed to collect run artifacts', {
          workflowId: result.workflowId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const { status, findings, errors, taskSummary, decisions, nodeOutputPaths } = result;

    // ── Extract the final worker output (the actual analysis/report) ──
    const finalOutput = this.extractFinalOutput(result);

    // ── Structured text message ─────────────────────────────────────
    const parts: string[] = [];

    let header: string;
    if (status === 'complete') header = 'Workflow complete.';
    else if (status === 'error') header = 'Workflow finished with errors.';
    else header = 'Workflow stopped.';
    parts.push(header);

    parts.push('', `**Task:** ${taskSummary}`);

    if (errors.length > 0) {
      parts.push('', '**Errors:**');
      for (const e of errors.slice(0, 5)) parts.push(`  ${e.worker}: ${e.message}`);
    }

    if (findings.length > 0) {
      parts.push('', '**Key findings:**');
      for (const f of findings.slice(0, 8)) parts.push(`  - ${f}`);
    }

    if (decisions.length > 0) {
      parts.push('', '**Decisions:**');
      for (const d of decisions.slice(0, 5)) parts.push(`  - ${d}`);
    }

    if (finalOutput) {
      parts.push('', finalOutput);
    }

    const summary = parts.join('\n');
    this.callbacks.onText(summary, false, true, workflowId);
    pushHistory({ role: 'assistant', content: `[Workflow result] ${summary}` });

    const completeInfo: DAGCompleteInfo = {
      workflowId,
      status,
      summary: taskSummary,
      output: summary,
      findings: findings.length > 0 ? findings.slice(0, 8) : undefined,
      outputPaths: result.outputPaths.length > 0 ? result.outputPaths : undefined,
      nodeOutputPaths: nodeOutputPaths && Object.keys(nodeOutputPaths).length > 0 ? nodeOutputPaths : undefined,
      durationSec: result.durationSec,
      workerCount: result.workerCount,
      totalCostUsd: result.totalCostUsd ?? result.estimatedCost,
      modelUsage: result.modelUsage && result.modelUsage.length > 0 ? result.modelUsage : undefined,
      toolCallCount: result.toolCallCount,
    };
    this.callbacks.onDAGComplete?.(completeInfo);

    if (status === 'complete' || status === 'stopped' || status === 'error') {
      const mgr = new CheckpointManager(this.config.checkpointDir);
      mgr.remove(workflowId);
    }

    if (wf) this.callbacks.onGraphState(wf.executor.getState());
  }


  private extractFinalOutput(result: ExecutionResult): string | null {
    // Return the full final output verbatim. Workers may produce long
    // research/spec documents and the user must always see the complete
    // message — never a "(output truncated)" suffix. The chat UI is
    // responsible for handling long content via scrolling/markdown.
    const trim = (text: string): string => text.trim();

    if (result.nodeFinalResults && Object.keys(result.nodeFinalResults).length > 0) {
      const values = Object.values(result.nodeFinalResults);
      const last = values[values.length - 1];
      if (last && last.trim()) return trim(last);
    }

    if (result.nodeOutputs && Object.keys(result.nodeOutputs).length > 0) {
      const entries = Object.values(result.nodeOutputs);
      const last = entries[entries.length - 1];
      if (last && last.trim()) return trim(last);
    }

    return null;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Clean up resources for a single completed or stopped workflow.
   * Does not affect sibling workflows.
   */
  private cleanupWorkflow(workflowId: string): void {
    const wf = this.activeWorkflows.get(workflowId);
    if (!wf) return;
    wf.eventUnsubscribe();
    clearInterval(wf.stateSnapshotTimer);
    this.callbacks.onWorkflowEnd?.(workflowId);
    this.activeWorkflows.delete(workflowId);
    this.commands.removeWorkflow(workflowId);
    if (this.memory.retention) {
      this.memory.retention.unregisterWorkflowBank(workflowId);
      this.memory.retention.unregisterWorkflowSession(workflowId);
    }
  }

  /** Clear all pending plans (e.g. on /reset). */
  clearPendingPlans(): void {
    this.pendingPlans.clear();
  }

  /**
   * Stop a specific workflow by ID, or stop all if no ID given.
   */
  stop(workflowId?: string): void {
    if (workflowId) {
      this.activeWorkflows.get(workflowId)?.executor.stop();
    } else {
      for (const [, wf] of this.activeWorkflows) wf.executor.stop();
    }
  }

  /** Stop all running workflows. */
  stopAll(): void {
    for (const [, wf] of this.activeWorkflows) wf.executor.stop();
  }

  // ── Human gate API ──────────────────────────────────────────────

  /** Resolve a pending human gate by ID. */
  resolveGate(gateId: string, approved: boolean): void {
    const gate = this.pendingGates.get(gateId);
    if (!gate) return;
    this.pendingGates.delete(gateId);
    gate.resolve(approved);
    this.callbacks.onText(
      `${approved ? '✅' : '❌'} Gate ${gate.action} [${gate.workflowName}]: ${approved ? 'approved' : 'denied'}`,
      false, true,
    );
    // Broadcast resolution so any other connected clients (or replays) can
    // finalize the matching approval card instead of leaving it pending.
    this.callbacks.onGateResolved?.({
      gateId,
      workflowId: gate.workflowId,
      resolution: approved ? 'approved' : 'denied',
      timestamp: new Date().toISOString(),
    });
  }

  /** Return all pending gate requests as an array. */
  listPendingGates(): HumanGateRequest[] {
    return [...this.pendingGates.values()];
  }

  // ── Checkpoint resume API ───────────────────────────────────────

  /** Scan the checkpoint directory for incomplete workflows from previous sessions. */
  checkForInterruptedWorkflows(): WorkflowCheckpoint[] {
    const mgr = new CheckpointManager(this.config.checkpointDir);
    return mgr.findIncomplete();
  }

  async resumeFromCheckpoint(
    checkpoint: WorkflowCheckpoint,
    pushHistory: (entry: { role: string; content: string }) => void,
  ): Promise<void> {
    const graph = CheckpointManager.graphFromCheckpoint(checkpoint);
    for (const [, node] of graph.nodes) {
      if (node.status === 'running') {
        node.status = 'pending';
        node.startedAt = undefined;
      }
    }

    let restoredState: WorkflowState | undefined;
    try {
      restoredState = await WorkflowState.restore(checkpoint.workflowId, this.config.checkpointDir);
    } catch {
      log.warn(`Could not restore WorkflowState for '${checkpoint.workflowId}' — starting fresh`);
    }

    const plan: PlannerOutput = {
      graph,
      reasoning: `Resuming interrupted workflow from layer ${checkpoint.currentLayer}`,
      estimatedCost: 0,
      estimatedTime: 0,
      summary: checkpoint.task,
    };
    this.callbacks.onText(`Resuming: ${checkpoint.graph.name} (from layer ${checkpoint.currentLayer + 1})`, false, true);
    await this.executePlan(plan, pushHistory, checkpoint.currentLayer, restoredState);
  }

  /** Delete a checkpoint without resuming it. */
  discardInterruptedWorkflow(workflowId: string): void {
    const mgr = new CheckpointManager(this.config.checkpointDir);
    mgr.remove(workflowId);
  }
}
