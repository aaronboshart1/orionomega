/**
 * @module components/workflow-panel
 * Top-level container managing multiple WorkflowBox instances.
 * Drop-in replacement for MultiWorkflowTracker.
 *
 * Supports focus mode: when focusedId is set, unfocused workflows
 * collapse to a compact header + summary line.
 *
 * Provides aggregate statistics across all active workflows for the status bar.
 */

import { Container } from '@mariozechner/pi-tui';
import type { GraphState, WorkerEvent } from '@orionomega/core';
import { WorkflowBox } from './workflow-box.js';

/** Aggregated statistics across all active workflows. */
export interface AggregateWorkflowStats {
  activeWorkflows: number;
  totalRunningWorkers: number;
  totalCompletedNodes: number;
  totalNodes: number;
  combinedCost: number;
  totalCompletedLayers: number;
  totalLayers: number;
  /** Worker summaries from all active workflows. */
  workerSummaries: string[];
  /** Elapsed time of the longest-running active workflow. */
  maxElapsed: number;
}

export class WorkflowPanel extends Container {
  readonly boxes = new Map<string, WorkflowBox>();
  private focusedId: string | null = null;
  private removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private collapseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Wire this to tui.requestRender() for spinner-driven re-renders. */
  onUpdate?: () => void;

  /** Add a new workflow and initialize it from graph state. */
  addWorkflow(id: string, state: GraphState): void {
    if (!this.boxes.has(id)) {
      const box = new WorkflowBox();
      box.onUpdate = () => this.onUpdate?.();
      this.boxes.set(id, box);
      this.addChild(box);
    }
    this.boxes.get(id)!.initFromGraphState(state);
    this.updateVisibility();
  }

  /** Update an existing workflow from a new graph state snapshot. */
  updateWorkflow(id: string, state: GraphState): void {
    const box = this.boxes.get(id);
    if (!box) return;
    box.updateFromGraphState(state);

    if (state.status === 'complete' || state.status === 'error' || state.status === 'stopped') {
      if (!this.removalTimers.has(id)) {
        const collapseTimer = setTimeout(() => {
          this.collapseTimers.delete(id);
          const b = this.boxes.get(id);
          if (b) b.expanded = false;
          this.onUpdate?.();
        }, 10_000);

        const removeTimer = setTimeout(() => {
          this.removalTimers.delete(id);
          this.collapseTimers.delete(id);
          const b = this.boxes.get(id);
          if (b) {
            b.dispose();
            this.removeChild(b);
            this.boxes.delete(id);
          }
          if (this.focusedId === id) this.focusedId = null;
          this.updateVisibility();
          this.onUpdate?.();
        }, 30_000);

        this.removalTimers.set(id, removeTimer);
        this.collapseTimers.set(id, collapseTimer);
      }
    } else {
      const existingRemoval = this.removalTimers.get(id);
      if (existingRemoval) {
        clearTimeout(existingRemoval);
        this.removalTimers.delete(id);
      }
      const existingCollapse = this.collapseTimers.get(id);
      if (existingCollapse) {
        clearTimeout(existingCollapse);
        this.collapseTimers.delete(id);
      }
    }
  }

  /** Update a single node from a worker event (takes full event object). */
  updateNodeEvent(wfId: string, event: WorkerEvent): void {
    this.boxes.get(wfId)?.updateNodeEvent(event);
  }

  /** Set focus to a specific workflow (or null to show all). */
  setFocus(workflowId: string | null): void {
    this.focusedId = workflowId;
    this.updateVisibility();
  }

  /** Number of active (non-completed) workflows. */
  get activeCount(): number {
    return [...this.boxes.values()].filter(b => b.isActive).length;
  }

  /**
   * Compute aggregate statistics across all active workflows.
   * Used by the status bar to show unified metrics.
   */
  getAggregateStats(): AggregateWorkflowStats {
    let totalRunningWorkers = 0;
    let totalCompletedNodes = 0;
    let totalNodes = 0;
    let combinedCost = 0;
    let totalCompletedLayers = 0;
    let totalLayers = 0;
    let maxElapsed = 0;
    const workerSummaries: string[] = [];
    let activeWorkflows = 0;

    for (const box of this.boxes.values()) {
      const stats = box.getStats();
      if (box.isActive) {
        activeWorkflows++;
      }
      totalRunningWorkers += stats.runningWorkers;
      totalCompletedNodes += stats.completedNodes;
      totalNodes += stats.totalNodes;
      combinedCost += stats.estimatedCost;
      totalCompletedLayers += stats.completedLayers;
      totalLayers += stats.totalLayers;
      if (stats.elapsed > maxElapsed) maxElapsed = stats.elapsed;
      workerSummaries.push(...stats.workerSummaries);
    }

    return {
      activeWorkflows,
      totalRunningWorkers,
      totalCompletedNodes,
      totalNodes,
      combinedCost,
      totalCompletedLayers,
      totalLayers,
      workerSummaries,
      maxElapsed,
    };
  }

  private updateVisibility(): void {
    for (const [id, box] of this.boxes) {
      box.expanded = this.focusedId === null || this.focusedId === id;
    }
  }
}
