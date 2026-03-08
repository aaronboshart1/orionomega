/**
 * @module components/plan-overlay
 * Plan rendering as inline chat content + keybinding interception.
 * No floating overlays — plans render in the chat flow.
 */

import type { PlannerOutput } from '@orionomega/core';
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
 * Format a plan as a styled string for inline display in the chat log.
 * Returns a single string with ANSI styling.
 */
export function formatPlan(plan: PlannerOutput): string {
  const graph = plan.graph;
  const W = 60;
  const lines: string[] = [];

  const bdr = chalk.hex(palette.border);
  const dim = chalk.hex(palette.dim);
  const txt = chalk.hex(palette.text);
  const acc = chalk.hex(palette.accent);
  const blu = chalk.hex(palette.blue);
  const pur = chalk.hex(palette.purple);
  const grn = chalk.hex(palette.green);

  lines.push('');
  lines.push(bdr('┌' + '─'.repeat(W) + '┐'));
  lines.push(bdr('│') + ' ' + acc.bold('📋 Execution Plan') + ' '.repeat(W - 19) + bdr('│'));
  lines.push(bdr('├' + '─'.repeat(W) + '┤'));

  // Plan name
  const name = graph.name.length > W - 2 ? graph.name.slice(0, W - 5) + '...' : graph.name;
  lines.push(bdr('│') + ' ' + txt.bold(name) + ' '.repeat(Math.max(1, W - 1 - name.length)) + bdr('│'));

  // Summary
  if (plan.summary) {
    for (const sl of wrapText(plan.summary, W - 2)) {
      lines.push(bdr('│') + ' ' + dim(sl) + ' '.repeat(Math.max(1, W - 1 - sl.length)) + bdr('│'));
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

    const layerText = isParallel
      ? ` ═══ Layer ${layerIdx + 1} (parallel) ═══`
      : ` ─── Layer ${layerIdx + 1} ───`;
    lines.push(bdr('│') + blu(layerText) + ' '.repeat(Math.max(1, W - layerText.length)) + bdr('│'));

    for (const nodeId of layerNodes) {
      taskNum++;
      const node = nodes.get(nodeId) as any;
      if (!node) continue;

      const label = node.label ?? nodeId;
      const model = shortenModel(node.agent?.model ?? '');
      const nodeType = node.type ?? 'AGENT';
      const icon = nodeType === 'CODING_AGENT' ? '💻' : '🔧';

      const taskText = ` ${taskNum}. ${icon} ${label}${model ? ` [${model}]` : ''}`;
      const styledTask = ' ' + acc.bold(`${taskNum}.`) + txt.bold(` ${icon} ${label}`) +
        (model ? pur(` [${model}]`) : '');
      lines.push(bdr('│') + styledTask + ' '.repeat(Math.max(1, W - taskText.length)) + bdr('│'));

      // Description (max 3 lines)
      if (node.task) {
        const descLines = wrapText(node.task, W - 8);
        for (const dl of descLines.slice(0, 3)) {
          const padded = `     ${dl}`;
          lines.push(bdr('│') + dim(padded) + ' '.repeat(Math.max(1, W - padded.length)) + bdr('│'));
        }
        if (descLines.length > 3) {
          const more = `     ... +${descLines.length - 3} more`;
          lines.push(bdr('│') + dim(more) + ' '.repeat(Math.max(1, W - more.length)) + bdr('│'));
        }
      }

      // Dependencies
      const deps = node.dependsOn ?? [];
      if (deps.length) {
        const depStr = `     → depends on: ${deps.join(', ')}`;
        lines.push(bdr('│') + dim(depStr) + ' '.repeat(Math.max(1, W - depStr.length)) + bdr('│'));
      }
    }
  }

  // Orphan nodes
  const layerNodeIds = new Set(layers.flat());
  for (const [nodeId, node] of nodes) {
    if (!layerNodeIds.has(nodeId)) {
      taskNum++;
      const n = node as any;
      const taskText = ` ${taskNum}. 🔧 ${n.label ?? nodeId}`;
      const styled = ' ' + acc.bold(`${taskNum}.`) + txt.bold(` 🔧 ${n.label ?? nodeId}`);
      lines.push(bdr('│') + styled + ' '.repeat(Math.max(1, W - taskText.length)) + bdr('│'));
    }
  }

  lines.push(bdr('├' + '─'.repeat(W) + '┤'));

  // Estimates footer
  const estimates: string[] = [];
  if (plan.estimatedTime) estimates.push(`⏱ ~${Math.ceil(plan.estimatedTime)}s`);
  if (plan.estimatedCost) estimates.push(`💰 ~$${plan.estimatedCost.toFixed(3)}`);
  estimates.push(`${taskNum} task${taskNum !== 1 ? 's' : ''}`);
  estimates.push(`${layers.length} layer${layers.length !== 1 ? 's' : ''}`);
  const estLine = ' ' + estimates.join('  •  ');
  lines.push(bdr('│') + dim(estLine) + ' '.repeat(Math.max(1, W - estLine.length)) + bdr('│'));

  // Reasoning (truncated)
  if (plan.reasoning) {
    lines.push(bdr('├' + '─'.repeat(W) + '┤'));
    const reasonLines = wrapText(plan.reasoning, W - 2);
    for (const rl of reasonLines.slice(0, 4)) {
      lines.push(bdr('│') + ' ' + dim.italic(rl) + ' '.repeat(Math.max(1, W - 1 - rl.length)) + bdr('│'));
    }
    if (reasonLines.length > 4) {
      lines.push(bdr('│') + dim(' ... (truncated)') + ' '.repeat(W - 16) + bdr('│'));
    }
  }

  lines.push(bdr('└' + '─'.repeat(W) + '┘'));
  lines.push('');

  return lines.join('\n');
}

function wrapText(text: string, width: number): string[] {
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

function shortenModel(model: string): string {
  const match = model.match(/claude-(\w+)-([\d.-]+)/);
  if (match) {
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    const ver = match[2].replace(/-\d{8}$/, '').replace(/-/g, '.');
    return `${name} ${ver}`;
  }
  return model.length > 20 ? model.slice(0, 20) + '…' : model;
}
