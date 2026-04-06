/**
 * @module orchestration/coding/file-lock-manager
 * Atomic file-level write coordination for parallel coding agents.
 *
 * Prevents concurrent implementer nodes from writing to the same file
 * simultaneously. Uses an all-or-nothing acquisition strategy to avoid
 * deadlocks: a worker either acquires ALL its required locks, or acquires none
 * and can be queued for retry.
 */

import type { AcquireResult, FileLockRecord } from './coding-types.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('file-lock-manager');

export interface FileLockManagerState {
  [workerId: string]: { holder: string; files: string[] };
}

/**
 * Manages exclusive write locks on file paths.
 *
 * All methods are synchronous and safe for use within a single Node.js
 * process (no cross-process coordination required). For distributed use,
 * replace the Map with a distributed store.
 */
export class FileLockManager {
  /** Active locks: file path → lock record. */
  private readonly locks: Map<string, FileLockRecord> = new Map();

  /**
   * Attempt to acquire exclusive locks on all requested files.
   *
   * Uses all-or-nothing semantics: if any file is already locked by another
   * worker, no locks are acquired and the caller should wait and retry.
   *
   * @param workerId - The ID of the requesting worker.
   * @param files - File paths to lock.
   * @param timeoutMs - Not used for the acquire itself; stored for future
   *   timeout-based auto-release (deadlock recovery).
   * @returns AcquireResult indicating success or which files are conflicting.
   */
  async acquire(
    workerId: string,
    files: string[],
    _timeoutMs: number,
  ): Promise<AcquireResult> {
    if (files.length === 0) {
      return { acquired: true };
    }

    // Check all files atomically (all-or-nothing)
    const conflictingFiles: string[] = [];
    let conflictingWorker: string | undefined;

    for (const file of files) {
      const existing = this.locks.get(file);
      if (existing && existing.holder !== workerId) {
        conflictingFiles.push(file);
        conflictingWorker = existing.holder;
      }
    }

    if (conflictingFiles.length > 0) {
      log.debug(
        `Lock acquire denied for worker ${workerId}: ` +
        `${conflictingFiles.length} files held by ${conflictingWorker}`,
      );
      return { acquired: false, conflictingFiles, conflictingWorker };
    }

    // Acquire all locks atomically
    const acquiredAt = new Date().toISOString();
    // Build a shared Set for all files in this worker's lock entry
    const fileSet = new Set(files);

    for (const file of files) {
      this.locks.set(file, { holder: workerId, acquiredAt, files: fileSet });
    }

    log.debug(`Worker ${workerId} acquired ${files.length} file lock(s): ${files.join(', ')}`);
    return { acquired: true };
  }

  /**
   * Release all locks held by the given worker.
   * Safe to call even if the worker holds no locks (no-op).
   *
   * @param workerId - The ID of the worker releasing locks.
   */
  release(workerId: string): void {
    const released: string[] = [];
    for (const [file, lock] of this.locks) {
      if (lock.holder === workerId) {
        this.locks.delete(file);
        released.push(file);
      }
    }
    if (released.length > 0) {
      log.debug(`Worker ${workerId} released ${released.length} lock(s): ${released.join(', ')}`);
    }
  }

  /**
   * Check whether all requested files can be locked without conflict.
   * Does NOT acquire the locks.
   *
   * @param files - File paths to check.
   * @returns True if all files are currently unlocked.
   */
  canAcquire(files: string[]): boolean {
    for (const file of files) {
      if (this.locks.has(file)) return false;
    }
    return true;
  }

  /**
   * Returns the current lock state for debugging and event emission.
   * Maps each locked file to its holder and acquisition timestamp.
   */
  getState(): Map<string, { holder: string; acquiredAt: string }> {
    const result = new Map<string, { holder: string; acquiredAt: string }>();
    for (const [file, lock] of this.locks) {
      result.set(file, { holder: lock.holder, acquiredAt: lock.acquiredAt });
    }
    return result;
  }

  /**
   * Serializes the current lock state for checkpoint persistence.
   * The file Set is converted to an array for JSON compatibility.
   */
  serialize(): FileLockManagerState {
    const state: FileLockManagerState = {};
    // Group by worker ID
    const workerFiles = new Map<string, string[]>();
    for (const [file, lock] of this.locks) {
      const existing = workerFiles.get(lock.holder) ?? [];
      existing.push(file);
      workerFiles.set(lock.holder, existing);
    }
    for (const [workerId, files] of workerFiles) {
      state[workerId] = { holder: workerId, files };
    }
    return state;
  }

  /**
   * Restores lock state from a checkpoint.
   * Called on resume-after-crash to re-establish in-progress lock state.
   *
   * @param state - Serialized state from `serialize()`.
   */
  restore(state: FileLockManagerState): void {
    this.locks.clear();
    for (const [workerId, entry] of Object.entries(state)) {
      const acquiredAt = new Date().toISOString(); // Timestamp lost on crash; reset to now
      const fileSet = new Set(entry.files);
      for (const file of entry.files) {
        this.locks.set(file, { holder: workerId, acquiredAt, files: fileSet });
      }
    }
    log.info(`Restored file lock state: ${this.locks.size} active lock(s)`);
  }

  /**
   * Force-release all locks (e.g. on workflow cancellation or completion).
   */
  releaseAll(): void {
    const count = this.locks.size;
    this.locks.clear();
    if (count > 0) {
      log.debug(`Released all ${count} file lock(s) (force release)`);
    }
  }

  /** Returns the total number of currently locked files. */
  get lockedFileCount(): number {
    return this.locks.size;
  }

  /** Returns the set of workers that currently hold at least one lock. */
  get activeWorkers(): Set<string> {
    const workers = new Set<string>();
    for (const lock of this.locks.values()) {
      workers.add(lock.holder);
    }
    return workers;
  }
}
