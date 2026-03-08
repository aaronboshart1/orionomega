/**
 * @module components/workflow-tracker
 * Displays workflow progress with tree-style layout.
 * Each task shows status icon + name + model, with an L-shaped bar
 * showing streaming activity indented below.
 *
 *   ⚡ Review OrionOmega SDK · 45s · ✅ 3/8 · 🔄 2 running · layer 2/3
 *   ✅ Discover Repo Structure [Haiku 4.5]
 *   └─ Explored 47 files, found 6 packages
 *   🔄 SDK Architecture Review [Opus 4.6]
 *   └─ Analyzing skill manifest schema...
 *   🔄 Security Review [Sonnet 4.6]
 *   └─ Checking dependency audit...
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
 * Visual workflow tracker with tree-style activity lines.
 */
export class WorkflowTracker extends Container {
  private trackedNodes = new Map<string, TrackedNode>();
  private workflowName = '';
  private startTime = Date.now();
  private totalLayers = 0;
  private completedLayers = 0;
  private renderedLines = new Map<string, Text>(); // keyed by purpose: "header", "node:{id}", "activity:{id}"

  constructor() {
    super();
  }

  /** Initialize tracker with a new workflow's graph state. */
  initFromGraphState(state: GraphState): void {
    this.workflowName = state.name;
    this.totalLayers = state.totalLayers;
    this.completedLayers = state.completedLayers;
    this.startTime = Date.now();

    // Clear everything
    for (const text of this.renderedLines.values()) {
      this.removeChild(text);
    }
    this.renderedLines.clear();
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

    // Header line
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

    this.setLine('header', '  ' + parts.join(dim(' · ')));

    // Nodes sorted by layer then id
    const sorted = vals.sort((a, b) =>
      a.layer !== b.layer ? a.layer - b.layer : a.id.localeCompare(b.id),
    );

    let prevLayer = -1;
    for (const node of sorted) {
      // Layer separator
      if (node.layer !== prevLayer) {
        prevLayer = node.layer;
      }

      // Node line: icon + name + model
      const icon = this.statusIcon(node.status);
      const nameColor = node.status === 'complete' ? grn
        : node.status === 'error' ? red
        : node.status === 'running' ? blu
        : dim;
      const model = node.model ? pur(` [${node.model}]`) : '';
      this.setLine(`node:${node.id}`, `    ${icon} ${nameColor(node.label)}${model}`);

      // Activity line: L-bar with message (only for running/complete/error with messages)
      if (node.lastMessage) {
        const msg = node.lastMessage.length > 60
          ? node.lastMessage.slice(0, 60) + '…'
          : node.lastMessage;
        const msgColor = node.status === 'error' ? red : dim;
        this.setLine(`activity:${node.id}`, `    ${tree('└─')} ${msgColor(msg)}`);
      } else if (node.status === 'running') {
        this.setLine(`activity:${node.id}`, `    ${tree('└─')} ${dim('starting...')}`);
      } else {
        // Remove activity line if no message and not running
        this.removeLine(`activity:${node.id}`);
      }
    }
  }

  /** Set or update a named line. */
  private setLine(key: string, content: string): void {
    const existing = this.renderedLines.get(key);
    if (existing) {
      existing.setText(content);
    } else {
      const text = new Text(content, 1, 0);
      // Insert in order — header first, then nodes/activities in order
      this.addChild(text);
      this.renderedLines.set(key, text);
    }
  }

  /** Remove a named line. */
  private removeLine(key: string): void {
    const existing = this.renderedLines.get(key);
    if (existing) {
      this.removeChild(existing);
      this.renderedLines.delete(key);
    }
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
