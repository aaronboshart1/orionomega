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

  // Summary (wraps to fit)
  const summaryText = plan.summary ?? graph.name;
  for (const sl of wrapText(summaryText, W - 2)) {
    lines.push(bdr('│') + ' ' + txt(sl) + ' '.repeat(Math.max(1, W - 1 - sl.length)) + bdr('│'));
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
      const model = shortenModel(node.agent?.model ?? node.codingAgent?.model ?? '');
      const nodeType = node.type ?? 'AGENT';
      const icon = nodeType === 'CODING_AGENT' ? '💻' : nodeType === 'LOOP' ? '🔁' : '🔧';

      const taskText = ` ${taskNum}. ${icon} ${label}${model ? ` [${model}]` : ''}`;
      const styledTask = ' ' + acc.bold(`${taskNum}.`) + txt.bold(` ${icon} ${label}`) +
        (model ? pur(` [${model}]`) : '');
      lines.push(bdr('│') + styledTask + ' '.repeat(Math.max(1, W - taskText.length)) + bdr('│'));

      // Dependencies (compact, same line style)
      const deps = node.dependsOn ?? [];
      if (deps.length) {
        const depStr = `     → ${deps.join(', ')}`;
        lines.push(bdr('│') + dim(depStr) + ' '.repeat(Math.max(1, W - depStr.length)) + bdr('│'));
      }
    }
  }

  // Orphan nodes (not in any layer — show them so nothing is hidden)
  const layerNodeIds = new Set(layers.flat());
  for (const [nodeId, nodeVal] of nodes) {
    if (!layerNodeIds.has(nodeId)) {
      taskNum++;
      const n = nodeVal as any;
      const nLabel = n.label ?? nodeId;
      const nModel = shortenModel(n.agent?.model ?? n.codingAgent?.model ?? '');
      const taskText = ` ${taskNum}. 🔧 ${nLabel}${nModel ? ` [${nModel}]` : ''}`;
      const styled = ' ' + acc.bold(`${taskNum}.`) + txt.bold(` 🔧 ${nLabel}`) +
        (nModel ? pur(` [${nModel}]`) : '');
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

  // Reasoning — omitted from display, available in logs

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
