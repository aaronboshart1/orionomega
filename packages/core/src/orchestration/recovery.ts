/**
 * @module orchestration/recovery
 * Crash recovery: scan checkpoint directory, restore workflow state, clean up old checkpoints.
 */

import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowState } from './state.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('recovery');

/** Default maximum age for checkpoint cleanup (days). */
const DEFAULT_MAX_AGE_DAYS = 7;

/** Information about a recoverable workflow. */
export interface RecoverableWorkflow {
  /** Workflow identifier. */
  workflowId: string;
  /** ISO timestamp of the last checkpoint. */
  lastCheckpoint: string;
  /** Number of fully completed topological layers. */
  completedLayers: number;
}

/** Result of recovering a workflow. */
export interface RecoveryResult {
  /** The restored workflow state. */
  state: WorkflowState;
  /** The layer index to resume execution from. */
  resumeFromLayer: number;
}

/**
 * Manages crash recovery by scanning checkpoint directories,
 * restoring workflow state, and cleaning up stale checkpoints.
 */
export class RecoveryManager {
  private readonly checkpointDir: string;

  constructor(checkpointDir: string) {
    this.checkpointDir = checkpointDir;
  }

  /**
   * Lists all workflows that have recoverable checkpoint data.
   *
   * Scans the checkpoint directory for subdirectories containing a
   * `state.json` file and reads the checkpoint metadata.
   *
   * @returns Array of recoverable workflow descriptors.
   */
  async listRecoverable(): Promise<RecoverableWorkflow[]> {
    const results: RecoverableWorkflow[] = [];

    let entries: string[];
    try {
      entries = await readdir(this.checkpointDir);
    } catch {
      // Directory doesn't exist — nothing to recover
      return results;
    }

    for (const entry of entries) {
      const stateFile = join(this.checkpointDir, entry, 'state.json');
      try {
        const raw = await readFile(stateFile, 'utf-8');
        const data = JSON.parse(raw) as {
          workflowId: string;
          completedLayers: number;
          checkpointedAt: string;
        };

        results.push({
          workflowId: data.workflowId,
          lastCheckpoint: data.checkpointedAt,
          completedLayers: data.completedLayers,
        });
      } catch {
        // Skip entries that aren't valid checkpoints
        log.debug(`Skipping non-checkpoint entry: ${entry}`);
      }
    }

    return results;
  }

  /**
   * Recovers a workflow from its checkpoint, returning the restored state
   * and the layer index to resume from.
   *
   * @param workflowId - The workflow to recover.
   * @returns The recovery result, or `null` if no checkpoint exists.
   */
  async recover(workflowId: string): Promise<RecoveryResult | null> {
    try {
      const state = await WorkflowState.restore(workflowId, this.checkpointDir);
      log.info(
        `Recovered workflow '${workflowId}' — resume from layer ${state.completedLayers}`,
      );

      return {
        state,
        resumeFromLayer: state.completedLayers,
      };
    } catch {
      log.warn(`Could not recover workflow '${workflowId}' — no valid checkpoint found`);
      return null;
    }
  }

  /**
   * Removes checkpoint data older than `maxAgeDays`.
   *
   * @param maxAgeDays - Maximum age in days. Defaults to 7.
   * @returns The number of checkpoints removed.
   */
  async cleanup(maxAgeDays: number = DEFAULT_MAX_AGE_DAYS): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.checkpointDir);
    } catch {
      return 0;
    }

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const entry of entries) {
      const dirPath = join(this.checkpointDir, entry);
      try {
        const info = await stat(dirPath);
        if (info.isDirectory() && info.mtimeMs < cutoff) {
          await rm(dirPath, { recursive: true, force: true });
          removed++;
          log.info(`Cleaned up checkpoint: ${entry}`);
        }
      } catch {
        // Skip entries we can't stat
      }
    }

    return removed;
  }
}
