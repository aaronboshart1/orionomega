/**
 * @module components/workflow-panel
 * Top-level container managing multiple WorkflowBox instances.
 * Drop-in replacement for MultiWorkflowTracker.
 *
 * Supports focus mode: when focusedId is set, unfocused workflows
 * collapse to a compact header + summary line.
 */

import { Container } from '@mariozechner/pi-tui';
import type { GraphState, WorkerEvent } from '@orionomega/core';
import { WorkflowBox } from './workflow-box.js';

export class WorkflowPanel extends Container {
  readonly boxes = new Map<string, WorkflowBox>();
  private focusedId: string | null = null;
  private removalTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

    // Schedule removal after completion
    if (state.status === 'complete' || state.status === 'error' || state.status === 'stopped') {
      if (!this.removalTimers.has(id)) {
        const timer = setTimeout(() => {
          const b = this.boxes.get(id);
          if (b) {
            try { b.dispose(); } catch {}
            try { this.removeChild(b); } catch {}
            this.boxes.delete(id);
          }
          this.removalTimers.delete(id);
          if (this.focusedId === id) this.focusedId = null;
          this.updateVisibility();
        }, 30_000);
        this.removalTimers.set(id, timer);
      }
    } else {
      // Workflow resumed / restarted — cancel any pending removal
      const existing = this.removalTimers.get(id);
      if (existing !== undefined) {
        clearTimeout(existing);
        this.removalTimers.delete(id);
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

  /** Total number of running workers across all workflows. */
  get totalRunningWorkers(): number {
    let count = 0;
    for (const box of this.boxes.values()) {
      if (box.isActive) count++;
    }
    return count;
  }

  /**
   * Dispose all workflows and cancel all pending removal timers.
   * Called during TUI shutdown to prevent timer-based activity after exit.
   */
  dispose(): void {
    for (const timer of this.removalTimers.values()) {
      clearTimeout(timer);
    }
    this.removalTimers.clear();
    for (const box of this.boxes.values()) {
      try { box.dispose(); } catch {}
    }
    this.boxes.clear();
  }

  private updateVisibility(): void {
    for (const [id, box] of this.boxes) {
      box.expanded = this.focusedId === null || this.focusedId === id;
    }
  }
}
