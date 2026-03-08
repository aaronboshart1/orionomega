/**
 * @module components/plan-overlay
 * Plan approval overlay with rich formatting — numbered tasks, models,
 * dependencies, estimated cost/time. Supports approve/reject/modify.
 * Scrollable when content exceeds viewport.
 */

import { Container, Text, Spacer, Key, matchesKey } from '@mariozechner/pi-tui';
import type { Focusable } from '@mariozechner/pi-tui';
import type { PlannerOutput } from '@orionomega/core';
import { theme } from '../theme.js';
import chalk from 'chalk';

const palette = {
  border: '#F6C453',
  dim: '#5C6370',
  text: '#ABB2BF',
  green: '#7DD3A5',
  blue: '#61AFEF',
  purple: '#C678DD',
  accent: '#F6C453',
};

/**
 * Plan overlay with internal scroll offset.
 * Content is pre-built as an array of styled lines.
 * render() slices to fit the available height, controlled by up/down keys.
 */
export class PlanOverlay extends Container implements Focusable {
  focused = false;
  private readonly plan: PlannerOutput;
  private allLines: string[] = [];
  private scrollOffset = 0;
  onRespond?: (action: 'approve' | 'reject' | 'modify') => void;

  /** Called when the overlay needs a re-render (scroll change). Wire to tui.requestRender(). */
  onUpdate?: () => void;

  constructor(plan: PlannerOutput) {
    super();
    this.plan = plan;
    this.allLines = this.buildLines();
    this.rebuildChildren();
  }

  /** Build all content lines (un-sliced). */
  private buildLines(): string[] {
    const p = this.plan;
    const graph = p.graph;
    const W = 62;
    const lines: string[] = [];

    const bdr = (ch: string) => chalk.hex(palette.border)(ch);
    const row = (content: string, rawLen?: number) => {
      const len = rawLen ?? this.stripAnsi(content).length;
      const pad = Math.max(1, W - len);
      return bdr('│') + content + ' '.repeat(pad) + bdr('│');
    };

    // Top border + title
    lines.push(bdr('┌' + '─'.repeat(W) + '┐'));
    lines.push(row(' ' + chalk.hex(palette.accent).bold('📋 Execution Plan') + ' '.repeat(44), 48));
    lines.push(bdr('├' + '─'.repeat(W) + '┤'));

    // Plan name + summary
    const nameStr = ' ' + chalk.hex(palette.text).bold(graph.name);
    lines.push(row(nameStr, 1 + graph.name.length));
    if (p.summary) {
      for (const line of this.wrapText(p.summary, W - 2)) {
        lines.push(row(' ' + chalk.hex(palette.dim)(line), 1 + line.length));
      }
    }
    lines.push(bdr('├' + '─'.repeat(W) + '┤'));

    // Nodes grouped by layer
    const nodes = graph.nodes instanceof Map
      ? graph.nodes
      : new Map(Object.entries(graph.nodes as Record<string, any>));
    const layers = graph.layers ?? [];
    let taskNum = 0;

    for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
      const layerNodes = layers[layerIdx];
      const isParallel = layerNodes.length > 1;
      const layerLabel = isParallel
        ? chalk.hex(palette.blue)(`  ═══ Layer ${layerIdx + 1} (parallel) ═══`)
        : chalk.hex(palette.blue)(`  ─── Layer ${layerIdx + 1} ───`);
      const rawLen = isParallel
        ? `  ═══ Layer ${layerIdx + 1} (parallel) ═══`.length
        : `  ─── Layer ${layerIdx + 1} ───`.length;
      lines.push(row(layerLabel, rawLen));

      for (const nodeId of layerNodes) {
        taskNum++;
        const node = nodes.get(nodeId) as any;
        if (!node) continue;

        const label = node.label ?? nodeId;
        const model = this.shortenModel(node.agent?.model ?? '');
        const nodeType = node.type ?? 'AGENT';
        const icon = nodeType === 'CODING_AGENT' ? '💻' : '🔧';
        const taskLine = `  ${taskNum}. ${icon} ${label}` + (model ? ` [${model}]` : '');
        const styledTask = chalk.hex(palette.accent).bold(`  ${taskNum}.`) +
          chalk.hex(palette.text).bold(` ${icon} ${label}`) +
          (model ? chalk.hex(palette.purple)(` [${model}]`) : '');
        lines.push(row(styledTask, taskLine.length));

        // Task description (max 3 lines)
        if (node.task) {
          const descLines = this.wrapText(node.task, W - 8);
          for (const dl of descLines.slice(0, 3)) {
            const padded = `      ${dl}`;
            lines.push(row(chalk.hex(palette.dim)(padded), padded.length));
          }
          if (descLines.length > 3) {
            const more = `      ... +${descLines.length - 3} more lines`;
            lines.push(row(chalk.hex(palette.dim)(more), more.length));
          }
        }

        // Dependencies
        const deps = node.dependsOn ?? [];
        if (deps.length > 0) {
          const depStr = `      → depends on: ${deps.join(', ')}`;
          lines.push(row(chalk.hex(palette.dim)(depStr), depStr.length));
        }
      }
    }

    // Orphan nodes not in layers
    const layerNodeIds = new Set(layers.flat());
    for (const [nodeId, node] of nodes) {
      if (!layerNodeIds.has(nodeId)) {
        taskNum++;
        const n = node as any;
        const taskLine = `  ${taskNum}. 🔧 ${n.label ?? nodeId}`;
        const styled = chalk.hex(palette.accent).bold(`  ${taskNum}.`) +
          chalk.hex(palette.text).bold(` 🔧 ${n.label ?? nodeId}`);
        lines.push(row(styled, taskLine.length));
      }
    }

    lines.push(bdr('├' + '─'.repeat(W) + '┤'));

    // Estimates
    const estimates: string[] = [];
    if (p.estimatedTime) estimates.push(`⏱ ~${Math.ceil(p.estimatedTime)}s`);
    if (p.estimatedCost) estimates.push(`💰 ~$${p.estimatedCost.toFixed(3)}`);
    estimates.push(`${taskNum} task${taskNum !== 1 ? 's' : ''}`);
    estimates.push(`${layers.length} layer${layers.length !== 1 ? 's' : ''}`);
    const estLine = '  ' + estimates.join('  •  ');
    lines.push(row(chalk.hex(palette.dim)(estLine), estLine.length));

    // Reasoning
    if (p.reasoning) {
      lines.push(bdr('├' + '─'.repeat(W) + '┤'));
      const reasonLines = this.wrapText(p.reasoning, W - 2);
      for (const rl of reasonLines.slice(0, 6)) {
        lines.push(row(' ' + chalk.hex(palette.dim).italic(rl), 1 + rl.length));
      }
      if (reasonLines.length > 6) {
        lines.push(row(chalk.hex(palette.dim)('  ... (truncated)'), 17));
      }
    }

    // Actions
    lines.push(bdr('├' + '─'.repeat(W) + '┤'));
    const actionsLine = '  ' +
      chalk.hex(palette.green).bold('[Enter]') + ' Approve  ' +
      chalk.hex('#F97066').bold('[Esc]') + ' Reject  ' +
      chalk.hex(palette.accent).bold('[m]') + ' Modify';
    lines.push(row(actionsLine, '  [Enter] Approve  [Esc] Reject  [m] Modify'.length));
    lines.push(bdr('└' + '─'.repeat(W) + '┘'));

    return lines;
  }

  /** Rebuild visible children from scroll offset. */
  private rebuildChildren(): void {
    // Remove all existing children
    while (this.children.length > 0) {
      this.removeChild(this.children[0]);
    }

    // Determine visible window — use terminal rows if available
    const termRows = process.stdout.rows ?? 40;
    const maxVisible = Math.max(10, Math.floor(termRows * 0.85) - 2);
    const totalLines = this.allLines.length;

    // Clamp scroll offset
    const maxScroll = Math.max(0, totalLines - maxVisible);
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
    if (this.scrollOffset < 0) this.scrollOffset = 0;

    // Slice visible lines
    const visibleLines = this.allLines.slice(this.scrollOffset, this.scrollOffset + maxVisible);

    for (const line of visibleLines) {
      this.addChild(new Text(line, 1, 0));
    }

    // Scroll indicator
    if (totalLines > maxVisible) {
      const indicator = this.scrollOffset > 0 && this.scrollOffset < maxScroll
        ? `  ↑↓ scroll (${this.scrollOffset + 1}-${Math.min(this.scrollOffset + maxVisible, totalLines)}/${totalLines})`
        : this.scrollOffset > 0
        ? `  ↑ scroll up (${this.scrollOffset + 1}-${totalLines}/${totalLines})`
        : `  ↓ scroll down (1-${maxVisible}/${totalLines})`;
      this.addChild(new Text(chalk.hex(palette.dim)(indicator), 1, 0));
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      this.onRespond?.('approve');
    } else if (matchesKey(data, Key.escape)) {
      this.onRespond?.('reject');
    } else if (data === 'm' || data === 'M') {
      this.onRespond?.('modify');
    } else if (matchesKey(data, Key.up) || data === 'k') {
      if (this.scrollOffset > 0) {
        this.scrollOffset--;
        this.rebuildChildren();
        this.onUpdate?.();
      }
    } else if (matchesKey(data, Key.down) || data === 'j') {
      this.scrollOffset++;
      this.rebuildChildren();
      this.onUpdate?.();
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      this.rebuildChildren();
      this.onUpdate?.();
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += 10;
      this.rebuildChildren();
      this.onUpdate?.();
    } else if (data === 'g') {
      this.scrollOffset = 0;
      this.rebuildChildren();
      this.onUpdate?.();
    } else if (data === 'G') {
      this.scrollOffset = this.allLines.length; // clamp handles it
      this.rebuildChildren();
      this.onUpdate?.();
    }
  }

  invalidate(): void {
    super.invalidate();
  }

  private wrapText(text: string, width: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      if (current.length + word.length + 1 > width) {
        lines.push(current);
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  private stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private shortenModel(model: string): string {
    const match = model.match(/claude-(\w+)-([\d.-]+)/);
    if (match) {
      const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
      const ver = match[2].replace(/-\d{8}$/, '').replace(/-/g, '.');
      return `${name} ${ver}`;
    }
    return model.length > 20 ? model.slice(0, 20) + '…' : model;
  }
}
