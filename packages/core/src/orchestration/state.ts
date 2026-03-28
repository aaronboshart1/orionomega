/**
 * @module orchestration/state
 * Workflow state management with checkpoint/restore support.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A single entry in the workflow state store. */
export interface StateEntry {
  /** Entry key. */
  key: string;
  /** Entry value (arbitrary data). */
  value: unknown;
  /** Category of data. */
  type: 'input' | 'artifact' | 'intermediate' | 'decision';
  /** Which node produced this entry. */
  source: string;
  /** Lifetime scope. */
  ttl: 'workflow' | 'persistent' | 'ephemeral';
  /** ISO timestamp of when the entry was created or last updated. */
  timestamp: string;
}

/** Serialised form of WorkflowState for checkpoint files. */
interface CheckpointData {
  workflowId: string;
  entries: StateEntry[];
  completedLayers: number;
  checkpointedAt: string;
}

/**
 * Manages key/value state for a single workflow execution.
 *
 * Node outputs are stored under the key pattern `node:{nodeId}:output`.
 * State can be checkpointed to disk and restored for crash recovery.
 */
export class WorkflowState {
  private readonly store = new Map<string, StateEntry>();
  private readonly workflowId: string;
  private readonly checkpointDir: string | undefined;

  /** Number of fully completed topological layers (used by recovery). */
  completedLayers = 0;

  constructor(workflowId: string, checkpointDir?: string) {
    this.workflowId = workflowId;
    this.checkpointDir = checkpointDir;
  }

  /**
   * Returns the output stored for a given node, or `undefined` if none.
   *
   * @param nodeId - The node identifier.
   */
  getNodeOutput(nodeId: string): unknown {
    const entry = this.store.get(`node:${nodeId}:output`);
    return entry?.value;
  }

  /**
   * Stores a node's output in the state.
   *
   * @param nodeId - The node identifier.
   * @param value - The output data.
   * @param type - Entry type classification. Defaults to `'artifact'`.
   */
  setNodeOutput(
    nodeId: string,
    value: unknown,
    type: StateEntry['type'] = 'artifact',
  ): void {
    this.set(`node:${nodeId}:output`, {
      key: `node:${nodeId}:output`,
      value,
      type,
      source: nodeId,
      ttl: 'workflow',
    });
  }

  /**
   * Retrieves a state entry by key.
   *
   * @param key - The entry key.
   */
  get(key: string): StateEntry | undefined {
    return this.store.get(key);
  }

  /**
   * Stores a state entry. The `timestamp` field is set automatically.
   *
   * @param key - The entry key.
   * @param entry - Entry data (without timestamp).
   */
  set(key: string, entry: Omit<StateEntry, 'timestamp'>): void {
    this.store.set(key, {
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Returns all state entries as an array.
   */
  entries(): StateEntry[] {
    return [...this.store.values()];
  }

  /**
   * Writes the current state to disk as a JSON checkpoint.
   *
   * The file is written to `{checkpointDir}/{workflowId}/state.json`.
   * Does nothing if no `checkpointDir` was provided.
   */
  async checkpoint(): Promise<void> {
    if (!this.checkpointDir) return;

    const dir = join(this.checkpointDir, this.workflowId);
    await mkdir(dir, { recursive: true });

    const data: CheckpointData = {
      workflowId: this.workflowId,
      entries: this.entries(),
      completedLayers: this.completedLayers,
      checkpointedAt: new Date().toISOString(),
    };

    const filePath = join(dir, 'state.json');
    const tmpPath = filePath + '.tmp';
    try {
      await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      await rename(tmpPath, filePath);
    } catch (err) {
      try { await unlink(tmpPath); } catch { /* ignore cleanup failure */ }
      throw err;
    }
  }

  /**
   * Restores a WorkflowState from a checkpoint file on disk.
   *
   * @param workflowId - The workflow identifier to restore.
   * @param checkpointDir - The directory containing checkpoint data.
   * @returns A reconstituted WorkflowState.
   * @throws If the checkpoint file does not exist or is malformed.
   */
  static async restore(
    workflowId: string,
    checkpointDir: string,
  ): Promise<WorkflowState> {
    const filePath = join(checkpointDir, workflowId, 'state.json');
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as CheckpointData;

    const state = new WorkflowState(workflowId, checkpointDir);
    for (const entry of data.entries) {
      state.store.set(entry.key, entry);
    }
    state.completedLayers = data.completedLayers;

    return state;
  }

  /**
   * Clears all state entries and resets completedLayers.
   */
  clear(): void {
    this.store.clear();
    this.completedLayers = 0;
  }
}
