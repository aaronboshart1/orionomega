/**
 * @module orchestration/layer-scheduler
 *
 * Layer scheduling for the graph executor (Task #237 split out of
 * `executor.ts`). Owns the per-layer decisions about which nodes are runnable
 * and how router selections prune downstream subtrees:
 *   - {@link computeRunnableNodes} — filter a topological layer down to nodes
 *     that should actually run (not skipped, not already done, dependencies
 *     not failed), marking newly-skipped nodes as it goes.
 *   - {@link evaluateRouters} — after a layer completes, look at ROUTER node
 *     outputs and skip the subtrees of non-selected routes.
 *   - {@link markSubtreeSkipped} — recursively skip a node and every dependent
 *     that depends exclusively on already-skipped nodes.
 *
 * The scheduler shares the executor's live state collections by reference
 * (graph, skippedNodes, nodeErrors, nodeResults) so mutations stay consistent
 * with the rest of the run, while isolating the scheduling logic for testing.
 */

import type { WorkflowGraph } from './types.js';
import type { WorkerResult } from './worker.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('layer-scheduler');

export class LayerScheduler {
  constructor(
    private readonly graph: WorkflowGraph,
    private readonly skippedNodes: Set<string>,
    private readonly nodeErrors: Map<string, string>,
    private readonly nodeResults: Map<string, WorkerResult>,
  ) {}

  /**
   * Filter `layer` down to the node ids that should run this pass. Skips:
   *   - nodes already marked skipped;
   *   - nodes already `done` (resume case);
   *   - nodes whose upstream dependencies failed — these are marked skipped
   *     (status `'skipped'`, added to the skipped set) so downstream layers
   *     don't wait on outputs that will never arrive.
   */
  computeRunnableNodes(layer: string[]): string[] {
    return layer.filter((id) => {
      if (this.skippedNodes.has(id)) return false;
      const node = this.graph.nodes.get(id);
      if (node && node.status === 'done') {
        log.info(`Skipping already-completed node '${id}'`);
        return false;
      }
      if (node && node.dependsOn.length > 0) {
        const failedDeps = node.dependsOn.filter((depId) => this.nodeErrors.has(depId));
        if (failedDeps.length > 0) {
          const failedLabels = failedDeps
            .map((depId) => this.graph.nodes.get(depId)?.label ?? depId)
            .join(', ');
          log.warn(`Node '${id}' skipped — upstream dependencies failed: ${failedLabels}`);
          this.skippedNodes.add(id);
          node.status = 'skipped';
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Evaluate ROUTER nodes in a completed layer and skip the subtrees of any
   * route that wasn't selected.
   */
  evaluateRouters(layer: string[]): void {
    for (const nodeId of layer) {
      const node = this.graph.nodes.get(nodeId);
      if (node?.type !== 'ROUTER' || node.status !== 'done') continue;

      const result = this.nodeResults.get(nodeId);
      if (!result?.output) continue;

      const routeOutput = result.output as { route: string; target?: string };
      const router = node.router;
      if (!router) continue;

      const selectedTarget = routeOutput.target;
      for (const [, targetId] of Object.entries(router.routes)) {
        if (targetId && targetId !== selectedTarget) {
          this.markSubtreeSkipped(targetId);
        }
      }
    }
  }

  /** Recursively marks a node and all its exclusive dependents as skipped. */
  markSubtreeSkipped(nodeId: string): void {
    if (this.skippedNodes.has(nodeId)) return;
    this.skippedNodes.add(nodeId);

    for (const [id, node] of this.graph.nodes) {
      if (
        node.dependsOn.includes(nodeId) &&
        node.dependsOn.every((dep) => this.skippedNodes.has(dep))
      ) {
        this.markSubtreeSkipped(id);
      }
    }
  }
}
