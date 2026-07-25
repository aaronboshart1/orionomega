/**
 * @module components/status-bar
 * Rich status bar showing gateway status, model, tokens, tasks, and workers.
 * Sits below the editor as a fixed-height bar.
 *
 * When the agent is thinking, the animated omega spinner replaces the green ●
 * to the left of "OmegaClaw". Similarly, when the memory store is busy the
 * spinner replaces the ◈ icon to the left of "Memory".
 */

import { Text } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { palette, spacing, icons } from '../theme.js';
import { shortenModel, formatCost, formatDuration } from '../utils/format.js';
import { omegaSpinner } from './omega-spinner.js';
import { VERSION_STRING } from '../version.js';

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
  /** Authoritative cumulative session cost from the server. */
  sessionCostUsd?: number;
  /** Current layer progress (1-based index of the layer being executed). */
  completedLayers?: number;
  /** Total number of layers in the workflow graph. */
  totalLayers?: number;
  /** Elapsed wall-clock seconds for the active workflow. */
  workflowElapsed?: number;
  /** Short labels describing what each active worker is doing. */
  workerSummaries?: string[];
  /**
   * What the memory store can currently do. Never a connectivity flag —
   * the bar reports capability, not sockets. Defaults to 'ready'.
   */
  memoryHealth?: 'ready' | 'rebuilding' | 'degraded';
  /** Rebuild progress 0-100, shown while `memoryHealth === 'rebuilding'`. */
  memoryPct?: number;
}

/**
 * Status bar component that renders a single line with key metrics.
 * Layout: [connection] | [memory] | [model] | [cost] | [tasks] | [workers] | [version]
 */
export class StatusBar extends Text {
  private _connected = false;
  private _thinking = false;
  private _memoryBusy = false;
  private _status: SessionStatus = {};
  private unsubSpinner: (() => void) | null = null;
  private unsubMemorySpinner: (() => void) | null = null;

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

  set memoryBusy(value: boolean) {
    if (this._memoryBusy === value) return;
    this._memoryBusy = value;
    if (value) {
      if (!this.unsubMemorySpinner) {
        this.unsubMemorySpinner = omegaSpinner.subscribe(() => {
          this.updateDisplay();
          this.onUpdate?.();
        });
      }
    } else if (this.unsubMemorySpinner) {
      this.unsubMemorySpinner();
      this.unsubMemorySpinner = null;
    }
    this.updateDisplay();
  }

  updateStatus(status: Partial<SessionStatus>): void {
    Object.assign(this._status, status);
    this.updateDisplay();
  }

  dispose(): void {
    if (this.unsubSpinner) {
      this.unsubSpinner();
      this.unsubSpinner = null;
    }
    if (this.unsubMemorySpinner) {
      this.unsubMemorySpinner();
      this.unsubMemorySpinner = null;
    }
  }

  private updateDisplay(): void {
    const parts: string[] = [];
    const sep = chalk.hex(palette.dim)(spacing.separator);

    // ── Connection / Agent status ──
    if (this._connected) {
      const icon = this._thinking
        ? chalk.hex(palette.accent)(omegaSpinner.current)
        : chalk.hex(palette.success)(icons.connected);
      parts.push(icon + chalk.hex(palette.dim)(' OmegaClaw'));
    } else {
      parts.push(chalk.hex(palette.error)(icons.disconnected) + chalk.hex(palette.dim)(' OmegaClaw'));
    }

    // ── Memory status ──
    // Always rendered: there is no connectivity gate, and the bar never says
    // "offline". The colour and suffix say what memory can currently do.
    const memoryHealth = this._status.memoryHealth ?? 'ready';
    const memoryColor = memoryHealth === 'ready'
      ? palette.success
      : memoryHealth === 'rebuilding'
        ? palette.warning
        : palette.error;
    const memoryIcon = this._memoryBusy
      ? chalk.hex(palette.accent)(omegaSpinner.current)
      : chalk.hex(memoryColor)(icons.memory);
    let memoryLabel = ' Memory';
    if (memoryHealth === 'rebuilding') {
      const pct = this._status.memoryPct;
      memoryLabel += pct !== undefined ? ` rebuilding ${Math.round(pct)}%` : ' rebuilding';
    } else if (memoryHealth === 'degraded') {
      memoryLabel += ' degraded';
    }
    parts.push(memoryIcon + chalk.hex(memoryHealth === 'ready' ? palette.dim : memoryColor)(memoryLabel));

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
    const accumulatedCost = this._status.sessionCostUsd ?? 0;
    const inProgressCost = this._status.estimatedCost ?? 0;
    const displayCost = accumulatedCost + inProgressCost;
    if (displayCost > 0 && isFinite(displayCost)) {
      const costColor = displayCost >= 10 ? palette.error : palette.text;
      parts.push(chalk.hex(palette.dim)(icons.cost) + chalk.hex(costColor)(displayCost.toFixed(2)));
    } else if (this._status.model) {
      parts.push(chalk.hex(palette.dim)(formatCost(0)));
    }

    // ── Version (far right, dim) ──
    const version = chalk.hex(palette.dim)(VERSION_STRING);
    const mainLine = spacing.indent1 + parts.join(sep) + sep + version;

    this.setText(mainLine);
  }

}
