/**
 * @module components/plan-overlay
 * Plan rendering as inline chat content + keybinding interception.
 * No floating overlays — plans render in the chat flow.
 */

import type { PlannerOutput } from '@orionomega/core';
import chalk from 'chalk';
import { palette, box, icons } from '../theme.js';
import { wrapText, shortenModel, formatDuration, formatCost } from '../utils/format.js';

/**
 * Format a plan as a styled string for inline display in the chat log.
 * Returns a single string with ANSI styling.
 */
export function formatPlan(plan: PlannerOutput): string {
  const graph = plan.graph;
  const W = Math.min(60, (process.stdout.columns ?? 80) - 4);
  const lines: string[] = [];

  const bdr = chalk.hex(palette.borderAccent);
  const dim = chalk.hex(palette.dim);
  const txt = chalk.hex(palette.text);
  const acc = chalk.hex(palette.accent);
  const blu = chalk.hex(palette.info);
  const pur = chalk.hex(palette.purple);

  lines.push('');
  lines.push(bdr(box.topLeft + box.horizontal.repeat(W) + box.topRight));
  lines.push(bdr(box.vertical) + ' ' + acc.bold(`${icons.plan} Execution Plan`) + ' '.repeat(W - 19) + bdr(box.vertical));
  lines.push(bdr(box.teeRight + box.horizontal.repeat(W) + box.teeLeft));

  // Summary (wraps to fit)
  const summaryText = plan.summary ?? graph.name;
  for (const sl of wrapText(summaryText, W - 2)) {
    lines.push(bdr(box.vertical) + ' ' + txt(sl) + ' '.repeat(Math.max(1, W - 1 - sl.length)) + bdr(box.vertical));
  }

  lines.push(bdr(box.teeRight + box.horizontal.repeat(W) + box.teeLeft));

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
      ? ` ${box.doubleHorizontal.repeat(3)} Layer ${layerIdx + 1} (parallel) ${box.doubleHorizontal.repeat(3)}`
      : ` ${box.horizontal.repeat(3)} Layer ${layerIdx + 1} ${box.horizontal.repeat(3)}`;
    lines.push(bdr(box.vertical) + blu(layerText) + ' '.repeat(Math.max(1, W - layerText.length)) + bdr(box.vertical));

    for (const nodeId of layerNodes) {
      taskNum++;
      const node = nodes.get(nodeId) as any;
      if (!node) continue;

      const label = node.label ?? nodeId;
      const model = shortenModel(node.agent?.model ?? node.codingAgent?.model ?? '');
      const nodeType = node.type ?? 'AGENT';
      const icon = nodeType === 'CODING_AGENT' ? icons.codingAgent : nodeType === 'LOOP' ? icons.loopNode : icons.agentNode;

      const taskText = ` ${taskNum}. ${icon} ${label}${model ? ` [${model}]` : ''}`;
      const styledTask = ' ' + acc.bold(`${taskNum}.`) + txt.bold(` ${icon} ${label}`) +
        (model ? pur(` [${model}]`) : '');
      lines.push(bdr(box.vertical) + styledTask + ' '.repeat(Math.max(1, W - taskText.length)) + bdr(box.vertical));

      // Dependencies (compact, same line style)
      const deps = node.dependsOn ?? [];
      if (deps.length) {
        const depStr = `     ${icons.arrow} ${deps.join(', ')}`;
        lines.push(bdr(box.vertical) + dim(depStr) + ' '.repeat(Math.max(1, W - depStr.length)) + bdr(box.vertical));
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
      const taskText = ` ${taskNum}. ${icons.agentNode} ${nLabel}${nModel ? ` [${nModel}]` : ''}`;
      const styled = ' ' + acc.bold(`${taskNum}.`) + txt.bold(` ${icons.agentNode} ${nLabel}`) +
        (nModel ? pur(` [${nModel}]`) : '');
      lines.push(bdr(box.vertical) + styled + ' '.repeat(Math.max(1, W - taskText.length)) + bdr(box.vertical));
    }
  }

  lines.push(bdr(box.teeRight + box.horizontal.repeat(W) + box.teeLeft));

  // Estimates footer
  const estimates: string[] = [];
  if (plan.estimatedTime) estimates.push(`${icons.time} ~${formatDuration(plan.estimatedTime)}`);
  if (plan.estimatedCost) estimates.push(`${icons.cost}~${formatCost(plan.estimatedCost)}`);
  estimates.push(`${taskNum} task${taskNum !== 1 ? 's' : ''}`);
  estimates.push(`${layers.length} layer${layers.length !== 1 ? 's' : ''}`);
  const estLine = ' ' + estimates.join(` ${icons.dot} `);
  lines.push(bdr(box.vertical) + dim(estLine) + ' '.repeat(Math.max(1, W - estLine.length)) + bdr(box.vertical));

  lines.push(bdr(box.bottomLeft + box.horizontal.repeat(W) + box.bottomRight));
  lines.push('');

  return lines.join('\n');
}
