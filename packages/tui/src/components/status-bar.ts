/**
 * @module components/status-bar
 * Rich status bar showing gateway status, model, tokens, tasks, and workers.
 * Sits below the editor as a fixed-height bar.
 */

import { Text } from '@mariozechner/pi-tui';
import chalk from 'chalk';

const palette = {
  bg: '#1A1D23',
  dim: '#5C6370',
  text: '#ABB2BF',
  accent: '#F6C453',
  green: '#00DE6A',
  red: '#F97066',
  blue: '#61AFEF',
  purple: '#C678DD',
};

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
 * Layout: [connection] | [model] | [tokens] | [tasks] | [workers] | [cost]
 */
export class StatusBar extends Text {
  private _connected = false;
  private _thinking = false;
  private _status: SessionStatus = {};
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  // Braille pixel Ω — 14×4 pixel grid (7 braille chars wide)
  // Builds phase by phase, holds, dissolves in reverse.
  //
  //   ..▪▪▪▪▪▪▪▪▪▪..    arc
  //   .▪▪........▪▪.    sides
  //   .▪..........▪.    sides
  //   ▪▪.▪▪▪..▪▪▪.▪▪    feet
  //
  private static readonly SPINNER = (() => {
    // Pixel grid: 14 wide × 4 tall
    const OMEGA = [
      [0,0,1,1,1,1,1,1,1,1,1,1,0,0],
      [0,1,1,0,0,0,0,0,0,0,0,1,1,0],
      [0,1,0,0,0,0,0,0,0,0,0,0,1,0],
      [1,1,0,1,1,1,0,0,1,1,1,0,1,1],
    ];

    // Reveal phases — pixels appear in symmetric groups
    const PHASES: [number, number][][] = [
      [[0,6],[0,7]],                                       // center arc
      [[0,5],[0,8],[0,4],[0,9]],                           // arc extends
      [[0,3],[0,10],[0,2],[0,11]],                         // full arc
      [[1,1],[1,12],[1,2],[1,11]],                         // upper sides
      [[2,1],[2,12]],                                      // lower sides
      [[3,0],[3,13],[3,1],[3,12]],                         // outer feet
      [[3,3],[3,10],[3,4],[3,9],[3,5],[3,8]],              // inner feet → FULL
    ];

    const toBraille = (grid: number[][]): string => {
      let result = '';
      const w = grid[0].length;
      for (let x = 0; x < w; x += 2) {
        let code = 0x2800;
        for (let y = 0; y < 4; y++) {
          if (grid[y]?.[x])     code |= y < 3 ? (1 << y) : 0x40;
          if (grid[y]?.[x + 1]) code |= y < 3 ? (1 << (y + 3)) : 0x80;
        }
        result += String.fromCharCode(code);
      }
      return result;
    };

    const grid = OMEGA.map(r => r.map(() => 0));
    const frames: string[] = [];

    // Empty
    frames.push(toBraille(grid));

    // Build
    for (const phase of PHASES) {
      for (const [y, x] of phase) grid[y][x] = 1;
      frames.push(toBraille(grid));
    }

    // Hold full
    frames.push(toBraille(grid));
    frames.push(toBraille(grid));
    frames.push(toBraille(grid));

    // Dissolve (reverse)
    for (let i = PHASES.length - 1; i >= 0; i--) {
      for (const [y, x] of PHASES[i]) grid[y][x] = 0;
      frames.push(toBraille(grid));
    }

    // Hold empty
    frames.push(toBraille(grid));

    return frames;
  })();

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
    if (value && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % StatusBar.SPINNER.length;
        this.updateDisplay();
        this.onUpdate?.();
      }, 120);
    } else if (!value && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      this.spinnerFrame = 0;
    }
    this.updateDisplay();
  }

  updateStatus(status: Partial<SessionStatus>): void {
    Object.assign(this._status, status);
    this.updateDisplay();
  }

  dispose(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
  }

  private updateDisplay(): void {
    const parts: string[] = [];

    // Connection status
    if (this._connected) {
      parts.push(chalk.hex(palette.green)('●') + chalk.hex(palette.dim)(' connected'));
    } else {
      parts.push(chalk.hex(palette.red)('●') + chalk.hex(palette.dim)(' disconnected'));
    }

    // Thinking indicator
    if (this._thinking) {
      parts.push(chalk.hex(palette.accent)(StatusBar.SPINNER[this.spinnerFrame]));
    }

    // Model
    if (this._status.model) {
      const shortModel = this.shortenModel(this._status.model);
      parts.push(chalk.hex(palette.purple)('⬡') + ' ' + chalk.hex(palette.text)(shortModel));
    }

    // Token usage
    const input = this._status.inputTokens ?? 0;
    const output = this._status.outputTokens ?? 0;
    const total = input + output;
    const max = this._status.maxContextTokens ?? 200000;
    if (total > 0) {
      const pct = Math.round((total / max) * 100);
      const color = pct > 80 ? palette.red : pct > 60 ? palette.accent : palette.text;
      parts.push(
        chalk.hex(palette.dim)('ctx ') +
        chalk.hex(color)(this.formatTokens(total)) +
        chalk.hex(palette.dim)('/') +
        chalk.hex(palette.dim)(this.formatTokens(max)),
      );
    }

    // Tasks
    const tasks = this._status.activeTasks ?? 0;
    const completedTasks = this._status.completedTasks ?? 0;
    const totalTasks = this._status.totalTasks ?? 0;
    if (tasks > 0 || totalTasks > 0) {
      const taskStr = totalTasks > 0
        ? `${completedTasks}/${totalTasks}`
        : `${tasks}`;
      parts.push(chalk.hex(palette.blue)('◆') + ' ' + chalk.hex(palette.text)(`tasks ${taskStr}`));
    }

    // Workers
    const workers = this._status.activeWorkers ?? 0;
    if (workers > 0) {
      parts.push(chalk.hex(palette.green)('⚙') + ' ' + chalk.hex(palette.text)(`workers ${workers}`));
    }

    // Cost
    if (this._status.estimatedCost && this._status.estimatedCost > 0) {
      parts.push(chalk.hex(palette.dim)('$' + this._status.estimatedCost.toFixed(3)));
    }

    const separator = chalk.hex(palette.dim)(' │ ');
    this.setText('  ' + parts.join(separator));
  }

  private shortenModel(model: string): string {
    // claude-sonnet-4-20250514 → Sonnet 4
    // claude-opus-4-20250514 → Opus 4
    // claude-haiku-4-5-20251001 → Haiku 4.5
    const match = model.match(/claude-(\w+)-([\d.-]+)/);
    if (match) {
      const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
      const ver = match[2].replace(/-\d{8}$/, '').replace(/-/g, '.');
      return `${name} ${ver}`;
    }
    return model.length > 20 ? model.slice(0, 20) + '…' : model;
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }
}
