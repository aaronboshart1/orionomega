/**
 * @module components/chat-log
 * Chat log component with capped ring buffer and viewport rendering.
 * Messages are stored in memory — render() returns only visible lines.
 */

import { Container, Markdown, Spacer, Text } from '@mariozechner/pi-tui';
import type { Component } from '@mariozechner/pi-tui';
import type { DisplayMessage } from '../gateway-client.js';
import { markdownTheme, theme, spacing, palette, box, icons } from '../theme.js';
import { truncate, formatDuration } from '../utils/format.js';
import { omegaSpinner } from './omega-spinner.js';
import chalk from 'chalk';

interface ChatEntry {
  components: Component[];
  separatorCount: number;
  role: 'user' | 'assistant' | 'system';
}

export class ChatLog extends Container {
  private readonly maxEntries: number;
  private entries: ChatEntry[] = [];
  private streamingComponent: Markdown | null = null;
  private streamingLabel: Text | null = null;
  private streamingDivider: Text | null = null;
  private streamingContext: Text | null = null;
  private streamingSpacers: Component[] = [];
  private thinkingComponent: Text | null = null;
  private thinkingText = '';
  private unsubSpinner: (() => void) | null = null;
  private lastRole: 'user' | 'assistant' | 'system' | null = null;
  private userMessages = new Map<string, string>();
  onUpdate?: () => void;

  constructor(maxEntries = 200) {
    super();
    this.maxEntries = maxEntries;
  }

  private makeDivider(): Text {
    const rule = chalk.hex(palette.border)(box.horizontal.repeat(70));
    return new Text(rule, spacing.componentMarginX, 0);
  }

  private makeContextRef(userContent: string): Text {
    const truncMsg = truncate(userContent, 60);
    return new Text(
      chalk.hex(palette.dim)(`  ↳ re: "${truncMsg}"`),
      spacing.componentMarginX,
      0,
    );
  }

  private resolveContext(msg: DisplayMessage): string | null {
    if (msg.replyTo) {
      const original = this.userMessages.get(msg.replyTo);
      if (original) return original;
    }
    return null;
  }

  private addEntry(role: ChatEntry['role'], separators: Component[], content: Component[]): void {
    const all = [...separators, ...content];
    for (const c of all) this.addChild(c);
    this.entries.push({ components: all, separatorCount: separators.length, role });
    this.lastRole = role;
    this.pruneOverflow();
  }

  addSystemWarning(content: string): void {
    const text = new Text(
      chalk.hex(palette.warning)(`${icons.warning}  ${content}`),
      spacing.componentMarginX,
      spacing.componentMarginY,
    );
    this.addEntry('system', [new Spacer(1)], [text]);
  }

  addSystemSuccess(content: string): void {
    const text = new Text(
      chalk.hex(palette.success)(`${icons.complete}  ${content}`),
      spacing.componentMarginX,
      spacing.componentMarginY,
    );
    this.addEntry('system', [new Spacer(1)], [text]);
  }

  private static fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  private renderStatusLine(
    status: 'complete' | 'error' | 'stopped',
    durationSec: number,
    workerCount: number,
    toolCallCount: number | undefined,
  ): string {
    const dim = chalk.hex(palette.dim);
    const bright = chalk.hex(palette.textBright);
    const success = chalk.hex(palette.success);
    const error = chalk.hex(palette.error);
    const statusLabel = status === 'complete' ? success('COMPLETE') : status === 'error' ? error('ERROR') : dim('STOPPED');
    const toolCallPart = toolCallCount != null
      ? `  ${dim('|')}  Tool Calls: ${bright(String(toolCallCount))}`
      : '';
    return `  Status: ${statusLabel}  ${dim('|')}  Duration: ${bright(formatDuration(durationSec))}  ${dim('|')}  Workers: ${bright(String(workerCount))}${toolCallPart}`;
  }

  private renderModelUsageTable(
    modelUsage: Array<{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; workerCount: number; costUsd: number }>,
    totalCostUsd: number,
  ): string[] {
    const dim = chalk.hex(palette.dim);
    const accent = chalk.hex(palette.accent);
    const bright = chalk.hex(palette.textBright);
    const success = chalk.hex(palette.success);
    const info_ = chalk.hex(palette.info);
    const border = chalk.hex(palette.border);
    const purple = chalk.hex(palette.purple);
    const fmtCost = `$${totalCostUsd.toFixed(4)}`;
    const lines: string[] = [];
    lines.push(`  ${dim('Model'.padEnd(35))} ${dim('Input'.padStart(8))} ${dim('Output'.padStart(8))} ${dim('Cache R'.padStart(8))} ${dim('Cache W'.padStart(8))} ${dim('Cost'.padStart(9))}`);
    lines.push(`  ${border(box.horizontal.repeat(77))}`);
    let totalInput = 0, totalOutput = 0, totalCacheR = 0, totalCacheW = 0;
    for (const m of modelUsage) {
      totalInput += m.inputTokens;
      totalOutput += m.outputTokens;
      totalCacheR += m.cacheReadTokens;
      totalCacheW += m.cacheCreationTokens;
      const shortModel = m.model.length > 33 ? m.model.slice(0, 30) + '...' : m.model;
      lines.push(`  ${purple(shortModel.padEnd(35))} ${info_(ChatLog.fmtTokens(m.inputTokens).padStart(8))} ${info_(ChatLog.fmtTokens(m.outputTokens).padStart(8))} ${dim(ChatLog.fmtTokens(m.cacheReadTokens).padStart(8))} ${dim(ChatLog.fmtTokens(m.cacheCreationTokens).padStart(8))} ${bright(('$' + m.costUsd.toFixed(4)).padStart(9))}`);
    }
    lines.push(`  ${border(box.horizontal.repeat(77))}`);
    lines.push(`  ${accent('Total'.padEnd(35))} ${info_(ChatLog.fmtTokens(totalInput).padStart(8))} ${info_(ChatLog.fmtTokens(totalOutput).padStart(8))} ${dim(ChatLog.fmtTokens(totalCacheR).padStart(8))} ${dim(ChatLog.fmtTokens(totalCacheW).padStart(8))} ${success.bold(fmtCost.padStart(9))}`);
    return lines;
  }

  private renderArtifacts(nodeOutputPaths: Record<string, string[]>): string[] {
    const dim = chalk.hex(palette.dim);
    const accent = chalk.hex(palette.accent);
    const bright = chalk.hex(palette.textBright);
    const info_ = chalk.hex(palette.info);
    const border = chalk.hex(palette.border);
    const lines: string[] = [];
    lines.push('');
    lines.push(accent.bold('  Artifacts'));
    lines.push(`  ${border(box.horizontal.repeat(77))}`);
    for (const [nodeLabel, paths] of Object.entries(nodeOutputPaths)) {
      lines.push(`  ${bright(nodeLabel)}`);
      for (const p of paths) {
        lines.push(`    ${dim('\u2192')} ${info_(p)}`);
      }
    }
    return lines;
  }

  addRunStats(info: {
    status: 'complete' | 'error' | 'stopped';
    durationSec: number;
    workerCount: number;
    totalCostUsd: number;
    toolCallCount?: number;
    modelUsage?: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      workerCount: number;
      costUsd: number;
    }>;
    nodeOutputPaths?: Record<string, string[]>;
  }): void {
    const accent = chalk.hex(palette.accent);
    const success = chalk.hex(palette.success);
    const border = chalk.hex(palette.border);
    const fmtCost = `$${info.totalCostUsd.toFixed(4)}`;
    const rule = border(box.horizontal.repeat(50));

    const lines: string[] = [];
    lines.push(rule);
    lines.push(accent.bold('  Run Summary'));
    lines.push(this.renderStatusLine(info.status, info.durationSec, info.workerCount, info.toolCallCount));
    lines.push('');

    if (info.modelUsage && info.modelUsage.length > 0) {
      lines.push(...this.renderModelUsageTable(info.modelUsage, info.totalCostUsd));
    } else {
      lines.push(`  Total Cost: ${success.bold(fmtCost)}`);
    }

    if (info.nodeOutputPaths && Object.keys(info.nodeOutputPaths).length > 0) {
      lines.push(...this.renderArtifacts(info.nodeOutputPaths));
    }

    lines.push(rule);

    const container = new Container();
    container.addChild(new Spacer(1));
    for (const line of lines) {
      container.addChild(new Text(line, spacing.componentMarginX, 0));
    }
    this.addEntry('system', [], [container]);
  }

  addMessage(msg: DisplayMessage): void {
    const seps: Component[] = [];
    const content: Component[] = [];

    if (msg.role === 'user') {
      if (this.lastRole !== null) {
        seps.push(new Spacer(1));
        seps.push(this.makeDivider());
      }
      seps.push(new Spacer(1));

      content.push(new Text(
        theme.userLabel() + spacing.labelGap + theme.user(msg.content),
        spacing.componentMarginX,
        spacing.componentMarginY,
      ));

      this.userMessages.set(msg.id, msg.content);
      this.addEntry('user', seps, content);

    } else if (msg.raw) {
      if (this.lastRole === 'assistant') {
        seps.push(new Spacer(1));
        seps.push(this.makeDivider());
      }
      seps.push(new Spacer(1));
      const rawLines = msg.raw.split('\n');
      for (const line of rawLines) {
        content.push(new Text(line, spacing.componentMarginX, spacing.componentMarginY));
      }
      this.addEntry('system', seps, content);

    } else if (msg.role === 'system') {
      seps.push(new Spacer(1));
      const prefix = msg.emoji ? `${msg.emoji} ` : '';
      content.push(new Text(
        theme.system(prefix + msg.content),
        spacing.componentMarginX,
        spacing.componentMarginY,
      ));
      this.addEntry('system', seps, content);

    } else {
      if (this.lastRole === 'assistant') {
        seps.push(new Spacer(1));
        seps.push(this.makeDivider());
      }
      seps.push(new Spacer(1));

      content.push(new Text(
        theme.assistantLabel(),
        spacing.componentMarginX,
        spacing.componentMarginY,
      ));

      const context = this.resolveContext(msg);
      if (context && this.lastRole !== 'user') {
        content.push(this.makeContextRef(context));
      }

      content.push(new Markdown(
        msg.content,
        spacing.componentMarginX,
        spacing.componentMarginY,
        markdownTheme,
      ));
      this.addEntry('assistant', seps, content);
    }
  }

  updateStreaming(content: string): void {
    if (!this.streamingComponent) {
      if (this.lastRole !== null) {
        this.streamingDivider = this.makeDivider();
        const sp1 = new Spacer(1);
        this.streamingSpacers.push(sp1);
        this.addChild(sp1);
        this.addChild(this.streamingDivider);
      }

      const sp2 = new Spacer(1);
      this.streamingSpacers.push(sp2);
      this.addChild(sp2);
      this.streamingLabel = new Text(
        theme.assistantLabel(),
        spacing.componentMarginX,
        spacing.componentMarginY,
      );
      this.addChild(this.streamingLabel);

      this.streamingComponent = new Markdown(
        content,
        spacing.componentMarginX,
        spacing.componentMarginY,
        markdownTheme,
      );
      this.addChild(this.streamingComponent);
    } else {
      this.streamingComponent.setText(content);
    }
  }

  clearStreaming(): void {
    for (const sp of this.streamingSpacers) {
      this.removeChild(sp);
    }
    this.streamingSpacers = [];
    if (this.streamingComponent) {
      this.removeChild(this.streamingComponent);
      this.streamingComponent = null;
    }
    if (this.streamingLabel) {
      this.removeChild(this.streamingLabel);
      this.streamingLabel = null;
    }
    if (this.streamingDivider) {
      this.removeChild(this.streamingDivider);
      this.streamingDivider = null;
    }
    if (this.streamingContext) {
      this.removeChild(this.streamingContext);
      this.streamingContext = null;
    }
  }

  updateThinking(text: string): void {
    if (!text) {
      if (this.thinkingComponent) {
        this.removeChild(this.thinkingComponent);
        this.thinkingComponent = null;
      }
      if (this.unsubSpinner) {
        this.unsubSpinner();
        this.unsubSpinner = null;
      }
      this.thinkingText = '';
      return;
    }

    this.thinkingText = text;
    const truncated = truncate(text, 100);
    const display = theme.dim(`${omegaSpinner.current} ${truncated}`);

    if (!this.thinkingComponent) {
      this.thinkingComponent = new Text(display, spacing.componentMarginX, spacing.componentMarginY);
      this.addChild(this.thinkingComponent);
      this.unsubSpinner = omegaSpinner.subscribe(() => {
        if (this.thinkingComponent && this.thinkingText) {
          const t = truncate(this.thinkingText, 100);
          this.thinkingComponent.setText(theme.dim(`${omegaSpinner.current} ${t}`));
          this.onUpdate?.();
        }
      });
    } else {
      this.thinkingComponent.setText(display);
    }
  }

  clearAll(): void {
    this.clear();
    this.entries = [];
    this.streamingComponent = null;
    this.streamingLabel = null;
    this.streamingDivider = null;
    this.streamingContext = null;
    this.streamingSpacers = [];
    if (this.unsubSpinner) {
      this.unsubSpinner();
      this.unsubSpinner = null;
    }
    this.thinkingComponent = null;
    this.thinkingText = '';
    this.lastRole = null;
    this.userMessages.clear();
  }

  private pruneOverflow(): void {
    let pruned = false;
    while (this.entries.length > this.maxEntries) {
      const oldest = this.entries.shift();
      if (oldest) {
        for (const c of oldest.components) {
          this.removeChild(c);
        }
      }
      pruned = true;
    }
    if (pruned) {
      if (this.entries.length === 0) {
        this.lastRole = null;
      } else {
        const first = this.entries[0];
        while (first.separatorCount > 0 && first.components.length > 1) {
          this.removeChild(first.components[0]);
          first.components.shift();
          first.separatorCount--;
        }
      }
    }
  }
}
