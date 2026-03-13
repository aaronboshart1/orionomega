/**
 * @module components/workflow-tracker
 * Displays workflow progress aligned to the approved plan.
 * Shows each task with status indicators using shared theme constants.
 * Rendered as a persistent block in the chat log when a workflow is active.
 */

import { Container, Text } from '@mariozechner/pi-tui';
import type { GraphState, WorkerEvent } from '@orionomega/core';
import chalk from 'chalk';
import { palette, spacing, icons } from '../theme.js';
import { shortenModel, truncate, formatDuration } from '../utils/format.js';
import { omegaSpinner } from './omega-spinner.js';

/** Accumulated activity state for a running/completed node. */
interface NodeActivityState {
  toolCallCount: number;
  filesRead: Set<string>;
  filesModified: Set<string>;
  currentTool?: string;
  currentFile?: string;
  currentSummary?: string;
  startedAt: number;
  lastUpdateAt: number;
  loopIteration?: number;
  loopMaxIterations?: number;
}

interface TrackedNode {
  id: string;
  label: string;
  model: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  layer: number;
  lastMessage?: string;
  progress?: number;
  elapsed?: number;
  nodeType?: string;
  activity?: NodeActivityState;
}

/**
 * Visual workflow tracker that updates in-place as tasks progress.
 */
export class WorkflowTracker extends Container {
  private headerText: Text;
  private nodeTexts = new Map<string, Text[]>();
  private nodeAttached = new Set<string>();
  private trackedNodes = new Map<string, TrackedNode>();
  private lastRebuildAt = 0;
  private workflowName = '';
  private startTime = Date.now();
  private totalLayers = 0;
  private completedLayers = 0;
  private _expanded = true;
  private unsubSpinner: (() => void) | null = null;
  /** Wire this to tui.requestRender() for spinner-driven re-renders. */
  onUpdate?: () => void;

  constructor() {
    super();
    this.headerText = new Text('', 1, 0);
    this.addChild(this.headerText);
  }

  get expanded(): boolean {
    return this._expanded;
  }

  set expanded(value: boolean) {
    if (this._expanded === value) return;
    this._expanded = value;
    if (!value) {
      // Collapse: detach all node texts
      for (const [id, texts] of this.nodeTexts) {
        if (this.nodeAttached.has(id)) {
          for (const t of texts) this.removeChild(t);
          this.nodeAttached.delete(id);
        }
      }
      this.stopSpinner();
    } else {
      // Expand: re-attach via rebuild
      this.rebuild();
    }
  }

  /** Initialize tracker with a new workflow's graph state. */
  initFromGraphState(state: GraphState): void {
    this.workflowName = state.name;
    this.totalLayers = state.totalLayers;
    this.completedLayers = state.completedLayers;
    this.startTime = Date.now();

    // Clear old nodes
    for (const texts of this.nodeTexts.values()) {
      for (const t of texts) this.removeChild(t);
    }
    this.nodeTexts.clear();
    this.nodeAttached.clear();
    this.trackedNodes.clear();

    // Build tracked nodes from graph state
    const nodes = state.nodes ?? {};
    for (const [id, node] of Object.entries(nodes)) {
      const n = node as any;
      const tracked: TrackedNode = {
        id,
        label: n.label ?? id,
        model: shortenModel(n.agent?.model ?? n.codingAgent?.model ?? ''),
        status: this.mapStatus(n.status),
        layer: n.layer ?? 0,
        lastMessage: undefined,
        progress: n.progress,
        nodeType: n.type,
      };
      this.trackedNodes.set(id, tracked);
    }

    this.rebuild();
  }

  /** Update from a new graph state snapshot. */
  updateFromGraphState(state: GraphState): void {
    this.completedLayers = state.completedLayers;
    this.totalLayers = state.totalLayers;

    const nodes = state.nodes ?? {};
    for (const [id, node] of Object.entries(nodes)) {
      const n = node as any;
      const existing = this.trackedNodes.get(id);
      if (existing) {
        existing.status = this.mapStatus(n.status);
        existing.progress = n.progress;
      } else {
        this.trackedNodes.set(id, {
          id,
          label: n.label ?? id,
          model: shortenModel(n.agent?.model ?? n.codingAgent?.model ?? ''),
          status: this.mapStatus(n.status),
          layer: n.layer ?? 0,
          progress: n.progress,
          nodeType: n.type,
        });
      }
    }

    // Check recent events for status messages
    for (const evt of state.recentEvents ?? []) {
      const tracked = this.trackedNodes.get(evt.nodeId);
      if (tracked && evt.message) {
        tracked.lastMessage = evt.message;
      }
    }

    this.rebuild();
  }

  /** Update a single node's status from a worker event. */
  updateNodeEvent(nodeId: string, type: string, message?: string): void {
    const tracked = this.trackedNodes.get(nodeId);
    if (!tracked) return;

    if (type === 'done') tracked.status = 'complete';
    else if (type === 'error') tracked.status = 'error';
    else if (type !== 'done' && type !== 'error' && tracked.status === 'pending') {
      tracked.status = 'running';
    }
    if (message) tracked.lastMessage = message;
    this.rebuild();
  }

  /** Check if workflow is still active. */
  get isActive(): boolean {
    return this.trackedNodes.size > 0 &&
      Array.from(this.trackedNodes.values()).some(n => n.status === 'pending' || n.status === 'running');
  }

  /** Clean up spinner subscription. */
  dispose(): void {
    this.stopSpinner();
  }

  private hasRunningNodes(): boolean {
    return Array.from(this.trackedNodes.values()).some(n => n.status === 'running');
  }

  private startSpinner(): void {
    if (this.unsubSpinner) return;
    this.unsubSpinner = omegaSpinner.subscribe(() => {
      this.rebuildNodeLines();
      this.onUpdate?.();
    });
  }

  private stopSpinner(): void {
    if (this.unsubSpinner) {
      this.unsubSpinner();
      this.unsubSpinner = null;
    }
  }

  private rebuild(): void {
    // Update header
    const elapsed = Math.round((Date.now() - this.startTime) / 1000);
    const done = Array.from(this.trackedNodes.values()).filter(n => n.status === 'complete').length;
    const total = this.trackedNodes.size;
    const running = Array.from(this.trackedNodes.values()).filter(n => n.status === 'running').length;
    const failed = Array.from(this.trackedNodes.values()).filter(n => n.status === 'error').length;

    const headerParts = [
      chalk.hex(palette.accent).bold(`${icons.workflowName} ${this.workflowName}`),
      chalk.hex(palette.dim)(formatDuration(elapsed)),
      chalk.hex(palette.success)(`${icons.complete} ${done}`) +
        chalk.hex(palette.dim)('/') +
        chalk.hex(palette.text)(`${total}`),
    ];
    if (running > 0) headerParts.push(chalk.hex(palette.info)(`${omegaSpinner.current} ${running} running`));
    if (failed > 0) headerParts.push(chalk.hex(palette.error)(`${icons.error} ${failed} failed`));
    headerParts.push(chalk.hex(palette.dim)(`layer ${this.completedLayers}/${this.totalLayers}`));

    this.headerText.setText(spacing.indent1 + headerParts.join(chalk.hex(palette.dim)(spacing.dot)));

    // Manage spinner subscription based on running state
    if (this.hasRunningNodes()) {
      this.startSpinner();
    } else {
      this.stopSpinner();
    }

    if (!this._expanded) return;

    this.rebuildNodeLines();
  }

  /** Update activity state from a full WorkerEvent. */
  handleWorkerEvent(nodeId: string, event: WorkerEvent): void {
    const tracked = this.trackedNodes.get(nodeId);
    if (!tracked) return;

    // Update status
    if (event.type === 'done') tracked.status = 'complete';
    else if (event.type === 'error') tracked.status = 'error';
    else if (tracked.status === 'pending') tracked.status = 'running';

    if (event.message) tracked.lastMessage = event.message;

    // Initialize activity state on first non-terminal event
    if (!tracked.activity && tracked.status === 'running') {
      tracked.activity = {
        toolCallCount: 0,
        filesRead: new Set(),
        filesModified: new Set(),
        startedAt: Date.now(),
        lastUpdateAt: Date.now(),
      };
    }

    const act = tracked.activity;
    if (!act) { this.rebuild(); return; }

    if (event.type === 'tool_call') {
      act.toolCallCount++;
      if (event.tool) {
        act.currentTool = event.tool.name;
        act.currentFile = event.tool.file;
        act.currentSummary = event.tool.summary;

        // Track files by tool type
        const toolLower = event.tool.name.toLowerCase();
        const file = event.tool.file;
        if (file) {
          if (toolLower === 'read' || toolLower === 'grep' || toolLower === 'glob') {
            act.filesRead.add(file);
          } else if (toolLower === 'write' || toolLower === 'edit') {
            act.filesModified.add(file);
          }
        }
      }
    } else if (event.type === 'tool_result') {
      act.currentTool = undefined;
      act.currentFile = undefined;
      act.currentSummary = undefined;
    } else if (event.type === 'loop_iteration' && event.data) {
      const data = event.data as { iteration?: number; maxIterations?: number };
      if (data.iteration) act.loopIteration = data.iteration;
      if (data.maxIterations) act.loopMaxIterations = data.maxIterations;
    } else if (event.type === 'status' && event.message) {
      act.currentSummary = event.message;
    }

    act.lastUpdateAt = Date.now();

    // Throttle visual rebuilds to ~3/sec
    const now = Date.now();
    if (now - this.lastRebuildAt < 300) return;
    this.lastRebuildAt = now;
    this.rebuild();
  }

  private rebuildNodeLines(): void {
    // Remove all existing node text elements
    for (const texts of this.nodeTexts.values()) {
      for (const t of texts) this.removeChild(t);
    }
    this.nodeTexts.clear();
    this.nodeAttached.clear();

    // Sort by layer then by id
    const sorted = Array.from(this.trackedNodes.values()).sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      return a.id.localeCompare(b.id);
    });

    for (const node of sorted) {
      const texts: Text[] = [];
      const icon = this.statusIcon(node.status);
      const nameColor =
        node.status === 'complete' ? palette.success :
        node.status === 'error' ? palette.error :
        node.status === 'running' ? palette.info :
        palette.dim;
      const name = chalk.hex(nameColor)(node.label);
      const model = node.model ? chalk.hex(palette.purple)(` [${node.model}]`) : '';

      // Main status line
      let mainLine: string;
      if (node.status === 'running' && node.activity) {
        const elapsed = Math.round((Date.now() - node.activity.startedAt) / 1000);
        mainLine = `${spacing.indent2}${icon} ${name}${model} ${chalk.hex(palette.dim)('— ' + formatDuration(elapsed) + ' elapsed')}`;
      } else {
        const msg = node.lastMessage
          ? chalk.hex(palette.dim)(` — ${truncate(node.lastMessage, 50)}`)
          : '';
        mainLine = `${spacing.indent2}${icon} ${name}${model}${msg}`;
      }
      texts.push(new Text(mainLine, 1, 0));

      // Activity + stats sub-lines for running nodes
      if (node.status === 'running' && node.activity) {
        const act = node.activity;
        const hasStats = act.toolCallCount > 0;

        // Activity line: what the worker is currently doing
        const connector = hasStats ? '├' : '└';
        const activityDesc = this.formatToolActivity(act);
        const actLine = `${spacing.indent3}${chalk.hex(palette.dim)(connector)} ${chalk.hex(palette.text)(activityDesc)}`;
        texts.push(new Text(actLine, 0, 0));

        // Stats line: cumulative counts
        if (hasStats) {
          const parts: string[] = [`${act.toolCallCount} tool calls`];
          if (act.filesRead.size > 0) parts.push(`${act.filesRead.size} files read`);
          if (act.filesModified.size > 0) parts.push(`${act.filesModified.size} files modified`);
          if (act.loopIteration) {
            const max = act.loopMaxIterations ? `/${act.loopMaxIterations}` : '';
            parts.push(`iteration ${act.loopIteration}${max}`);
          }
          const statsLine = `${spacing.indent3}${chalk.hex(palette.dim)('└')} ${chalk.hex(palette.dim)(parts.join(' · '))}`;
          texts.push(new Text(statsLine, 0, 0));
        }
      }
      // Summary stats for completed nodes with activity
      else if (node.status === 'complete' && node.activity && node.activity.toolCallCount > 0) {
        const act = node.activity;
        const parts: string[] = [`${act.toolCallCount} tool calls`];
        if (act.filesModified.size > 0) parts.push(`${act.filesModified.size} files modified`);
        const completedStats = `${spacing.indent3}${chalk.hex(palette.dim)('└')} ${chalk.hex(palette.dim)(parts.join(' · '))}`;
        texts.push(new Text(completedStats, 0, 0));
      }

      for (const t of texts) this.addChild(t);
      this.nodeTexts.set(node.id, texts);
      this.nodeAttached.add(node.id);
    }
  }

  /** Format human-readable activity description from current tool state. */
  private formatToolActivity(act: NodeActivityState): string {
    if (!act.currentTool) return 'Starting...';

    const toolName = act.currentTool.toLowerCase();
    const file = act.currentFile ? this.shortenPath(act.currentFile) : '';
    const summary = act.currentSummary ?? '';

    // Extract detail from summary (strip "ToolName: " prefix)
    const detail = summary.includes(':')
      ? summary.split(':').slice(1).join(':').trim()
      : file;
    const shortDetail = detail ? truncate(detail, 50) : '';

    switch (toolName) {
      case 'read': return `Reading ${shortDetail || file || 'file'}`;
      case 'write': return `Writing ${shortDetail || file || 'file'}`;
      case 'edit': return `Editing ${shortDetail || file || 'file'}`;
      case 'bash': return `Running ${shortDetail ? truncate(shortDetail, 40) : 'command'}`;
      case 'grep': return `Searching ${shortDetail || 'codebase'}`;
      case 'glob': return `Finding files${shortDetail ? ' ' + shortDetail : ''}`;
      case 'websearch': return 'Searching the web';
      case 'webfetch': return 'Fetching web page';
      default: return shortDetail ? truncate(shortDetail, 50) : 'Processing...';
    }
  }

  /** Shorten a file path to fit display width. */
  private shortenPath(path: string, maxLen: number = 45): string {
    if (path.length <= maxLen) return path;
    const parts = path.split('/');
    for (let start = 1; start < parts.length; start++) {
      const shortened = '…/' + parts.slice(start).join('/');
      if (shortened.length <= maxLen) return shortened;
    }
    return truncate(path, maxLen);
  }

  private statusIcon(status: string): string {
    switch (status) {
      case 'complete': return chalk.hex(palette.success)(icons.complete);
      case 'error': return chalk.hex(palette.error)(icons.error);
      case 'running': return chalk.hex(palette.info)(omegaSpinner.current);
      default: return chalk.hex(palette.dim)(icons.pending);
    }
  }

  private mapStatus(status: string | undefined): TrackedNode['status'] {
    switch (status) {
      case 'complete': case 'done': return 'complete';
      case 'error': case 'failed': return 'error';
      case 'running': case 'in_progress': return 'running';
      default: return 'pending';
    }
  }
}

/**
 * Manages multiple WorkflowTracker instances — one per concurrent workflow.
 * Supports focus mode: when focusedId is set, all other trackers collapse to header-only.
 */
export class MultiWorkflowTracker extends Container {
  readonly trackers = new Map<string, WorkflowTracker>();
  private focusedId: string | null = null;
  private removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Wire this to tui.requestRender() for spinner-driven re-renders. */
  onUpdate?: () => void;

  addWorkflow(workflowId: string, state: import('@orionomega/core').GraphState): void {
    if (!this.trackers.has(workflowId)) {
      const tracker = new WorkflowTracker();
      tracker.onUpdate = () => this.onUpdate?.();
      this.trackers.set(workflowId, tracker);
      this.addChild(tracker);
    }
    this.trackers.get(workflowId)!.initFromGraphState(state);
    this.updateVisibility();
  }

  updateWorkflow(workflowId: string, state: import('@orionomega/core').GraphState): void {
    const tracker = this.trackers.get(workflowId);
    if (!tracker) return;
    tracker.updateFromGraphState(state);

    // Schedule removal after completion
    if (state.status === 'complete' || state.status === 'error' || state.status === 'stopped') {
      if (!this.removalTimers.has(workflowId)) {
        const timer = setTimeout(() => {
          const t = this.trackers.get(workflowId);
          if (t) {
            t.dispose();
            this.removeChild(t);
            this.trackers.delete(workflowId);
          }
          this.removalTimers.delete(workflowId);
          if (this.focusedId === workflowId) this.focusedId = null;
          this.updateVisibility();
        }, 30_000);
        this.removalTimers.set(workflowId, timer);
      }
    }
  }

  /** @deprecated Use handleWorkerEvent for richer activity display. */
  updateNodeEvent(workflowId: string, nodeId: string, type: string, message?: string): void {
    this.trackers.get(workflowId)?.updateNodeEvent(nodeId, type, message);
  }

  /** Process a full WorkerEvent for streaming activity display. */
  handleWorkerEvent(workflowId: string, event: WorkerEvent): void {
    this.trackers.get(workflowId)?.handleWorkerEvent(event.nodeId, event);
  }

  setFocus(workflowId: string | null): void {
    this.focusedId = workflowId;
    this.updateVisibility();
  }

  get activeCount(): number {
    return [...this.trackers.values()].filter(t => t.isActive).length;
  }

  get totalRunningWorkers(): number {
    let count = 0;
    for (const tracker of this.trackers.values()) {
      if (tracker.isActive) count++;
    }
    return count;
  }

  private updateVisibility(): void {
    for (const [id, tracker] of this.trackers) {
      tracker.expanded = this.focusedId === null || this.focusedId === id;
    }
  }
}
