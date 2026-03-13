# Conversational DAG Architecture

## Design Document: Auto-DAG Generation with Conversational Flow

**Status:** Proposed
**Date:** 2026-03-12
**Scope:** Core agent loop, orchestration bridge, gateway, web frontend, TUI

---

## 1. Executive Summary

This document redesigns OrionOmega's interaction model from a **plan-then-approve** paradigm to a **conversational auto-DAG** paradigm. The key changes:

1. **Every actionable request generates a DAG** — simple tasks get a 1-node DAG, complex tasks get full multi-node DAGs. No separate "planning mode."
2. **DAGs execute immediately** within the conversational flow — progress streams inline as chat messages, not in a separate orchestration pane.
3. **The main agent stays free** — DAG execution is fully async; the agent can handle follow-up questions, status checks, or new requests while DAGs run.
4. **Plan approval becomes the exception**, not the rule — only destructive/expensive operations get a brief confirmation step.

---

## 2. Current Architecture (What Changes)

### Current Flow
```
User message
  → regex fast-paths (CONVERSATIONAL_FAST / TASK_FAST / IMMEDIATE_PATTERNS)
  → LLM classifier (CHAT vs TASK)
  → CHAT path: streamConversation() with tools (blocking)
  → TASK path: planOnly() → show PlanCard → await user approval → executePlan()
```

### Problems
1. **Binary routing** — messages are either "chat" or "task", with no middle ground for simple file reads, quick commands, etc.
2. **Plan approval friction** — every task requires approve/modify/reject, even trivial ones.
3. **Blocking execution** — the main agent loop awaits `executor.execute()` completion before processing new messages.
4. **Separate UI panes** — orchestration state lives in a side panel, disconnected from the conversation.

---

## 3. New Architecture

### 3.1 Three-Tier Classification

Replace the current binary CHAT/TASK classification with a three-tier system:

| Tier | Description | DAG Shape | Confirmation | Example |
|------|-------------|-----------|--------------|---------|
| **CHAT** | Pure conversation, opinions, factual Q&A | No DAG | None | "What is Docker?", "Thanks" |
| **ACTION** | Simple, single-step tasks | 1-node micro-DAG | None (auto-execute) | "Read config.yaml", "Run the tests", "What files are in src/" |
| **ORCHESTRATE** | Multi-step, coordinated work | Multi-node DAG | Only if destructive/expensive | "Research X and write a report", "Refactor the auth module" |

A fourth tier, **ORCHESTRATE_GUARDED**, applies when the ORCHESTRATE task involves destructive operations (deploy, delete, merge, publish) or estimated cost > configurable threshold (default $0.50). This is the only tier that pauses for confirmation.

### 3.2 Modified Agent Loop

```
User message
  │
  ├─ 0. Gate/checkpoint resolution (unchanged)
  ├─ 1. Slash commands (unchanged)
  │
  ├─ 2. CHAT fast-path (expanded — greetings, factual Q&A, opinions, ≤1 sentence questions)
  │     → streamConversation() as today
  │
  ├─ 3. ACTION fast-path (NEW — single-step commands)
  │     → buildMicroDAG(task) → dispatchAsync(dag) → conversational ack
  │     → agent loop returns immediately
  │
  ├─ 4. ORCHESTRATE fast-path (MODIFIED — replaces TASK_FAST + IMMEDIATE)
  │     → planner.plan(task) → dispatchAsync(dag) → conversational ack
  │     → agent loop returns immediately
  │
  └─ 5. LLM classifier (fallback for ambiguous)
        → classifyIntent() now returns CHAT | ACTION | ORCHESTRATE
        → routes to appropriate handler above
```

**Critical change:** Steps 3 and 4 call `dispatchAsync()` which fires-and-forgets the DAG execution. The main agent's `handleMessage()` returns immediately after dispatching, freeing the agent loop for new messages.

### 3.3 Micro-DAG Builder

For ACTION-tier requests, we skip the full Planner LLM call and build a trivial 1-node DAG programmatically:

```typescript
// New function in orchestration-bridge.ts
buildMicroDAG(task: string, toolHint?: string): PlannerOutput {
  const node: WorkflowNode = {
    id: `micro-${randomId()}`,
    type: 'AGENT',
    label: task.slice(0, 60),
    agent: {
      model: this.defaultModel,   // lightweight model for simple tasks
      task,
      tokenBudget: 50_000,        // small budget for fast execution
    },
    dependsOn: [],
    status: 'pending',
  };
  return {
    graph: buildGraph([node], task.slice(0, 80)),
    reasoning: 'Single-step task — executing directly.',
    estimatedCost: 0,
    estimatedTime: 10,
    summary: task.slice(0, 120),
  };
}
```

This eliminates the LLM planning call for simple tasks (~$0.01-0.03 savings and ~2-5s latency savings per request).

### 3.4 Async Dispatch & Agent Freedom

```typescript
// New method in orchestration-bridge.ts
async dispatchAsync(
  plan: PlannerOutput,
  pushHistory: (entry: HistoryEntry) => void,
): Promise<string> {  // returns workflowId
  const workflowId = plan.graph.id;

  // Send conversational acknowledgment BEFORE execution starts
  this.callbacks.onText(
    this.buildAckMessage(plan),
    false, true,
  );
  pushHistory({ role: 'assistant', content: `[Dispatched] ${plan.summary}` });

  // Fire-and-forget execution with progress streaming
  void this.executePlanAsync(plan, pushHistory).catch((err) => {
    this.callbacks.onText(`Workflow failed: ${err.message}`, false, true);
  });

  return workflowId;
}
```

The key difference from the current `executePlan()`: it does NOT `await executor.execute()`. The execution runs in the background while the main agent loop returns to process new messages.

### 3.5 Inline Progress Streaming

Instead of routing events exclusively to the OrchestrationPane, DAG progress appears inline in the chat as lightweight status messages:

```typescript
// New message type for inline DAG progress
interface InlineProgressMessage {
  type: 'dag_progress';
  workflowId: string;
  nodeId: string;
  nodeLabel: string;
  status: 'started' | 'progress' | 'done' | 'error';
  message?: string;
  progress?: number;  // 0-100
}
```

Progress messages are **throttled** (max 1 per node per 5 seconds) and **collapsed** in the chat UI — showing a compact progress indicator rather than full event dumps.

### 3.6 Conversational Result Delivery

When a DAG completes, the result is delivered as a normal assistant chat message:

```typescript
// Modified onExecutionComplete in orchestration-bridge.ts
private async onExecutionComplete(result: ExecutionResult, ...): Promise<void> {
  // ... existing logic to build summary ...

  // NEW: Deliver result conversationally
  // For simple (1-2 node) DAGs: just the output text
  // For complex DAGs: structured summary with findings/outputs
  if (result.workerCount <= 2 && result.status === 'complete') {
    // Simple result — just show the output
    const output = Object.values(result.nodeOutputs ?? {})[0] ?? result.taskSummary;
    this.callbacks.onText(output, false, true);
  } else {
    // Complex result — structured summary (existing format, slightly modified)
    this.callbacks.onText(this.buildResultSummary(result), false, true);
  }
}
```

---

## 4. Classification System Design

### 4.1 Fast-Path Patterns (No LLM Call)

```typescript
// Expanded patterns in conversation.ts

/** CHAT: Pure conversation, no action needed */
const CHAT_FAST = [
  /^(hi|hello|hey|yo|sup|howdy|greetings)\b/i,
  /^(thanks|thank\s*you|cheers|ta)\b/i,
  /^(good\s*(morning|afternoon|evening|night))\b/i,
  /^who\s+are\s+you/i,
  /^how\s+are\s+you/i,
  /^help\b/i,
  /^(ok|okay|sure|alright|got\s*it|understood)\b/i,
  // NEW: Short yes/no without pending plan
  /^(yes|no|yep|nope|yeah|nah)\s*[.!?]?\s*$/i,
  // NEW: Opinions and factual questions
  /^(what|who|when|where|why|how)\s+(is|are|was|were|do|does|did|would|should|could|can)\b/i,
  /^(explain|describe|define|tell\s+me\s+about)\b/i,
];

/** ACTION: Single-step executable tasks */
const ACTION_FAST = [
  // File operations
  /^(read|show|cat|view|open|display)\s+\S+/i,
  /^(list|ls|find)\s+(files?|dir|folders?)/i,
  // Shell commands
  /^(run|execute|exec)\s+/i,
  // Status queries
  /^(check|show|get|what('s| is| are))\s+(the\s+)?(status|state|health|logs?|version)/i,
  // Git operations (single-step)
  /^(git\s+\w+|commit|push|pull|checkout|branch)\b/i,
  // Quick lookups
  /^(how\s+many|count|size\s+of|disk\s+usage)/i,
];

/** ORCHESTRATE: Multi-step coordinated work */
const ORCHESTRATE_FAST = [
  // Existing TASK_FAST patterns
  /\b(research|investigate|analyze|compare)\b.*\b(and|then|also|plus)\b/i,
  /\bstep[- ]by[- ]step\b/i,
  /\bmulti[- ]?step\b/i,
  // NEW: Build/create/deploy patterns
  /\b(build|create|write|generate|implement|develop)\s+(a|an|the)\s+/i,
  /\b(refactor|rewrite|redesign|migrate|upgrade)\b/i,
  /\b(deploy|provision|set\s*up|configure|install)\b.*\b(on|to|for|in)\b/i,
  // NEW: Research + output patterns
  /\b(research|find|gather)\b.*\b(write|create|save|output|report)\b/i,
];

/** ORCHESTRATE_GUARDED: Destructive or expensive operations */
const GUARDED_PATTERNS = [
  /\b(delete|remove|destroy|drop|purge|wipe)\b/i,
  /\b(deploy|publish|release|push\s+to\s+(prod|production|main|master))\b/i,
  /\b(merge|force[- ]push)\b/i,
  /\b(send\s+(email|message|notification))\b/i,
];
```

### 4.2 LLM Classifier (Updated)

```typescript
const CLASSIFY_PROMPT_V2 = `You are an intent classifier for an AI agent system.
Given a user message, classify it as one of:

- CHAT: Conversational, greetings, opinions, factual questions the assistant can answer directly from knowledge. No file access, no commands, no multi-step work needed.
  Examples: "what is Docker?", "explain the CAP theorem", "tell me a joke"

- ACTION: A single concrete task requiring one tool use — read a file, run a command, check status, write a small file. Can be done in one step by one worker.
  Examples: "read package.json", "run npm test", "what's in the logs directory", "show me the git status"

- ORCHESTRATE: Multi-step work requiring planning, research, coordination, or multiple file operations. Needs a workflow with potentially parallel workers.
  Examples: "research GraphQL vs REST and write a comparison", "refactor the auth module to use JWT", "set up CI/CD for this project"

Bias toward CHAT for questions that can be answered from knowledge.
Bias toward ACTION for requests involving a single file or command.
Only classify as ORCHESTRATE when the task genuinely needs multiple coordinated steps.

Respond with ONLY the word: CHAT, ACTION, or ORCHESTRATE.`;
```

### 4.3 Classification Flow

```
User message
  │
  ├─ matches CHAT_FAST?          → CHAT
  ├─ matches ACTION_FAST?        → ACTION
  ├─ matches ORCHESTRATE_FAST?
  │   ├─ matches GUARDED_PATTERNS? → ORCHESTRATE_GUARDED
  │   └─ else                      → ORCHESTRATE
  └─ none matched
      └─ LLM classifyIntent()     → CHAT | ACTION | ORCHESTRATE
          └─ if ORCHESTRATE + matches GUARDED → ORCHESTRATE_GUARDED
```

---

## 5. Message Types & Event Protocol

### 5.1 New ServerMessage Types

Add to `packages/gateway/src/types.ts`:

```typescript
export interface ServerMessage {
  // ... existing fields ...
  type: 'text' | 'thinking' | 'plan' | 'event' | 'status'
      | 'command_result' | 'session_status' | 'error' | 'ack' | 'history'
      // NEW types:
      | 'dag_dispatched'      // DAG was created and started
      | 'dag_progress'        // Inline progress update for a running DAG
      | 'dag_complete'        // DAG finished (success or error)
      | 'dag_confirm';        // DAG needs confirmation before executing (guarded)

  // NEW fields:
  dagDispatch?: {
    workflowId: string;
    workflowName: string;
    nodeCount: number;
    estimatedTime: number;
    estimatedCost: number;
    summary: string;
    nodes: Array<{ id: string; label: string; type: string }>;
  };
  dagProgress?: {
    workflowId: string;
    nodeId: string;
    nodeLabel: string;
    status: 'started' | 'progress' | 'done' | 'error';
    message?: string;
    progress?: number;
    layerProgress?: { completed: number; total: number };
  };
  dagComplete?: {
    workflowId: string;
    status: 'complete' | 'error' | 'stopped';
    summary: string;
    output?: string;           // Primary output text
    findings?: string[];
    outputPaths?: string[];
    durationSec: number;
    workerCount: number;
    totalCostUsd: number;
  };
  dagConfirm?: {
    workflowId: string;
    summary: string;
    reasoning: string;
    estimatedCost: number;
    estimatedTime: number;
    nodes: Array<{ id: string; label: string; type: string }>;
    guardedActions: string[];   // e.g. ["deploy to production", "delete database"]
  };
}
```

### 5.2 New ClientMessage Types

```typescript
export interface ClientMessage {
  // ... existing fields ...
  type: 'chat' | 'command' | 'plan_response' | 'subscribe'
      // NEW:
      | 'dag_response';       // Response to dag_confirm

  // NEW fields:
  dagAction?: 'approve' | 'reject' | 'modify';
  dagModification?: string;
}
```

### 5.3 MainAgentCallbacks Updates

```typescript
export interface MainAgentCallbacks {
  // EXISTING (unchanged):
  onText: (text: string, streaming: boolean, done: boolean) => void;
  onThinking: (text: string, streaming: boolean, done: boolean) => void;
  onEvent: (event: WorkerEvent) => void;
  onGraphState: (state: GraphState) => void;
  onCommandResult: (result: CommandResult) => void;
  onSessionStatus?: (status: SessionStatus) => void;
  onWorkflowStart?: (workflowId: string, workflowName: string) => void;
  onWorkflowEnd?: (workflowId: string) => void;

  // DEPRECATED (will be removed in Phase 3):
  onPlan: (plan: PlannerOutput) => void;

  // NEW:
  onDAGDispatched: (dispatch: DAGDispatchInfo) => void;
  onDAGProgress: (progress: DAGProgressInfo) => void;
  onDAGComplete: (result: DAGCompleteInfo) => void;
  onDAGConfirm: (confirm: DAGConfirmInfo) => void;
}
```

---

## 6. Frontend Changes

### 6.1 New Component: InlineDAGCard

A compact, collapsible card that appears inline in the chat stream:

```
┌─────────────────────────────────────────────────┐
│ ⚡ Building auth module refactor                 │
│ ████████░░░░░░░░░░ 45% · Layer 2/4 · 3 workers │
│ ├ ✅ Analyze existing code                       │
│ ├ ✅ Design new interfaces                       │
│ ├ 🔄 Implement JWT handler (running...)          │
│ └ ⏳ Write tests                                 │
│                              [Expand] [Stop]     │
└─────────────────────────────────────────────────┘
```

**File:** `packages/web/src/components/chat/InlineDAGCard.tsx` (NEW)

States:
- **Dispatched**: Shows summary + node list + estimated time
- **Running**: Animated progress bar + per-node status + layer progress
- **Complete**: Green border, summary output, expandable details
- **Error**: Red border, error message, retry option
- **Confirm**: Yellow border, shows guarded actions, Approve/Reject buttons

### 6.2 Modified Component: ChatPane

```diff
// packages/web/src/components/chat/ChatPane.tsx

+ import { InlineDAGCard } from './InlineDAGCard';

// In the message render loop:
  {messages.map((msg) => (
    <div key={msg.id}>
-     <MessageBubble message={msg} />
+     {msg.type === 'dag_dispatched' || msg.type === 'dag_progress' || msg.type === 'dag_complete' ? (
+       <InlineDAGCard
+         workflowId={msg.workflowId!}
+         onStop={() => sendCommand(`/stop ${msg.workflowId}`)}
+         onExpand={() => orchStore.selectWorkflow(msg.workflowId!)}
+       />
+     ) : msg.type === 'dag_confirm' ? (
+       <InlineDAGCard
+         workflowId={msg.workflowId!}
+         mode="confirm"
+         onApprove={() => respondToDAG(msg.workflowId!, 'approve')}
+         onReject={() => respondToDAG(msg.workflowId!, 'reject')}
+       />
+     ) : (
+       <MessageBubble message={msg} />
+     )}
    </div>
  ))}

- // Remove PlanCard rendering
- {activePlan && <PlanCard ... />}
```

### 6.3 Modified Store: chat.ts

```typescript
// packages/web/src/stores/chat.ts

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  type?: 'text' | 'plan' | 'orchestration-update' | 'command-result'
       // NEW types:
       | 'dag_dispatched'
       | 'dag_progress'
       | 'dag_complete'
       | 'dag_confirm';
  // NEW: workflow association
  workflowId?: string;
}
```

### 6.4 Modified Store: orchestration.ts

```typescript
// packages/web/src/stores/orchestration.ts

interface OrchestrationStore {
  // EXISTING:
  graphState: GraphState | null;
  events: WorkerEvent[];
  selectedWorker: string | null;

  // DEPRECATED (Phase 3 removal):
  activePlan: PlanData | null;

  // NEW: Track multiple running DAGs
  runningDAGs: Map<string, DAGState>;
  dagHistory: DAGCompleteInfo[];  // last 50 completed DAGs

  // NEW actions:
  addRunningDAG: (dag: DAGState) => void;
  updateDAGProgress: (workflowId: string, progress: DAGProgressInfo) => void;
  completeDAG: (workflowId: string, result: DAGCompleteInfo) => void;
  removeDAG: (workflowId: string) => void;
}

interface DAGState {
  workflowId: string;
  name: string;
  status: 'running' | 'complete' | 'error' | 'stopped' | 'confirming';
  nodes: Array<{ id: string; label: string; type: string; status: string }>;
  progress: number;  // 0-100
  layerProgress: { completed: number; total: number };
  startedAt: string;
  estimatedCost: number;
}
```

### 6.5 Modified: gateway.ts (WebSocket Client Hook)

```typescript
// packages/web/src/lib/gateway.ts — add handlers for new message types

ws.onmessage = (raw) => {
  const msg = JSON.parse(raw.data);

  switch (msg.type) {
    // ... existing cases ...

    case 'dag_dispatched':
      // Add inline card to chat
      chatStore.addMessage({
        id: msg.id,
        role: 'assistant',
        content: msg.dagDispatch.summary,
        timestamp: new Date().toISOString(),
        type: 'dag_dispatched',
        workflowId: msg.dagDispatch.workflowId,
      });
      // Track in orchestration store
      orchStore.addRunningDAG({
        workflowId: msg.dagDispatch.workflowId,
        name: msg.dagDispatch.workflowName,
        status: 'running',
        nodes: msg.dagDispatch.nodes.map(n => ({ ...n, status: 'pending' })),
        progress: 0,
        layerProgress: { completed: 0, total: msg.dagDispatch.nodes.length },
        startedAt: new Date().toISOString(),
        estimatedCost: msg.dagDispatch.estimatedCost,
      });
      break;

    case 'dag_progress':
      orchStore.updateDAGProgress(msg.dagProgress.workflowId, msg.dagProgress);
      break;

    case 'dag_complete':
      orchStore.completeDAG(msg.dagComplete.workflowId, msg.dagComplete);
      chatStore.addMessage({
        id: msg.id,
        role: 'assistant',
        content: msg.dagComplete.output || msg.dagComplete.summary,
        timestamp: new Date().toISOString(),
        type: 'dag_complete',
        workflowId: msg.dagComplete.workflowId,
      });
      break;

    case 'dag_confirm':
      chatStore.addMessage({
        id: msg.id,
        role: 'assistant',
        content: msg.dagConfirm.summary,
        timestamp: new Date().toISOString(),
        type: 'dag_confirm',
        workflowId: msg.dagConfirm.workflowId,
      });
      break;
  }
};
```

### 6.6 OrchestrationPane Becomes Optional Detail View

The existing OrchestrationPane (DAG visualization, activity feed, worker detail) is preserved but demoted to an **expandable detail view** triggered from the InlineDAGCard's "Expand" button:

```diff
// packages/web/src/app/page.tsx

export default function Home() {
- const graphState = useOrchestrationStore((s) => s.graphState);
+ const expandedWorkflow = useOrchestrationStore((s) => s.expandedWorkflow);

  return (
    <div className="flex h-screen">
-     <div className={graphState ? 'w-1/2 min-w-[400px]' : 'w-full'}>
+     <div className={expandedWorkflow ? 'w-1/2 min-w-[400px]' : 'w-full'}>
        <ChatPane />
      </div>
-     {graphState && (
+     {expandedWorkflow && (
        <div className="w-1/2 border-l border-zinc-800">
          <OrchestrationPane />
        </div>
      )}
    </div>
  );
}
```

---

## 7. Backend Changes: File-by-File

### 7.1 `packages/core/src/agent/conversation.ts`

| Change | Description |
|--------|-------------|
| Replace `CONVERSATIONAL_FAST` | Expand to `CHAT_FAST` with factual Q&A patterns |
| Replace `TASK_FAST` | Split into `ACTION_FAST` and `ORCHESTRATE_FAST` |
| Add `GUARDED_PATTERNS` | New array for destructive operation detection |
| Replace `isImmediateExecution()` | Repurpose: now checks if user is confirming a guarded DAG |
| Add `isActionRequest()` | New function: checks `ACTION_FAST` patterns |
| Add `isOrchestrateRequest()` | New function: checks `ORCHESTRATE_FAST` patterns |
| Add `isGuardedRequest()` | New function: checks `GUARDED_PATTERNS` |
| Update `classifyIntent()` | Return `'CHAT' \| 'ACTION' \| 'ORCHESTRATE'` instead of `'CHAT' \| 'TASK'` |
| Update `CLASSIFY_PROMPT` | New 3-tier prompt (see Section 4.2) |

### 7.2 `packages/core/src/agent/main-agent.ts`

| Change | Description |
|--------|-------------|
| Update `MainAgentCallbacks` | Add `onDAGDispatched`, `onDAGProgress`, `onDAGComplete`, `onDAGConfirm` |
| Rewrite `handleMessage()` | New 3-tier routing (see Section 3.2) |
| Add `handleDAGResponse()` | New public method for dag_response messages (approve/reject guarded DAGs) |
| Remove `handlePlanResponse()` | Deprecated — replaced by `handleDAGResponse()` |
| Update routing priorities | New priority 3 (ACTION) and priority 4 (ORCHESTRATE) replace old priorities 3-5 |

**New `handleMessage()` implementation:**

```typescript
async handleMessage(content: string): Promise<void> {
  await this.initPromise;
  if (!content?.trim()) { /* unchanged */ }

  const trimmed = content.trim();
  this.pushHistory({ role: 'user', content: trimmed });

  try {
    // 0a. Human gate / DAG confirmation resolution
    if (this.orchestration.hasPendingConfirmations) {
      const confirmed = /^(allow|approve|yes|y|go|do\s*it|lgtm)$/i.test(trimmed);
      const rejected = /^(deny|reject|no|n|cancel|stop)$/i.test(trimmed);
      if (confirmed || rejected) {
        this.orchestration.resolveConfirmation(confirmed);
        return;
      }
    }

    // 0b. Checkpoint resume / discard (unchanged)
    // 1. Slash commands (unchanged)

    // 2. CHAT fast-path (expanded)
    if (isChatFast(trimmed)) {
      await this.respondConversationally(trimmed);
      return;
    }

    // 3. ACTION fast-path (NEW)
    if (isActionRequest(trimmed)) {
      await this.orchestration.dispatchMicroDAG(
        trimmed,
        (e) => this.pushHistory(e),
      );
      return;  // Returns immediately — DAG runs async
    }

    // 4. ORCHESTRATE fast-path (NEW)
    if (isOrchestrateRequest(trimmed)) {
      const guarded = isGuardedRequest(trimmed);
      await this.orchestration.dispatchFullDAG(
        trimmed,
        (e) => this.pushHistory(e),
        { requireConfirmation: guarded },
      );
      return;  // Returns immediately — DAG runs async
    }

    // 5. LLM classifier (updated)
    const intent = await classifyIntent(this.anthropic, this.config.model, trimmed);
    switch (intent) {
      case 'CHAT':
        await this.respondConversationally(trimmed);
        break;
      case 'ACTION':
        await this.orchestration.dispatchMicroDAG(trimmed, (e) => this.pushHistory(e));
        break;
      case 'ORCHESTRATE': {
        const guarded = isGuardedRequest(trimmed);
        await this.orchestration.dispatchFullDAG(
          trimmed, (e) => this.pushHistory(e),
          { requireConfirmation: guarded },
        );
        break;
      }
    }
  } catch (err) { /* unchanged */ }
}
```

### 7.3 `packages/core/src/agent/orchestration-bridge.ts`

| Change | Description |
|--------|-------------|
| Add `buildMicroDAG()` | New method: builds 1-node DAG programmatically |
| Add `dispatchMicroDAG()` | New public method: build + dispatch immediately |
| Add `dispatchFullDAG()` | New public method: plan + dispatch (or confirm if guarded) |
| Add `dispatchAsync()` | New private method: fire-and-forget execution |
| Modify `executePlan()` | Make non-blocking — `void executor.execute()` instead of `await` |
| Add `pendingConfirmations` | New Map for guarded DAGs awaiting user approval |
| Add `resolveConfirmation()` | New public method for approving/rejecting guarded DAGs |
| Modify `onExecutionComplete()` | Use `onDAGComplete` callback instead of raw `onText` |
| Add progress throttling | New logic to throttle `onDAGProgress` events (max 1/node/5s) |
| Deprecate `planOnly()` | Replaced by `dispatchFullDAG()` with `requireConfirmation: true` |
| Deprecate `planAndExecute()` | Replaced by `dispatchFullDAG()` |
| Deprecate `handlePlanResponse()` | Replaced by `resolveConfirmation()` |

**New methods:**

```typescript
async dispatchMicroDAG(
  task: string,
  pushHistory: (entry: HistoryEntry) => void,
): Promise<void> {
  const plan = this.buildMicroDAG(task);
  this.callbacks.onDAGDispatched({
    workflowId: plan.graph.id,
    workflowName: plan.graph.name,
    nodeCount: 1,
    estimatedTime: plan.estimatedTime,
    estimatedCost: plan.estimatedCost,
    summary: plan.summary,
    nodes: [{ id: plan.graph.entryNodes[0], label: task.slice(0, 60), type: 'AGENT' }],
  });
  pushHistory({ role: 'assistant', content: `[Dispatched] ${plan.summary}` });
  void this.executeBackground(plan, pushHistory);
}

async dispatchFullDAG(
  task: string,
  pushHistory: (entry: HistoryEntry) => void,
  opts: { requireConfirmation?: boolean } = {},
): Promise<void> {
  this.callbacks.onThinking('Planning workflow...', true, false);

  const memories = await this.memory.recallForPlanning(task);
  const plan = await this.planner.plan(task, {
    ...(memories.length ? { memories } : {}),
    ...(this.availableSkills.length ? { availableSkills: this.availableSkills } : {}),
  });
  this.callbacks.onThinking('', true, true);

  if (opts.requireConfirmation) {
    // Store for confirmation and notify client
    this.pendingConfirmations.set(plan.graph.id, { plan, task, pushHistory });
    this.callbacks.onDAGConfirm({
      workflowId: plan.graph.id,
      summary: plan.summary,
      reasoning: plan.reasoning,
      estimatedCost: plan.estimatedCost,
      estimatedTime: plan.estimatedTime,
      nodes: [...plan.graph.nodes.values()].map(n => ({
        id: n.id, label: n.label, type: n.type,
      })),
      guardedActions: this.extractGuardedActions(task),
    });
    pushHistory({ role: 'assistant', content: `[Awaiting confirmation] ${plan.summary}` });
  } else {
    // Dispatch immediately
    this.callbacks.onDAGDispatched({
      workflowId: plan.graph.id,
      workflowName: plan.graph.name,
      nodeCount: plan.graph.nodes.size,
      estimatedTime: plan.estimatedTime,
      estimatedCost: plan.estimatedCost,
      summary: plan.summary,
      nodes: [...plan.graph.nodes.values()].map(n => ({
        id: n.id, label: n.label, type: n.type,
      })),
    });
    pushHistory({ role: 'assistant', content: `[Dispatched] ${plan.summary}` });
    void this.executeBackground(plan, pushHistory);
  }
}

private async executeBackground(
  plan: PlannerOutput,
  pushHistory: (entry: HistoryEntry) => void,
): Promise<void> {
  // Setup executor (same as current executePlan, but non-blocking)
  const workflowId = plan.graph.id;
  // ... executor setup (same as current executePlan lines 315-374) ...

  try {
    const result = await executor.execute();
    await this.onExecutionComplete(result, workflowId, pushHistory);
  } catch (err) {
    this.callbacks.onDAGComplete({
      workflowId,
      status: 'error',
      summary: `Workflow failed: ${err.message}`,
      durationSec: 0,
      workerCount: 0,
      totalCostUsd: 0,
    });
  } finally {
    this.cleanupWorkflow(workflowId);
  }
}
```

### 7.4 `packages/gateway/src/types.ts`

| Change | Description |
|--------|-------------|
| Add `ServerMessage` types | `dag_dispatched`, `dag_progress`, `dag_complete`, `dag_confirm` |
| Add `ServerMessage` fields | `dagDispatch`, `dagProgress`, `dagComplete`, `dagConfirm` |
| Add `ClientMessage` type | `dag_response` |
| Add `ClientMessage` fields | `dagAction`, `dagModification` |

### 7.5 `packages/gateway/src/websocket.ts`

| Change | Description |
|--------|-------------|
| Add `dag_response` handler | Route to `MainAgent.handleDAGResponse()` |
| Add callback mappings | Map new callbacks to WebSocket message sends |

### 7.6 `packages/gateway/src/events.ts`

| Change | Description |
|--------|-------------|
| Add progress throttling | Per-node throttle (5s interval) for `dag_progress` events |
| Add `dag_progress` extraction | Convert `WorkerEvent` stream into throttled `dag_progress` messages |

### 7.7 Frontend Files Summary

| File | Change |
|------|--------|
| `web/src/app/page.tsx` | Switch from `graphState` to `expandedWorkflow` for pane toggle |
| `web/src/lib/gateway.ts` | Add handlers for 4 new message types |
| `web/src/stores/chat.ts` | Add `workflowId` field, new message types |
| `web/src/stores/orchestration.ts` | Add `runningDAGs` map, `dagHistory`, `expandedWorkflow` |
| `web/src/components/chat/InlineDAGCard.tsx` | **NEW**: Inline progress/confirm card |
| `web/src/components/chat/ChatPane.tsx` | Render InlineDAGCard for DAG messages |
| `web/src/components/chat/PlanCard.tsx` | Deprecate (Phase 3 removal) |
| `web/src/components/orchestration/OrchestrationPane.tsx` | Unchanged, now triggered by expand |

### 7.8 TUI Files

| File | Change |
|------|--------|
| `tui/src/index.ts` | Handle new message types, update approval flow |
| `tui/src/plan-overlay.ts` | Deprecate full plan overlay, add compact DAG status |
| `tui/src/workflow-tracker.ts` | Adapt to receive `dag_progress` events |

---

## 8. Data Flow Diagram

### 8.1 ACTION Request (e.g. "run npm test")

```
User: "run npm test"
  │
  ├─ MainAgent.handleMessage()
  │   ├─ isActionRequest() → true
  │   └─ orchestration.dispatchMicroDAG("run npm test")
  │       ├─ buildMicroDAG() → 1-node DAG
  │       ├─ callbacks.onDAGDispatched(...)
  │       │   └─ Gateway → WebSocket → Client
  │       │       └─ chat store: add dag_dispatched message
  │       │       └─ UI: InlineDAGCard (dispatched state)
  │       │
  │       └─ void executeBackground(plan)
  │           ├─ GraphExecutor.execute()
  │           │   ├─ WorkerProcess.run() → runs `npm test`
  │           │   ├─ eventBus.emit(progress events)
  │           │   │   └─ throttled → callbacks.onDAGProgress(...)
  │           │   │       └─ Gateway → Client → UI: InlineDAGCard updates
  │           │   └─ returns ExecutionResult
  │           │
  │           └─ onExecutionComplete()
  │               ├─ callbacks.onDAGComplete(...)
  │               │   └─ Gateway → Client → UI: InlineDAGCard (complete)
  │               └─ callbacks.onText(output) → chat message with test results
  │
  └─ handleMessage() returns immediately
      └─ Agent is free for next message
```

### 8.2 ORCHESTRATE_GUARDED Request (e.g. "deploy to production")

```
User: "deploy the app to production"
  │
  ├─ MainAgent.handleMessage()
  │   ├─ isOrchestrateRequest() → true
  │   ├─ isGuardedRequest() → true (matches "deploy" + "production")
  │   └─ orchestration.dispatchFullDAG(task, { requireConfirmation: true })
  │       ├─ planner.plan() → multi-node DAG
  │       ├─ stores in pendingConfirmations
  │       └─ callbacks.onDAGConfirm(...)
  │           └─ Gateway → Client → UI: InlineDAGCard (confirm state)
  │               └─ Shows: "Deploy to production — 4 workers, ~$0.12, ~2min"
  │               └─ Buttons: [Approve] [Reject]
  │
  └─ handleMessage() returns — agent is free
  │
  ╔══════════════════════════════════════════╗
  ║ User clicks [Approve] or types "yes"     ║
  ╚══════════════════════════════════════════╝
  │
  ├─ Gateway receives dag_response { action: 'approve' }
  ├─ MainAgent.handleDAGResponse() or handleMessage() resolves confirmation
  │   └─ orchestration.resolveConfirmation(true)
  │       ├─ removes from pendingConfirmations
  │       ├─ callbacks.onDAGDispatched(...)
  │       └─ void executeBackground(plan)
  │           └─ ... same as ACTION flow above ...
```

---

## 9. Configuration

### 9.1 New Config Options

Add to `config.yaml`:

```yaml
orchestration:
  # DEPRECATED: planFirst: true (removed — now auto-DAG always)

  # Cost threshold for guarded confirmation (USD)
  guardedCostThreshold: 0.50

  # Patterns that always require confirmation (in addition to built-in GUARDED_PATTERNS)
  customGuardedPatterns:
    - "rm -rf"
    - "DROP TABLE"

  # Whether to show inline progress for micro-DAGs (1-node)
  showMicroDAGProgress: false   # set true for verbose mode

  # Progress throttle interval (ms)
  progressThrottleMs: 5000

  # Model to use for micro-DAGs (lightweight, fast)
  microDAGModel: null   # null = use default model, or specify e.g. "claude-haiku-4-5-20251001"
```

---

## 10. Phased Implementation Plan

### Phase 1: Foundation (Week 1-2)

**Goal:** Three-tier classification + micro-DAG dispatch, agent stays free.

**Files to modify:**
1. `packages/core/src/agent/conversation.ts` — New classification patterns and 3-tier classifier
2. `packages/core/src/agent/main-agent.ts` — Rewrite `handleMessage()` with new routing
3. `packages/core/src/agent/orchestration-bridge.ts` — Add `buildMicroDAG()`, `dispatchMicroDAG()`, `dispatchAsync()`
4. `packages/core/src/orchestration/types.ts` — Add `DAGDispatchInfo`, `DAGProgressInfo`, `DAGCompleteInfo`, `DAGConfirmInfo` types

**Behavior change:**
- ACTION requests build 1-node DAGs and execute immediately
- ORCHESTRATE requests still use full planner but execute without approval
- Agent loop returns immediately after dispatch
- Results still delivered via existing `onText` callback (converted in Phase 2)

**Tests:**
- Unit tests for new classification patterns
- Integration test: send ACTION request → verify immediate dispatch
- Integration test: send ORCHESTRATE request → verify async execution
- Integration test: verify agent handles follow-up while DAG runs

### Phase 2: New Message Protocol (Week 2-3)

**Goal:** New event types flowing end-to-end, inline progress in frontend.

**Files to modify:**
1. `packages/gateway/src/types.ts` — New message types
2. `packages/gateway/src/websocket.ts` — New message handlers
3. `packages/gateway/src/events.ts` — Progress throttling
4. `packages/core/src/agent/main-agent.ts` — New callback signatures
5. `packages/core/src/agent/orchestration-bridge.ts` — Emit new event types
6. `packages/web/src/lib/gateway.ts` — Handle new message types
7. `packages/web/src/stores/chat.ts` — New message type fields
8. `packages/web/src/stores/orchestration.ts` — `runningDAGs` state

**Behavior change:**
- DAG lifecycle events flow as distinct message types
- Frontend receives structured DAG state updates
- Existing `onPlan` and `plan` message type still work (backward compat)

### Phase 3: Inline DAG UI (Week 3-4)

**Goal:** InlineDAGCard replaces PlanCard, orchestration pane becomes optional.

**Files to create:**
1. `packages/web/src/components/chat/InlineDAGCard.tsx` — NEW component

**Files to modify:**
1. `packages/web/src/components/chat/ChatPane.tsx` — Render InlineDAGCard
2. `packages/web/src/app/page.tsx` — Switch to `expandedWorkflow` toggle
3. `packages/web/src/stores/orchestration.ts` — Add `expandedWorkflow`

**Files to deprecate:**
1. `packages/web/src/components/chat/PlanCard.tsx` — Remove from ChatPane render

**Behavior change:**
- DAG progress appears inline in chat as compact cards
- Clicking "Expand" on a card opens the full OrchestrationPane
- PlanCard no longer renders (kept for backward compat but unused)

### Phase 4: Guarded Operations & Polish (Week 4-5)

**Goal:** Confirmation flow for destructive operations, TUI support, cleanup.

**Files to modify:**
1. `packages/core/src/agent/orchestration-bridge.ts` — `pendingConfirmations`, `resolveConfirmation()`
2. `packages/core/src/agent/conversation.ts` — `GUARDED_PATTERNS`, `isGuardedRequest()`
3. `packages/core/src/agent/main-agent.ts` — `handleDAGResponse()`
4. `packages/gateway/src/websocket.ts` — `dag_response` handler
5. `packages/tui/src/index.ts` — New DAG message handling
6. `packages/tui/src/plan-overlay.ts` — Compact DAG status display

**Behavior change:**
- Destructive operations pause for confirmation
- TUI displays inline DAG progress
- Full end-to-end conversational DAG flow

### Phase 5: Cleanup & Migration (Week 5-6)

**Goal:** Remove deprecated code paths, update docs.

**Files to remove/deprecate:**
1. Remove `planOnly()` from orchestration-bridge.ts
2. Remove `planAndExecute()` from orchestration-bridge.ts
3. Remove `handlePlanResponse()` from main-agent.ts and gateway
4. Remove `onPlan` from `MainAgentCallbacks`
5. Remove `plan_response` from `ClientMessage`
6. Remove `plan` from `ServerMessage`
7. Remove `PlanCard.tsx` component entirely
8. Remove `IMMEDIATE_PATTERNS` from conversation.ts
9. Update `config.yaml` schema to remove `planFirst`

---

## 11. Migration & Backward Compatibility

### During Phases 1-4:
- **Old `onPlan` callback** still fires alongside new `onDAGDispatched`/`onDAGConfirm` — both old PlanCard and new InlineDAGCard can render simultaneously
- **Old `plan_response` message type** still accepted — gateway routes to `handlePlanResponse()` which internally calls `resolveConfirmation()`
- **TUI clients** continue receiving batched events as before; new message types are added incrementally

### Phase 5 breaking changes:
- `plan_response` client message type removed
- `plan` server message type removed
- `onPlan` callback removed
- TUI clients must handle `dag_dispatched`/`dag_progress`/`dag_complete` types

---

## 12. Performance Considerations

1. **Micro-DAGs avoid planner LLM call** — saves ~$0.01-0.03 and 2-5 seconds per ACTION request
2. **Progress throttling** prevents event flooding — max 1 update per node per 5 seconds
3. **Async dispatch** means the WebSocket message loop is never blocked by executor.execute()
4. **Multiple concurrent DAGs** — the existing `activeWorkflows` Map already supports this; no architectural change needed
5. **Memory pressure** — `runningDAGs` frontend state is bounded (auto-cleanup on completion); `dagHistory` capped at 50 entries

---

## 13. Risk Analysis

| Risk | Mitigation |
|------|------------|
| Misclassification: ACTION treated as CHAT | LLM classifier fallback; user can prefix with "run:" or "do:" |
| Misclassification: ORCHESTRATE treated as ACTION | ACTION micro-DAG will still attempt the task; if it fails, suggest re-running as full workflow |
| Guarded detection misses destructive op | Conservative: any LLM-classified ORCHESTRATE request with unknown verbs gets a cost-based guard check |
| Race condition: user sends message while DAG is dispatching | `handleMessage()` is already serialized per session in the gateway; new messages queue behind current dispatch |
| Cost runaway with auto-execution | Existing budget limits (AutonomousConfig) apply; GUARDED threshold is configurable |
| Frontend state inconsistency with multiple DAGs | Each DAG has unique workflowId; InlineDAGCard is keyed by workflowId |

---

## 14. Summary of All Files Modified

### New Files
| File | Description |
|------|-------------|
| `packages/web/src/components/chat/InlineDAGCard.tsx` | Inline DAG progress/confirm card |

### Modified Files (by package)

**packages/core/**
| File | Changes |
|------|---------|
| `src/agent/conversation.ts` | 3-tier classification, new pattern arrays, updated LLM prompt |
| `src/agent/main-agent.ts` | New `handleMessage()` routing, new callbacks, `handleDAGResponse()` |
| `src/agent/orchestration-bridge.ts` | `buildMicroDAG()`, `dispatchMicroDAG()`, `dispatchFullDAG()`, `dispatchAsync()`, `pendingConfirmations`, `resolveConfirmation()` |
| `src/orchestration/types.ts` | New DAG info interfaces |

**packages/gateway/**
| File | Changes |
|------|---------|
| `src/types.ts` | New message types and fields |
| `src/websocket.ts` | New message handlers, callback mappings |
| `src/events.ts` | Progress throttling for DAG events |

**packages/web/**
| File | Changes |
|------|---------|
| `src/app/page.tsx` | `expandedWorkflow` toggle instead of `graphState` |
| `src/lib/gateway.ts` | Handle 4 new message types |
| `src/stores/chat.ts` | `workflowId` field, new message types |
| `src/stores/orchestration.ts` | `runningDAGs`, `dagHistory`, `expandedWorkflow`, new actions |
| `src/components/chat/ChatPane.tsx` | Render InlineDAGCard, remove PlanCard |

**packages/tui/**
| File | Changes |
|------|---------|
| `src/index.ts` | New DAG message handling |
| `src/plan-overlay.ts` | Compact DAG status display |
