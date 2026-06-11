/**
 * @module orchestration/queue
 *
 * Task #238 — Persistent distributed task-queue public surface + factory.
 *
 * `createTaskQueue(config)` returns the queue implementation selected by config,
 * defaulting to the zero-setup {@link InProcessTaskQueue}. The Redis backend is
 * opt-in and degrades gracefully: if it can't be constructed (missing optional
 * deps), the factory logs and falls back to in-process so a run never hard-fails
 * because of queue infrastructure.
 */

import { createLogger } from '../../logging/logger.js';
import { InProcessTaskQueue } from './in-process-queue.js';
import { RedisTaskQueue } from './redis-queue.js';
import type { TaskQueue } from './task-queue.js';

const log = createLogger('task-queue-factory');

export type {
  TaskQueue,
  TaskQueueBackend,
  NodeJob,
  NodeRunner,
  NodeRunOutcome,
  NodeSettledHandler,
} from './task-queue.js';
export { InProcessTaskQueue } from './in-process-queue.js';
export { RedisTaskQueue, type RedisTaskQueueOptions } from './redis-queue.js';

/** Subset of `OrionOmegaConfig.orchestration.queue` consumed by the factory. */
export interface TaskQueueConfig {
  /** Backend to use. Defaults to `in-process`. */
  backend?: 'in-process' | 'redis';
  /** Redis URL (when backend is `redis`). Falls back to `REDIS_URL` env. */
  redisUrl?: string;
  /** BullMQ queue name. */
  queueName?: string;
  /** Worker concurrency for the Redis backend. */
  concurrency?: number;
}

/**
 * Build a {@link TaskQueue} from config. Returns the in-process default when no
 * queue config is present, when the backend is `in-process`, or when the Redis
 * backend can't be constructed.
 */
export function createTaskQueue(config?: TaskQueueConfig): TaskQueue {
  const backend = config?.backend ?? 'in-process';

  if (backend === 'redis') {
    const redisUrl = config?.redisUrl ?? process.env.REDIS_URL;
    if (!redisUrl) {
      log.warn(
        "orchestration.queue.backend is 'redis' but no redisUrl/REDIS_URL is set — " +
          'falling back to the in-process queue.',
      );
      return new InProcessTaskQueue();
    }
    try {
      log.info('Using Redis task-queue backend', { redisUrl: redactUrl(redisUrl) });
      return new RedisTaskQueue({
        redisUrl,
        queueName: config?.queueName,
        concurrency: config?.concurrency,
      });
    } catch (err) {
      log.warn('Failed to construct Redis task queue — falling back to in-process', {
        error: err instanceof Error ? err.message : String(err),
      });
      return new InProcessTaskQueue();
    }
  }

  return new InProcessTaskQueue();
}

/** Hide any credentials in a redis URL before logging it. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch {
    return '[redacted]';
  }
}
