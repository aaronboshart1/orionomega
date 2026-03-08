# Multi-Workflow Concurrency — Implementation Spec

## Overview
OrionOmega currently supports only a single active workflow. When a user starts a second workflow while one is running, it creates a race condition: the new executor overwrites the old reference, event subscriptions tangle, and the first-finishing workflow's cleanup kills the plumbing for the still-running one.

This spec details the changes needed for true concurrent multi-workflow execution.

---

## Phase 1: Core — OrchestrationBridge Refactor

### File: packages/core/src/orchestration/types.ts

Add `workflowId` to `WorkerEvent`:

```typescript
interface WorkerEvent {
  workflowId: string;      // ← NEW — identifies which workflow this event belongs to
  workerId: string;
  nodeId: string;
  // ... rest unchanged
}
```

### File: packages/core/src/orchestration/event-bus.ts

No structural changes needed — it already supports channel-based subscriptions. Each workflow will subscribe to its own `workflowId` channel rather than the global `'*'`.

### File: packages/core/src/orchestration/executor.ts

Add `workflowId` to all `emitOrchestrator` calls:

```typescript
private emitOrchestrator(type: WorkerEvent['type'], message: string, data?: unknown): void {
  this.eventBus.emit({
    workflowId: this.graph.id,   // ← NEW
    workerId: 'orchestrator',
    nodeId: 'orchestrator',
    timestamp: new Date().toISOString(),
    type,
    message,
    data,
  });
}
```

Also, all events emitted by `WorkerProcess` and inside executeNode should include `workflowId: this.graph.id`.

### File: packages/core/src/orchestration/worker.ts

The worker needs the workflowId passed in so it can tag events. Add it to the constructor config and include in all events emitted.

### File: packages/core/src/orchestration/commands.ts — MAJOR REFACTOR

Replace single executor with workflow registry:

```typescript
export class OrchestratorCommands {
  private workflows: Map<string, { executor: GraphExecutor; name: string; startedAt: string }>;

  constructor() {
    this.workflows = new Map();
  }

  addWorkflow(id: string, executor: GraphExecutor, name: string): void {
    this.workflows.set(id, { executor, name, startedAt: new Date().toISOString() });
  }

  removeWorkflow(id: string): void {
    this.workflows.delete(id);
  }

  /** Resolve a workflow from an optional hint (id prefix, fuzzy name, or nothing for single) */
  private resolveWorkflow(hint?: string): { id: string; executor: GraphExecutor; name: string } | null {
    if (!hint && this.workflows.size === 1) {
      const [id, entry] = [...this.workflows.entries()][0];
      return { id, ...entry };
    }
    if (!hint) return null; // ambiguous
    
    // Try ID prefix match
    for (const [id, entry] of this.workflows) {
      if (id.startsWith(hint) || id.slice(0, 8) === hint) return { id, ...entry };
    }
    
    // Fuzzy name match
    const lower = hint.toLowerCase();
    for (const [id, entry] of this.workflows) {
      if (entry.name.toLowerCase().includes(lower)) return { id, ...entry };
    }
    
    return null;
  }

  async handle(command: string): Promise<OrchestratorCommandResult> {
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    if (this.workflows.size === 0 && cmd !== '/workflows') {
      return { success: false, message: 'No active workflows.' };
    }

    switch (cmd) {
      case '/stop': return this.handleStop(arg);
      case '/status': return this.handleStatus(arg);
      case '/plan': return this.handlePlan(arg);
      case '/workers': return this.handleWorkers(arg);
      case '/pause': return this.handlePause(arg);
      case '/resume': return this.handleResume(arg);
      case '/workflows': return this.handleWorkflows();
      default: return { success: false, message: `Unknown: '${cmd}'. Available: /workflows, /status, /stop, /pause, /resume, /plan, /workers` };
    }
  }

  /** /workflows — list all active workflows */
  private handleWorkflows(): OrchestratorCommandResult {
    if (this.workflows.size === 0) {
      return { success: true, message: 'No active workflows.' };
    }
    const lines = ['Active Workflows:', ''];
    for (const [id, entry] of this.workflows) {
      const state = entry.executor.getState();
      const shortId = id.slice(0, 8);
      lines.push(`  [${shortId}] ${entry.name}`);
      lines.push(`    Status: ${state.status} | Layer ${state.completedLayers}/${state.totalLayers} | ${state.elapsed.toFixed(1)}s`);
    }
    return { success: true, message: lines.join('\n') };
  }

  /** /status [hint] — show all or one */
  private handleStatus(hint?: string): OrchestratorCommandResult {
    if (!hint && this.workflows.size > 1) {
      return this.handleWorkflows(); // show all
    }
    const wf = this.resolveWorkflow(hint);
    if (!wf) return { success: false, message: this.ambiguousMsg(hint) };

    const state = wf.executor.getState();
    // ... detailed single-workflow status as today
    const nodeStatuses = Object.values(state.nodes)
      .map(n => `  ${n.label} [${n.type}]: ${n.status}${n.progress != null ? ` (${n.progress}%)` : ''}`)
      .join('\n');

    return {
      success: true,
      message: [`Workflow: ${state.name} [${wf.id.slice(0,8)}]`, `Status: ${state.status}`, `Progress: ${state.completedLayers}/${state.totalLayers} layers`, `Elapsed: ${state.elapsed.toFixed(1)}s`, `Nodes:\n${nodeStatuses}`].join('\n'),
      data: state,
    };
  }

  /** /stop [hint|all] */
  private handleStop(hint?: string): OrchestratorCommandResult {
    if (hint?.toLowerCase() === 'all') {
      for (const [, entry] of this.workflows) entry.executor.stop();
      return { success: true, message: `Stop requested for all ${this.workflows.size} workflow(s).` };
    }
    if (!hint && this.workflows.size > 1) {
      return { success: false, message: 'Multiple workflows running. Use /stop <name> or /stop all.\n' + this.listWorkflowHints() };
    }
    const wf = this.resolveWorkflow(hint);
    if (!wf) return { success: false, message: this.ambiguousMsg(hint) };
    wf.executor.stop();
    return { success: true, message: `Stop requested for ${wf.name}.` };
  }

  /** /pause [hint] */
  private handlePause(hint?: string): OrchestratorCommandResult {
    if (!hint && this.workflows.size > 1) {
      return { success: false, message: 'Multiple workflows. Use /pause <name>.\n' + this.listWorkflowHints() };
    }
    const wf = this.resolveWorkflow(hint);
    if (!wf) return { success: false, message: this.ambiguousMsg(hint) };
    wf.executor.pause();
    return { success: true, message: `Pause requested for ${wf.name}.` };
  }

  /** /resume [hint] */
  private handleResume(hint?: string): OrchestratorCommandResult {
    if (!hint && this.workflows.size > 1) {
      return { success: false, message: 'Multiple workflows. Use /resume <name>.\n' + this.listWorkflowHints() };
    }
    const wf = this.resolveWorkflow(hint);
    if (!wf) return { success: false, message: this.ambiguousMsg(hint) };
    wf.executor.resume();
    return { success: true, message: 'Resumed.' };
  }

  private handlePlan(hint?: string): OrchestratorCommandResult {
    if (!hint && this.workflows.size > 1) {
      return { success: false, message: 'Multiple workflows. Use /plan <name>.\n' + this.listWorkflowHints() };
    }
    const wf = this.resolveWorkflow(hint);
    if (!wf) return { success: false, message: this.ambiguousMsg(hint) };
    const state = wf.executor.getState();
    const nodes = Object.values(state.nodes);
    return {
      success: true,
      message: [`Workflow: ${state.name}`, `Layers: ${state.totalLayers}`, `Nodes (${nodes.length}):`, ...nodes.map(n => `  ${n.id}: ${n.label} [${n.type}]${n.dependsOn.length ? ' ← [' + n.dependsOn.join(', ') + ']' : ''}`)].join('\n'),
    };
  }

  private handleWorkers(hint?: string): OrchestratorCommandResult {
    if (!hint && this.workflows.size > 1) {
      // Show workers across ALL workflows
      const lines: string[] = [];
      for (const [id, entry] of this.workflows) {
        const workers = entry.executor.getActiveWorkers();
        lines.push(`${entry.name} [${id.slice(0,8)}]:`);
        if (workers.size === 0) { lines.push('  No active workers.'); continue; }
        for (const [wid, worker] of workers) {
          const st = worker.getStatus();
          lines.push(`  ${wid}: ${st.status} (${st.progress}%)`);
        }
      }
      return { success: true, message: lines.join('\n') || 'No active workers.' };
    }
    const wf = this.resolveWorkflow(hint);
    if (!wf) return { success: false, message: this.ambiguousMsg(hint) };
    const workers = wf.executor.getActiveWorkers();
    if (workers.size === 0) return { success: true, message: 'No active workers.' };
    const lines = [...workers].map(([wid, w]) => `  ${wid}: ${w.getStatus().status} (${w.getStatus().progress}%)`);
    return { success: true, message: `Workers (${workers.size}):\n${lines.join('\n')}` };
  }

  private ambiguousMsg(hint?: string): string {
    if (!hint) return 'Multiple workflows running. Specify one:\n' + this.listWorkflowHints();
    return `No workflow matches ${hint}.\n` + this.listWorkflowHints();
  }

  private listWorkflowHints(): string {
    return [...this.workflows].map(([id, e]) => `  [${id.slice(0,8)}] ${e.name}`).join('\n');
  }
}
```

### File: packages/core/src/agent/orchestration-bridge.ts — MAJOR REFACTOR

Replace single `activeExecutor` + `pendingPlan` with maps:

```typescript
interface ActiveWorkflow {
  id: string;
  name: string;
  executor: GraphExecutor;
  eventUnsubscribe: () => void;
  stateSnapshotTimer: ReturnType<typeof setInterval>;
  startedAt: string;
  task: string;
}

interface PendingPlan {
  id: string;
  plan: PlannerOutput;
  task: string;
  createdAt: string;
}

class OrchestrationBridge {
  private activeWorkflows = new Map<string, ActiveWorkflow>();
  private pendingPlans = new Map<string, PendingPlan>();
  readonly commands: OrchestratorCommands;

  get hasPendingPlans(): boolean { return this.pendingPlans.size > 0; }
  get latestPendingPlanId(): string | null {
    if (this.pendingPlans.size === 0) return null;
    return [...this.pendingPlans.keys()].pop()!;
  }
  get workflowCount(): number { return this.activeWorkflows.size; }
  get hasActiveWorkflow(): boolean { return this.activeWorkflows.size > 0; }

  // executePlan now registers into the map:
  private async executePlan(plan, pushHistory): Promise<void> {
    const workflowId = plan.graph.id;
    const workflowName = plan.graph.name;

    // Remove from pending
    this.pendingPlans.delete(workflowId);

    const executor = new GraphExecutor(plan.graph, this.eventBus, executorConfig);

    const eventUnsub = this.eventBus.subscribe(workflowId, (event) => {
      this.handleWorkerEvent(event, workflowId);
    });
    // Also subscribe to '*' for orchestrator-level events FROM this workflow
    const wildcardUnsub = this.eventBus.subscribe('*', (event) => {
      if (event.workflowId === workflowId) {
        this.handleWorkerEvent(event, workflowId);
      }
    });

    const timer = setInterval(() => {
      const wf = this.activeWorkflows.get(workflowId);
      if (wf) this.callbacks.onGraphState(wf.executor.getState());
    }, 2000);

    const workflow: ActiveWorkflow = {
      id: workflowId, name: workflowName, executor, 
      eventUnsubscribe: () => { eventUnsub(); wildcardUnsub(); },
      stateSnapshotTimer: timer, startedAt: new Date().toISOString(), task: plan.summary,
    };

    this.activeWorkflows.set(workflowId, workflow);
    this.commands.addWorkflow(workflowId, executor, workflowName);

    try {
      const result = await executor.execute();
      await this.onExecutionComplete(result, workflowId, pushHistory);
    } catch (err) { ... }
    finally {
      this.cleanupWorkflow(workflowId);
    }
  }

  // Cleanup is per-workflow — no more nuking siblings
  private cleanupWorkflow(workflowId: string): void {
    const wf = this.activeWorkflows.get(workflowId);
    if (!wf) return;
    wf.eventUnsubscribe();
    clearInterval(wf.stateSnapshotTimer);
    this.activeWorkflows.delete(workflowId);
    this.commands.removeWorkflow(workflowId);
  }

  // planOnly stores into the Map:
  async planOnly(task, pushHistory): Promise<void> {
    // ... planning logic unchanged ...
    this.pendingPlans.set(plan.graph.id, { id: plan.graph.id, plan, task, createdAt: new Date().toISOString() });
    this.callbacks.onPlan(plan);
  }

  // handlePlanResponse resolves from map:
  async handlePlanResponse(planId, action, pushHistory, modification?): Promise<void> {
    const pending = this.pendingPlans.get(planId);
    if (!pending) {
      this.callbacks.onText('That plan is no longer available.', false, true);
      return;
    }
    switch (action) {
      case 'approve':
        await this.executePlan(pending.plan, pushHistory);
        break;
      case 'modify':
        this.pendingPlans.delete(planId);
        await this.planOnly(modification ? `${pending.task}\nModification: ${modification}` : pending.task, pushHistory);
        break;
      case 'reject':
        this.pendingPlans.delete(planId);
        this.callbacks.onText('Plan rejected.', false, true);
        break;
    }
  }

  clearPendingPlans(): void { this.pendingPlans.clear(); }
  
  stop(workflowId?: string): void {
    if (workflowId) {
      this.activeWorkflows.get(workflowId)?.executor.stop();
    } else {
      for (const [, wf] of this.activeWorkflows) wf.executor.stop();
    }
  }

  stopAll(): void {
    for (const [id] of this.activeWorkflows) {
      this.activeWorkflows.get(id)?.executor.stop();
    }
  }
}
```

### File: packages/core/src/agent/main-agent.ts

Update references:
- `this.orchestration.hasPendingPlan` → `this.orchestration.hasPendingPlans`
- `this.orchestration.pendingId` → `this.orchestration.latestPendingPlanId`
- `this.orchestration.executor` → `this.orchestration.hasActiveWorkflow`
- `/reset` → call `this.orchestration.clearPendingPlans()` + `this.orchestration.stopAll()`

---

## Phase 2: Gateway Protocol

### File: packages/gateway/src/types.ts

Add `workflowId` to `ServerMessage`:
```typescript
interface ServerMessage {
  id: string;
  workflowId?: string;    // ← NEW
  // ... rest unchanged
}
```

Add `workflowId` to `ClientMessage`:
```typescript
interface ClientMessage {
  // ... existing
  workflowId?: string;    // ← NEW
}
```

### File: packages/gateway/src/sessions.ts

```typescript
interface Session {
  // ... existing
  activeWorkflows: Set<string>;  // replaces activeWorkflow?: string
}
```

Update `setActiveWorkflow` → `addActiveWorkflow(sessionId, workflowId)` and `removeActiveWorkflow(sessionId, workflowId)`.

### File: packages/gateway/src/server.ts

The `MainAgentCallbacks` wired in `initMainAgent()` need to pass `workflowId` through. The `onPlan`, `onEvent`, `onGraphState` callbacks should include it in the broadcast:

```typescript
onEvent(event) {
  wsHandler.broadcast({
    id: randomBytes(8).toString('hex'),
    type: 'event',
    workflowId: event.workflowId,   // ← pass through
    event,
  });
},
onGraphState(state) {
  wsHandler.broadcast({
    id: randomBytes(8).toString('hex'),
    type: 'status',
    workflowId: state.workflowId,   // ← pass through
    graphState: state,
  });
},
```

### File: packages/gateway/src/routes/status.ts

Update to report multiple active workflows from session manager.

---

## Phase 3: Commands — already covered in Phase 1 commands.ts refactor above. Also:

### File: packages/core/src/agent/main-agent.ts

Add `/workflows` to the help text. Update `/reset` to use `stopAll()` + `clearPendingPlans()`.

---

## Phase 4: TUI Multi-Workflow Display

### File: packages/tui/src/components/workflow-tracker.ts — MAJOR REFACTOR

Create a `MultiWorkflowTracker` wrapper that manages multiple `WorkflowTracker` instances:

```typescript
export class MultiWorkflowTracker extends Container {
  private trackers = new Map<string, WorkflowTracker>();
  private focusedId: string | null = null;

  addWorkflow(workflowId: string, state: GraphState): void {
    if (!this.trackers.has(workflowId)) {
      const tracker = new WorkflowTracker();
      this.trackers.set(workflowId, tracker);
      this.addChild(tracker);
    }
    this.trackers.get(workflowId)!.initFromGraphState(state);
    this.updateVisibility();
  }

  updateWorkflow(workflowId: string, state: GraphState): void {
    const tracker = this.trackers.get(workflowId);
    if (tracker) tracker.updateFromGraphState(state);
    
    // Remove completed workflows after a delay
    if (state.status === 'complete' || state.status === 'error' || state.status === 'stopped') {
      setTimeout(() => {
        const t = this.trackers.get(workflowId);
        if (t) { this.removeChild(t); this.trackers.delete(workflowId); }
      }, 30_000); // keep visible 30s after completion
    }
  }

  updateNodeEvent(workflowId: string, nodeId: string, type: string, message?: string): void {
    this.trackers.get(workflowId)?.updateNodeEvent(nodeId, type, message);
  }

  setFocus(workflowId: string | null): void {
    this.focusedId = workflowId;
    this.updateVisibility();
  }

  get activeCount(): number {
    return [...this.trackers.values()].filter(t => t.isActive).length;
  }

  private updateVisibility(): void {
    for (const [id, tracker] of this.trackers) {
      if (this.focusedId === null || this.focusedId === id) {
        tracker.expanded = true;
      } else {
        tracker.expanded = false; // show collapsed summary only
      }
    }
  }
}
```

Add `expanded` property to existing `WorkflowTracker`: when false, show only the header line. When true, show full node list.

### File: packages/tui/src/components/status-bar.ts

Update status display to show aggregate across all workflows:
```
● connected │ ⬡ Sonnet 4 │ ctx 45k/200k │ ◆ workflows 2 │ ⚙ workers 5 │ .24
```

Replace single `activeTasks` with `activeWorkflows` count. Aggregate workers across all.

### File: packages/tui/src/gateway-client.ts

The `GatewayClient` events now carry `workflowId`. Update:
- `graphState` event → include `workflowId`
- `event` → include `workflowId`  
- `plan` → include `workflowId`

```typescript
// In handleMessage, extract workflowId from server messages
case 'status':
  if (msg.graphState) this.emit('graphState', msg.graphState as GraphState, msg.workflowId);
  break;
case 'event':
  if (event) this.emit('event', event, msg.workflowId);
  break;
```

Update the `GatewayClientEvents` interface to include the workflowId parameter.

### File: packages/tui/src/index.ts — TUI wiring

Replace single `workflowTracker` with `MultiWorkflowTracker`. Update event handlers:

```typescript
const multiTracker = new MultiWorkflowTracker();
let trackerAttached = false;

client.on('graphState', (state: GraphState, workflowId?: string) => {
  const wfId = workflowId ?? state.workflowId;
  if (!trackerAttached) {
    chatLog.addChild(multiTracker);
    trackerAttached = true;
  }
  
  if (!multiTracker.trackers.has(wfId)) {
    multiTracker.addWorkflow(wfId, state);
  } else {
    multiTracker.updateWorkflow(wfId, state);
  }

  // Aggregate stats for status bar
  statusBar.updateStatus({
    activeTasks: multiTracker.activeCount,
    activeWorkers: /* sum running nodes across all */,
  });
  tui.requestRender();
});

client.on('event', (event: WorkerEvent, workflowId?: string) => {
  const wfId = workflowId ?? event.workflowId;
  multiTracker.updateNodeEvent(wfId, event.nodeId, event.type, event.message);
  tui.requestRender();
});
```

---

## Phase 5: Plan Queue & Multi-Plan Approval

### File: packages/tui/src/index.ts

Replace single `activePlanId` with a Map:

```typescript
const pendingPlans = new Map<string, { plan: PlannerOutput; receivedAt: string }>();

client.on('plan', (plan: PlannerOutput, planId: string) => {
  pendingPlans.set(planId, { plan, receivedAt: new Date().toISOString() });
  statusBar.thinking = false;

  if (pendingPlans.size === 1) {
    // Single plan — show inline as today
    const formatted = formatPlan(plan);
    chatLog.addMessage({ id: `plan-${planId}`, role: 'system', content: '', timestamp: new Date().toISOString(), raw: formatted });
  } else {
    // Multiple plans — show queue summary
    const summary = formatPlanQueue(pendingPlans);
    chatLog.addMessage({ id: 'plan-queue', role: 'system', content: '', timestamp: new Date().toISOString(), raw: summary });
  }
  tui.requestRender();
});

// Update editor.onSubmit plan handling:
if (pendingPlans.size > 0) {
  const lower = value.toLowerCase().trim();

  if (/^approve all$/i.test(lower)) {
    for (const [pid] of pendingPlans) client.respondToPlan(pid, 'approve');
    pendingPlans.clear();
  } else if (/^approve (\d+)$/.test(lower)) {
    const idx = parseInt(RegExp.) - 1;
    const ids = [...pendingPlans.keys()];
    if (idx >= 0 && idx < ids.length) {
      client.respondToPlan(ids[idx], 'approve');
      pendingPlans.delete(ids[idx]);
    }
  } else if (/^reject (\d+)$/.test(lower)) {
    const idx = parseInt(RegExp.) - 1;
    const ids = [...pendingPlans.keys()];
    if (idx >= 0 && idx < ids.length) {
      client.respondToPlan(ids[idx], 'reject');
      pendingPlans.delete(ids[idx]);
    }
  } else if (pendingPlans.size === 1) {
    // Single plan — existing approval logic
    const isApproval = /^(y|yes|go|do it|go ahead|ok|okay|approve|run it|execute|looks good|lgtm|ship it|send it)$/i.test(lower);
    const [planId] = pendingPlans.keys();
    if (isApproval) {
      client.respondToPlan(planId, 'approve');
    } else {
      client.respondToPlan(planId, 'reject');
      client.sendChat(value);
    }
    pendingPlans.delete(planId);
  } else {
    // Multiple plans, ambiguous input — send as chat
    client.sendChat(value);
  }
}
```

### New helper: formatPlanQueue

```typescript
function formatPlanQueue(plans: Map<string, { plan: PlannerOutput }>): string {
  const lines = [chalk.bold('📋 Pending Plans:'), ''];
  let i = 1;
  for (const [, { plan }] of plans) {
    const g = plan.graph;
    const nodeCount = g.nodes instanceof Map ? g.nodes.size : Object.keys(g.nodes).length;
    lines.push(`  ${i}. ${g.name}`);
    lines.push(`     ${nodeCount} workers · ~${Math.round(plan.estimatedTime/60)}min · ~$${plan.estimatedCost.toFixed(2)}`);
    i++;
  }
  lines.push('', 'Reply: approve 1, approve all, reject 2, or describe changes');
  return lines.join('\n');
}
```

---

## Phase 6: Human-in-the-Loop Gates

### File: packages/core/src/orchestration/executor.ts

The `checkHumanGate` method already exists. Update to include workflowId in the gate event:

```typescript
async checkHumanGate(action: string, description: string): Promise<boolean> {
  // ...
  this.emitOrchestrator('status', `🚧 Human gate: ${action} — awaiting approval`, { action, description, workflowId: this.graph.id });
  // ...
}
```

### File: packages/core/src/agent/orchestration-bridge.ts

Add gate request queue and callback routing:

```typescript
interface HumanGateRequest {
  workflowId: string;
  workflowName: string;
  action: string;
  description: string;
  resolve: (approved: boolean) => void;
  timestamp: string;
}

private pendingGates = new Map<string, HumanGateRequest>();

// When creating executor config:
humanGateCallback: async (action, description) => {
  const gateId = randomBytes(8).toString('hex');
  return new Promise<boolean>((resolve) => {
    this.pendingGates.set(gateId, { workflowId, workflowName, action, description, resolve, timestamp: new Date().toISOString() });
    this.callbacks.onText(`⚠️ [${workflowName}] Approval needed: ${action} — ${description}\nReply allow or deny`, false, true);
  });
}
```

### Gateway + TUI:

Gate requests appear as special messages. The TUI recognizes them and routes allow/deny responses back.

---

## Phase 7: Checkpoint Resume on Startup

### File: packages/core/src/agent/orchestration-bridge.ts

Add on-init checkpoint scan:

```typescript
async checkForInterruptedWorkflows(): Promise<WorkflowCheckpoint[]> {
  const { readdirSync, readFileSync } = await import('node:fs');
  try {
    const files = readdirSync(this.config.checkpointDir).filter(f => f.endsWith('.checkpoint.json'));
    return files.map(f => JSON.parse(readFileSync(`${this.config.checkpointDir}/${f}`, 'utf-8')));
  } catch { return []; }
}
```

### File: packages/core/src/agent/main-agent.ts

In `init()`, after orchestration bridge is created:

```typescript
const interrupted = await this.orchestration.checkForInterruptedWorkflows();
if (interrupted.length > 0) {
  const list = interrupted.map((c, i) => `  ${i+1}. ${c.task} (layer ${c.currentLayer}/${c.graph.layers.length}, ${Object.values(c.nodeOutputs).length} nodes done)`).join('\n');
  this.callbacks.onText(`🔄 Found ${interrupted.length} interrupted workflow(s):\n${list}\n\nSay resume or resume all to continue, or discard to clear.`, false, true);
}
```

---

## Build & Test

After all changes:
1. `cd ~/orionomega && pnpm install && pnpm -r build`
2. Test: start gateway, open TUI, submit two tasks simultaneously
3. Verify `/workflows`, `/status`, `/stop <name>` work
4. Verify both workflows complete independently
5. Commit to `feat/multi-workflow-concurrency` branch

## Implementation Notes

- Maintain backward compat: if only 1 workflow running, commands work without specifying target (no UX regression)
- GraphState already has `workflowId` field — use it consistently
- The EventBus ring buffer is shared across all workflows — this is fine, events are tagged
- Per-workflow cost tracking can be derived from worker results in onExecutionComplete
- The 2s state snapshot timer per workflow means N*2s timer overhead — acceptable for reasonable N

