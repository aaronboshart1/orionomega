/**
 * @module components/workflow-tracker
 * Displays workflow progress with tree-style layout.
 * Rendered as a single Text block to ensure correct line ordering:
 *
 *   ⚡ Review SDK · 45s · ✅ 3/8 · 🔄 2 · layer 2/3
 *   ✅ Discover Repo Structure [Haiku 4.5]
 *      └─ Explored 47 files, found 6 packages
 *   🔄 SDK Architecture Review [Opus 4.6]
 *      └─ Analyzing skill manifest schema...
 *   🔄 Security Review [Sonnet 4.6]
 *      └─ Checking dependency audit...
 *   ⏳ Final Report [Opus 4.6]
 */

import { Container, Text } from '@mariozechner/pi-tui';
import type { GraphState } from '@orionomega/core';
import chalk from 'chalk';

const palette = {
  dim: '#5C6370',
  text: '#ABB2BF',
  accent: '#F6C453',
  green: '#00DE6A',
  red: '#F97066',
  blue: '#61AFEF',
  purple: '#C678DD',
  tree: '#3E4451',
};

interface TrackedNode {
  id: string;
  label: string;
  model: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  layer: number;
  lastMessage?: string;
  progress?: number;
}

/**
 * Visual workflow tracker — renders as a single Text element so
 * node lines and their activity └─ lines stay correctly interleaved.
 */
export class WorkflowTracker extends Container {
  private display: Text;
  private trackedNodes = new Map<string, TrackedNode>();
  private workflowName = '';
  private startTime = Date.now();
  private totalLayers = 0;
  private completedLayers = 0;

  constructor() {
    super();
    this.display = new Text('', 1, 0);
    this.addChild(this.display);
  }

  /** Initialize tracker with a new workflow's graph state. */
  initFromGraphState(state: GraphState): void {
    this.workflowName = state.name;
    this.totalLayers = state.totalLayers;
    this.completedLayers = state.completedLayers;
    this.startTime = Date.now();
    this.trackedNodes.clear();

    const nodes = state.nodes ?? {};
    for (const [id, node] of Object.entries(nodes)) {
      const n = node as any;
      this.trackedNodes.set(id, {
        id,
        label: n.label ?? id,
        model: this.shortenModel(n.agent?.model ?? n.codingAgent?.model ?? ''),
        status: this.mapStatus(n.status),
        layer: n.layer ?? 0,
        progress: n.progress,
      });
    }

    this.rebuild();
  }

  /** Update from a new graph state snapshot. */
  updateFromGraphState(state: GraphState): void {
    this.completedLayers = state.completedLayers;
    this.totalLayers = state.totalLayers;

    const nodes = state.nodes ?? {};
    for (const [id, node] of Object.entries(nodes)) {
      const n = node as any;
      const existing = this.trackedNodes.get(id);
      if (existing) {
        existing.status = this.mapStatus(n.status);
        existing.progress = n.progress;
      } else {
        this.trackedNodes.set(id, {
          id,
          label: n.label ?? id,
          model: this.shortenModel(n.agent?.model ?? n.codingAgent?.model ?? ''),
          status: this.mapStatus(n.status),
          layer: n.layer ?? 0,
          progress: n.progress,
        });
      }
    }

    for (const evt of state.recentEvents ?? []) {
      const tracked = this.trackedNodes.get(evt.nodeId);
      if (tracked && evt.message) {
        tracked.lastMessage = evt.message;
      }
    }

    this.rebuild();
  }

  /** Update a single node's status from a worker event. */
  updateNodeEvent(nodeId: string, type: string, message?: string): void {
    const tracked = this.trackedNodes.get(nodeId);
    if (!tracked) return;

    if (type === 'done') tracked.status = 'complete';
    else if (type === 'error') tracked.status = 'error';
    else if (tracked.status === 'pending') tracked.status = 'running';
    if (message) tracked.lastMessage = message;
    this.rebuild();
  }

  get isActive(): boolean {
    return this.trackedNodes.size > 0 &&
      Array.from(this.trackedNodes.values()).some(n => n.status === 'pending' || n.status === 'running');
  }

  private rebuild(): void {
    const dim = chalk.hex(palette.dim);
    const txt = chalk.hex(palette.text);
    const acc = chalk.hex(palette.accent);
    const grn = chalk.hex(palette.green);
    const red = chalk.hex(palette.red);
    const blu = chalk.hex(palette.blue);
    const pur = chalk.hex(palette.purple);
    const tree = chalk.hex(palette.tree);

    const lines: string[] = [];

    // Header
    const elapsed = Math.round((Date.now() - this.startTime) / 1000);
    const vals = Array.from(this.trackedNodes.values());
    const done = vals.filter(n => n.status === 'complete').length;
    const total = vals.length;
    const running = vals.filter(n => n.status === 'running').length;
    const failed = vals.filter(n => n.status === 'error').length;

    const parts = [
      acc.bold(`⚡ ${this.workflowName.slice(0, 50)}`),
      dim(`${elapsed}s`),
      grn(`✅ ${done}`) + dim('/') + txt(`${total}`),
    ];
    if (running > 0) parts.push(blu(`🔄 ${running}`));
    if (failed > 0) parts.push(red(`❌ ${failed}`));
    parts.push(dim(`layer ${this.completedLayers}/${this.totalLayers}`));

    lines.push('  ' + parts.join(dim(' · ')));

    // Nodes sorted by layer then id — with activity lines interleaved
    const sorted = vals.sort((a, b) =>
      a.layer !== b.layer ? a.layer - b.layer : a.id.localeCompare(b.id),
    );

    for (const node of sorted) {
      // Node line
      const icon = this.statusIcon(node.status);
      const nameColor = node.status === 'complete' ? grn
        : node.status === 'error' ? red
        : node.status === 'running' ? blu
        : dim;
      const model = node.model ? pur(` [${node.model}]`) : '';
      lines.push(`    ${icon} ${nameColor(node.label)}${model}`);

      // Activity line immediately after its node
      if (node.lastMessage) {
        const msg = node.lastMessage.length > 60
          ? node.lastMessage.slice(0, 60) + '…'
          : node.lastMessage;
        const msgColor = node.status === 'error' ? red : dim;
        lines.push(`       ${tree('└─')} ${msgColor(msg)}`);
      } else if (node.status === 'running') {
        lines.push(`       ${tree('└─')} ${dim('starting...')}`);
      }
    }

    this.display.setText(lines.join('\n'));
  }

  private statusIcon(status: string): string {
    switch (status) {
      case 'complete': return '✅';
      case 'error': return '❌';
      case 'running': return '🔄';
      default: return '⏳';
    }
  }

  private mapStatus(status: string | undefined): TrackedNode['status'] {
    switch (status) {
      case 'complete': case 'done': return 'complete';
      case 'error': case 'failed': return 'error';
      case 'running': case 'in_progress': return 'running';
      default: return 'pending';
    }
  }

  private shortenModel(model: string): string {
    const match = model.match(/claude-(\w+)-([\d.-]+)/);
    if (match) {
      const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
      const ver = match[2].replace(/-\d{8}$/, '').replace(/-/g, '.');
      return `${name} ${ver}`;
    }
    return model.length > 15 ? model.slice(0, 15) + '…' : model;
  }
}
