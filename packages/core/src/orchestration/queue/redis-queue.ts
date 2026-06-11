/**
 * @module orchestration/queue/redis-queue
 *
 * Task #238 — Persistent, Redis/BullMQ-backed {@link TaskQueue}.
 *
 * Node jobs are enqueued into a BullMQ queue (durably persisted in Redis) and
 * consumed by a BullMQ Worker. This removes the in-process memory ceiling for
 * enormous plans and lets node work be processed by **separate worker
 * processes**: every process that constructs an executor pointed at the same
 * Redis registers a Worker, and BullMQ load-balances jobs across them. Because
 * the checkpoint store — not this queue — is the source of truth for node
 * outputs, a worker process that dies mid-job is retried by BullMQ and any
 * already-completed node is skipped on resume (the executor reads node status
 * from the checkpoint).
 *
 * BullMQ + ioredis are an **optional** dependency: the import is dynamic so
 * local dev with the default in-process backend needs zero setup. Selecting the
 * `redis` backend without the packages installed (or without a reachable Redis)
 * surfaces a clear, actionable error.
 *
 * Single-process note: when only one process is running, this process is both
 * producer and consumer. The durability/distribution benefit comes from Redis
 * holding the job + checkpoint state; horizontal scaling is achieved by
 * starting additional processes against the same `redisUrl` + `queueName`.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../../logging/logger.js';
import type {
  NodeJob,
  NodeRunner,
  NodeRunOutcome,
  NodeSettledHandler,
  TaskQueue,
  TaskQueueBackend,
} from './task-queue.js';
import type { WorkerResult } from '../worker.js';

const log = createLogger('redis-queue');

/** Options for constructing a {@link RedisTaskQueue}. */
export interface RedisTaskQueueOptions {
  /** Redis connection URL (e.g. `redis://localhost:6379`). */
  redisUrl: string;
  /** BullMQ queue name. Defaults to `orionomega-nodes`. */
  queueName?: string;
  /** Worker concurrency per process. Defaults to 8. */
  concurrency?: number;
}

/**
 * Minimal structural typing for the slices of BullMQ/ioredis we use, so this
 * file type-checks without the optional packages installed. The real modules
 * are loaded at runtime via dynamic import.
 */
interface BullLike {
  Queue: new (name: string, opts: unknown) => {
    add: (name: string, data: unknown, opts?: unknown) => Promise<unknown>;
    close: () => Promise<void>;
  };
  Worker: new (
    name: string,
    processor: (job: { data: NodeJob }) => Promise<WorkerResult>,
    opts: unknown,
  ) => {
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    close: () => Promise<void>;
  };
  QueueEvents: new (name: string, opts: unknown) => {
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    close: () => Promise<void>;
  };
}

const DEFAULT_QUEUE_NAME = 'orionomega-nodes';
const DEFAULT_CONCURRENCY = 8;

/** Redis/BullMQ-backed persistent task queue. */
export class RedisTaskQueue implements TaskQueue {
  readonly backend: TaskQueueBackend = 'redis';

  private readonly queueName: string;
  private readonly concurrency: number;
  private readonly redisUrl: string;

  private bull: BullLike | null = null;
  // Lazily-constructed BullMQ primitives (typed loosely — see BullLike).
  private queue: InstanceType<BullLike['Queue']> | null = null;
  private worker: InstanceType<BullLike['Worker']> | null = null;
  private queueEvents: InstanceType<BullLike['QueueEvents']> | null = null;

  /**
   * The current run's node runner. BullMQ workers are long-lived and process
   * jobs across layers, so the active runner is swapped per `dispatchLayer`
   * call. Within a single executor the runner is stable, so this is safe.
   */
  private activeRunner: NodeRunner | null = null;

  constructor(opts: RedisTaskQueueOptions) {
    this.redisUrl = opts.redisUrl;
    this.queueName = opts.queueName ?? DEFAULT_QUEUE_NAME;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  }

  /** Dynamically import bullmq, failing with an actionable message if absent. */
  private async loadBull(): Promise<BullLike> {
    if (this.bull) return this.bull;
    try {
      // Dynamic import keeps bullmq optional for the in-process default. The
      // module specifier is held in a variable so TypeScript does not try to
      // statically resolve the (optional, possibly-uninstalled) package.
      const moduleName = 'bullmq';
      const mod = (await import(moduleName)) as unknown as BullLike;
      this.bull = mod;
      return mod;
    } catch (err) {
      throw new Error(
        `Redis task-queue backend selected but the 'bullmq' package is not installed. ` +
          `Install it (and ensure Redis is reachable at ${this.redisUrl}) or set ` +
          `orchestration.queue.backend: 'in-process'. Original error: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.queue && this.worker && this.queueEvents) return;
    const bull = await this.loadBull();
    const connection = { url: this.redisUrl };

    this.queue = new bull.Queue(this.queueName, { connection });
    this.queueEvents = new bull.QueueEvents(this.queueName, { connection });

    // The worker delegates to whatever runner the current dispatch installed.
    this.worker = new bull.Worker(
      this.queueName,
      async (job: { data: NodeJob }) => {
        const runner = this.activeRunner;
        if (!runner) {
          throw new Error(
            `RedisTaskQueue received job for node '${job.data.nodeId}' but no runner is registered`,
          );
        }
        return runner(job.data);
      },
      { connection, concurrency: this.concurrency },
    );

    log.info('Redis task queue initialized', {
      queueName: this.queueName,
      concurrency: this.concurrency,
    });
  }

  async dispatchLayer(
    jobs: NodeJob[],
    runner: NodeRunner,
    onSettled: NodeSettledHandler,
  ): Promise<void> {
    if (jobs.length === 0) return;
    await this.ensureInitialized();
    this.activeRunner = runner;

    const queue = this.queue!;
    const queueEvents = this.queueEvents!;

    log.debug('Dispatching layer via Redis', {
      jobCount: jobs.length,
      queueName: this.queueName,
    });

    await Promise.all(
      jobs.map(async (job) => {
        // A unique BullMQ job id per dispatch so retried layers don't collide
        // with a previously-completed job of the same node id.
        const jobId = `${job.workflowId}:${job.nodeId}:${randomUUID()}`;
        let outcome: NodeRunOutcome;
        try {
          const value = await this.runOne(queue, queueEvents, job, jobId);
          outcome = { status: 'fulfilled', value };
        } catch (reason) {
          outcome = { status: 'rejected', reason };
        }
        await onSettled(job, outcome);
      }),
    );
  }

  /** Enqueue a single job and await its terminal result via QueueEvents. */
  private runOne(
    queue: InstanceType<BullLike['Queue']>,
    queueEvents: InstanceType<BullLike['QueueEvents']>,
    job: NodeJob,
    jobId: string,
  ): Promise<WorkerResult> {
    return new Promise<WorkerResult>((resolve, reject) => {
      const onCompleted = (args: unknown): void => {
        const ev = args as { jobId: string; returnvalue: WorkerResult };
        if (ev.jobId !== jobId) return;
        cleanup();
        resolve(ev.returnvalue);
      };
      const onFailed = (args: unknown): void => {
        const ev = args as { jobId: string; failedReason: string };
        if (ev.jobId !== jobId) return;
        cleanup();
        reject(new Error(ev.failedReason));
      };
      const cleanup = (): void => {
        // BullMQ EventEmitter supports off(); guarded for the structural type.
        const qe = queueEvents as unknown as {
          off?: (e: string, cb: (...a: unknown[]) => void) => void;
        };
        qe.off?.('completed', onCompleted);
        qe.off?.('failed', onFailed);
      };

      queueEvents.on('completed', onCompleted);
      queueEvents.on('failed', onFailed);

      queue
        .add('node', job, { jobId, removeOnComplete: true, removeOnFail: true })
        .catch((err: unknown) => {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  async close(): Promise<void> {
    this.activeRunner = null;
    const tasks: Promise<void>[] = [];
    if (this.worker) tasks.push(this.worker.close());
    if (this.queueEvents) tasks.push(this.queueEvents.close());
    if (this.queue) tasks.push(this.queue.close());
    await Promise.allSettled(tasks);
    this.worker = null;
    this.queueEvents = null;
    this.queue = null;
  }
}
