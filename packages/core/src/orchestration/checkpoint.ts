/**
 * @module orchestration/checkpoint
 * Serializes and deserializes workflow state for crash recovery.
 * After each node completion, the executor writes a checkpoint.
 * On restart, incomplete checkpoints can be detected and resumed.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../logging/logger.js';
import type { WorkflowCheckpoint, WorkflowGraph, WorkflowNode } from './types.js';

const log = createLogger('checkpoint');

/**
 * Manages workflow checkpoints on disk.
 */
export class CheckpointManager {
  private readonly dir: string;

  constructor(checkpointDir: string) {
    this.dir = checkpointDir;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /**
   * Save a checkpoint for the given workflow.
   */
  save(checkpoint: WorkflowCheckpoint): void {
    const file = this.filePath(checkpoint.workflowId);
    const tmpFile = file + '.tmp';
    try {
      const serialized = JSON.stringify(checkpoint, null, 2);
      writeFileSync(tmpFile, serialized, 'utf-8');
      renameSync(tmpFile, file);
      log.debug('Checkpoint saved', {
        workflowId: checkpoint.workflowId,
        layer: checkpoint.currentLayer,
        status: checkpoint.status,
      });
    } catch (err) {
      log.warn('Failed to save checkpoint', {
        workflowId: checkpoint.workflowId,
        error: err instanceof Error ? err.message : String(err),
      });
      try { unlinkSync(tmpFile); } catch { /* ignore cleanup failure */ }
    }
  }

  /**
   * Load a checkpoint for the given workflow ID.
   * Returns null if not found or corrupted.
   */
  load(workflowId: string): WorkflowCheckpoint | null {
    const file = this.filePath(workflowId);
    if (!existsSync(file)) return null;

    try {
      const raw = readFileSync(file, 'utf-8');
      const checkpoint = JSON.parse(raw) as WorkflowCheckpoint;
      log.info('Checkpoint loaded', {
        workflowId,
        layer: checkpoint.currentLayer,
        status: checkpoint.status,
      });
      return checkpoint;
    } catch (err) {
      log.warn('Failed to load checkpoint', {
        workflowId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Remove the checkpoint file for a completed/stopped workflow.
   */
  remove(workflowId: string): void {
    const file = this.filePath(workflowId);
    try {
      if (existsSync(file)) {
        unlinkSync(file);
        log.debug('Checkpoint removed', { workflowId });
      }
    } catch {
      // Ignore removal errors
    }
  }

  /**
   * Find all incomplete checkpoints (status !== 'complete' && status !== 'stopped').
   */
  findIncomplete(): WorkflowCheckpoint[] {
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith('.checkpoint.json'));
      const incomplete: WorkflowCheckpoint[] = [];

      for (const file of files) {
        try {
          const raw = readFileSync(join(this.dir, file), 'utf-8');
          const checkpoint = JSON.parse(raw) as WorkflowCheckpoint;
          if (checkpoint.status === 'running') {
            incomplete.push(checkpoint);
          }
        } catch {
          // Skip corrupted files
        }
      }

      if (incomplete.length > 0) {
        log.info('Found incomplete checkpoints', {
          count: incomplete.length,
          ids: incomplete.map((c) => c.workflowId),
        });
      }

      return incomplete;
    } catch {
      return [];
    }
  }

  /**
   * Reconstruct a WorkflowGraph from a checkpoint's serialized graph.
   * Converts Record<string, WorkflowNode> back to Map<string, WorkflowNode>.
   */
  static graphFromCheckpoint(checkpoint: WorkflowCheckpoint): WorkflowGraph {
    const nodeEntries = Object.entries(checkpoint.graph.nodes);
    return {
      id: checkpoint.graph.id,
      name: checkpoint.graph.name,
      createdAt: checkpoint.graph.createdAt,
      nodes: new Map(nodeEntries),
      layers: checkpoint.graph.layers,
      entryNodes: checkpoint.graph.entryNodes,
      exitNodes: checkpoint.graph.exitNodes,
    };
  }

  /**
   * Create a checkpoint from current execution state.
   */
  static buildCheckpoint(
    graph: WorkflowGraph,
    task: string,
    nodeOutputs: Record<string, string>,
    currentLayer: number,
    status: string,
    outputPaths: string[],
    decisions: string[],
    findings: string[],
    errors: { worker: string; message: string; resolution?: string }[],
  ): WorkflowCheckpoint {
    // Serialize Map to Record
    const serializedNodes: Record<string, WorkflowNode> = {};
    if (graph.nodes instanceof Map) {
      for (const [id, node] of graph.nodes) {
        serializedNodes[id] = node;
      }
    } else {
      const rec = graph.nodes as unknown as Record<string, WorkflowNode>;
      for (const [id, node] of Object.entries(rec)) {
        serializedNodes[id] = node;
      }
    }

    return {
      workflowId: graph.id,
      task,
      timestamp: new Date().toISOString(),
      graph: {
        id: graph.id,
        name: graph.name,
        createdAt: graph.createdAt,
        nodes: serializedNodes,
        layers: graph.layers,
        entryNodes: graph.entryNodes,
        exitNodes: graph.exitNodes,
      },
      nodeOutputs,
      currentLayer,
      status: status as WorkflowCheckpoint['status'],
      outputPaths,
      decisions,
      findings,
      errors,
    };
  }

  private filePath(workflowId: string): string {
    return join(this.dir, `${workflowId}.checkpoint.json`);
  }
}
