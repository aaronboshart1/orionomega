# TUI Workflow Display Redesign — Complete Specification

## Executive Summary

This document specifies a redesigned workflow display for the OrionOmega TUI that eliminates duplication, adds per-node streaming activity, enforces consistent formatting, groups nodes by execution layer, and enhances the status bar. All changes work within the existing `@mariozechner/pi-tui` component tree architecture.

---

## 1. ASCII Mockups

### 1A. Early Execution — All Running (Layer 1 active)

```
  orionomega — ws://127.0.0.1:7800/ws

  Ω Here's my plan for implementing the authentication system...

  ╭─ ⚡ auth-system-impl ─────────────────── 47s · layer 1/3 · $0.12 ─╮
  │                                                                     │
  │  ═══ Layer 1 (2/3) ═══                                              │
  │                                                                     │
  │  ⣾ Research auth patterns       [Sonnet 4]  32s                     │
  │    ├ Reading src/auth/provider.ts                                   │
  │    └ 7 tool calls · 45%  ████████░░░░░░░░░░                        │
  │                                                                     │
  │  ⣾ Analyze existing middleware   [Sonnet 4]  28s                    │
  │    └ Running grep across src/ — scanning middleware chain           │
  │                                                                     │
  │  ○ Review security requirements  [Haiku 4.5]                        │
  │    └ waiting on: —                                                  │
  │                                                                     │
  │  ─── Layer 2 ───                                                    │
  │  ○ Implement auth module         [Opus 4]                           │
  │    └ waiting on: research-auth, analyze-middleware                  │
  │  ○ Write auth tests              [Sonnet 4]                         │
  │    └ waiting on: research-auth                                     │
  │                                                                     │
  │  ─── Layer 3 ───                                                    │
  │  ○ Integration test suite        [Sonnet 4]                         │
  │    └ waiting on: impl-auth, write-tests                            │
  │                                                                     │
  ╰─────────────────────────────── ✓ 0/6 · ⣾ 2 running · ○ 4 pending ─╯

  ● connected │ ⬡ Sonnet 4 │ $0.12 │ ⚡ layer 1/3 │ ⣾ 2 active │ 47s
```

### 1B. Mid-Execution — Mixed States (Layer 1 done, Layer 2 active)

```
  orionomega — ws://127.0.0.1:7800/ws

  Ω Here's my plan for implementing the authentication system...
  ✓ Plan Approved

  ╭─ ⚡ auth-system-impl ──────────────── 2m 14s · layer 2/3 · $0.89 ─╮
  │                                                                     │
  │  ▸ Layer 1 — ✓ 3/3 complete · 1m 02s                               │
  │                                                                     │
  │  ═══ Layer 2 (1/2) ═══                                              │
  │                                                                     │
  │  ⣾ Implement auth module         [Opus 4]  1m 12s                   │
  │    ├ Editing src/auth/jwt-provider.ts — adding token validation     │
  │    └ 14 tool calls · 65%  ████████████░░░░░░░░                     │
  │                                                                     │
  │  ✓ Write auth tests              [Sonnet 4]  48s · $0.18           │
  │    └ 12 tool calls · wrote 4 test files                            │
  │                                                                     │
  │  ─── Layer 3 ───                                                    │
  │  ○ Integration test suite        [Sonnet 4]                         │
  │    └ waiting on: impl-auth                                         │
  │                                                                     │
  ╰────────────────────────────── ✓ 4/6 · ⣾ 1 running · ○ 1 pending ─╯

  ● connected │ ⬡ Opus 4 │ $0.89 │ ⚡ layer 2/3 │ ⣾ 1 active │ 2m 14s
```

### 1C. Near Completion — Mostly Done (auto-collapsed layers)

```
  orionomega — ws://127.0.0.1:7800/ws

  Ω Here's my plan for implementing the authentication system...
  ✓ Plan Approved

  ╭─ ⚡ auth-system-impl ──────────────── 4m 31s · layer 3/3 · $2.14 ─╮
  │                                                                     │
  │  ▸ Layer 1 — ✓ 3/3 complete · 1m 02s                               │
  │  ▸ Layer 2 — ✓ 2/2 complete · 1m 55s                               │
  │                                                                     │
  │  ═══ Layer 3 (0/1) ═══                                              │
  │                                                                     │
  │  ⣾ Integration test suite        [Sonnet 4]  1m 34s                 │
  │    ├ Running npm test -- --filter=auth                              │
  │    └ 22 tool calls · 80%  ████████████████░░░░                     │
  │                                                                     │
  ╰──────────────────────────────── ✓ 5/6 · ⣾ 1 running · ○ 0 pending ─╯

  ● connected │ ⬡ Sonnet 4 │ $2.14 │ ⚡ layer 3/3 │ ⣾ 1 active │ 4m 31s
```

### 1D. Completed Workflow (final summary, before 30s removal)

```
  orionomega — ws://127.0.0.1:7800/ws

  ╭─ ✓ auth-system-impl ──────────── 5m 48s · complete · $2.67 ────────╮
  │                                                                     │
  │  ▸ Layer 1 — ✓ 3/3 complete · 1m 02s                               │
  │  ▸ Layer 2 — ✓ 2/2 complete · 1m 55s                               │
  │  ▸ Layer 3 — ✓ 1/1 complete · 2m 51s                               │
  │                                                                     │
  │  💡 Findings:                                                       │
  │    • JWT validation added to all protected routes                   │
  │    • Discovered unused session middleware — removed                 │
  │                                                                     │
  │  📁 Files modified: 12 · Tests: 28 passing                          │
  │                                                                     │
  ╰──────────────────────────────────────────────── ✓ 6/6 · $2.67 ─────╯

  Ω The authentication system has been fully implemented...
```

### 1E. Error State

```
  ╭─ ⚡ deploy-staging ────────────────── 3m 12s · layer 2/2 · $1.05 ─╮
  │                                                                     │
  │  ▸ Layer 1 — ✓ 2/2 complete · 1m 30s                               │
  │                                                                     │
  │  ═══ Layer 2 (1/2) ═══                                              │
  │                                                                     │
  │  ✗ Run deployment script         [Sonnet 4]  1m 42s                 │
  │    └ ✗ Error: EACCES permission denied on /etc/nginx/conf.d        │
  │                                                                     │
  │  ○ Verify health checks          [Haiku 4.5]                        │
  │    └ waiting on: deploy-script                                     │
  │                                                                     │
  ╰──────────────────────────── ✓ 2/4 · ✗ 1 failed · ○ 1 pending ─────╯
```

### 1F. Multiple Concurrent Workflows (one focused)

```
  ╭─ ⚡ auth-system ───────────────────── 2m 14s · layer 2/3 · $0.89 ─╮
  │  (expanded — see 1B above)                                          │
  ╰─────────────────────────────────────────────────────────────────────╯

  ╭─ ⣾ api-refactor ─────────────────── 45s · layer 1/2 · $0.15 ──────╮
  │  ⣾ 2 running · ○ 1 pending                                         │
  ╰─────────────────────────────────────────────────────────────────────╯
```

---

## 2. Format Strings & Icons — Complete Specification

### 2.1 Node Status Icons

| Status | Icon | Color | Source |
|--------|------|-------|--------|
| Pending | `○` | `palette.dim` (#5C6370) | `icons.pending` |
| Running | `⣾` (animated) | `palette.info` (#61AFEF) | `omegaSpinner.current` |
| Complete | `✓` | `palette.success` (#7DD3A5) | `icons.complete` |
| Error | `✗` | `palette.error` (#F97066) | `icons.error` |
| Skipped | `⊘` | `palette.dim` (#5C6370) | NEW: `icons.skipped` |

### 2.2 Node Line Formats

Each node is rendered as 2-3 lines. The format depends on status:

**Running node (2-3 lines):**
```
  ⣾ {label}  [{model}]  {elapsed}
    ├ {current_activity}
    └ {tool_count} tool calls · {progress}%  {progress_bar}
```

Format string:
```typescript
// Line 1: status + identity + timing
`${indent2}${spinnerIcon} ${chalk.hex(palette.info)(label)}  ${chalk.hex(palette.purple)(`[${model}]`)}  ${chalk.hex(palette.dim)(elapsed)}`

// Line 2: current activity (from latest tool_call or status event)
`${indent3}├ ${chalk.hex(palette.text)(truncate(activity, 60))}`

// Line 3: progress summary
`${indent3}└ ${chalk.hex(palette.dim)(`${toolCount} tool calls`)} · ${chalk.hex(palette.info)(`${progress}%`)}  ${progressBar}`
```

**Completed node (2 lines):**
```
  ✓ {label}  [{model}]  {duration} · ${cost}
    └ {tool_count} tool calls · {result_summary}
```

Format string:
```typescript
// Line 1
`${indent2}${chalk.hex(palette.success)(icons.complete)} ${chalk.hex(palette.success)(label)}  ${chalk.hex(palette.purple)(`[${model}]`)}  ${chalk.hex(palette.dim)(`${duration} · ${formatCost(cost)}`)}`

// Line 2
`${indent3}└ ${chalk.hex(palette.dim)(`${toolCount} tool calls · ${truncate(resultSummary, 50)}`)}`
```

**Pending node (2 lines):**
```
  ○ {label}  [{model}]
    └ waiting on: {dependency_names}
```

Format string:
```typescript
// Line 1
`${indent2}${chalk.hex(palette.dim)(icons.pending)} ${chalk.hex(palette.dim)(label)}  ${chalk.hex(palette.purple)(`[${model}]`)}`

// Line 2
`${indent3}└ ${chalk.hex(palette.dim)(`waiting on: ${dependencyLabels.join(', ')}`)}`
```

**Failed node (2 lines):**
```
  ✗ {label}  [{model}]  {duration}
    └ ✗ Error: {error_message}
```

Format string:
```typescript
// Line 1
`${indent2}${chalk.hex(palette.error)(icons.error)} ${chalk.hex(palette.error)(label)}  ${chalk.hex(palette.purple)(`[${model}]`)}  ${chalk.hex(palette.dim)(duration)}`

// Line 2
`${indent3}└ ${chalk.hex(palette.error)(`${icons.error} Error: ${truncate(errorMsg, 55)}`)}`
```

**Skipped node (1 line):**
```
  ⊘ {label}  [{model}] — skipped (dependency failed)
```

### 2.3 Layer Headers

**Active layer (currently executing):**
```
═══ Layer {N} ({completed}/{total}) ═══
```
Format: `chalk.hex(palette.info).bold(...)` with `box.doubleHorizontal` (`═`)

**Pending layer (not yet started):**
```
─── Layer {N} ───
```
Format: `chalk.hex(palette.dim)(...)` with `box.horizontal` (`─`)

**Collapsed completed layer:**
```
▸ Layer {N} — ✓ {done}/{total} complete · {totalDuration}
```
Format: `chalk.hex(palette.dim)('▸')` + `chalk.hex(palette.success)(...)`

### 2.4 Workflow Box

**Header line (inside top border):**
```
╭─ {status_icon} {workflow_name} ──── {elapsed} · layer {cur}/{total} · ${cost} ─╮
```

**Footer line (inside bottom border):**
```
╰──────────────── ✓ {done}/{total} · ⣾ {running} running · ○ {pending} pending ─╯
```

**Status icon in header:**
- Running: `⚡` (accent yellow)
- Complete: `✓` (success green)
- Error: `✗` (error red)
- Paused: `⏸` (warning yellow)

### 2.5 Progress Bar

10-character bar using block characters:
```
████████░░░░░░░░░░   (45%)
████████████░░░░░░░░ (65%)
████████████████░░░░ (80%)
████████████████████ (100%)
```

Implementation:
```typescript
function progressBar(pct: number, width = 18): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return chalk.hex(palette.info)('█'.repeat(filled)) + chalk.hex(palette.dim)('░'.repeat(empty));
}
```

### 2.6 Enhanced Status Bar

```
● connected │ ⬡ Sonnet 4 │ $2.14 │ ⚡ layer 2/3 │ ⣾ 2 active │ 4m 31s
```

Segments:
1. **Connection**: `● connected` / `● disconnected`
2. **Active model**: `⬡ {model}` (model of currently most-active worker)
3. **Total cost**: `${cost}` (sum across all workflows)
4. **Layer progress**: `⚡ layer {current}/{total}` (from focused/latest workflow)
5. **Active workers**: `⣾ {N} active` (animated spinner when >0)
6. **Elapsed time**: `{duration}` (total session or workflow time)

---

## 3. Expand/Collapse Rules

### 3.1 Automatic Collapse

A completed layer is **automatically collapsed** to a single summary line when ALL of the following are true:

1. Every node in the layer has status `complete` or `skipped`
2. At least one later layer has started executing (status `running`)
3. The workflow has more than **4 total nodes** (don't collapse tiny workflows)

### 3.2 Automatic Expand

A layer is always shown expanded when:
1. It contains any `running` or `error` nodes
2. It is the most recent completed layer AND no later layer has started yet
3. The workflow has ≤ 4 nodes total (always show everything)

### 3.3 Workflow-Level Collapse (Multi-Workflow)

When multiple workflows are active:
- **Focused workflow** (via `/focus` command or auto-focused if only 1): Fully expanded
- **Unfocused workflows**: Show header + single summary line:
  ```
  ╭─ ⣾ api-refactor ──── 45s · layer 1/2 · $0.15 ─╮
  │  ⣾ 2 running · ○ 1 pending                      │
  ╰──────────────────────────────────────────────────╯
  ```

### 3.4 Completed Workflow Display

When a workflow completes:
1. All layers collapse to summary lines
2. A **findings section** appears if any findings were reported
3. A **files/stats line** appears with aggregate metrics
4. After 30 seconds, the entire box is removed (configurable)

### 3.5 Node Detail Lines

Running nodes show **up to 2 sub-lines** (activity + progress). Completed nodes show **1 sub-line** (summary). Pending nodes show **1 sub-line** (dependencies). This keeps the display compact while still being informative.

---

## 4. Streaming Data per Worker Type

### 4.1 AGENT Nodes

**Events consumed:** `tool_call`, `tool_result`, `status`, `thinking`, `finding`, `error`, `done`

**Activity line shows (priority order, first available):**
1. Latest `tool_call`: `"{tool.name}" — {tool.summary}` (e.g., `"web_search" — searching for auth patterns`)
2. Latest `status` message: `{message}` (e.g., `Analyzing 3 search results`)
3. Latest `thinking` (truncated): `Thinking: {first 50 chars}…`

**Progress line shows:**
- `{toolCallCount} tool calls · {progress}%  {progressBar}`
- Progress comes from `WorkerEvent.progress` field (auto-estimated by worker at ~5% per tool call, capped at 90%)

**Completion line shows:**
- `{toolCallCount} tool calls · {resultSummary}` where resultSummary is the first 50 chars of the done message or "Complete"

### 4.2 CODING_AGENT Nodes

**Events consumed:** Same as AGENT, plus file-specific tool calls

**Activity line shows (priority order):**
1. File operations: `Editing {file}` / `Reading {file}` / `Writing {file}` (from `tool.file`)
2. Shell commands: `Running {tool.summary}` (from tool_call with name=Bash)
3. Search operations: `Searching {tool.summary}` (from tool_call with name=Grep/Glob)
4. Fallback: Same as AGENT

**Progress line shows:**
- `{toolCallCount} tool calls · {progress}%  {progressBar}`

**Completion line shows:**
- `{toolCallCount} tool calls · wrote {fileCount} files` (count from outputPaths in done event data)
- Fallback: `{toolCallCount} tool calls · {resultSummary}`

### 4.3 TOOL Nodes

**Events consumed:** `status`, `error`, `done`

**Activity line shows:**
1. Latest `status` message (e.g., `Running npm test`, `Executing migration`)
2. If no status: `Running {tool.name}…`

**Progress line:** Not shown (tools rarely report granular progress)

**Completion line shows:**
- `{resultSummary}` — typically stdout excerpt or "Complete"

### 4.4 LOOP Nodes

**Events consumed:** `loop_iteration`, `status`, `error`, `done`

**Activity line shows:**
- `Iteration {current}/{max} — {bodyNodeStatus}` (from `loop_iteration` events)

**Progress line shows:**
- `iteration {N}/{max}  {progressBar}` (progress = N/max * 100)

### 4.5 Structural Nodes (ROUTER, JOIN, PARALLEL)

**Activity line:** Not shown (these are instant/near-instant)
**Shown as single collapsed line when complete**

---

## 5. Component Structure Changes

### 5.1 Current Structure (to be replaced)

```
MultiWorkflowTracker (Container)
  └─ WorkflowTracker (Container)
       ├─ Text (header)         ← single flat header line
       └─ Text (per node)       ← flat list, no grouping
```

### 5.2 New Structure

```
WorkflowPanel (Container)                    ← NEW: top-level container
  └─ WorkflowBox (Container)                 ← NEW: per-workflow bordered box
       ├─ Text (box-top)                     ← "╭─ ⚡ name ── elapsed · layer · cost ─╮"
       ├─ LayerGroup (Container)             ← NEW: per-layer grouping
       │    ├─ Text (layer-header)           ← "═══ Layer 1 (2/3) ═══" or collapsed
       │    └─ NodeDisplay (Container)       ← NEW: per-node multi-line display
       │         ├─ Text (node-main)         ← "⣾ label [model] elapsed"
       │         ├─ Text (node-activity)     ← "  ├ Reading src/auth/..."
       │         └─ Text (node-progress)     ← "  └ 7 tool calls · 45% ████..."
       ├─ LayerGroup ...                     ← repeated per layer
       ├─ FindingsSection (Container)        ← NEW: shown on completion only
       │    └─ Text (finding lines)
       ├─ Text (box-stats)                   ← "📁 Files modified: 12 · Tests: 28 passing"
       └─ Text (box-bottom)                  ← "╰── ✓ 5/6 · ⣾ 1 running ─╯"
```

### 5.3 New/Modified Files

#### `src/components/workflow-panel.ts` (NEW)
Top-level replacement for `MultiWorkflowTracker`. Manages multiple `WorkflowBox` instances.

```typescript
export class WorkflowPanel extends Container {
  private boxes = new Map<string, WorkflowBox>();
  private focusedId: string | null = null;
  onUpdate?: () => void;

  addWorkflow(id: string, state: GraphState): void;
  updateWorkflow(id: string, state: GraphState): void;
  updateNodeEvent(wfId: string, event: WorkerEvent): void;  // ← takes full event, not just type+message
  setFocus(id: string | null): void;
  get activeCount(): number;
}
```

#### `src/components/workflow-box.ts` (NEW)
Single workflow display with box-drawing border and layer groups.

```typescript
export class WorkflowBox extends Container {
  private topBorder: Text;
  private bottomBorder: Text;
  private layers = new Map<number, LayerGroup>();
  private findingsSection: Container | null = null;
  private statsLine: Text | null = null;
  private nodes = new Map<string, NodeDisplay>();

  initFromGraphState(state: GraphState): void;
  updateFromGraphState(state: GraphState): void;
  updateNodeEvent(event: WorkerEvent): void;  // ← full event object
  get isCollapsed(): boolean;
  set collapsed(v: boolean);
}
```

#### `src/components/layer-group.ts` (NEW)
A single layer's header + node list. Handles collapse/expand.

```typescript
export class LayerGroup extends Container {
  private headerText: Text;
  private nodeDisplays: NodeDisplay[] = [];
  private _collapsed = false;
  private layerIndex: number;
  private totalNodes: number;
  private completedNodes: number;
  private layerDuration: number;

  get collapsed(): boolean;
  set collapsed(v: boolean);  // toggles between full and summary line
  updateHeader(): void;
  addNodeDisplay(nd: NodeDisplay): void;
}
```

#### `src/components/node-display.ts` (NEW)
Multi-line display for a single node. Manages activity and progress sub-lines.

```typescript
interface NodeState {
  id: string;
  label: string;
  model: string;
  type: NodeType;
  status: NodeStatus;
  layer: number;
  dependsOn: string[];
  dependencyLabels: string[];  // resolved from graph

  // Running state
  currentActivity?: string;    // from latest tool_call/status event
  toolCallCount: number;
  progress: number;
  elapsed: number;
  startedAt?: number;

  // Completed state
  duration?: number;
  costUsd?: number;
  resultSummary?: string;
  outputPathCount?: number;
  findings?: string[];

  // Error state
  errorMessage?: string;
}

export class NodeDisplay extends Container {
  private mainLine: Text;
  private activityLine: Text | null = null;
  private progressLine: Text | null = null;
  private state: NodeState;

  updateFromEvent(event: WorkerEvent): void;
  updateFromGraphState(node: WorkflowNode): void;
  rebuild(): void;
}
```

#### `src/components/workflow-tracker.ts` (MODIFIED)
**Remove entirely.** Replaced by `workflow-panel.ts` + `workflow-box.ts`.

#### `src/gateway-client.ts` (MODIFIED)
**Remove the automatic `message` emission for finding/error/done events.** These are now handled by the unified node display and should NOT create separate chat log entries.

Change:
```typescript
// REMOVE these lines (gateway-client.ts:272-284):
if (event.type === 'finding' || event.type === 'error' || event.type === 'done') {
  this.emit('message', { ... });
}
```

Instead, pass the full event to the workflow panel:
```typescript
// Keep only the event emission — let WorkflowPanel handle display
this.emit('event', event, msg.workflowId ?? event.workflowId);
```

The `dag_complete` info message should still appear in the chat log as a final summary (this comes through as a regular text message from the server, not from the event handler).

#### `src/components/status-bar.ts` (MODIFIED)
Add new fields to `SessionStatus`:

```typescript
export interface SessionStatus {
  // ... existing fields ...
  currentLayer?: number;
  totalLayers?: number;
  workflowElapsed?: number;
  activeWorkerActivity?: string;  // e.g. "Editing jwt-provider.ts"
}
```

Update `updateDisplay()` to include layer progress and elapsed time segments.

#### `src/index.ts` (MODIFIED)
Update event wiring to pass full events to the new `WorkflowPanel`:

```typescript
// Replace:
client.on('event', (event, workflowId) => {
  if (wfId) multiTracker.updateNodeEvent(wfId, event.nodeId, event.type, event.message);
});

// With:
client.on('event', (event, workflowId) => {
  if (wfId) workflowPanel.updateNodeEvent(wfId, event);
  // Also update status bar with latest activity
  if (event.type === 'tool_call' && event.tool) {
    statusBar.updateStatus({ activeWorkerActivity: `${event.tool.name}: ${event.tool.summary}` });
  }
});
```

#### `src/utils/format.ts` (ADD function)

```typescript
/**
 * Render a progress bar using block characters.
 * @param pct - Percentage 0-100
 * @param width - Character width of the bar (default 18)
 * @returns Styled string like "████████░░░░░░░░░░"
 */
export function progressBar(pct: number, width = 18): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return chalk.hex(palette.info)('█'.repeat(filled)) +
         chalk.hex(palette.dim)('░'.repeat(empty));
}
```

#### `src/theme.ts` (ADD icons)

```typescript
export const icons = {
  // ... existing ...
  skipped: '⊘',       // NEW
  collapsed: '▸',     // NEW — collapsed layer indicator
  expanded: '▾',      // NEW — expanded layer indicator (if needed)
  paused: '⏸',        // NEW
  files: '📁',        // NEW
  treeMiddle: '├',    // NEW — tree connector
  treeLast: '└',      // NEW — tree connector (last child)
} as const;
```

### 5.4 Data Flow Changes

```
GatewayClient
  │
  ├─ 'event' (WorkerEvent, workflowId)
  │     ↓
  │   WorkflowPanel.updateNodeEvent(wfId, event)  ← FULL event, not decomposed
  │     ↓
  │   WorkflowBox.updateNodeEvent(event)
  │     ↓
  │   NodeDisplay.updateFromEvent(event)           ← Updates activity, progress, tool count
  │     ↓
  │   rebuild() → requestRender()
  │
  ├─ 'graphState' (GraphState, workflowId)
  │     ↓
  │   WorkflowPanel.addWorkflow/updateWorkflow
  │     ↓
  │   WorkflowBox.updateFromGraphState(state)
  │     ↓
  │   For each node: NodeDisplay.updateFromGraphState(node)
  │   For each layer: LayerGroup.updateHeader()
  │   Auto-collapse check
  │     ↓
  │   rebuild() → requestRender()
  │
  ├─ NO LONGER: 'message' for finding/done/error   ← REMOVED (no more duplication)
  │
  └─ 'message' for regular text/command_result/error ← Unchanged, goes to ChatLog
```

### 5.5 Per-Node Event Accumulator

Each `NodeDisplay` maintains an event accumulator that processes incoming `WorkerEvent`s:

```typescript
class NodeEventAccumulator {
  private toolCalls: Array<{ name: string; file?: string; summary: string }> = [];
  private latestActivity = '';
  private latestThinking = '';
  private findings: string[] = [];

  processEvent(event: WorkerEvent): void {
    switch (event.type) {
      case 'tool_call':
        this.toolCalls.push(event.tool!);
        // Format activity based on tool type
        if (event.tool!.file) {
          const action = event.tool!.action ?? event.tool!.name;
          this.latestActivity = `${capitalize(action)} ${event.tool!.file}`;
        } else if (event.tool!.summary) {
          this.latestActivity = `${event.tool!.name} — ${event.tool!.summary}`;
        } else {
          this.latestActivity = `Running ${event.tool!.name}`;
        }
        break;

      case 'status':
        if (event.message) this.latestActivity = event.message;
        break;

      case 'thinking':
        if (event.thinking) this.latestThinking = event.thinking;
        break;

      case 'finding':
        if (event.message) this.findings.push(event.message);
        break;

      case 'tool_result':
        // Don't update activity — keep showing the tool_call
        break;

      case 'done':
        // Handled at NodeDisplay level
        break;

      case 'error':
        this.latestActivity = event.error ?? event.message ?? 'Error';
        break;
    }
  }

  get activity(): string { return this.latestActivity; }
  get toolCount(): number { return this.toolCalls.length; }
  get allFindings(): string[] { return this.findings; }
}
```

---

## 6. Box-Drawing Implementation

The workflow box uses rounded corners from the existing `box` constants in `theme.ts`:

```typescript
function renderTopBorder(icon: string, name: string, elapsed: string, layer: string, cost: string, width: number): string {
  const content = ` ${icon} ${name} `;
  const right = ` ${elapsed} · ${layer} · ${cost} `;
  const fillWidth = width - content.length - right.length - 2; // -2 for corners
  const fill = box.horizontal.repeat(Math.max(1, fillWidth));
  return chalk.hex(palette.border)(
    box.topLeft + box.horizontal + content + fill + right + box.horizontal + box.topRight
  );
}

function renderBottomBorder(stats: string, width: number): string {
  const right = ` ${stats} `;
  const fillWidth = width - right.length - 2;
  const fill = box.horizontal.repeat(Math.max(1, fillWidth));
  return chalk.hex(palette.border)(
    box.bottomLeft + fill + right + box.horizontal + box.bottomRight
  );
}
```

---

## 7. Width Calculations

All workflow box content should be sized to terminal width:

```typescript
const W = Math.min(72, (process.stdout.columns ?? 80) - 4);
```

- Box borders: width W + 2 (for `│` on each side)
- Content lines: padded with spaces to fill the box
- Progress bars: 18 chars fixed (works in any terminal ≥ 60 cols)
- Node labels: truncated at `W - 30` to leave room for model + elapsed
- Activity text: truncated at `W - 10` (accounting for tree connector indent)

---

## 8. Timing & Performance

- **Spinner tick** (120ms): Only updates activity/progress lines of running nodes + header elapsed time. Does NOT rebuild the entire tree.
- **GraphState snapshot** (5s): Full rebuild of all layer headers, auto-collapse checks, status counts.
- **WorkerEvent** (immediate): Updates single NodeDisplay, no cascade.
- **Total Text components per workflow**: ~2 (borders) + 1 per layer (header) + 2-3 per node ≈ 20-30 for a 6-node workflow. Well within pi-tui's capabilities.

---

## 9. Migration Path

1. **Phase 1**: Create `node-display.ts` and `layer-group.ts` as standalone components. Write unit tests for format strings.
2. **Phase 2**: Create `workflow-box.ts` that composes LayerGroups and NodeDisplays. Test with mock GraphState data.
3. **Phase 3**: Create `workflow-panel.ts` as drop-in replacement for `MultiWorkflowTracker`. Wire to same events.
4. **Phase 4**: Remove duplicate message emission from `gateway-client.ts`. Update `index.ts` event wiring.
5. **Phase 5**: Enhance `status-bar.ts` with new fields.

Each phase can be tested independently. Phase 3 is the swap point — `WorkflowPanel` has the same public API surface as `MultiWorkflowTracker` so the change in `index.ts` is minimal.
