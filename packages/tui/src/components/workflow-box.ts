/**
 * @module components/workflow-box
 * Box-bordered display for a single workflow.
 * Renders top/bottom borders with metadata, layer groups with nodes,
 * and an optional findings section on completion.
 *
 * Layout:
 *   ╭─ ⚡ name ────── elapsed · layer N/M · $cost ─╮
 *   ═══ Layer 1 (2/3) ═══
 *   ⣾ node-label [Model]  32s
 *     ├ Reading src/file.ts
 *     └ 7 tool calls · 45%  ████████░░░░░░░░░░
 *   ╰───────────── ✓ done/total · ⣾ N running ─╯
 */

import { Container, Text, Spacer } from '@mariozechner/pi-tui';
import type { GraphState, WorkerEvent } from '@orionomega/core';
import chalk from 'chalk';
import { palette, spacing, icons, box } from '../theme.js';
import { shortenModel, formatDuration, formatCost, visibleLength } from '../utils/format.js';
import { omegaSpinner } from './omega-spinner.js';
import { NodeDisplay, mapNodeStatus, type NodeState, type NodeStatusType } from './node-display.js';
import { LayerGroup, type LayerStatus } from './layer-group.js';

/** Compute display width for the workflow box. */
function getBoxWidth(): number {
  return Math.min(72, (process.stdout.columns ?? 80) - 4);
}

/**
 * Compute execution layers from node dependency data.
 * Returns a map from nodeId to layer index.
 */
function computeNodeLayers(nodes: Record<string, any>): Map<string, number> {
  const layers = new Map<string, number>();
  const entries = Object.entries(nodes);

  // First, check if nodes already have a layer property
  let allHaveLayers = true;
  for (const [, node] of entries) {
    if (node.layer === undefined && node.layer !== 0) {
      allHaveLayers = false;
      break;
    }
  }
  if (allHaveLayers && entries.length > 0) {
    for (const [id, node] of entries) {
      layers.set(id, node.layer ?? 0);
    }
    return layers;
  }

  // Compute layers from dependsOn topology
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of entries) {
      if (layers.has(id)) continue;
      const deps = (node.dependsOn ?? []) as string[];
      if (deps.length === 0) {
        layers.set(id, 0);
        changed = true;
      } else if (deps.every((d: string) => layers.has(d))) {
        const maxDepLayer = Math.max(...deps.map((d: string) => layers.get(d)!));
        layers.set(id, maxDepLayer + 1);
        changed = true;
      }
    }
  }

  // Fallback for any remaining nodes (circular deps)
  for (const [id] of entries) {
    if (!layers.has(id)) layers.set(id, 0);
  }

  return layers;
}

/**
 * Single workflow display with box-drawing borders, layer-grouped nodes,
 * and optional findings section.
 */
export class WorkflowBox extends Container {
  private topBorder: Text;
  private bottomBorder: Text;
  private layerGroups = new Map<number, LayerGroup>();
  private nodeDisplays = new Map<string, NodeDisplay>();
  private findingsText: Text | null = null;
  private statsText: Text | null = null;
  private workflowName = '';
  private workflowStatus: string = 'running';
  private startTime = Date.now();
  private completedLayers = 0;
  private totalLayers = 0;
  private estimatedCost = 0;
  private _expanded = true;
  private unsubSpinner: (() => void) | null = null;
  private summaryLine: Text | null = null;
  private resultText: Text | null = null;

  /** Wire this to tui.requestRender() for spinner-driven re-renders. */
  onUpdate?: () => void;

  constructor() {
    super();
    this.topBorder = new Text('', 1, 0);
    this.bottomBorder = new Text('', 1, 0);
  }

  get expanded(): boolean { return this._expanded; }

  set expanded(value: boolean) {
    if (this._expanded === value) return;
    this._expanded = value;
    this.rebuildStructure();
  }

  /** Check if workflow is still active (has pending or running nodes). */
  get isActive(): boolean {
    for (const nd of this.nodeDisplays.values()) {
      if (nd.state.status === 'pending' || nd.state.status === 'running') return true;
    }
    return false;
  }

  /** Initialize from a new workflow's graph state. */
  initFromGraphState(state: GraphState): void {
    this.workflowName = state.name;
    this.workflowStatus = state.status;
    this.startTime = Date.now();
    this.completedLayers = state.completedLayers;
    this.totalLayers = state.totalLayers;
    this.estimatedCost = state.estimatedCost ?? 0;

    // Clear old state
    this.nodeDisplays.clear();
    this.layerGroups.clear();

    const nodes = state.nodes ?? {};
    const layerMap = computeNodeLayers(nodes);

    // Build node displays
    for (const [id, node] of Object.entries(nodes)) {
      const n = node as any;
      const nodeState: NodeState = {
        id,
        label: n.label ?? id,
        model: shortenModel(n.agent?.model ?? n.codingAgent?.model ?? ''),
        type: n.type ?? 'AGENT',
        status: mapNodeStatus(n.status),
        layer: layerMap.get(id) ?? 0,
        dependsOn: n.dependsOn ?? [],
        dependencyLabels: this.resolveDependencyLabels(n.dependsOn ?? [], nodes),
        progress: n.progress ?? 0,
        elapsed: 0,
        startedAt: n.startedAt ? new Date(n.startedAt).getTime() : undefined,
        duration: (n.completedAt && n.startedAt)
          ? Math.round((new Date(n.completedAt).getTime() - new Date(n.startedAt).getTime()) / 1000)
          : undefined,
        errorMessage: n.error,
      };
      if (nodeState.startedAt) {
        nodeState.elapsed = Math.round((Date.now() - nodeState.startedAt) / 1000);
      }
      this.nodeDisplays.set(id, new NodeDisplay(nodeState));
    }

    // Build layer groups
    this.buildLayerGroups();

    // Process recent events for activity
    for (const evt of state.recentEvents ?? []) {
      const nd = this.nodeDisplays.get(evt.nodeId);
      if (nd) nd.accumulator.processEvent(evt);
    }

    // Manage spinner
    this.updateSpinner();

    // Rebuild the component tree
    this.rebuildStructure();
  }

  /** Update from a new graph state snapshot. */
  updateFromGraphState(state: GraphState): void {
    this.workflowStatus = state.status;
    this.completedLayers = state.completedLayers;
    this.totalLayers = state.totalLayers;
    this.estimatedCost = state.estimatedCost ?? this.estimatedCost;

    const nodes = state.nodes ?? {};
    const layerMap = computeNodeLayers(nodes);

    // Update existing nodes and add new ones
    for (const [id, node] of Object.entries(nodes)) {
      const n = node as any;
      const existing = this.nodeDisplays.get(id);
      if (existing) {
        existing.updateFromGraphNode(n);
      } else {
        const nodeState: NodeState = {
          id,
          label: n.label ?? id,
          model: shortenModel(n.agent?.model ?? n.codingAgent?.model ?? ''),
          type: n.type ?? 'AGENT',
          status: mapNodeStatus(n.status),
          layer: layerMap.get(id) ?? 0,
          dependsOn: n.dependsOn ?? [],
          dependencyLabels: this.resolveDependencyLabels(n.dependsOn ?? [], nodes),
          progress: n.progress ?? 0,
          elapsed: 0,
          startedAt: n.startedAt ? new Date(n.startedAt).getTime() : undefined,
          duration: (n.completedAt && n.startedAt)
            ? Math.round((new Date(n.completedAt).getTime() - new Date(n.startedAt).getTime()) / 1000)
            : undefined,
          errorMessage: n.error,
        };
        if (nodeState.startedAt) {
          nodeState.elapsed = Math.round((Date.now() - nodeState.startedAt) / 1000);
        }
        this.nodeDisplays.set(id, new NodeDisplay(nodeState));
      }
    }

    // Process recent events
    for (const evt of state.recentEvents ?? []) {
      const nd = this.nodeDisplays.get(evt.nodeId);
      if (nd) nd.accumulator.processEvent(evt);
    }

    // Rebuild layer groups and structure
    this.buildLayerGroups();
    this.updateSpinner();
    this.rebuildStructure();
  }

  /** Update a single node from a worker event. */
  updateNodeEvent(event: WorkerEvent): void {
    const nd = this.nodeDisplays.get(event.nodeId);
    if (nd) {
      nd.updateFromEvent(event);
      // Node display rebuilds itself — just update borders
      this.updateBorders();
    }
  }

  /** Clean up resources. */
  dispose(): void {
    this.stopSpinner();
  }

  // ── Stats & Result Rendering ───────────────────────────────────

  /**
   * Expose per-workflow statistics for aggregate computation.
   * Called by WorkflowPanel.getAggregateStats().
   */
  getStats(): {
    runningWorkers: number;
    completedNodes: number;
    totalNodes: number;
    estimatedCost: number;
    completedLayers: number;
    totalLayers: number;
    elapsed: number;
    workerSummaries: string[];
  } {
    let runningWorkers = 0;
    let completedNodes = 0;
    const workerSummaries: string[] = [];
    for (const nd of this.nodeDisplays.values()) {
      switch (nd.state.status) {
        case 'running':
          runningWorkers++;
          workerSummaries.push(nd.state.label);
          break;
        case 'complete': case 'skipped':
          completedNodes++;
          break;
      }
    }
    return {
      runningWorkers,
      completedNodes,
      totalNodes: this.nodeDisplays.size,
      estimatedCost: this.estimatedCost,
      completedLayers: this.completedLayers,
      totalLayers: this.totalLayers,
      elapsed: Math.round((Date.now() - this.startTime) / 1000),
      workerSummaries,
    };
  }

  /**
   * Add a result text section to the workflow box (rendered on completion).
   * Used to display workflow output inside the box instead of the chat log.
   */
  addResult(text: string): void {
    if (!this.resultText) {
      this.resultText = new Text('', 1, 0);
    }
    const maxLen = 2000;
    const display = text.length > maxLen ? text.slice(0, maxLen) + '\n... [truncated]' : text;
    const lines = display.split('\n').map(line =>
      `${spacing.indent2}${chalk.hex(palette.text)(line)}`,
    );
    this.resultText.setText(lines.join('\n'));
    this.rebuildStructure();
  }

  // ── Layer Group Management ─────────────────────────────────────

  private buildLayerGroups(): void {
    // Group nodes by layer
    const layerNodes = new Map<number, NodeDisplay[]>();
    for (const nd of this.nodeDisplays.values()) {
      const layer = nd.state.layer;
      if (!layerNodes.has(layer)) layerNodes.set(layer, []);
      layerNodes.get(layer)!.push(nd);
    }

    // Sort nodes within each layer by id
    for (const nodes of layerNodes.values()) {
      nodes.sort((a, b) => a.state.id.localeCompare(b.state.id));
    }

    // Create or update layer groups
    const allLayerIndices = [...layerNodes.keys()].sort((a, b) => a - b);
    const newLayerGroups = new Map<number, LayerGroup>();

    for (const layerIdx of allLayerIndices) {
      const nodes = layerNodes.get(layerIdx)!;
      let lg = this.layerGroups.get(layerIdx);
      if (!lg) {
        lg = new LayerGroup(layerIdx);
      }

      // Compute layer stats
      const completed = nodes.filter(n =>
        n.state.status === 'complete' || n.state.status === 'skipped',
      ).length;
      const total = nodes.length;
      const hasRunning = nodes.some(n => n.state.status === 'running');
      const hasError = nodes.some(n => n.state.status === 'error');

      // Determine layer status
      let layerStatus: LayerStatus = 'pending';
      if (completed === total && total > 0) {
        layerStatus = 'complete';
      } else if (hasRunning || hasError || completed > 0) {
        layerStatus = 'active';
      }

      // Compute layer duration
      let layerDuration = 0;
      if (layerStatus === 'complete') {
        layerDuration = this.computeLayerDuration(nodes);
      }

      lg.updateStats(completed, total, layerDuration, layerStatus);
      lg.setNodes(nodes);

      // Auto-collapse logic:
      // Collapse if: all nodes done/skipped, a later layer has started, total workflow nodes > 4
      const laterLayerStarted = allLayerIndices.some(
        idx => idx > layerIdx && (layerNodes.get(idx) ?? []).some(
          n => n.state.status === 'running' || n.state.status === 'complete',
        ),
      );
      const totalNodeCount = this.nodeDisplays.size;
      if (
        layerStatus === 'complete' &&
        laterLayerStarted &&
        totalNodeCount > 4
      ) {
        lg.collapse();
      } else if (layerStatus === 'active' || (layerStatus === 'complete' && !laterLayerStarted)) {
        lg.expand();
      }

      newLayerGroups.set(layerIdx, lg);
    }

    this.layerGroups = newLayerGroups;
  }

  private computeLayerDuration(nodes: NodeDisplay[]): number {
    let earliest = Infinity;
    let latest = 0;
    for (const nd of nodes) {
      if (nd.state.startedAt && nd.state.startedAt < earliest) earliest = nd.state.startedAt;
      if (nd.state.duration !== undefined && nd.state.startedAt) {
        const endTime = nd.state.startedAt + nd.state.duration * 1000;
        if (endTime > latest) latest = endTime;
      }
    }
    if (earliest === Infinity || latest === 0) return 0;
    return Math.round((latest - earliest) / 1000);
  }

  // ── Rendering ──────────────────────────────────────────────────

  /** Full rebuild of the component tree (children of this Container). */
  private rebuildStructure(): void {
    // Detach all children
    this.detachAll();

    if (!this._expanded) {
      // Collapsed: show header + summary + footer
      this.addChild(this.topBorder);
      this.updateTopBorder();

      if (!this.summaryLine) this.summaryLine = new Text('', 1, 0);
      this.updateSummaryLine();
      this.addChild(this.summaryLine);

      this.addChild(this.bottomBorder);
      this.updateBottomBorder();
      return;
    }

    // Expanded: full display
    this.addChild(this.topBorder);
    this.updateTopBorder();

    // Spacer after top border
    this.addChild(new Spacer(1));

    // Layer groups in order
    const sortedLayers = [...this.layerGroups.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, lg] of sortedLayers) {
      this.addChild(lg);
    }

    // Findings section (on completion)
    if (this.workflowStatus === 'complete' || this.workflowStatus === 'error' || this.workflowStatus === 'stopped') {
      const allFindings = this.collectFindings();
      if (allFindings.length > 0) {
        this.addChild(new Spacer(1));
        if (!this.findingsText) this.findingsText = new Text('', 1, 0);
        const findingLines = [
          `${spacing.indent2}${chalk.hex(palette.accent)(icons.finding)} ${chalk.hex(palette.accent)('Findings:')}`,
          ...allFindings.map(f =>
            `${spacing.indent3}${chalk.hex(palette.dim)('\u2022')} ${chalk.hex(palette.text)(f)}`,
          ),
        ];
        this.findingsText.setText(findingLines.join('\n'));
        this.addChild(this.findingsText);
      }
    }

    // Result section (workflow output rendered inside the box)
    if (this.resultText) {
      this.addChild(new Spacer(1));
      const resultHeader = new Text(
        `${spacing.indent2}${chalk.hex(palette.info)(icons.worker)} ${chalk.hex(palette.info)('Result:')}`,
        1, 0,
      );
      this.addChild(resultHeader);
      this.addChild(this.resultText);
    }

    // Spacer before bottom border
    this.addChild(new Spacer(1));

    this.addChild(this.bottomBorder);
    this.updateBottomBorder();
  }

  /** Detach all children without destroying them. */
  private detachAll(): void {
    // Remove top/bottom borders
    try { this.removeChild(this.topBorder); } catch {}
    try { this.removeChild(this.bottomBorder); } catch {}
    if (this.summaryLine) try { this.removeChild(this.summaryLine); } catch {}
    if (this.findingsText) try { this.removeChild(this.findingsText); } catch {}
    if (this.statsText) try { this.removeChild(this.statsText); } catch {}
    if (this.resultText) try { this.removeChild(this.resultText); } catch {}

    // Remove layer groups
    for (const lg of this.layerGroups.values()) {
      try { this.removeChild(lg); } catch {}
    }

    // Remove any spacers (use clear for a fresh start, re-add persistent children)
    this.clear();
  }

  /** Update only border texts (without restructuring). */
  private updateBorders(): void {
    this.updateTopBorder();
    this.updateBottomBorder();
    if (this.summaryLine && !this._expanded) this.updateSummaryLine();
  }

  private updateTopBorder(): void {
    const W = getBoxWidth();
    const bc = chalk.hex(palette.border);

    // Status icon
    let statusIcon: string;
    if (this.workflowStatus === 'complete') {
      statusIcon = chalk.hex(palette.success)(icons.complete);
    } else if (this.workflowStatus === 'error') {
      statusIcon = chalk.hex(palette.error)(icons.error);
    } else {
      statusIcon = chalk.hex(palette.accent)(icons.workflowName);
    }

    const name = chalk.hex(palette.accent).bold(this.workflowName);
    const elapsed = Math.round((Date.now() - this.startTime) / 1000);

    // Build metadata parts
    const metaParts: string[] = [formatDuration(elapsed)];
    if (this.workflowStatus === 'complete') {
      metaParts.push('complete');
    } else {
      metaParts.push(`layer ${this.completedLayers}/${this.totalLayers}`);
    }
    if (this.estimatedCost > 0) metaParts.push(formatCost(this.estimatedCost));
    const meta = metaParts.join(' \u00b7 ');

    // Build border
    const leftContent = ` ${statusIcon} ${name} `;
    const rightContent = ` ${meta} `;
    const leftLen = visibleLength(leftContent);
    const rightLen = visibleLength(rightContent);
    const fillLen = Math.max(1, W - leftLen - rightLen - 2);
    const fill = box.horizontal.repeat(fillLen);

    this.topBorder.setText(
      `${spacing.indent1}${bc(box.topLeft + box.horizontal)}${leftContent}${bc(fill)}${rightContent}${bc(box.horizontal + box.topRight)}`,
    );
  }

  private updateBottomBorder(): void {
    const W = getBoxWidth();
    const bc = chalk.hex(palette.border);

    // Count node statuses
    let done = 0, running = 0, pending = 0, failed = 0;
    for (const nd of this.nodeDisplays.values()) {
      switch (nd.state.status) {
        case 'complete': case 'skipped': done++; break;
        case 'running': running++; break;
        case 'pending': pending++; break;
        case 'error': failed++; break;
      }
    }
    const total = this.nodeDisplays.size;

    // Build stats
    const statsParts: string[] = [];
    statsParts.push(`${chalk.hex(palette.success)(icons.complete)} ${done}/${total}`);
    if (running > 0) statsParts.push(`${chalk.hex(palette.info)(omegaSpinner.current)} ${running} running`);
    if (failed > 0) statsParts.push(`${chalk.hex(palette.error)(icons.error)} ${failed} failed`);
    if (pending > 0) statsParts.push(`${chalk.hex(palette.dim)(icons.pending)} ${pending} pending`);

    const stats = statsParts.join(' \u00b7 ');
    const rightContent = ` ${stats} `;
    const rightLen = visibleLength(rightContent);
    const fillLen = Math.max(1, W - rightLen - 2);
    const fill = box.horizontal.repeat(fillLen);

    this.bottomBorder.setText(
      `${spacing.indent1}${bc(box.bottomLeft + fill)}${rightContent}${bc(box.horizontal + box.bottomRight)}`,
    );
  }

  private updateSummaryLine(): void {
    if (!this.summaryLine) return;
    let running = 0, pending = 0;
    for (const nd of this.nodeDisplays.values()) {
      if (nd.state.status === 'running') running++;
      if (nd.state.status === 'pending') pending++;
    }
    const parts: string[] = [];
    if (running > 0) parts.push(`${chalk.hex(palette.info)(omegaSpinner.current)} ${running} running`);
    if (pending > 0) parts.push(`${chalk.hex(palette.dim)(icons.pending)} ${pending} pending`);
    this.summaryLine.setText(`${spacing.indent2}${parts.join(' \u00b7 ')}`);
  }

  // ── Spinner Management ─────────────────────────────────────────

  private hasRunningNodes(): boolean {
    for (const nd of this.nodeDisplays.values()) {
      if (nd.state.status === 'running') return true;
    }
    return false;
  }

  private updateSpinner(): void {
    if (this.hasRunningNodes()) {
      this.startSpinner();
    } else {
      this.stopSpinner();
    }
  }

  private startSpinner(): void {
    if (this.unsubSpinner) return;
    this.unsubSpinner = omegaSpinner.subscribe(() => {
      // Update running nodes' elapsed times and spinner icons
      for (const nd of this.nodeDisplays.values()) {
        nd.tickUpdate();
      }
      // Update borders (elapsed time in header, spinner in footer)
      this.updateBorders();
      this.onUpdate?.();
    });
  }

  private stopSpinner(): void {
    if (this.unsubSpinner) {
      this.unsubSpinner();
      this.unsubSpinner = null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  private resolveDependencyLabels(depIds: string[], nodes: Record<string, any>): string[] {
    return depIds.map(id => {
      const node = nodes[id];
      return node?.label ?? id;
    });
  }

  private collectFindings(): string[] {
    const findings: string[] = [];
    for (const nd of this.nodeDisplays.values()) {
      findings.push(...nd.accumulator.findings);
    }
    return findings;
  }
}
