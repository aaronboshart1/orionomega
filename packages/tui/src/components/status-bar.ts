/**
 * @module components/status-bar
 * Rich status bar showing gateway status, model, tokens, tasks, and workers.
 * Sits below the editor as a fixed-height bar.
 */

import { Text } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { palette, spacing, icons } from '../theme.js';
import { shortenModel, formatCost } from '../utils/format.js';
import { omegaSpinner } from './omega-spinner.js';

export interface SessionStatus {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  maxContextTokens?: number;
  activeTasks?: number;
  activeWorkers?: number;
  completedTasks?: number;
  totalTasks?: number;
  estimatedCost?: number;
}

/**
 * Status bar component that renders a single line with key metrics.
 * Layout: [connection] | [model] | [cost] | [tasks] | [workers]
 */
export class StatusBar extends Text {
  private _connected = false;
  private _thinking = false;
  private _status: SessionStatus = {};
  private unsubSpinner: (() => void) | null = null;

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

  updateStatus(status: Partial<SessionStatus>): void {
    Object.assign(this._status, status);
    this.updateDisplay();
  }

  dispose(): void {
    if (this.unsubSpinner) {
      this.unsubSpinner();
      this.unsubSpinner = null;
    }
  }

  private updateDisplay(): void {
    const parts: string[] = [];

    // Connection status
    if (this._connected) {
      parts.push(chalk.hex(palette.success)(icons.connected) + chalk.hex(palette.dim)(' connected'));
    } else {
      parts.push(chalk.hex(palette.error)(icons.disconnected) + chalk.hex(palette.dim)(' disconnected'));
    }

    // Thinking indicator
    if (this._thinking) {
      parts.push(chalk.hex(palette.accent)(omegaSpinner.current));
    }

    // Model
    if (this._status.model) {
      const shortModel = shortenModel(this._status.model);
      parts.push(chalk.hex(palette.purple)(icons.model) + ' ' + chalk.hex(palette.text)(shortModel));
    }

    // Session cost — computed from tokens + model pricing
    const input = this._status.inputTokens ?? 0;
    const output = this._status.outputTokens ?? 0;
    const sessionCost = this.computeCost(input, output, this._status.model);
    const displayCost = (this._status.estimatedCost ?? 0) + sessionCost;
    if (displayCost > 0 && isFinite(displayCost)) {
      parts.push(chalk.hex(palette.dim)(icons.cost) + chalk.hex(palette.text)(displayCost.toFixed(2)));
    } else {
      // Always show $0.00 once connected and model is known
      if (this._status.model) {
        parts.push(chalk.hex(palette.dim)(formatCost(0)));
      }
    }

    // Workflows / tasks
    const tasks = this._status.activeTasks ?? 0;
    const completedTasks = this._status.completedTasks ?? 0;
    const totalTasks = this._status.totalTasks ?? 0;
    if (tasks > 0 || totalTasks > 0) {
      const taskStr = totalTasks > 0
        ? `${completedTasks}/${totalTasks}`
        : `${tasks}`;
      parts.push(chalk.hex(palette.info)(icons.workflow) + ' ' + chalk.hex(palette.text)(`workflows ${taskStr}`));
    }

    // Workers
    const workers = this._status.activeWorkers ?? 0;
    if (workers > 0) {
      parts.push(chalk.hex(palette.success)(icons.worker) + ' ' + chalk.hex(palette.text)(`workers ${workers}`));
    }

    const separator = chalk.hex(palette.dim)(spacing.separator);
    this.setText(spacing.indent1 + parts.join(separator));
  }

  /**
   * Estimate cost from token counts + model name.
   * Prices per million tokens (input / output) as of mid-2025.
   */
  private computeCost(inputTokens: number, outputTokens: number, model?: string): number {
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
    return (inputTokens / 1_000_000) * rates[0] + (outputTokens / 1_000_000) * rates[1];
  }
}
