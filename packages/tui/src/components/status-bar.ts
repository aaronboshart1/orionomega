/**
 * @module components/status-bar
 * Rich status bar showing gateway status, model, tokens, tasks, and workers.
 * Sits below the editor as a fixed-height bar.
 */

import { Text } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { palette, spacing, icons } from '../theme.js';
import { shortenModel, formatCost, formatDuration, truncate } from '../utils/format.js';
import { omegaSpinner } from './omega-spinner.js';

export interface SessionStatus {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  maxContextTokens?: number;
  activeTasks?: number;
  activeWorkers?: number;
  completedTasks?: number;
  totalTasks?: number;
  estimatedCost?: number;
  /** Current layer progress (1-based index of the layer being executed). */
  completedLayers?: number;
  /** Total number of layers in the workflow graph. */
  totalLayers?: number;
  /** Elapsed wall-clock seconds for the active workflow. */
  workflowElapsed?: number;
  /** Short labels describing what each active worker is doing. */
  workerSummaries?: string[];
  /** Whether hindsight is connected. */
  hindsightConnected?: boolean;
  /** Whether hindsight I/O is in progress. */
  hindsightBusy?: boolean;
}

/**
 * Status bar component that renders a single line with key metrics.
 * Layout: [connection] | [model] | [cost] | [tasks] | [workers]
 *
 * [H2] Per-workflow state isolation:
 * When multiple workflows run concurrently, each workflow's GraphState
 * snapshots are stored separately in `_workflowStates` and aggregated
 * (summed for counters, max for elapsed) before display. This prevents
 * incoherent mixed-state display (e.g. "Layer 2/8" where 2 comes from
 * workflow A and 8 from workflow B).
 *
 * Callers should prefer `updateWorkflowStatus(workflowId, ...)` for
 * workflow-scoped updates and `clearWorkflowStatus(workflowId)` when a
 * workflow ends. The legacy `updateStatus()` continues to work for
 * non-workflow fields (model, tokens, etc.).
 */
export class StatusBar extends Text {
  private _connected = false;
  private _thinking = false;
  private _hindsightBusy = false;
  private _status: SessionStatus = {};
  private unsubSpinner: (() => void) | null = null;
  private unsubHindsightSpinner: (() => void) | null = null;

  /**
   * [H2] Per-workflow state store. Each active workflow maintains its own
   * partial SessionStatus. These are aggregated in aggregate() before rendering
   * so no two workflows' data are ever mixed into the same displayed metric.
   */
  private readonly _workflowStates = new Map<string, Partial<SessionStatus>>();

  /** Called when the status bar updates itself (e.g. spinner tick). Wire to tui.requestRender(). */
  onUpdate?: () => void;

  constructor() {
    super('', 1, 0);
    this.updateDisplay();
  }

  set connected(value: boolean) {
    this._connected = value;
    this.updateDisplay();
  }

  get connected(): boolean {
    return this._connected;
  }

  set thinking(value: boolean) {
    if (this._thinking === value) return;
    this._thinking = value;
    if (value) {
      if (!this.unsubSpinner) {
        this.unsubSpinner = omegaSpinner.subscribe(() => {
          this.updateDisplay();
          this.onUpdate?.();
        });
      }
    } else if (this.unsubSpinner) {
      this.unsubSpinner();
      this.unsubSpinner = null;
    }
    this.updateDisplay();
  }

  set hindsightBusy(value: boolean) {
    if (this._hindsightBusy === value) return;
    this._hindsightBusy = value;
    if (value) {
      if (!this.unsubHindsightSpinner) {
        this.unsubHindsightSpinner = omegaSpinner.subscribe(() => {
          this.updateDisplay();
          this.onUpdate?.();
        });
      }
    } else if (this.unsubHindsightSpinner) {
      this.unsubHindsightSpinner();
      this.unsubHindsightSpinner = null;
    }
    this.updateDisplay();
  }

  /**
   * Update non-workflow-scoped fields (model, tokens, hindsight status, etc.).
   * These fields are stored on `_status` and preserved across workflow state
   * aggregation. For workflow-specific metrics use `updateWorkflowStatus`.
   */
  updateStatus(status: Partial<SessionStatus>): void {
    Object.assign(this._status, status);
    this.updateDisplay();
  }

  /**
   * [H2] Update the status for a specific workflow.
   * Merges the partial status into the per-workflow store and re-aggregates
   * all active workflow states before rendering. This ensures that concurrent
   * workflows display coherent, workflow-isolated metrics rather than a
   * last-write-wins mix of fields from different workflows.
   *
   * @param workflowId - The workflow ID (used as the isolation key).
   * @param status     - Partial status fields from this workflow's GraphState.
   */
  updateWorkflowStatus(workflowId: string, status: Partial<SessionStatus>): void {
    this._workflowStates.set(workflowId, {
      ...this._workflowStates.get(workflowId),
      ...status,
    });
    this._status = this.aggregate();
    this.updateDisplay();
  }

  /**
   * [H2] Remove a workflow's state from the per-workflow store.
   * Call this when a workflow ends (completed, error, or stopped) so its
   * metrics are no longer included in the aggregated display.
   *
   * @param workflowId - The workflow ID to clear.
   */
  clearWorkflowStatus(workflowId: string): void {
    this._workflowStates.delete(workflowId);
    this._status = this.aggregate();
    this.updateDisplay();
  }

  /**
   * [H2] Aggregate per-workflow states into a single SessionStatus for rendering.
   *
   * Aggregation rules:
   * - Numeric counters (layers, workers, tasks, cost): summed across all workflows
   * - workflowElapsed: max (show the longest-running workflow's elapsed time)
   * - workerSummaries: concatenated from all workflows
   * - Non-workflow fields (model, tokens, hindsight): preserved from _status
   */
  private aggregate(): SessionStatus {
    // Preserve non-workflow fields from current _status
    const base: SessionStatus = {
      model: this._status.model,
      inputTokens: this._status.inputTokens,
      outputTokens: this._status.outputTokens,
      cacheCreationTokens: this._status.cacheCreationTokens,
      cacheReadTokens: this._status.cacheReadTokens,
      maxContextTokens: this._status.maxContextTokens,
      hindsightConnected: this._status.hindsightConnected,
      hindsightBusy: this._status.hindsightBusy,
    };

    if (this._workflowStates.size === 0) return base;

    let completedLayers = 0;
    let totalLayers = 0;
    let activeWorkers = 0;
    let estimatedCost = 0;
    let completedTasks = 0;
    let totalTasks = 0;
    let activeTasks = 0;
    let workflowElapsed = 0;
    const workerSummaries: string[] = [];

    for (const s of this._workflowStates.values()) {
      completedLayers += s.completedLayers ?? 0;
      totalLayers     += s.totalLayers ?? 0;
      activeWorkers   += s.activeWorkers ?? 0;
      estimatedCost   += s.estimatedCost ?? 0;
      completedTasks  += s.completedTasks ?? 0;
      totalTasks      += s.totalTasks ?? 0;
      activeTasks     += s.activeTasks ?? 0;
      // Show the elapsed time of the longest-running workflow
      workflowElapsed  = Math.max(workflowElapsed, s.workflowElapsed ?? 0);
      workerSummaries.push(...(s.workerSummaries ?? []));
    }

    return {
      ...base,
      completedLayers,
      totalLayers,
      activeWorkers,
      estimatedCost,
      completedTasks,
      totalTasks,
      activeTasks,
      workflowElapsed,
      workerSummaries,
    };
  }

  dispose(): void {
    if (this.unsubSpinner) {
      this.unsubSpinner();
      this.unsubSpinner = null;
    }
    if (this.unsubHindsightSpinner) {
      this.unsubHindsightSpinner();
      this.unsubHindsightSpinner = null;
    }
  }

  private updateDisplay(): void {
    const parts: string[] = [];
    const sep = chalk.hex(palette.dim)(spacing.separator);

    // ── Connection status ──
    if (this._connected) {
      parts.push(chalk.hex(palette.success)(icons.connected) + chalk.hex(palette.dim)(' connected'));
    } else {
      parts.push(chalk.hex(palette.error)(icons.disconnected) + chalk.hex(palette.dim)(' disconnected'));
    }

    // ── Hindsight status ──
    const hsConnected = this._status.hindsightConnected;
    if (hsConnected === true) {
      if (this._hindsightBusy) {
        parts.push(
          chalk.hex(palette.accent)(omegaSpinner.current) + ' ' +
          chalk.hex(palette.success)(icons.hindsight) +
          chalk.hex(palette.dim)(' Hindsight')
        );
      } else {
        parts.push(
          chalk.hex(palette.success)(icons.hindsight) +
          chalk.hex(palette.dim)(' Hindsight')
        );
      }
    } else if (hsConnected === false) {
      parts.push(
        chalk.hex(palette.error)(icons.hindsight) +
        chalk.hex(palette.dim)(' Hindsight')
      );
    }

    // ── Thinking indicator ──
    if (this._thinking) {
      parts.push(chalk.hex(palette.accent)(omegaSpinner.current));
    }

    // ── Model (shown when no workflow is active, to save space) ──
    const totalLayers = this._status.totalLayers ?? 0;
    const hasWorkflow = totalLayers > 0;
    if (this._status.model && !hasWorkflow) {
      const shortModel = shortenModel(this._status.model);
      parts.push(chalk.hex(palette.purple)(icons.model) + ' ' + chalk.hex(palette.text)(shortModel));
    }

    // ── Layer progress (workflow active) ──
    const completedLayers = this._status.completedLayers ?? 0;
    if (hasWorkflow) {
      parts.push(chalk.hex(palette.info)(`Layer ${completedLayers}/${totalLayers}`));
    }

    // ── Node completion ──
    const completedTasks = this._status.completedTasks ?? 0;
    const totalTasks = this._status.totalTasks ?? 0;
    if (totalTasks > 0) {
      parts.push(
        chalk.hex(palette.success)(icons.complete) + ' ' +
        chalk.hex(palette.text)(`${completedTasks}/${totalTasks}`)
      );
    }

    // ── Active workers ──
    const workers = this._status.activeWorkers ?? 0;
    if (workers > 0) {
      parts.push(
        chalk.hex(palette.info)(icons.worker) + ' ' +
        chalk.hex(palette.text)(`${workers} active`)
      );
    }

    // ── Elapsed time (workflow active) ──
    const elapsed = this._status.workflowElapsed ?? 0;
    if (hasWorkflow && elapsed > 0) {
      parts.push(chalk.hex(palette.dim)(formatDuration(elapsed)));
    }

    // ── Estimated time remaining ──
    if (completedTasks > 0 && totalTasks > 0 && completedTasks < totalTasks && elapsed > 0) {
      const rate = elapsed / completedTasks;
      const remaining = Math.round(rate * (totalTasks - completedTasks));
      parts.push(chalk.hex(palette.dim)(`~${formatDuration(remaining)} remaining`));
    }

    // ── Session cost ──
    const input = this._status.inputTokens ?? 0;
    const output = this._status.outputTokens ?? 0;
    const cacheCreation = this._status.cacheCreationTokens ?? 0;
    const cacheRead = this._status.cacheReadTokens ?? 0;
    const sessionCost = this.computeCost(input, output, cacheCreation, cacheRead, this._status.model);
    const displayCost = (this._status.estimatedCost ?? 0) + sessionCost;
    if (displayCost > 0 && isFinite(displayCost)) {
      const costColor = displayCost >= 10 ? palette.error : palette.text;
      parts.push(chalk.hex(palette.dim)(icons.cost) + chalk.hex(costColor)(displayCost.toFixed(2)));
    } else if (this._status.model) {
      parts.push(chalk.hex(palette.dim)(formatCost(0)));
    }

    const mainLine = spacing.indent1 + parts.join(sep);

    // ── Worker activity line (second line, only when workers are active) ──
    const summaries = this._status.workerSummaries ?? [];
    if (summaries.length > 0) {
      const workerParts = summaries
        .slice(0, 4)
        .map((label, i) =>
          chalk.hex(palette.info)(icons.worker) + ' ' +
          chalk.hex(palette.dim)(`Worker ${i + 1}:`) + ' ' +
          chalk.hex(palette.text)(truncate(label, 30))
        );
      const workerLine = spacing.indent1 + workerParts.join(chalk.hex(palette.dim)(spacing.dot));
      this.setText(workerLine + '\n' + mainLine);
    } else {
      this.setText(mainLine);
    }
  }

  /**
   * Estimate cost from token counts + model name.
   * Prices per million tokens as of mid-2025.
   * Cache reads = 10% of input price, cache creation = 125% of input price (25% premium).
   */
  private computeCost(inputTokens: number, outputTokens: number, cacheCreationTokens: number, cacheReadTokens: number, model?: string): number {
    const pricing: Record<string, [number, number]> = {
      'opus':    [15.0,  75.0],
      'sonnet':  [3.0,   15.0],
      'haiku':   [0.8,   4.0],
    };
    let rates: [number, number] = [3.0, 15.0]; // default sonnet
    if (model) {
      const lower = model.toLowerCase();
      for (const [key, val] of Object.entries(pricing)) {
        if (lower.includes(key)) { rates = val; break; }
      }
    }
    const inputCost = (inputTokens / 1_000_000) * rates[0];
    const outputCost = (outputTokens / 1_000_000) * rates[1];
    const cacheCreationCost = (cacheCreationTokens / 1_000_000) * rates[0] * 1.25;
    const cacheReadCost = (cacheReadTokens / 1_000_000) * rates[0] * 0.1;
    return inputCost + outputCost + cacheCreationCost + cacheReadCost;
  }
}
