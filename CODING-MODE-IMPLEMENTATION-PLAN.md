# Coding Mode — Complete Implementation Plan

> **Author:** Lead Architect
> **Date:** 2026-04-05
> **Status:** Ready for implementation
> **Estimated LOC delta:** ~2,800 new / ~350 modified across 18 files

---

## Executive Summary

The Coding Mode engine is **~75-80% complete**. The core orchestration components (`CodingPlanner`, `CodingWorkerPool`, `FileLockManager`, `OutputAggregator`, `ValidationLoop`, `CodingBudget`, 5 DAG templates, Agent SDK bridge) are fully implemented at ~2,272 LOC.

What's missing are **integration hooks and user-facing surfaces**:
1. Wire `CodingPlanner` into the conversation flow (Gap 1 — CRITICAL)
2. Add repo management / git workspace setup (Gap 2 — CRITICAL)
3. Expose `'code'` mode in UI + gateway (Gap 3 — HIGH)
4. Add filesystem-based session persistence for coding sessions (Gap 4 — MEDIUM)
5. Frontend coding-mode status panel (Gap 5 — MEDIUM)

The plan is organized into **4 phases**, with Phases 1-2 on the critical path and Phases 3-4 parallelizable.

---

## Phase 1: Backend Wiring (CRITICAL PATH)

### 1.1 — Repo Manager

**Purpose:** Clone/sync git repos to a workspace directory before coding agents run. All DAG templates assume `cwd` points to a real checkout.

**New file:** `packages/core/src/orchestration/coding/repo-manager.ts`

```typescript
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('repo-manager');

export interface RepoSpec {
  /** Full git URL (https or ssh). Omit if working on local-only cwd. */
  url?: string;
  /** Branch to checkout. Default: 'main'. */
  branch?: string;
  /** If true, create a new branch off `branch` for the coding session. */
  createWorkingBranch?: boolean;
  /** Name of the working branch. Default: `orionomega/coding-<timestamp>`. */
  workingBranchName?: string;
}

export interface RepoWorkspace {
  /** Absolute path to the checked-out repo on disk. */
  cwd: string;
  /** Branch name currently checked out. */
  branch: string;
  /** Whether this was freshly cloned (vs. already existed). */
  freshClone: boolean;
  /** The remote URL, if any. */
  remoteUrl?: string;
}

/**
 * Manages git workspace lifecycle for coding sessions.
 *
 * Layout: `{baseDir}/{repo-name}-{branch}/`
 * Example: `orionomega/workspace/repo/my-app-main/`
 */
export class RepoManager {
  constructor(private readonly baseDir: string) {
    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
  }

  /**
   * Ensure a repo workspace exists and is up-to-date.
   * - If `spec.url` is provided and directory doesn't exist → `git clone`
   * - If directory exists → `git fetch && git checkout <branch> && git pull`
   * - If `spec.createWorkingBranch` → `git checkout -b <workingBranchName>`
   * - If no URL → validate cwd is a git repo, return as-is
   */
  async ensure(spec: RepoSpec, existingCwd?: string): Promise<RepoWorkspace> { ... }

  /**
   * Commit all staged + unstaged changes with a message.
   */
  async commitAll(cwd: string, message: string): Promise<string /* commitHash */> { ... }

  /**
   * Push the current branch to origin.
   */
  async push(cwd: string, branch: string, force?: boolean): Promise<void> { ... }

  /**
   * Create and checkout a new branch.
   */
  async createBranch(cwd: string, branchName: string): Promise<void> { ... }

  /**
   * Get current branch name.
   */
  async currentBranch(cwd: string): Promise<string> { ... }

  /**
   * Get the diff of all changes (staged + unstaged).
   */
  async diff(cwd: string): Promise<string> { ... }

  /**
   * Internal: run a git command and return stdout.
   */
  private git(cwd: string, args: string[]): Promise<string> { ... }
}
```

**Integration points:**
- Used by `CodingOrchestrator` (new, see 1.2) before building the DAG
- `baseDir` defaults to `{config.workspaceDir}/repo/`

**Priority:** CRITICAL — without this, coding mode only works on pre-existing local repos.

---

### 1.2 — Coding Orchestrator (Entry Point Bridge)

**Purpose:** A new class that bridges `OrchestrationBridge` to the coding-specific flow. This is the **single entry point** that wires together `RepoManager` → `CodingPlanner` → `GraphExecutor` with coding-specific lifecycle events.

**New file:** `packages/core/src/orchestration/coding/coding-orchestrator.ts`

```typescript
import { CodingPlanner, type CodingPlannerOptions } from './coding-planner.js';
import { RepoManager, type RepoSpec, type RepoWorkspace } from './repo-manager.js';
import { CodingWorkerPool } from './coding-worker-pool.js';
import { FileLockManager } from './file-lock-manager.js';
import { OutputAggregator } from './output-aggregator.js';
import { ValidationLoop } from './validation-loop.js';
import { GraphExecutor } from '../executor.js';
import { EventBus } from '../event-bus.js';
import type { WorkflowNode, WorkerEvent, ExecutionResult } from '../types.js';
import type { CodingModeConfig, CodingPlannerOutput, CodingSessionState } from './coding-types.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('coding-orchestrator');

export interface CodingOrchestratorConfig {
  workspaceDir: string;
  checkpointDir: string;
  codingModeConfig: CodingModeConfig;
  fallbackModel: string;
  workerTimeout: number;
  maxRetries: number;
}

export interface CodingSessionCallbacks {
  onProgress: (event: CodingProgressEvent) => void;
  onStepComplete: (step: CodingStepInfo) => void;
  onReviewResult: (result: ReviewResult) => void;
  onComplete: (result: CodingSessionResult) => void;
  onError: (error: Error) => void;
}

export interface CodingProgressEvent {
  sessionId: string;
  phase: 'repo-setup' | 'scanning' | 'designing' | 'implementing' | 'testing' | 'reviewing' | 'committing';
  progress: number;        // 0-100
  message: string;
  nodeId?: string;
  detail?: string;
}

export interface CodingStepInfo {
  nodeId: string;
  role: string;
  status: 'done' | 'error';
  durationMs: number;
  output?: string;
}

export interface ReviewResult {
  approved: boolean;
  feedback?: string;
  retaskNodes?: string[];
}

export interface CodingSessionResult {
  sessionId: string;
  success: boolean;
  commitHash?: string;
  branch?: string;
  diffSummary?: string;
  totalCostUsd: number;
  totalDurationMs: number;
  nodesExecuted: number;
  testsPassed?: boolean;
}

/**
 * Orchestrates a complete coding session:
 *
 * 1. Repo setup (clone/sync via RepoManager)
 * 2. Template selection + planning (CodingPlanner)
 * 3. DAG execution (GraphExecutor with CodingWorkerPool)
 * 4. Validation loop (build/test/lint)
 * 5. Architect review gate
 * 6. Auto-commit + push on approval
 *
 * Each phase emits progress events via callbacks for real-time UI updates.
 */
export class CodingOrchestrator {
  private readonly repoManager: RepoManager;
  private readonly eventBus: EventBus;
  private activeSessions = new Map<string, CodingSessionState>();

  constructor(
    private readonly config: CodingOrchestratorConfig,
    private readonly eventBusRef: EventBus,
  ) {
    this.repoManager = new RepoManager(`${config.workspaceDir}/repo`);
    this.eventBus = eventBusRef;
  }

  /**
   * Execute a complete coding session end-to-end.
   *
   * @param task - Natural language task description
   * @param repo - Optional repo specification (URL, branch)
   * @param callbacks - Progress and completion callbacks
   * @param abortSignal - Optional cancellation signal
   * @returns CodingSessionResult
   */
  async execute(
    task: string,
    repo: RepoSpec | undefined,
    callbacks: CodingSessionCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<CodingSessionResult> {
    const sessionId = `coding-${Date.now().toString(36)}`;
    const startTime = Date.now();

    try {
      // Phase 1: Repo setup
      callbacks.onProgress({ sessionId, phase: 'repo-setup', progress: 0, message: 'Setting up workspace…' });
      const workspace = await this.repoManager.ensure(repo ?? {}, this.config.workspaceDir);

      // Phase 2: Planning (template selection + budget + model assignment)
      callbacks.onProgress({ sessionId, phase: 'scanning', progress: 10, message: 'Planning coding approach…' });
      const planner = new CodingPlanner({
        codingModeConfig: this.config.codingModeConfig,
        fallbackModel: this.config.fallbackModel,
        cwd: workspace.cwd,
      });
      const template = planner.selectTemplate(task);
      const plan = planner.plan(task, template, /* stubProfile */ undefined as any);

      // Phase 3: Execute DAG
      callbacks.onProgress({ sessionId, phase: 'implementing', progress: 30, message: 'Executing coding workflow…' });
      const result = await this.executePlan(plan, workspace, callbacks, sessionId, abortSignal);

      // Phase 4: Auto-commit on success
      if (result.success && workspace.remoteUrl) {
        callbacks.onProgress({ sessionId, phase: 'committing', progress: 95, message: 'Committing changes…' });
        const commitHash = await this.repoManager.commitAll(workspace.cwd, `feat: ${task.slice(0, 72)}`);
        await this.repoManager.push(workspace.cwd, workspace.branch);
        result.commitHash = commitHash;
        result.branch = workspace.branch;
      }

      callbacks.onComplete(result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      callbacks.onError(error);
      throw error;
    }
  }

  private async executePlan(...): Promise<CodingSessionResult> { /* delegates to GraphExecutor */ }

  /** Get state of an active coding session. */
  getSession(sessionId: string): CodingSessionState | undefined { ... }

  /** Cancel an active coding session. */
  cancelSession(sessionId: string): void { ... }
}
```

**Key design decisions:**
- The `CodingOrchestrator` wraps the existing `GraphExecutor` — it does NOT replace it
- It adds the coding-specific lifecycle phases (repo setup, review gate, auto-commit) around the generic DAG execution
- Session state is tracked in-memory with checkpoint support

**Priority:** CRITICAL

---

### 1.3 — Wire into OrchestrationBridge

**Modified file:** `packages/core/src/agent/orchestration-bridge.ts`

**Changes:**

```diff
+ import { CodingOrchestrator, type CodingOrchestratorConfig } from '../orchestration/coding/coding-orchestrator.js';
+ import { isCodingModeRequest } from '../orchestration/coding/coding-planner.js';
+ import type { CodingModeConfig } from '../orchestration/coding/coding-types.js';

  export class OrchestrationBridge {
    private readonly planner: Planner;
+   private codingOrchestrator: CodingOrchestrator | null = null;
    readonly eventBus: EventBus;

    constructor(...) {
      ...
+     // Initialize coding orchestrator if config enables it
+     this.initCodingOrchestrator();
    }

+   private initCodingOrchestrator(): void {
+     const codingConfig = readCodingModeConfig(); // from config loader
+     if (!codingConfig.enabled) return;
+
+     this.codingOrchestrator = new CodingOrchestrator({
+       workspaceDir: this.config.workspaceDir,
+       checkpointDir: this.config.checkpointDir,
+       codingModeConfig: codingConfig,
+       fallbackModel: this.model,
+       workerTimeout: this.config.workerTimeout,
+       maxRetries: this.config.maxRetries,
+     }, this.eventBus);
+   }

+   /**
+    * Dispatch a coding mode workflow.
+    * Called when agentMode === 'code' or when isCodingModeRequest() matches.
+    */
+   async dispatchCodingWorkflow(
+     task: string,
+     pushHistory: (entry: { role: string; content: string }) => void,
+     repo?: RepoSpec,
+   ): Promise<void> {
+     if (!this.codingOrchestrator) {
+       this.callbacks.onText('Coding mode is not enabled in configuration.', false, true);
+       return;
+     }
+
+     this.emitStep('coding', 'Starting coding workflow', 'active');
+     this.callbacks.onThinking('Setting up coding workspace…', true, false);
+
+     try {
+       const result = await this.codingOrchestrator.execute(task, repo, {
+         onProgress: (event) => {
+           this.callbacks.onDAGProgress?.({
+             workflowId: event.sessionId,
+             nodeId: event.nodeId,
+             status: 'running',
+             progress: event.progress,
+             message: event.message,
+           } as any);
+           this.callbacks.onThinking(event.message, true, false);
+         },
+         onStepComplete: (step) => {
+           this.emitStep(step.nodeId, step.role, step.status === 'done' ? 'done' : 'active', step.output?.slice(0, 200));
+         },
+         onReviewResult: (result) => {
+           if (result.approved) {
+             this.callbacks.onText('✅ Architect review: APPROVED', false, true);
+           } else {
+             this.callbacks.onText(`🔄 Architect review: RETASK — ${result.feedback}`, false, true);
+           }
+         },
+         onComplete: (result) => {
+           this.emitStep('coding', 'Coding workflow complete', 'done');
+           this.callbacks.onThinking('', true, true);
+           const summary = this.formatCodingResult(result);
+           this.callbacks.onText(summary, false, true);
+           pushHistory({ role: 'assistant', content: summary });
+           this.callbacks.onDAGComplete?.({
+             workflowId: result.sessionId,
+             status: result.success ? 'complete' : 'error',
+             totalCostUsd: result.totalCostUsd,
+             totalDurationMs: result.totalDurationMs,
+             nodesExecuted: result.nodesExecuted,
+           } as any);
+         },
+         onError: (error) => {
+           this.emitStep('coding', 'Coding workflow failed', 'done', error.message);
+           this.callbacks.onThinking('', true, true);
+           this.callbacks.onText(`Coding workflow failed: ${error.message}`, false, true);
+         },
+       });
+     } catch (err) {
+       const msg = err instanceof Error ? err.message : String(err);
+       log.error('dispatchCodingWorkflow error', { error: msg });
+       this.callbacks.onThinking('', true, true);
+       this.callbacks.onText(`Coding mode failed: ${msg}`, false, true);
+     }
+   }

+   private formatCodingResult(result: CodingSessionResult): string {
+     const lines = [
+       result.success ? '✅ **Coding session complete**' : '❌ **Coding session failed**',
+       '',
+       `- **Duration:** ${(result.totalDurationMs / 1000).toFixed(1)}s`,
+       `- **Cost:** $${result.totalCostUsd.toFixed(4)}`,
+       `- **Nodes executed:** ${result.nodesExecuted}`,
+     ];
+     if (result.commitHash) {
+       lines.push(`- **Commit:** \`${result.commitHash.slice(0, 8)}\` on branch \`${result.branch}\``);
+     }
+     if (result.testsPassed !== undefined) {
+       lines.push(`- **Tests:** ${result.testsPassed ? '✅ passed' : '❌ failed'}`);
+     }
+     if (result.diffSummary) {
+       lines.push('', '```', result.diffSummary, '```');
+     }
+     return lines.join('\n');
+   }
  }
```

**Priority:** CRITICAL

---

### 1.4 — Wire into MainAgent Message Router

**Modified file:** `packages/core/src/agent/main-agent.ts`

**Changes to `handleMessage()`:**

```diff
  async handleMessage(
    content: string,
    replyContext?: ...,
    attachments?: ...,
-   agentMode?: 'orchestrate' | 'direct',
+   agentMode?: 'orchestrate' | 'direct' | 'code',
  ): Promise<void> {
    ...

    // 2. Direct mode — bypass all DAG dispatch
    if (agentMode === 'direct') {
      log.verbose('Route: CHAT (direct mode — DAG bypassed)');
      ...
      return;
    }

+   // 2b. Code mode — route to coding orchestrator
+   if (agentMode === 'code') {
+     log.verbose('Route: CODE (coding mode)');
+     this.emitStep('route', 'Routing request', 'done', 'Coding mode');
+     await this.orchestration.dispatchCodingWorkflow(
+       userContent,
+       (e) => this.pushHistory(e as HistoryEntry),
+     );
+     return;
+   }

    // 3. Skill-match shortcut
    ...

-   // 5. ORCHESTRATE fast-path
+   // 5. ORCHESTRATE fast-path — check for coding intent first
    if (isOrchestrateRequest(trimmed)) {
+     // Auto-detect coding mode requests in orchestrate mode
+     if (isCodingModeRequest(trimmed)) {
+       log.verbose('Route: CODE (auto-detected from orchestrate mode)');
+       this.emitStep('route', 'Routing request', 'done', 'Coding mode (auto-detected)');
+       await this.orchestration.dispatchCodingWorkflow(
+         userContent,
+         (e) => this.pushHistory(e as HistoryEntry),
+       );
+       return;
+     }
      log.verbose('Route: ORCHESTRATE fast-path');
      ...
    }

    // 6. Ambiguous — LLM classifier
    ...
    switch (intent) {
      case 'CHAT':
        ...
        break;
+     case 'CODE':
+       log.verbose('Route: CODE (LLM classified)');
+       await this.orchestration.dispatchCodingWorkflow(
+         userContent,
+         (e) => this.pushHistory(e as HistoryEntry),
+       );
+       break;
      case 'ORCHESTRATE':
      default:
        ...
    }
  }
```

**Additional imports needed:**
```diff
+ import { isCodingModeRequest } from '../orchestration/coding/coding-planner.js';
```

**Priority:** CRITICAL

---

### 1.5 — Update Intent Classifier

**Modified file:** `packages/core/src/agent/conversation.ts`

Add `'CODE'` as a third intent classification outcome:

```diff
- export type IntentClass = 'CHAT' | 'ORCHESTRATE';
+ export type IntentClass = 'CHAT' | 'ORCHESTRATE' | 'CODE';

  export async function classifyIntent(
    client: AnthropicClient,
    model: string,
    message: string,
    cheapModel?: string,
- ): Promise<'CHAT' | 'ORCHESTRATE'> {
+ ): Promise<IntentClass> {
    ...
    // Update the LLM prompt to include CODE as an option:
    // "CODE: The user wants to write/modify code in a repository.
    //  This includes implementing features, fixing bugs, refactoring,
    //  writing tests, or reviewing code."
    ...
  }
```

**Priority:** CRITICAL

---

### 1.6 — Export Updates

**Modified file:** `packages/core/src/orchestration/coding/index.ts`

```diff
+ export { RepoManager } from './repo-manager.js';
+ export type { RepoSpec, RepoWorkspace } from './repo-manager.js';
+ export { CodingOrchestrator } from './coding-orchestrator.js';
+ export type { CodingOrchestratorConfig, CodingSessionCallbacks, CodingProgressEvent, CodingSessionResult } from './coding-orchestrator.js';
```

**Priority:** CRITICAL

---

## Phase 2: Gateway + Frontend Mode (HIGH)

### 2.1 — Update AgentMode Type (Gateway)

**Modified file:** `packages/gateway/src/websocket.ts`

```diff
- const agentMode = (msg.agentMode === 'direct' || msg.agentMode === 'orchestrate') ? msg.agentMode : undefined;
+ const agentMode = (msg.agentMode === 'direct' || msg.agentMode === 'orchestrate' || msg.agentMode === 'code') ? msg.agentMode : undefined;
```

**Modified file:** `packages/gateway/src/sessions.ts`

Update `SessionState.agentMode` type:

```diff
- agentMode?: 'orchestrate' | 'direct';
+ agentMode?: 'orchestrate' | 'direct' | 'code';
```

**Priority:** HIGH

---

### 2.2 — Update Frontend Agent Mode Store

**Modified file:** `packages/web/src/stores/agent-mode.ts`

```diff
- export type AgentMode = 'orchestrate' | 'direct';
+ export type AgentMode = 'orchestrate' | 'direct' | 'code';

  export const useAgentModeStore = create<AgentModeStore>()(
    persist(
      (set) => ({
        mode: 'orchestrate',
        lastChangedAt: 0,
        setMode: (mode) => set({ mode, lastChangedAt: Date.now() }),
-       toggle: () =>
-         set((s) => ({
-           mode: s.mode === 'orchestrate' ? 'direct' : 'orchestrate',
-           lastChangedAt: Date.now(),
-         })),
+       toggle: () =>
+         set((s) => {
+           const order: AgentMode[] = ['direct', 'orchestrate', 'code'];
+           const idx = order.indexOf(s.mode);
+           return {
+             mode: order[(idx + 1) % order.length],
+             lastChangedAt: Date.now(),
+           };
+         }),
      }),
      ...
    ),
  );
```

**Priority:** HIGH

---

### 2.3 — Update AgentModeToggle Component

**Modified file:** `packages/web/src/components/chat/AgentModeToggle.tsx`

```diff
+ import { Code2 } from 'lucide-react';

  export function AgentModeToggle({ disabled }: AgentModeToggleProps) {
    ...
+   const isCode = mode === 'code';

    return (
      <div className="relative flex items-center">
        <div role="radiogroup" ...>
          {/* Direct mode button */}
          <button role="radio" aria-checked={isDirect} ... />

          {/* Orchestrate mode button */}
-         <button role="radio" aria-checked={!isDirect} ... />
+         <button role="radio" aria-checked={mode === 'orchestrate'} ... />

+         {/* Code mode button */}
+         <button
+           role="radio"
+           aria-checked={isCode}
+           aria-label="Code mode — multi-agent coding workflow"
+           onClick={() => handleSetMode('code')}
+           tabIndex={isCode ? 0 : -1}
+           title="Code: multi-agent coding workflow with repo management (Ctrl+M)"
+           className={`flex min-h-[32px] items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium
+             transition-all duration-150 ease-out
+             focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-1 focus:ring-offset-zinc-900
+             md:min-h-0
+             ${
+               isCode
+                 ? 'bg-emerald-600 text-white shadow-sm'
+                 : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
+             }`}
+         >
+           <Code2 size={13} aria-hidden="true" />
+           <span className="hidden md:inline">Code</span>
+         </button>
        </div>
        ...
      </div>
    );
  }
```

Update toast label logic:
```diff
- setToastLabel(newMode === 'direct' ? '⚡ Direct mode' : '◈ Orchestrate mode');
+ const labels: Record<AgentMode, string> = {
+   direct: '⚡ Direct mode',
+   orchestrate: '◈ Orchestrate mode',
+   code: '🖥️ Code mode',
+ };
+ setToastLabel(labels[newMode]);
```

**Priority:** HIGH

---

### 2.4 — WebSocket Coding Progress Events

**Modified file:** `packages/core/src/orchestration/types.ts`

```diff
  export interface WorkerEvent {
    ...
    fileLock?: { action: 'acquired' | 'released' | 'waiting'; files: string[]; holder: string };
+   codingPhase?: {
+     sessionId: string;
+     phase: 'repo-setup' | 'scanning' | 'designing' | 'implementing' | 'testing' | 'reviewing' | 'committing';
+     progress: number;
+     message: string;
+   };
  }
```

**Modified file:** `packages/gateway/src/websocket.ts`

Ensure `WorkerEvent` broadcasts already emit to subscribed clients (verify existing subscription mechanism handles the new `codingPhase` field — it should, since events are forwarded as-is):

```typescript
// Existing event relay in server.ts should already handle this:
// mainAgent.callbacks.onEvent → broadcast to subscribed WS clients
// No changes needed if generic event relay is already in place.
```

**Priority:** HIGH

---

## Phase 3: Coding Session Persistence (MEDIUM)

### 3.1 — Coding Session State Types

**Modified file:** `packages/core/src/orchestration/coding/coding-types.ts`

```diff
+ /** Persistent state for a coding session. */
+ export interface CodingSessionState {
+   sessionId: string;
+   task: string;
+   template: CodingDAGTemplate;
+   repoSpec?: RepoSpec;
+   workspace?: RepoWorkspace;
+   phase: 'repo-setup' | 'scanning' | 'designing' | 'implementing' | 'testing' | 'reviewing' | 'committing' | 'complete' | 'error';
+   progress: number;
+   startedAt: string;
+   updatedAt: string;
+   completedAt?: string;
+   nodeResults: Record<string, {
+     nodeId: string;
+     role: CodingRole;
+     status: 'pending' | 'running' | 'done' | 'error';
+     output?: string;
+     durationMs?: number;
+     costUsd?: number;
+   }>;
+   reviewHistory: Array<{
+     iteration: number;
+     approved: boolean;
+     feedback?: string;
+     timestamp: string;
+   }>;
+   totalCostUsd: number;
+   commitHash?: string;
+   branch?: string;
+   error?: string;
+ }
```

**Priority:** MEDIUM

---

### 3.2 — Filesystem Persistence for Coding Sessions

**New file:** `packages/core/src/orchestration/coding/coding-session-store.ts`

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CodingSessionState } from './coding-types.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('coding-session-store');

/**
 * Persists coding session state to disk as JSON files.
 *
 * Layout: `{baseDir}/coding-sessions/{sessionId}.json`
 *
 * Uses debounced writes (500ms) to avoid excessive I/O during
 * rapid progress updates. Critical state transitions (error, complete)
 * are written immediately.
 */
export class CodingSessionStore {
  private readonly dir: string;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'coding-sessions');
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /** Save session state (debounced unless `immediate` is true). */
  save(state: CodingSessionState, immediate?: boolean): void { ... }

  /** Load a session by ID. Returns null if not found. */
  load(sessionId: string): CodingSessionState | null { ... }

  /** List all persisted sessions, sorted by updatedAt descending. */
  listAll(): CodingSessionState[] { ... }

  /** List sessions that are incomplete (crashed mid-execution). */
  listIncomplete(): CodingSessionState[] { ... }

  /** Delete a session file. */
  delete(sessionId: string): void { ... }

  /** Flush all pending debounced writes immediately. */
  flush(): void { ... }
}
```

**Integration points:**
- `CodingOrchestrator` uses `CodingSessionStore` to persist state at each phase transition
- `OrchestrationBridge` exposes session listing for `/workflows` command
- Gateway REST API exposes session list/detail endpoints (see 3.3)

**Priority:** MEDIUM

---

### 3.3 — REST API for Coding Sessions

**New file:** `packages/gateway/src/routes/coding-sessions.ts`

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * REST endpoints for coding session management:
 *
 * GET  /api/coding-sessions           — List all coding sessions
 * GET  /api/coding-sessions/:id       — Get session detail
 * POST /api/coding-sessions/:id/cancel — Cancel an active session
 * GET  /api/coding-sessions/:id/diff  — Get current diff for a session
 */
export function codingSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  sessionStore: CodingSessionStore,
  codingOrchestrator: CodingOrchestrator,
): boolean { ... }
```

**Modified file:** `packages/gateway/src/server.ts`

```diff
+ import { codingSessionRoutes } from './routes/coding-sessions.js';

  // In route dispatch:
+ if (pathname.startsWith('/api/coding-sessions')) {
+   if (codingSessionRoutes(req, res, codingSessionStore, codingOrchestrator)) return;
+ }
```

**Priority:** MEDIUM

---

## Phase 4: Frontend Coding Mode UI (MEDIUM)

### 4.1 — Coding Session Status Panel

**New file:** `packages/web/src/components/coding/CodingSessionPane.tsx`

```typescript
/**
 * Shows the active coding session status:
 * - Current phase with progress bar
 * - DAG node status (scan → design → implement → test → review → commit)
 * - File lock visualization
 * - Budget tracking (cost spent vs allocated)
 * - Review history (iterations, feedback)
 * - Diff preview on completion
 *
 * Uses the existing WorkerEvent subscription from the WebSocket connection.
 */
export function CodingSessionPane({ sessionId }: { sessionId: string }) {
  // Subscribe to coding-specific WorkerEvents
  // Render pipeline phase indicator
  // Show active worker nodes with roles
  // Display review gate results
}
```

**Priority:** MEDIUM

---

### 4.2 — Coding Phase Pipeline Visualization

**New file:** `packages/web/src/components/coding/CodingPipeline.tsx`

```typescript
/**
 * Horizontal pipeline showing coding phases:
 * [Repo] → [Scan] → [Design] → [Implement] → [Test] → [Review] → [Commit]
 *
 * Each phase shows:
 * - ⬜ pending (gray)
 * - 🔵 active (blue, pulsing)
 * - ✅ done (green)
 * - ❌ error (red)
 */
export function CodingPipeline({ phase, progress }: {
  phase: CodingPhase;
  progress: number;
}) { ... }
```

**Priority:** MEDIUM

---

### 4.3 — Coding Diff Viewer

**New file:** `packages/web/src/components/coding/CodingDiffViewer.tsx`

```typescript
/**
 * Renders a git diff for a completed coding session.
 * Uses syntax-highlighted diff rendering with:
 * - File-level accordion
 * - Added/removed line counts
 * - Inline annotations from architect review
 */
export function CodingDiffViewer({ diff, annotations }: {
  diff: string;
  annotations?: Array<{ file: string; line: number; message: string }>;
}) { ... }
```

**Priority:** MEDIUM (nice-to-have for initial release)

---

### 4.4 — Integrate into OrchestrationPane

**Modified file:** `packages/web/src/components/orchestration/OrchestrationPane.tsx`

```diff
+ import { CodingSessionPane } from '../coding/CodingSessionPane';

  export function OrchestrationPane() {
    ...
+   // Show CodingSessionPane when a coding workflow is active
+   if (activeCodingSession) {
+     return <CodingSessionPane sessionId={activeCodingSession.id} />;
+   }

    // Existing DAG visualization for orchestrate mode
    return <DAGVisualization ... />;
  }
```

**Priority:** MEDIUM

---

## Phase Summary & Dependency Graph

```
Phase 1 (CRITICAL — sequential):
  1.1 RepoManager ──────────┐
  1.2 CodingOrchestrator ◄──┤
  1.3 OrchestrationBridge ◄─┤
  1.4 MainAgent router ◄────┤
  1.5 Intent classifier ◄───┘
  1.6 Export updates

Phase 2 (HIGH — parallelizable with Phase 1.5-1.6):
  2.1 Gateway agentMode ─────┐ (can start after 1.4)
  2.2 Frontend store ─────────┤
  2.3 AgentModeToggle ◄───────┤
  2.4 WS coding events ───────┘

Phase 3 (MEDIUM — parallelizable with Phase 2):
  3.1 Session state types ───┐
  3.2 Session store ◄────────┤
  3.3 REST API ◄─────────────┘

Phase 4 (MEDIUM — starts after Phase 2 complete):
  4.1 CodingSessionPane ────┐
  4.2 CodingPipeline ───────┤ (all parallelizable)
  4.3 CodingDiffViewer ─────┤
  4.4 OrchestrationPane ◄───┘
```

---

## File Manifest

### New Files (10)

| # | File | Phase | LOC (est.) |
|---|------|-------|------------|
| 1 | `packages/core/src/orchestration/coding/repo-manager.ts` | 1.1 | ~250 |
| 2 | `packages/core/src/orchestration/coding/coding-orchestrator.ts` | 1.2 | ~450 |
| 3 | `packages/core/src/orchestration/coding/coding-session-store.ts` | 3.2 | ~150 |
| 4 | `packages/gateway/src/routes/coding-sessions.ts` | 3.3 | ~120 |
| 5 | `packages/web/src/components/coding/CodingSessionPane.tsx` | 4.1 | ~200 |
| 6 | `packages/web/src/components/coding/CodingPipeline.tsx` | 4.2 | ~120 |
| 7 | `packages/web/src/components/coding/CodingDiffViewer.tsx` | 4.3 | ~150 |
| **Total new** | | | **~1,440** |

### Modified Files (11)

| # | File | Phase | Changes |
|---|------|-------|---------|
| 1 | `packages/core/src/agent/orchestration-bridge.ts` | 1.3 | +~120 lines: `dispatchCodingWorkflow()`, `formatCodingResult()`, `initCodingOrchestrator()` |
| 2 | `packages/core/src/agent/main-agent.ts` | 1.4 | +~25 lines: `'code'` mode routing in `handleMessage()`, import |
| 3 | `packages/core/src/agent/conversation.ts` | 1.5 | +~15 lines: `'CODE'` intent classification |
| 4 | `packages/core/src/orchestration/coding/index.ts` | 1.6 | +~8 lines: new exports |
| 5 | `packages/core/src/orchestration/coding/coding-types.ts` | 3.1 | +~40 lines: `CodingSessionState` type |
| 6 | `packages/core/src/orchestration/types.ts` | 2.4 | +~8 lines: `codingPhase` on `WorkerEvent` |
| 7 | `packages/gateway/src/websocket.ts` | 2.1 | ~2 lines: accept `'code'` in agentMode |
| 8 | `packages/gateway/src/sessions.ts` | 2.1 | ~1 line: type update |
| 9 | `packages/gateway/src/server.ts` | 3.3 | +~5 lines: route registration |
| 10 | `packages/web/src/stores/agent-mode.ts` | 2.2 | +~10 lines: `'code'` mode, cycle toggle |
| 11 | `packages/web/src/components/chat/AgentModeToggle.tsx` | 2.3 | +~30 lines: third button |
| **Total modified** | | | **~264 lines** |

---

## Critical Path Execution Order

For the fastest path to a working feature:

1. **`repo-manager.ts`** (new) — implements git operations
2. **`coding-orchestrator.ts`** (new) — the entry point that ties everything together
3. **`orchestration-bridge.ts`** (modify) — `dispatchCodingWorkflow()` method
4. **`main-agent.ts`** (modify) — `'code'` route in `handleMessage()`
5. **`conversation.ts`** (modify) — `'CODE'` intent classification
6. **`agent-mode.ts`** (modify, frontend) — add `'code'` to type
7. **`AgentModeToggle.tsx`** (modify, frontend) — add third button
8. **`websocket.ts`** (modify, gateway) — accept `'code'` agentMode

**Steps 1-5 are strictly sequential** (each depends on the previous).
**Steps 6-8 can be done in parallel** with steps 4-5.

After these 8 steps, users can select Code mode in the UI, messages route through the coding planner, repos are cloned, DAGs execute with coding agents, and results are reported back. The remaining Phase 3-4 items add polish (persistence, status panels).

---

## Testing Strategy

### Unit Tests

| Test file | Tests |
|-----------|-------|
| `tests/unit/repo-manager.test.ts` | git clone, pull, branch, commit, push (mocked `execFile`) |
| `tests/unit/coding-orchestrator.test.ts` | Full lifecycle with mocked RepoManager + GraphExecutor |
| `tests/unit/coding-mode-routing.test.ts` | `handleMessage()` routes `agentMode='code'` correctly |
| `tests/unit/intent-classifier.test.ts` | `classifyIntent()` returns `'CODE'` for coding tasks |

### Integration Tests

| Test file | Tests |
|-----------|-------|
| `tests/integration/coding-session.test.ts` | End-to-end: clone → scan → design → implement → test → commit (with a test repo) |
| `tests/integration/coding-mode-ws.test.ts` | WebSocket client sends `agentMode: 'code'`, receives progress events |

---

## Configuration

The existing `CodingModeConfig` type is already defined. It needs to be surfaced in the main config file:

**Modified file:** `packages/core/src/config/types.ts`

```diff
  export interface OrionOmegaConfig {
    ...
+   codingMode?: CodingModeConfig;
  }
```

Default config (already defined in `coding-types.ts`):
```typescript
{
  enabled: true,
  maxParallelAgents: 4,
  templates: {
    'feature-implementation': true,
    'bug-fix': true,
    'refactor': true,
    'test-suite': true,
    'review-iterate': true,
  },
  models: {},  // uses defaults per role
  validation: { autoRun: true, commands: [] },
  budgetMultiplier: 1.0,
}
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| `RepoManager` git operations fail silently | All git commands wrapped with timeout + error classification; fallback to local cwd |
| Coding sessions outlive the process | Checkpoint serialization at every phase boundary; `CodingSessionStore.listIncomplete()` for recovery |
| File lock deadlocks in parallel agents | `FileLockManager` uses all-or-nothing acquisition (already implemented) |
| Budget overruns | `CodingBudget` enforces per-node max USD caps (already implemented); session-level `$25` hard cap |
| Regex-based intent classification is too broad | `isCodingModeRequest()` is only used for auto-detection in orchestrate mode; explicit `agentMode='code'` always takes priority |
