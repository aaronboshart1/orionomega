/**
 * @module orchestration/queue/in-process-queue
 *
 * Task #238 — Default, zero-setup {@link TaskQueue} implementation.
 *
 * Runs every node job in the current process, concurrently within a layer.
 * This reproduces the executor's historical `Promise.allSettled` dispatch
 * exactly (same concurrency, same "wait for all to settle" semantics), so the
 * common path — local dev and small/medium plans — needs no external
 * infrastructure. The persistent Redis backend is opt-in via config.
 */

import { createLogger } from '../../logging/logger.js';
import type {
  NodeJob,
  NodeRunner,
  NodeRunOutcome,
  NodeSettledHandler,
  TaskQueue,
  TaskQueueBackend,
} from './task-queue.js';

const log = createLogger('in-process-queue');

/** In-process, single-process task queue (the default backend). */
export class InProcessTaskQueue implements TaskQueue {
  readonly backend: TaskQueueBackend = 'in-process';

  async dispatchLayer(
    jobs: NodeJob[],
    runner: NodeRunner,
    onSettled: NodeSettledHandler,
  ): Promise<void> {
    if (jobs.length === 0) return;

    log.debug('Dispatching layer in-process', { jobCount: jobs.length });

    // Run all jobs concurrently. We wrap each runner so it never rejects the
    // aggregate promise (Promise.allSettled semantics) and fire `onSettled`
    // the instant a job settles — this is what gives the executor node-level
    // checkpoint durability rather than only per-layer.
    await Promise.all(
      jobs.map(async (job) => {
        let outcome: NodeRunOutcome;
        try {
          const value = await runner(job);
          outcome = { status: 'fulfilled', value };
        } catch (reason) {
          outcome = { status: 'rejected', reason };
        }
        await onSettled(job, outcome);
      }),
    );
  }

  async close(): Promise<void> {
    // Nothing to release for the in-process backend.
  }
}
