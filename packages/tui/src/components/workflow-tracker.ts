/**
 * @module components/workflow-tracker
 * Displays workflow progress aligned to the approved plan.
 * Shows each task with status indicators using shared theme constants.
 * Rendered as a persistent block in the chat log when a workflow is active.
 */

import { Container, Text } from '@mariozechner/pi-tui';
import type { GraphState } from '@orionomega/core';
import chalk from 'chalk';
import { palette, spacing, icons } from '../theme.js';
import { shortenModel, truncate, formatDuration } from '../utils/format.js';
import { omegaSpinner } from './omega-spinner.js';

interface TrackedNode {
  id: string;
  label: string;
  model: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  layer: number;
  lastMessage?: string;
  progress?: number;
  elapsed?: number;
}

/**
 * Visual workflow tracker that updates in-place as tasks progress.
 */
export class WorkflowTracker extends Container {
  private headerText: Text;
  private nodeTexts = new Map<string, Text>();
  private nodeAttached = new Set<string>();
  private trackedNodes = new Map<string, TrackedNode>();
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
      for (const [id, text] of this.nodeTexts) {
        if (this.nodeAttached.has(id)) {
          this.removeChild(text);
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
    for (const text of this.nodeTexts.values()) {
      this.removeChild(text);
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
        model: shortenModel(n.agent?.model ?? ''),
        status: this.mapStatus(n.status),
        layer: n.layer ?? 0,
        lastMessage: undefined,
        progress: n.progress,
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
          model: shortenModel(n.agent?.model ?? ''),
          status: this.mapStatus(n.status),
          layer: n.layer ?? 0,
          progress: n.progress,
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

  private rebuildNodeLines(): void {
    // Sort by layer then by id
    const sorted = Array.from(this.trackedNodes.values()).sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      return a.id.localeCompare(b.id);
    });

    for (const node of sorted) {
      const icon = this.statusIcon(node.status);
      const name = chalk.hex(
        node.status === 'complete' ? palette.success :
        node.status === 'error' ? palette.error :
        node.status === 'running' ? palette.info :
        palette.dim
      )(node.label);
      const model = node.model ? chalk.hex(palette.purple)(` [${node.model}]`) : '';
      const msg = node.lastMessage
        ? chalk.hex(palette.dim)(` — ${truncate(node.lastMessage, 50)}`)
        : '';

      const line = `${spacing.indent2}${icon} ${name}${model}${msg}`;

      const existing = this.nodeTexts.get(node.id);
      if (existing) {
        existing.setText(line);
        if (!this.nodeAttached.has(node.id)) {
          this.addChild(existing);
          this.nodeAttached.add(node.id);
        }
      } else {
        const text = new Text(line, 1, 0);
        this.addChild(text);
        this.nodeTexts.set(node.id, text);
        this.nodeAttached.add(node.id);
      }
    }
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
