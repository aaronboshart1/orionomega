/**
 * @module components/node-display
 * Multi-line display for a single workflow node.
 * Renders 1-3 lines depending on node status:
 *   Running:  spinner + label + model + elapsed, activity line, progress line
 *   Complete: checkmark + label + model + duration, summary line
 *   Pending:  circle + label + model, dependency line
 *   Error:    x + label + model + duration, error line
 *   Skipped:  slash + label + model (single line)
 */

import { Container, Text } from '@mariozechner/pi-tui';
import type { WorkerEvent } from '@orionomega/core';
import chalk from 'chalk';
import { palette, spacing, icons } from '../theme.js';
import { truncate, formatDuration } from '../utils/format.js';
import { omegaSpinner } from './omega-spinner.js';

// ── Types ────────────────────────────────────────────────────────────

export type NodeStatusType = 'pending' | 'running' | 'complete' | 'error' | 'skipped' | 'cancelled';

export interface NodeState {
  id: string;
  label: string;
  model: string;
  type: string;
  status: NodeStatusType;
  layer: number;
  dependsOn: string[];
  dependencyLabels: string[];
  progress: number;
  elapsed: number;
  startedAt?: number;
  duration?: number;
  errorMessage?: string;
  resultSummary?: string;
}

/** Minimal shape of a runtime graph node as received from the server. */
export interface GraphNodeSnapshot {
  status?: string;
  startedAt?: string;
  completedAt?: string;
  progress?: number;
  error?: string;
}

export function mapNodeStatus(status: string | undefined): NodeStatusType {
  switch (status) {
    case 'done': case 'complete': return 'complete';
    case 'error': case 'failed': return 'error';
    case 'running': case 'in_progress': return 'running';
    case 'skipped': return 'skipped';
    case 'cancelled': return 'cancelled';
    default: return 'pending';
  }
}

// ── Progress Bar (styled) ────────────────────────────────────────────

function styledProgressBar(pct: number, width = 18): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return chalk.hex(palette.info)('\u2588'.repeat(filled)) +
         chalk.hex(palette.dim)('\u2591'.repeat(empty));
}

// ── Event Accumulator ────────────────────────────────────────────────

/**
 * Accumulates WorkerEvents for a single node to derive current activity,
 * tool call count, findings, and progress.
 */
export class NodeEventAccumulator {
  private _toolCalls: Array<{ name: string; file?: string; summary: string }> = [];
  private _latestActivity = '';
  private _latestThinking = '';
  private _findings: string[] = [];

  processEvent(event: WorkerEvent): void {
    switch (event.type) {
      case 'tool_call':
        if (event.tool) {
          this._toolCalls.push(event.tool);
          if (event.tool.file) {
            const action = event.tool.action ?? event.tool.name;
            this._latestActivity = `${action.charAt(0).toUpperCase() + action.slice(1)} ${event.tool.file}`;
          } else if (event.tool.summary) {
            this._latestActivity = `${event.tool.name} \u2014 ${event.tool.summary}`;
          } else {
            this._latestActivity = `Running ${event.tool.name}`;
          }
        }
        break;

      case 'status':
        if (event.message) this._latestActivity = event.message;
        break;

      case 'thinking':
        if (event.thinking) this._latestThinking = event.thinking;
        break;

      case 'finding':
        if (event.message) this._findings.push(event.message);
        break;

      case 'error':
        this._latestActivity = event.error ?? event.message ?? 'Error';
        break;

      case 'loop_iteration': {
        const data = event.data as { iteration?: number; maxIterations?: number } | undefined;
        if (data) {
          this._latestActivity = `Iteration ${data.iteration ?? '?'}/${data.maxIterations ?? '?'}`;
        }
        break;
      }
    }
  }

  get activity(): string { return this._latestActivity || this._latestThinking; }
  get toolCount(): number { return this._toolCalls.length; }
  get findings(): string[] { return this._findings; }
}

// ── NodeDisplay Component ────────────────────────────────────────────

/**
 * Renders a single workflow node as 1-3 lines depending on status.
 * Reuses persistent Text children to avoid tree mutations on every update.
 */
export class NodeDisplay extends Container {
  private mainLine: Text;
  private subLine1: Text;
  private subLine2: Text;
  private sub1Attached = false;
  private sub2Attached = false;
  private lastRenderedStatus: NodeStatusType | null = null;
  readonly state: NodeState;
  readonly accumulator = new NodeEventAccumulator();

  constructor(state: NodeState) {
    super();
    this.state = state;
    this.mainLine = new Text('', 1, 0);
    this.subLine1 = new Text('', 1, 0);
    this.subLine2 = new Text('', 1, 0);
    this.addChild(this.mainLine);
    this.rebuild();
  }

  updateFromEvent(event: WorkerEvent): void {
    this.accumulator.processEvent(event);
    if (event.progress !== undefined) this.state.progress = event.progress;

    if (event.type === 'done') {
      this.state.status = 'complete';
      this.state.resultSummary = event.message;
      if (this.state.startedAt) {
        this.state.duration = Math.round((Date.now() - this.state.startedAt) / 1000);
      }
    } else if (event.type === 'error') {
      this.state.status = 'error';
      this.state.errorMessage = event.error ?? event.message;
      if (this.state.startedAt) {
        this.state.duration = Math.round((Date.now() - this.state.startedAt) / 1000);
      }
    } else if (this.state.status === 'pending') {
      this.state.status = 'running';
      if (!this.state.startedAt) this.state.startedAt = Date.now();
    }

    this.rebuild();
  }

  updateFromGraphNode(node: GraphNodeSnapshot): void {
    const newStatus = mapNodeStatus(node.status);
    if (newStatus === 'running' && !this.state.startedAt) {
      this.state.startedAt = node.startedAt ? new Date(node.startedAt).getTime() : Date.now();
    }
    if ((newStatus === 'complete' || newStatus === 'error' || newStatus === 'cancelled') && node.completedAt && node.startedAt) {
      this.state.duration = Math.round(
        (new Date(node.completedAt).getTime() - new Date(node.startedAt).getTime()) / 1000,
      );
    }
    this.state.status = newStatus;
    if (node.progress !== undefined) this.state.progress = node.progress;
    if (node.error) this.state.errorMessage = node.error;
    this.rebuild();
  }

  tickUpdate(): void {
    if (this.state.status !== 'running') return;
    if (this.state.startedAt) {
      this.state.elapsed = Math.round((Date.now() - this.state.startedAt) / 1000);
    }
    const model = this.state.model
      ? chalk.hex(palette.purple)(` [${this.state.model}]`)
      : '';
    const icon = chalk.hex(palette.info)(omegaSpinner.current);
    const label = chalk.hex(palette.info)(this.state.label);
    const elapsed = chalk.hex(palette.dim)(formatDuration(this.state.elapsed));
    this.mainLine.setText(`${spacing.indent2}${icon} ${label}${model}  ${elapsed}`);
  }

  private ensureSub1(): void {
    if (!this.sub1Attached) {
      this.addChild(this.subLine1);
      this.sub1Attached = true;
    }
  }

  private removeSub1(): void {
    if (this.sub1Attached) {
      this.removeChild(this.subLine1);
      this.sub1Attached = false;
    }
  }

  private ensureSub2(): void {
    if (!this.sub2Attached) {
      this.addChild(this.subLine2);
      this.sub2Attached = true;
    }
  }

  private removeSub2(): void {
    if (this.sub2Attached) {
      this.removeChild(this.subLine2);
      this.sub2Attached = false;
    }
  }

  rebuild(): void {
    const { state, accumulator } = this;
    const model = state.model
      ? chalk.hex(palette.purple)(` [${state.model}]`)
      : '';

    const needsSub1Before = this.sub1Attached;
    const needsSub2Before = this.sub2Attached;
    let wantSub1 = false;
    let wantSub2 = false;

    switch (state.status) {
      case 'running': {
        const hasActivity = this.renderRunning(model, state, accumulator);
        const hasProgress = this.renderRunningProgressLine(state, accumulator, hasActivity);
        wantSub1 = hasActivity || hasProgress;
        wantSub2 = hasActivity && hasProgress;
        break;
      }
      case 'complete':
        wantSub1 = this.renderComplete(model, state, accumulator);
        break;
      case 'pending':
        wantSub1 = this.renderPending(model, state);
        break;
      case 'error':
        wantSub1 = this.renderError(model, state);
        break;
      case 'skipped':
        this.renderSkipped(model, state);
        break;
      case 'cancelled':
        this.renderCancelled(model, state);
        break;
    }

    const statusChanged = this.lastRenderedStatus !== state.status;
    this.lastRenderedStatus = state.status;

    if (statusChanged) {
      if (needsSub2Before) this.removeSub2();
      if (needsSub1Before) this.removeSub1();
      if (wantSub1) this.ensureSub1();
      if (wantSub2) this.ensureSub2();
    } else {
      if (!wantSub2 && needsSub2Before) this.removeSub2();
      if (!wantSub1 && needsSub1Before) this.removeSub1();
      if (wantSub1 && !needsSub1Before) this.ensureSub1();
      if (wantSub2 && !needsSub2Before) this.ensureSub2();
    }
  }

  private renderRunning(model: string, state: NodeState, acc: NodeEventAccumulator): boolean {
    if (state.startedAt) {
      state.elapsed = Math.round((Date.now() - state.startedAt) / 1000);
    }
    const icon = chalk.hex(palette.info)(omegaSpinner.current);
    const label = chalk.hex(palette.info)(state.label);
    const elapsed = chalk.hex(palette.dim)(formatDuration(state.elapsed));
    this.mainLine.setText(`${spacing.indent2}${icon} ${label}${model}  ${elapsed}`);

    const activity = acc.activity;
    if (activity) {
      this.subLine1.setText(
        `${spacing.indent3}${chalk.hex(palette.border)(icons.treeMiddle)} ${chalk.hex(palette.text)(truncate(activity, 60))}`,
      );
      return true;
    }
    return false;
  }

  private renderRunningProgressLine(state: NodeState, acc: NodeEventAccumulator, hasActivity: boolean): boolean {
    if (acc.toolCount > 0 || state.progress > 0) {
      const parts: string[] = [];
      if (acc.toolCount > 0) parts.push(`${acc.toolCount} tool calls`);
      let pctPart = '';
      if (state.progress > 0) {
        const pct = Math.round(state.progress);
        pctPart = ` \u00b7 ${chalk.hex(palette.info)(`${pct}%`)}  ${styledProgressBar(state.progress)}`;
      }
      const target = hasActivity ? this.subLine2 : this.subLine1;
      target.setText(
        `${spacing.indent3}${chalk.hex(palette.border)(icons.treeLast)} ${chalk.hex(palette.dim)(parts.join(' \u00b7 '))}${pctPart}`,
      );
      return true;
    }
    return false;
  }

  private renderComplete(model: string, state: NodeState, acc: NodeEventAccumulator): boolean {
    const icon = chalk.hex(palette.success)(icons.complete);
    const label = chalk.hex(palette.success)(state.label);
    const timeParts: string[] = [];
    if (state.duration !== undefined) timeParts.push(formatDuration(state.duration));
    const timeStr = timeParts.length > 0
      ? `  ${chalk.hex(palette.dim)(timeParts.join(' \u00b7 '))}`
      : '';
    this.mainLine.setText(`${spacing.indent2}${icon} ${label}${model}${timeStr}`);

    const summaryParts: string[] = [];
    if (acc.toolCount > 0) summaryParts.push(`${acc.toolCount} tool calls`);
    if (state.resultSummary) summaryParts.push(truncate(state.resultSummary, 50));
    else if (summaryParts.length === 0) summaryParts.push('Complete');
    this.subLine1.setText(
      `${spacing.indent3}${chalk.hex(palette.border)(icons.treeLast)} ${chalk.hex(palette.dim)(summaryParts.join(' \u00b7 '))}`,
    );
    return true;
  }

  private renderPending(model: string, state: NodeState): boolean {
    const icon = chalk.hex(palette.dim)(icons.pending);
    const label = chalk.hex(palette.dim)(state.label);
    this.mainLine.setText(`${spacing.indent2}${icon} ${label}${model}`);

    const deps = state.dependencyLabels.length > 0
      ? state.dependencyLabels.join(', ')
      : '\u2014';
    this.subLine1.setText(
      `${spacing.indent3}${chalk.hex(palette.border)(icons.treeLast)} ${chalk.hex(palette.dim)(`waiting on: ${deps}`)}`,
    );
    return true;
  }

  private renderError(model: string, state: NodeState): boolean {
    const icon = chalk.hex(palette.error)(icons.error);
    const label = chalk.hex(palette.error)(state.label);
    const dur = state.duration !== undefined
      ? `  ${chalk.hex(palette.dim)(formatDuration(state.duration))}`
      : '';
    this.mainLine.setText(`${spacing.indent2}${icon} ${label}${model}${dur}`);

    const errMsg = state.errorMessage || 'Unknown error';
    this.subLine1.setText(
      `${spacing.indent3}${chalk.hex(palette.border)(icons.treeLast)} ${chalk.hex(palette.error)(`${icons.error} Error: ${truncate(errMsg, 55)}`)}`,
    );
    return true;
  }

  private renderCancelled(model: string, state: NodeState): void {
    const label = chalk.hex(palette.dim)(state.label);
    this.mainLine.setText(
      `${spacing.indent2}${chalk.hex(palette.dim)(icons.skipped)} ${label}${model} ${chalk.hex(palette.dim)('\u2014 cancelled')}`,
    );
  }

  private renderSkipped(model: string, state: NodeState): void {
    const label = chalk.hex(palette.dim)(state.label);
    this.mainLine.setText(
      `${spacing.indent2}${chalk.hex(palette.dim)(icons.skipped)} ${label}${model} ${chalk.hex(palette.dim)('\u2014 skipped')}`,
    );
  }
}
