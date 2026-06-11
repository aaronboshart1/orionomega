/**
 * @module orchestration/queue/task-queue
 *
 * Task #238 (R5 / 4.1-P0) — Persistent distributed task queue abstraction.
 *
 * The executor previously dispatched each topological layer purely in-process
 * via `Promise.allSettled` over an in-memory `Map`. For enormous plans
 * (hundreds–thousands of nodes) that in-process map is both a memory ceiling
 * and a single point of failure. This interface decouples *how* a layer's node
 * jobs are dispatched from the executor so the same executor can run:
 *
 *   - {@link InProcessTaskQueue} — the default, zero-setup, single-process
 *     implementation (identical observable behaviour to the old inline
 *     `Promise.allSettled`), used for local dev and small plans; and
 *   - a Redis/BullMQ-backed implementation (see `redis-queue.ts`) where node
 *     jobs are persisted in Redis and can be consumed by separate worker
 *     processes, removing the in-process memory ceiling.
 *
 * The contract is intentionally narrow: the queue dispatches a *layer* of
 * {@link NodeJob}s, invokes the supplied {@link NodeRunner} to actually run a
 * single node, and reports each job's settled outcome back through `onSettled`
 * **as it completes**. The executor uses that per-node callback to persist node
 * state to the checkpoint store immediately — the checkpoint, not the queue, is
 * the source of truth for what completed (see the executor's resume path).
 */

import type { WorkerResult } from '../worker.js';

/** Backend identifier for a {@link TaskQueue} implementation. */
export type TaskQueueBackend = 'in-process' | 'redis';

/**
 * A unit of work dispatched through the queue: one workflow node within one
 * topological layer. Deliberately small and JSON-serialisable so a Redis
 * backend can round-trip it to a separate worker process.
 */
export interface NodeJob {
  /** The workflow/graph id this node belongs to. */
  workflowId: string;
  /** The node id to execute. */
  nodeId: string;
  /** The topological layer index this job was dispatched from. */
  layerIndex: number;
}

/**
 * The settled outcome of running a single {@link NodeJob}. Mirrors the shape of
 * a `Promise.allSettled` result so the executor's existing result-processing
 * logic ports across with no behaviour change.
 */
export type NodeRunOutcome =
  | { status: 'fulfilled'; value: WorkerResult }
  | { status: 'rejected'; reason: unknown };

/**
 * Runs a single node and resolves with its {@link WorkerResult}, or rejects on
 * failure. Supplied by the executor; invoked by whichever process actually
 * picks up the job (the same process for in-process; a worker process for
 * Redis). The runner closure is process-local and is **not** serialised — each
 * consuming process supplies its own.
 */
export type NodeRunner = (job: NodeJob) => Promise<WorkerResult>;

/**
 * Invoked once per job as it settles (in completion order). The executor uses
 * this to process the node result and checkpoint it immediately, so a crash
 * mid-layer never loses a completed node's progress.
 */
export type NodeSettledHandler = (
  job: NodeJob,
  outcome: NodeRunOutcome,
) => void | Promise<void>;

/**
 * Dispatches workflow node jobs for concurrent execution. Implementations may
 * run jobs in-process or fan them out across worker processes via a persistent
 * backend; the executor is agnostic to which.
 */
export interface TaskQueue {
  /** Which backend this queue uses. */
  readonly backend: TaskQueueBackend;

  /**
   * Dispatch a layer of node jobs for concurrent execution. Resolves only once
   * **every** job has settled (success or failure) — equivalent to
   * `Promise.allSettled` semantics: a rejected runner never rejects the
   * returned promise. `onSettled` is invoked exactly once per job, as soon as
   * that job settles, so the caller can persist node-level state to the
   * checkpoint store incrementally.
   */
  dispatchLayer(
    jobs: NodeJob[],
    runner: NodeRunner,
    onSettled: NodeSettledHandler,
  ): Promise<void>;

  /**
   * Release any backend resources (Redis connections, BullMQ workers, etc.).
   * Safe to call multiple times; a no-op for the in-process backend.
   */
  close(): Promise<void>;
}
