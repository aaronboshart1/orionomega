/**
 * @module components/status-bar
 * Rich status bar showing gateway status, model, tokens, tasks, and workers.
 * Sits below the editor as a fixed-height bar.
 *
 * When the agent is thinking, the animated omega spinner replaces the green ●
 * to the left of "OmegaClaw". Similarly, when Hindsight is busy the spinner
 * replaces the ◈ icon to the left of "Hindsight".
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
 * Layout: [connection] | [hindsight] | [model] | [cost] | [tasks] | [workers] | [version]
 */
export class StatusBar extends Text {
  private _connected = false;
  private _thinking = false;
  private _hindsightBusy = false;
  private _status: SessionStatus = {};
  private unsubSpinner: (() => void) | null = null;
  private unsubHindsightSpinner: (() => void) | null = null;

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

  updateStatus(status: Partial<SessionStatus>): void {
    Object.assign(this._status, status);
    this.updateDisplay();
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

    // ── Connection / Agent status ──
    if (this._connected) {
      const icon = this._thinking
        ? chalk.hex(palette.accent)(omegaSpinner.current)
        : chalk.hex(palette.success)(icons.connected);
      parts.push(icon + chalk.hex(palette.dim)(' OmegaClaw'));
    } else {
      parts.push(chalk.hex(palette.error)(icons.disconnected) + chalk.hex(palette.dim)(' OmegaClaw'));
    }

    // ── Hindsight status ──
    const hsConnected = this._status.hindsightConnected;
    if (hsConnected === true) {
      const icon = this._hindsightBusy
        ? chalk.hex(palette.accent)(omegaSpinner.current)
        : chalk.hex(palette.success)(icons.hindsight);
      parts.push(icon + chalk.hex(palette.dim)(' Hindsight'));
    } else if (hsConnected === false) {
      parts.push(
        chalk.hex(palette.error)(icons.hindsight) +
        chalk.hex(palette.error)(' OFFLINE')
      );
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

    // ── Version (far right, dim) ──
    const version = chalk.hex(palette.dim)(VERSION_STRING);
    const mainLine = spacing.indent1 + parts.join(sep) + sep + version;

    this.setText(mainLine);
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
