/**
 * @module orchestration/coding/coding-worker-pool
 * Concurrency-controlled worker pool for parallel coding agents.
 *
 * Manages a bounded pool of concurrent CODING_AGENT workers with integrated
 * file lock coordination. Queues work when at concurrency limit and drains
 * gracefully on workflow completion or cancellation.
 */

import type { WorkflowNode, WorkerEvent } from '../types.js';
import type { WorkerResult } from '../worker.js';
import type { EventBus } from '../event-bus.js';
import { FileLockManager } from './file-lock-manager.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('coding-worker-pool');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CodingWorkerPoolConfig {
  /** Maximum parallel coding agent workers. Default: 4. */
  maxConcurrency?: number;
  /** FileLockManager instance (shared across the workflow). */
  fileLockManager: FileLockManager;
  /** EventBus for emitting file-lock events to the UI. */
  eventBus: EventBus;
  /** Working directory for coding agents. */
  cwd?: string;
  /** Lock acquisition timeout in milliseconds. Default: 60,000. */
  lockTimeoutMs?: number;
  /** How long to wait between lock retry attempts. Default: 500ms. */
  lockRetryIntervalMs?: number;
}

export type WorkerExecutorFn = (
  node: WorkflowNode,
  context: string,
) => Promise<WorkerResult>;

interface QueuedWork {
  node: WorkflowNode;
  context: string;
  resolve: (result: WorkerResult) => void;
  reject: (err: unknown) => void;
}

// ── Pool ──────────────────────────────────────────────────────────────────────

/**
 * A concurrency-controlled worker pool for coding agents.
 *
 * Accepts WorkflowNode submissions, enforces the maxConcurrency limit,
 * acquires file locks before dispatching, and releases locks on completion.
 */
export class CodingWorkerPool {
  private readonly maxConcurrency: number;
  private readonly fileLockManager: FileLockManager;
  private readonly eventBus: EventBus;
  private readonly cwd: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryIntervalMs: number;

  /** Submitted but not yet started. */
  private readonly queue: QueuedWork[] = [];
  /** Active worker IDs. */
  private readonly activeWorkers = new Set<string>();
  /** Cancelled worker IDs (prevents starting after cancellation). */
  private readonly cancelled = new Set<string>();

  private executor?: WorkerExecutorFn;

  constructor(config: CodingWorkerPoolConfig) {
    this.maxConcurrency = config.maxConcurrency ?? 4;
    this.fileLockManager = config.fileLockManager;
    this.eventBus = config.eventBus;
    this.cwd = config.cwd ?? process.cwd();
    this.lockTimeoutMs = config.lockTimeoutMs ?? 60_000;
    this.lockRetryIntervalMs = config.lockRetryIntervalMs ?? 500;
  }

  /**
   * Set the executor function used to run each node.
   * Must be called before `submit()`.
   */
  setExecutor(fn: WorkerExecutorFn): void {
    this.executor = fn;
  }

  /**
   * Submit a node for execution.
   *
   * If the pool is below maxConcurrency, starts immediately.
   * Otherwise queues until a slot becomes available.
   *
   * @param node - The WorkflowNode to execute.
   * @param context - Upstream context string passed to the executor.
   * @returns A Promise that resolves to the WorkerResult.
   */
  submit(node: WorkflowNode, context: string): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      const work: QueuedWork = { node, context, resolve, reject };

      if (this.activeWorkers.size < this.maxConcurrency) {
        void this.startWork(work);
      } else {
        log.debug(`Pool at capacity (${this.maxConcurrency}); queuing ${node.id}`);
        this.queue.push(work);
      }
    });
  }

  /** Number of currently executing workers. */
  getActiveCount(): number {
    return this.activeWorkers.size;
  }

  /** Number of queued (not-yet-started) workers. */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /**
   * Cancel a specific worker.
   * If the worker is queued but not yet started, it is removed from the queue.
   * If already running, marks it cancelled (the executor must honour cancellation
   * via the EventBus signal or timeout).
   */
  cancel(workerId: string): void {
    this.cancelled.add(workerId);

    // Remove from queue if not yet started
    const idx = this.queue.findIndex((w) => w.node.id === workerId);
    if (idx !== -1) {
      const [work] = this.queue.splice(idx, 1);
      work.reject(new Error(`Worker ${workerId} cancelled before start`));
      log.debug(`Cancelled queued worker: ${workerId}`);
    }
  }

  /** Cancel all active and queued workers. */
  cancelAll(): void {
    // Cancel queue
    while (this.queue.length > 0) {
      const work = this.queue.shift()!;
      this.cancelled.add(work.node.id);
      work.reject(new Error(`Worker ${work.node.id} cancelled (pool shutdown)`));
    }
    // Mark all active as cancelled
    for (const id of this.activeWorkers) {
      this.cancelled.add(id);
    }
    log.info(`Cancelled all workers (${this.activeWorkers.size} active)`);
  }

  /**
   * Wait for all active workers to complete (queue drains naturally).
   * Does NOT prevent new submissions; callers should stop submitting first.
   */
  async drain(): Promise<void> {
    if (this.activeWorkers.size === 0 && this.queue.length === 0) {
      return;
    }

    log.debug(
      `Draining pool: ${this.activeWorkers.size} active, ${this.queue.length} queued`,
    );

    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.activeWorkers.size === 0 && this.queue.length === 0) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async startWork(work: QueuedWork): Promise<void> {
    const { node, context, resolve, reject } = work;
    const nodeId = node.id;

    if (this.cancelled.has(nodeId)) {
      reject(new Error(`Worker ${nodeId} was cancelled`));
      return;
    }

    if (!this.executor) {
      reject(new Error('CodingWorkerPool: executor not set'));
      return;
    }

    this.activeWorkers.add(nodeId);
    log.debug(
      `Starting worker ${nodeId} (active: ${this.activeWorkers.size}/${this.maxConcurrency})`,
    );

    try {
      // Acquire file locks if needed
      const fileScope = node.codingConfig?.fileScope;
      if (fileScope?.lockRequired && fileScope.owned.length > 0) {
        const acquired = await this.acquireLocksWithRetry(
          nodeId,
          fileScope.owned,
        );
        if (!acquired) {
          reject(new Error(`Worker ${nodeId}: file lock acquisition timed out`));
          this.activeWorkers.delete(nodeId);
          this.scheduleNext();
          return;
        }
      }

      // Execute
      const result = await this.executor(node, context);
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      // Always release locks and free the slot
      this.fileLockManager.release(nodeId);
      this.activeWorkers.delete(nodeId);
      log.debug(
        `Worker ${nodeId} finished (active: ${this.activeWorkers.size}/${this.maxConcurrency})`,
      );
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.queue.length > 0 && this.activeWorkers.size < this.maxConcurrency) {
      const next = this.queue.shift()!;
      void this.startWork(next);
    }
  }

  /**
   * Attempt to acquire all file locks for a worker, retrying until the
   * timeout is reached.
   *
   * @param workerId - The worker requesting locks.
   * @param files - Files to lock.
   * @returns True if locks were acquired, false on timeout.
   */
  private async acquireLocksWithRetry(
    workerId: string,
    files: string[],
  ): Promise<boolean> {
    const deadline = Date.now() + this.lockTimeoutMs;

    while (Date.now() < deadline) {
      if (this.cancelled.has(workerId)) return false;

      const result = await this.fileLockManager.acquire(
        workerId,
        files,
        this.lockTimeoutMs,
      );

      if (result.acquired) {
        this.emitLockEvent(workerId, 'acquire', files);
        return true;
      }

      // Emit conflict event
      log.debug(
        `Worker ${workerId} waiting for lock on: ` +
        `${result.conflictingFiles?.join(', ')} (held by ${result.conflictingWorker})`,
      );
      this.emitLockEvent(workerId, 'conflict', result.conflictingFiles ?? files, result.conflictingWorker);

      // Wait before retry
      await sleep(this.lockRetryIntervalMs);
    }

    this.emitLockEvent(workerId, 'timeout', files);
    log.warn(`Worker ${workerId}: file lock acquisition timed out after ${this.lockTimeoutMs}ms`);
    return false;
  }

  private emitLockEvent(
    workerId: string,
    action: 'acquire' | 'release' | 'conflict' | 'timeout',
    files: string[],
    holder?: string,
  ): void {
    const event: WorkerEvent = {
      workerId,
      nodeId: workerId,
      timestamp: new Date().toISOString(),
      type: 'status',
      message: action === 'acquire'
        ? `Acquired ${files.length} file lock(s)`
        : action === 'conflict'
        ? `Waiting for file lock (held by ${holder ?? 'unknown'})`
        : action === 'timeout'
        ? `File lock acquisition timed out`
        : `Released file lock(s)`,
      fileLock: { action, files, holder },
    };
    this.eventBus.emit(event);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
