/**
 * @module components/workflow-tracker
 * Displays workflow progress aligned to the approved plan.
 * Shows each task with status: ⏳ pending, 🔄 running, ✅ done, ❌ failed.
 * Rendered as a persistent block in the chat log when a workflow is active.
 */

import { Container, Text, Spacer } from '@mariozechner/pi-tui';
import type { GraphState } from '@orionomega/core';
import chalk from 'chalk';

const palette = {
  dim: '#5C6370',
  text: '#ABB2BF',
  accent: '#F6C453',
  green: '#7DD3A5',
  red: '#F97066',
  blue: '#61AFEF',
  purple: '#C678DD',
  yellow: '#E5C07B',
};

interface TrackedNode {
  id: string;
  label: string;
  model: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  layer: number;
  lastMessage?: string;
  progress?: number;
  elapsed?: number;
}

/**
 * Visual workflow tracker that updates in-place as tasks progress.
 */
export class WorkflowTracker extends Container {
  private headerText: Text;
  private nodeTexts = new Map<string, Text>();
  private trackedNodes = new Map<string, TrackedNode>();
  private workflowName = '';
  private startTime = Date.now();
  private totalLayers = 0;
  private completedLayers = 0;

  constructor() {
    super();
    this.headerText = new Text('', 1, 0);
    this.addChild(this.headerText);
  }

  /** Initialize tracker with a new workflow's graph state. */
  initFromGraphState(state: GraphState): void {
    this.workflowName = state.name;
    this.totalLayers = state.totalLayers;
    this.completedLayers = state.completedLayers;
    this.startTime = Date.now();

    // Clear old nodes
    for (const text of this.nodeTexts.values()) {
      this.removeChild(text);
    }
    this.nodeTexts.clear();
    this.trackedNodes.clear();

    // Build tracked nodes from graph state
    const nodes = state.nodes ?? {};
    for (const [id, node] of Object.entries(nodes)) {
      const n = node as any;
      const tracked: TrackedNode = {
        id,
        label: n.label ?? id,
        model: this.shortenModel(n.agent?.model ?? ''),
        status: this.mapStatus(n.status),
        layer: n.layer ?? 0,
        lastMessage: undefined,
        progress: n.progress,
      };
      this.trackedNodes.set(id, tracked);
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
          model: this.shortenModel(n.agent?.model ?? ''),
          status: this.mapStatus(n.status),
          layer: n.layer ?? 0,
          progress: n.progress,
        });
      }
    }

    // Check recent events for status messages
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
    else if (type !== 'done' && type !== 'error' && tracked.status === 'pending') {
      tracked.status = 'running';
    }
    if (message) tracked.lastMessage = message;
    this.rebuild();
  }

  /** Check if workflow is still active. */
  get isActive(): boolean {
    return this.trackedNodes.size > 0 &&
      Array.from(this.trackedNodes.values()).some(n => n.status === 'pending' || n.status === 'running');
  }

  private rebuild(): void {
    // Update header
    const elapsed = Math.round((Date.now() - this.startTime) / 1000);
    const done = Array.from(this.trackedNodes.values()).filter(n => n.status === 'complete').length;
    const total = this.trackedNodes.size;
    const running = Array.from(this.trackedNodes.values()).filter(n => n.status === 'running').length;
    const failed = Array.from(this.trackedNodes.values()).filter(n => n.status === 'error').length;

    const headerParts = [
      chalk.hex(palette.accent).bold(`⚡ ${this.workflowName}`),
      chalk.hex(palette.dim)(`${elapsed}s`),
      chalk.hex(palette.green)(`✅ ${done}`) +
        chalk.hex(palette.dim)('/') +
        chalk.hex(palette.text)(`${total}`),
    ];
    if (running > 0) headerParts.push(chalk.hex(palette.blue)(`🔄 ${running} running`));
    if (failed > 0) headerParts.push(chalk.hex(palette.red)(`❌ ${failed} failed`));
    headerParts.push(chalk.hex(palette.dim)(`layer ${this.completedLayers}/${this.totalLayers}`));

    this.headerText.setText('  ' + headerParts.join(chalk.hex(palette.dim)(' · ')));

    // Update or create node lines
    // Sort by layer then by id
    const sorted = Array.from(this.trackedNodes.values()).sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      return a.id.localeCompare(b.id);
    });

    for (const node of sorted) {
      const icon = this.statusIcon(node.status);
      const name = chalk.hex(node.status === 'complete' ? palette.green : node.status === 'error' ? palette.red : node.status === 'running' ? palette.blue : palette.dim)(node.label);
      const model = node.model ? chalk.hex(palette.purple)(` [${node.model}]`) : '';
      const msg = node.lastMessage
        ? chalk.hex(palette.dim)(` — ${node.lastMessage.length > 50 ? node.lastMessage.slice(0, 50) + '…' : node.lastMessage}`)
        : '';

      const line = `    ${icon} ${name}${model}${msg}`;

      const existing = this.nodeTexts.get(node.id);
      if (existing) {
        existing.setText(line);
      } else {
        const text = new Text(line, 1, 0);
        this.addChild(text);
        this.nodeTexts.set(node.id, text);
      }
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
