/**
 * @module components/plan-overlay
 * Plan approval overlay with rich formatting — numbered tasks, models,
 * dependencies, estimated cost/time. Supports approve/reject/modify.
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

export class PlanOverlay extends Container implements Focusable {
  focused = false;
  private readonly plan: PlannerOutput;
  onRespond?: (action: 'approve' | 'reject' | 'modify') => void;

  constructor(plan: PlannerOutput) {
    super();
    this.plan = plan;
    this.buildContent();
  }

  private buildContent(): void {
    const p = this.plan;
    const graph = p.graph;

    // Top border
    this.addChild(new Text(chalk.hex(palette.border)('┌' + '─'.repeat(62) + '┐'), 1, 0));
    this.addChild(new Text(
      chalk.hex(palette.border)('│') + ' ' +
      chalk.hex(palette.accent).bold('📋 Execution Plan') +
      ' '.repeat(44) +
      chalk.hex(palette.border)('│'),
      1, 0,
    ));
    this.addChild(new Text(chalk.hex(palette.border)('├' + '─'.repeat(62) + '┤'), 1, 0));

    // Plan name + summary
    this.addChild(new Text(
      chalk.hex(palette.border)('│') + ' ' +
      chalk.hex(palette.text).bold(graph.name) +
      ' '.repeat(Math.max(1, 62 - graph.name.length)) +
      chalk.hex(palette.border)('│'),
      1, 0,
    ));

    if (p.summary) {
      const summaryLines = this.wrapText(p.summary, 60);
      for (const line of summaryLines) {
        this.addChild(new Text(
          chalk.hex(palette.border)('│') + ' ' +
          chalk.hex(palette.dim)(line) +
          ' '.repeat(Math.max(1, 62 - line.length)) +
          chalk.hex(palette.border)('│'),
          1, 0,
        ));
      }
    }

    this.addChild(new Text(chalk.hex(palette.border)('├' + '─'.repeat(62) + '┤'), 1, 0));

    // Nodes as a numbered task list, grouped by layer
    const nodes = graph.nodes instanceof Map
      ? graph.nodes
      : new Map(Object.entries(graph.nodes as Record<string, any>));

    const layers = graph.layers ?? [];
    let taskNum = 0;

    for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
      const layerNodes = layers[layerIdx];
      const isParallel = layerNodes.length > 1;

      // Layer header
      const layerLabel = isParallel
        ? chalk.hex(palette.blue)(`  ═══ Layer ${layerIdx + 1} (parallel) ═══`)
        : chalk.hex(palette.blue)(`  ─── Layer ${layerIdx + 1} ───`);
      this.addChild(new Text(
        chalk.hex(palette.border)('│') + layerLabel +
        ' '.repeat(Math.max(1, 62 - this.stripAnsi(layerLabel).length)) +
        chalk.hex(palette.border)('│'),
        1, 0,
      ));

      for (const nodeId of layerNodes) {
        taskNum++;
        const node = nodes.get(nodeId) as any;
        if (!node) continue;

        const label = node.label ?? nodeId;
        const model = this.shortenModel(node.agent?.model ?? '');
        const nodeType = node.type ?? 'AGENT';

        // Task number + icon + name
        const icon = nodeType === 'CODING_AGENT' ? '💻' : '🔧';
        const numStr = chalk.hex(palette.accent).bold(`  ${taskNum}.`);
        const nameStr = chalk.hex(palette.text).bold(` ${icon} ${label}`);
        const modelStr = model ? chalk.hex(palette.purple)(` [${model}]`) : '';

        const taskLine = numStr + nameStr + modelStr;
        this.addChild(new Text(
          chalk.hex(palette.border)('│') + taskLine +
          ' '.repeat(Math.max(1, 62 - this.stripAnsi(taskLine).length)) +
          chalk.hex(palette.border)('│'),
          1, 0,
        ));

        // Task description (from task field)
        if (node.task) {
          const descLines = this.wrapText(node.task, 55);
          for (const line of descLines.slice(0, 3)) { // Max 3 lines
            const padded = `      ${line}`;
            this.addChild(new Text(
              chalk.hex(palette.border)('│') +
              chalk.hex(palette.dim)(padded) +
              ' '.repeat(Math.max(1, 63 - padded.length)) +
              chalk.hex(palette.border)('│'),
              1, 0,
            ));
          }
          if (descLines.length > 3) {
            this.addChild(new Text(
              chalk.hex(palette.border)('│') +
              chalk.hex(palette.dim)(`      ... +${descLines.length - 3} more lines`) +
              ' '.repeat(35) +
              chalk.hex(palette.border)('│'),
              1, 0,
            ));
          }
        }

        // Dependencies
        const deps = node.dependsOn ?? [];
        if (deps.length > 0) {
          const depStr = `      → depends on: ${deps.join(', ')}`;
          this.addChild(new Text(
            chalk.hex(palette.border)('│') +
            chalk.hex(palette.dim)(depStr) +
            ' '.repeat(Math.max(1, 63 - depStr.length)) +
            chalk.hex(palette.border)('│'),
            1, 0,
          ));
        }
      }
    }

    // Also show any nodes not in layers
    const layerNodeIds = new Set(layers.flat());
    for (const [nodeId, node] of nodes) {
      if (!layerNodeIds.has(nodeId)) {
        taskNum++;
        const n = node as any;
        const taskLine = chalk.hex(palette.accent).bold(`  ${taskNum}.`) +
          chalk.hex(palette.text).bold(` 🔧 ${n.label ?? nodeId}`);
        this.addChild(new Text(
          chalk.hex(palette.border)('│') + taskLine +
          ' '.repeat(Math.max(1, 62 - this.stripAnsi(taskLine).length)) +
          chalk.hex(palette.border)('│'),
          1, 0,
        ));
      }
    }

    this.addChild(new Text(chalk.hex(palette.border)('├' + '─'.repeat(62) + '┤'), 1, 0));

    // Estimates
    const estimates: string[] = [];
    if (p.estimatedTime) estimates.push(`⏱ ~${Math.ceil(p.estimatedTime)}s`);
    if (p.estimatedCost) estimates.push(`💰 ~$${p.estimatedCost.toFixed(3)}`);
    estimates.push(`${taskNum} task${taskNum !== 1 ? 's' : ''}`);
    estimates.push(`${layers.length} layer${layers.length !== 1 ? 's' : ''}`);
    const estLine = '  ' + estimates.join('  •  ');
    this.addChild(new Text(
      chalk.hex(palette.border)('│') +
      chalk.hex(palette.dim)(estLine) +
      ' '.repeat(Math.max(1, 63 - estLine.length)) +
      chalk.hex(palette.border)('│'),
      1, 0,
    ));

    // Reasoning
    if (p.reasoning) {
      this.addChild(new Text(chalk.hex(palette.border)('├' + '─'.repeat(62) + '┤'), 1, 0));
      const reasonLines = this.wrapText(p.reasoning, 60);
      for (const line of reasonLines.slice(0, 4)) {
        this.addChild(new Text(
          chalk.hex(palette.border)('│') + ' ' +
          chalk.hex(palette.dim).italic(line) +
          ' '.repeat(Math.max(1, 62 - line.length)) +
          chalk.hex(palette.border)('│'),
          1, 0,
        ));
      }
    }

    // Actions
    this.addChild(new Text(chalk.hex(palette.border)('├' + '─'.repeat(62) + '┤'), 1, 0));
    this.addChild(new Text(
      chalk.hex(palette.border)('│') + '  ' +
      chalk.hex(palette.green).bold('[Enter]') + ' Approve  ' +
      chalk.hex('#F97066').bold('[Esc]') + ' Reject  ' +
      chalk.hex(palette.accent).bold('[m]') + ' Modify' +
      ' '.repeat(14) +
      chalk.hex(palette.border)('│'),
      1, 0,
    ));
    this.addChild(new Text(chalk.hex(palette.border)('└' + '─'.repeat(62) + '┘'), 1, 0));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      this.onRespond?.('approve');
    } else if (matchesKey(data, Key.escape)) {
      this.onRespond?.('reject');
    } else if (data === 'm' || data === 'M') {
      this.onRespond?.('modify');
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
