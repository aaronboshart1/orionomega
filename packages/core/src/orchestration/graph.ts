/**
 * @module orchestration/graph
 * Workflow graph construction, validation, and topological sorting.
 */

import { randomUUID } from 'node:crypto';
import type { WorkflowNode, WorkflowGraph } from './types.js';

/** A validation error found during graph analysis. */
export interface ValidationError {
  /** The node ID that has the issue (or 'graph' for global issues). */
  nodeId: string;
  /** Human-readable error message. */
  message: string;
}

/**
 * Validates a set of workflow nodes for structural correctness.
 *
 * Checks for:
 * - Missing dependency references
 * - Duplicate node IDs
 * - Orphan nodes (no dependencies and no dependents, in a multi-node graph)
 * - Cycles (via topological sort attempt)
 *
 * @param nodes - Map of node ID → WorkflowNode.
 * @returns An array of validation errors (empty if valid).
 */
export function validateGraph(
  nodes: Map<string, WorkflowNode>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (nodes.size === 0) {
    return errors;
  }

  // Check for missing dependencies
  for (const [id, node] of nodes) {
    for (const dep of node.dependsOn) {
      if (!nodes.has(dep)) {
        errors.push({
          nodeId: id,
          message: `Depends on unknown node '${dep}'`,
        });
      }
    }
  }

  // Check for self-dependencies
  for (const [id, node] of nodes) {
    if (node.dependsOn.includes(id)) {
      errors.push({
        nodeId: id,
        message: 'Node depends on itself',
      });
    }
  }

  // Check for orphan nodes (no deps and nobody depends on them) in multi-node graphs
  if (nodes.size > 1) {
    const hasDependents = new Set<string>();
    for (const node of nodes.values()) {
      for (const dep of node.dependsOn) {
        hasDependents.add(dep);
      }
    }

    for (const [id, node] of nodes) {
      if (node.dependsOn.length === 0 && !hasDependents.has(id)) {
        // Only flag as orphan if there are other entry nodes
        const entryCount = [...nodes.values()].filter(
          (n) => n.dependsOn.length === 0,
        ).length;
        const exitCount = [...nodes.keys()].filter(
          (k) => !hasDependents.has(k),
        ).length;
        if (entryCount > 1 && exitCount > 1) {
          errors.push({
            nodeId: id,
            message:
              'Orphan node: no dependencies and no other nodes depend on it',
          });
        }
      }
    }
  }

  // Cycle detection via Kahn's algorithm
  try {
    topologicalSort(nodes);
  } catch (e) {
    errors.push({
      nodeId: 'graph',
      message: e instanceof Error ? e.message : 'Cycle detected in graph',
    });
  }

  return errors;
}

/**
 * Performs a topological sort using Kahn's algorithm, returning parallel layers.
 *
 * Each layer contains node IDs that can be executed in parallel
 * (all their dependencies are satisfied by previous layers).
 *
 * @param nodes - Map of node ID → WorkflowNode.
 * @returns Array of layers, where each layer is an array of node IDs.
 * @throws Error if the graph contains a cycle.
 */
export function topologicalSort(
  nodes: Map<string, WorkflowNode>,
): string[][] {
  if (nodes.size === 0) {
    return [];
  }

  // Build in-degree map (only counting edges within the provided nodes)
  const inDegree = new Map<string, number>();
  for (const id of nodes.keys()) {
    inDegree.set(id, 0);
  }

  for (const [id, node] of nodes) {
    for (const dep of node.dependsOn) {
      if (nodes.has(dep)) {
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }
  }

  // Seed the first layer with zero in-degree nodes
  const layers: string[][] = [];
  let currentLayer = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([id]) => id)
    .sort(); // Deterministic ordering

  let processed = 0;

  while (currentLayer.length > 0) {
    layers.push(currentLayer);
    processed += currentLayer.length;

    const nextLayer: string[] = [];

    for (const nodeId of currentLayer) {
      // Reduce in-degree for nodes that depend on this one
      for (const [candidateId, candidate] of nodes) {
        if (candidate.dependsOn.includes(nodeId)) {
          const newDeg = (inDegree.get(candidateId) ?? 1) - 1;
          inDegree.set(candidateId, newDeg);
          if (newDeg === 0) {
            nextLayer.push(candidateId);
          }
        }
      }
    }

    currentLayer = nextLayer.sort();
  }

  if (processed < nodes.size) {
    const stuck = [...nodes.keys()].filter(
      (id) => (inDegree.get(id) ?? 0) > 0,
    );
    throw new Error(
      `Cycle detected in workflow graph. Nodes involved: ${stuck.join(', ')}`,
    );
  }

  return layers;
}

/**
 * Builds a complete WorkflowGraph from an array of WorkflowNode definitions.
 *
 * Validates the nodes, computes topological layers, and identifies
 * entry nodes (no dependencies) and exit nodes (no dependents).
 *
 * @param nodes - Array of workflow node definitions.
 * @param name - Optional workflow name. Defaults to 'Untitled Workflow'.
 * @returns A fully constructed WorkflowGraph.
 * @throws Error if validation fails (cycles, missing dependencies, etc.).
 */
export function buildGraph(
  nodes: WorkflowNode[],
  name?: string,
): WorkflowGraph {
  const nodeMap = new Map<string, WorkflowNode>();

  // Check for duplicate IDs
  for (const node of nodes) {
    if (nodeMap.has(node.id)) {
      throw new Error(`Duplicate node ID: '${node.id}'`);
    }
    nodeMap.set(node.id, { ...node });
  }

  // Validate
  const errors = validateGraph(nodeMap);
  const criticalErrors = errors.filter(
    (e) =>
      e.message.startsWith('Cycle detected') ||
      e.message.startsWith('Depends on unknown') ||
      e.message.startsWith('Node depends on itself'),
  );

  if (criticalErrors.length > 0) {
    const msgs = criticalErrors.map((e) => `[${e.nodeId}] ${e.message}`);
    throw new Error(`Graph validation failed:\n  ${msgs.join('\n  ')}`);
  }

  // Compute layers
  const layers = topologicalSort(nodeMap);

  // Entry nodes: no dependencies
  const entryNodes = [...nodeMap.values()]
    .filter((n) => n.dependsOn.length === 0)
    .map((n) => n.id)
    .sort();

  // Exit nodes: no other node depends on them
  const hasDependents = new Set<string>();
  for (const node of nodeMap.values()) {
    for (const dep of node.dependsOn) {
      hasDependents.add(dep);
    }
  }
  const exitNodes = [...nodeMap.keys()]
    .filter((id) => !hasDependents.has(id))
    .sort();

  return {
    id: randomUUID(),
    name: name ?? 'Untitled Workflow',
    createdAt: new Date().toISOString(),
    nodes: nodeMap,
    layers,
    entryNodes,
    exitNodes,
  };
}
