/**
 * @module scheduler
 * In-process cron scheduler for the OrionOmega gateway.
 *
 * Owns a map of `croner` jobs that fire scheduled prompts through
 * `MainAgent.handleMessage()` exactly the same way an interactive chat
 * message would. Persists schedules and execution history in the unified
 * SQLite DB so they survive gateway restarts.
 *
 * Single-process, in-memory; no distributed coordination. Restart recovery
 * marks any in-flight execution rows from a prior process as failed before
 * mounting fresh cron jobs.
 */

import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import cronstrue from 'cronstrue';
import { desc, eq, ne, sql } from 'drizzle-orm';
import {
  createLogger,
  getDb,
  scheduledTasks,
  taskExecutions,
} from '@orionomega/core';
import type {
  MainAgent,
  ScheduleAgentMode,
  ScheduledTask,
  TaskExecution,
} from '@orionomega/core';
import type { WebSocketHandler } from './websocket.js';

const log = createLogger('scheduler');

// ── Public input/output types ────────────────────────────────────────────────

/** Subset of fields accepted when creating a new scheduled task. */
export interface CreateScheduleInput {
  name: string;
  description?: string;
  cronExpr: string;
  prompt: string;
  agentMode?: ScheduleAgentMode;
  sessionId?: string;
  timezone?: string;
  overlapPolicy?: 'skip' | 'queue' | 'allow';
  maxRetries?: number;
  timeoutSec?: number;
  /** ISO 8601 datetime for one-shot schedules. When set, task auto-pauses after first run. */
  runAt?: string;
}

/** Subset of fields accepted on update. All optional. */
export interface UpdateScheduleInput {
  name?: string;
  description?: string;
  cronExpr?: string;
  prompt?: string;
  agentMode?: ScheduleAgentMode;
  timezone?: string;
  overlapPolicy?: 'skip' | 'queue' | 'allow';
  maxRetries?: number;
  timeoutSec?: number;
}

/** Runtime options for the scheduler engine, sourced from `scheduling:` config. */
export interface SchedulerOptions {
  /** Default IANA timezone applied to new schedules that don't specify one. */
  defaultTimezone?: string;
  /** Maximum scheduled-task executions allowed in flight across all tasks. */
  maxConcurrent?: number;
  /** Minimum seconds between consecutive executions of any single task. */
  minIntervalSec?: number;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class SchedulerService {
  /** In-memory map of active cron jobs keyed by task ID. */
  private jobs = new Map<string, Cron>();

  /**
   * Per-task execution count currently in flight. Used for both:
   *   • overlap detection (`running.get(id) > 0`)
   *   • global concurrency cap (sum of all values)
   * A simple `Set<string>` would undercount when overlapPolicy='allow'
   * lets the same task run more than once concurrently.
   */
  private running = new Map<string, number>();

  /** Whether the service has been started (idempotent guard). */
  private started = false;

  /** Resolved scheduling options (defaults applied). */
  readonly options: Required<SchedulerOptions>;

  constructor(
    private readonly mainAgent: Pick<MainAgent, 'handleMessage'>,
    private readonly wsHandler: Pick<WebSocketHandler, 'broadcast'>,
    options: SchedulerOptions = {},
  ) {
    // Validate the configured default timezone up front. A bad value in
    // gateway config (e.g. typo'd IANA name) would otherwise propagate into
    // every task that relies on the default and silently fail to mount.
    let defaultTz = options.defaultTimezone ?? 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: defaultTz });
    } catch {
      log.warn(
        `Invalid scheduling.defaultTimezone "${defaultTz}" in config; falling back to "UTC".`,
      );
      defaultTz = 'UTC';
    }
    this.options = {
      defaultTimezone: defaultTz,
      maxConcurrent: options.maxConcurrent ?? 3,
      minIntervalSec: options.minIntervalSec ?? 60,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Load all active schedules from DB and register cron jobs.
   * Marks any 'running' executions left over from a prior gateway session
   * as failed before mounting jobs (so restart recovery is observable).
   *
   * Idempotent: calling twice is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    const db = getDb();

    // Mark any 'running' executions from a previous gateway session as failed
    const now = new Date().toISOString();
    db.update(taskExecutions)
      .set({
        status: 'failed',
        error: 'Gateway restarted during execution',
        completedAt: now,
      })
      .where(eq(taskExecutions.status, 'running'))
      .run();

    // Load and mount all active schedules
    const tasks = db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.status, 'active'))
      .all();

    for (const task of tasks) {
      this.mountJob(task);
    }
    log.info(`Scheduler started — ${tasks.length} active task(s) loaded`);
  }

  /** Stop all cron jobs. Called during graceful shutdown. */
  stop(): void {
    for (const [id, job] of this.jobs) {
      try {
        job.stop();
      } catch (err) {
        log.debug(`Error stopping job ${id}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.jobs.clear();
    this.running.clear();
    this.started = false;
    log.info('Scheduler stopped');
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  /**
   * Validate a cron expression by attempting to construct a paused Cron.
   * Throws with a stable error message on failure.
   */
  private static assertValidCron(expr: string): void {
    try {
      new Cron(expr, { paused: true }, () => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid cron expression: ${msg}`);
    }
  }

  /**
   * Validate an IANA timezone string via Intl.DateTimeFormat. Throws on invalid.
   */
  private static assertValidTimezone(tz: string): void {
    try {
      // Will throw RangeError on invalid IANA name in modern Node.
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw new Error(`Invalid timezone: ${tz}`);
    }
  }

  createTask(input: CreateScheduleInput): ScheduledTask {
    // Fail fast at the service layer so non-REST callers (e.g. CLI, tests,
    // or future internal seeds) cannot persist an unmountable row that
    // would silently never fire.
    SchedulerService.assertValidCron(input.cronExpr);
    if (input.timezone) SchedulerService.assertValidTimezone(input.timezone);

    const db = getDb();
    const now = new Date().toISOString();
    const id = randomUUID();

    const row: ScheduledTask = {
      id,
      name: input.name,
      description: input.description ?? '',
      cronExpr: input.cronExpr,
      prompt: input.prompt,
      agentMode: input.agentMode ?? 'orchestrate',
      sessionId: input.sessionId ?? 'default',
      status: 'active',
      timezone: input.timezone ?? this.options.defaultTimezone,
      overlapPolicy: input.overlapPolicy ?? 'skip',
      maxRetries: input.maxRetries ?? 0,
      timeoutSec: input.timeoutSec ?? 0,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      nextRunAt: null,
      lastStatus: null,
      runCount: 0,
      runAt: input.runAt ?? null,
    };

    db.insert(scheduledTasks).values(row).run();
    this.mountJob(row);

    // Re-read so the returned row reflects any nextRunAt persisted by mountJob.
    const persisted = this.getTask(id) ?? row;
    log.info(`Created schedule: ${persisted.name} (${persisted.cronExpr})`);
    return persisted;
  }

  getTask(id: string): ScheduledTask | null {
    const db = getDb();
    const row = db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.id, id))
      .get();
    return row ?? null;
  }

  listTasks(): ScheduledTask[] {
    const db = getDb();
    return db
      .select()
      .from(scheduledTasks)
      .where(ne(scheduledTasks.status, 'deleted'))
      .all();
  }

  updateTask(id: string, patch: UpdateScheduleInput): ScheduledTask {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`Schedule ${id} not found`);

    // Validate any fields that affect job mounting BEFORE we touch the row.
    if (patch.cronExpr !== undefined) SchedulerService.assertValidCron(patch.cronExpr);
    if (patch.timezone !== undefined) SchedulerService.assertValidTimezone(patch.timezone);

    const db = getDb();
    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.cronExpr !== undefined) updates.cronExpr = patch.cronExpr;
    if (patch.prompt !== undefined) updates.prompt = patch.prompt;
    if (patch.agentMode !== undefined) updates.agentMode = patch.agentMode;
    if (patch.timezone !== undefined) updates.timezone = patch.timezone;
    if (patch.overlapPolicy !== undefined) updates.overlapPolicy = patch.overlapPolicy;
    if (patch.maxRetries !== undefined) updates.maxRetries = patch.maxRetries;
    if (patch.timeoutSec !== undefined) updates.timeoutSec = patch.timeoutSec;

    db.update(scheduledTasks).set(updates).where(eq(scheduledTasks.id, id)).run();

    // If cron, timezone, or runAt changed, remount the job with fresh schedule
    if (patch.cronExpr !== undefined || patch.timezone !== undefined) {
      this.unmountJob(id);
      const updated = this.getTask(id);
      if (updated && updated.status === 'active') {
        this.mountJob(updated);
      }
    }

    return this.getTask(id)!;
  }

  deleteTask(id: string): void {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`Schedule ${id} not found`);
    this.unmountJob(id);
    const db = getDb();
    // Soft delete — preserves execution history rows
    db.update(scheduledTasks)
      .set({ status: 'deleted', updatedAt: new Date().toISOString() })
      .where(eq(scheduledTasks.id, id))
      .run();
    log.info(`Deleted schedule ${id} (${existing.name})`);
  }

  pauseTask(id: string): ScheduledTask {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`Schedule ${id} not found`);
    this.unmountJob(id);
    const db = getDb();
    db.update(scheduledTasks)
      .set({ status: 'paused', updatedAt: new Date().toISOString() })
      .where(eq(scheduledTasks.id, id))
      .run();
    log.info(`Paused schedule ${existing.name}`);
    return this.getTask(id)!;
  }

  resumeTask(id: string): ScheduledTask {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`Schedule ${id} not found`);
    const db = getDb();
    db.update(scheduledTasks)
      .set({ status: 'active', updatedAt: new Date().toISOString() })
      .where(eq(scheduledTasks.id, id))
      .run();
    const updated = this.getTask(id)!;
    this.mountJob(updated);
    log.info(`Resumed schedule ${updated.name}`);
    return updated;
  }

  /**
   * Manually trigger a scheduled task immediately.
   * Returns synchronously — execution is fire-and-forget.
   */
  triggerTask(id: string): void {
    const task = this.getTask(id);
    if (!task) throw new Error(`Schedule ${id} not found`);

    void this.executeTask(id, 'manual').catch((err) => {
      log.error(`Manual trigger failed for ${task.name}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  getExecutions(taskId: string, limit = 50): TaskExecution[] {
    const db = getDb();
    const safeLimit = Math.min(Math.max(1, limit), 200);
    return db
      .select()
      .from(taskExecutions)
      .where(eq(taskExecutions.taskId, taskId))
      .orderBy(desc(taskExecutions.startedAt))
      .limit(safeLimit)
      .all();
  }

  /** Get human-readable description of a cron expression (uses cronstrue). */
  describeCron(expr: string): string {
    try {
      return cronstrue.toString(expr, { verbose: true });
    } catch {
      return 'Invalid expression';
    }
  }

  // ── Internal: Cron Job Mounting ──────────────────────────────────────────

  private mountJob(task: ScheduledTask): void {
    if (this.jobs.has(task.id) || task.status !== 'active') return;

    // For one-time tasks, use the runAt date string directly; croner accepts it.
    const schedule = task.runAt ?? task.cronExpr;
    // Capture only the ID — executeTask re-reads the latest row from DB so
    // updates to prompt/agentMode/overlapPolicy/timeoutSec take effect on the
    // next fire without remounting the job.
    const taskId = task.id;
    const taskName = task.name;

    try {
      const job = new Cron(
        schedule,
        {
          timezone: task.timezone || this.options.defaultTimezone,
          // NOTE: croner's `protect` option (overrun protection) is intentionally
          // OMITTED. Setting it true would suppress every cron-triggered overlap
          // at the engine layer, which directly contradicts overlapPolicy='allow'
          // (and partially 'queue'). All overlap decisions are made in
          // executeTask() — that's the single source of truth for policy.
          catch: (err: unknown) => {
            log.error(`Cron error for task ${taskId} (${taskName})`, {
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
        () => {
          void this.executeTask(taskId, 'cron').catch((err) => {
            log.error(`Execution error for task ${taskId}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
      );

      this.jobs.set(task.id, job);

      // Persist nextRunAt for the UI / introspection.
      const nextRun = job.nextRun();
      if (nextRun) {
        const db = getDb();
        db.update(scheduledTasks)
          .set({ nextRunAt: nextRun.toISOString() })
          .where(eq(scheduledTasks.id, task.id))
          .run();
      }

      log.debug(`Mounted cron job for ${task.name}: ${schedule}`);
    } catch (err) {
      log.error(`Failed to mount cron job for task ${task.id} (${task.name})`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private unmountJob(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      try {
        job.stop();
      } catch {
        /* best-effort */
      }
      this.jobs.delete(id);
    }
  }

  // ── Internal: Task Execution Pipeline ────────────────────────────────────

  private async executeTask(
    taskIdInput: string,
    triggerType: 'cron' | 'manual',
  ): Promise<void> {
    const db = getDb();

    // ── Re-read latest task state ──
    // Cron callbacks fire long after mountJob captured the task, so we always
    // refetch by ID to honour live updates to prompt/agentMode/overlapPolicy/
    // timeoutSec. If the row was deleted/paused since mounting, abort.
    const task = this.getTask(taskIdInput);
    if (!task) {
      log.warn(`Skipping execution: task ${taskIdInput} no longer exists`);
      return;
    }
    if (triggerType === 'cron' && task.status !== 'active') {
      log.info(`Skipping cron tick for non-active task ${task.name} (${task.status})`);
      return;
    }

    const recordSkip = (reason: string): void => {
      const skippedAt = new Date().toISOString();
      db.insert(taskExecutions)
        .values({
          id: randomUUID(),
          taskId: task.id,
          status: 'skipped',
          startedAt: skippedAt,
          completedAt: skippedAt,
          durationSec: 0,
          triggerType,
          error: reason,
        })
        .run();
    };

    // ── Concurrency gate (config: scheduling.maxConcurrent) ──
    // Sum running counts across all tasks so overlapPolicy='allow' fires
    // count individually toward the global cap.
    let totalRunning = 0;
    for (const n of this.running.values()) totalRunning += n;
    if (totalRunning >= this.options.maxConcurrent) {
      log.info(
        `Skipping ${task.name}: maxConcurrent (${this.options.maxConcurrent}) reached (in flight: ${totalRunning})`,
      );
      recordSkip(`maxConcurrent (${this.options.maxConcurrent}) reached`);
      return;
    }

    // ── Min-interval gate (config: scheduling.minIntervalSec) ──
    if (task.lastRunAt && this.options.minIntervalSec > 0) {
      const elapsedSec =
        (Date.now() - new Date(task.lastRunAt).getTime()) / 1000;
      if (elapsedSec < this.options.minIntervalSec) {
        log.info(
          `Skipping ${task.name}: minIntervalSec (${this.options.minIntervalSec}s) not elapsed`,
        );
        recordSkip(
          `minIntervalSec (${this.options.minIntervalSec}s) not elapsed`,
        );
        return;
      }
    }

    // ── Overlap policy check ──
    // 'skip' (default) and 'queue' (MVP fallback to skip) both record a
    // skipped row when the previous run is still active. 'allow' lets it run.
    if (
      (task.overlapPolicy === 'skip' || task.overlapPolicy === 'queue') &&
      (this.running.get(task.id) ?? 0) > 0
    ) {
      log.info(`Skipping overlapping execution for ${task.name}`);
      recordSkip('overlap with previous run');
      return;
    }

    this.running.set(task.id, (this.running.get(task.id) ?? 0) + 1);
    const executionId = randomUUID();
    const startedAt = new Date();

    // ── Insert execution record ──
    db.insert(taskExecutions)
      .values({
        id: executionId,
        taskId: task.id,
        status: 'running',
        startedAt: startedAt.toISOString(),
        triggerType,
      })
      .run();

    // ── Update task last_run_at ──
    db.update(scheduledTasks)
      .set({
        lastRunAt: startedAt.toISOString(),
        updatedAt: startedAt.toISOString(),
      })
      .where(eq(scheduledTasks.id, task.id))
      .run();

    // ── Broadcast schedule_triggered ──
    this.wsHandler.broadcast({
      id: randomUUID(),
      type: 'schedule_triggered',
      scheduleTriggered: {
        taskId: task.id,
        taskName: task.name,
        executionId,
        prompt: task.prompt,
        firedAt: startedAt.toISOString(),
        triggerType,
      },
    });

    log.info(
      `Executing scheduled task: ${task.name} [${executionId}] (${triggerType})`,
    );

    let status: 'completed' | 'failed' | 'timeout' = 'completed';
    let error: string | null = null;

    try {
      const executionPromise = this.mainAgent.handleMessage(
        task.prompt,
        undefined,
        undefined,
        task.agentMode,
      );

      if (task.timeoutSec > 0) {
        const timeoutMs = task.timeoutSec * 1000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            executionPromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error(`Timeout after ${task.timeoutSec}s`)),
                timeoutMs,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        await executionPromise;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      status = errMsg.startsWith('Timeout after') ? 'timeout' : 'failed';
      error = errMsg;
      log.error(`Scheduled task ${task.name} ${status}: ${errMsg}`);
    } finally {
      const remaining = (this.running.get(task.id) ?? 1) - 1;
      if (remaining <= 0) this.running.delete(task.id);
      else this.running.set(task.id, remaining);
    }

    // ── Finalise execution record ──
    const completedAt = new Date();
    const durationSec =
      (completedAt.getTime() - startedAt.getTime()) / 1000;

    db.update(taskExecutions)
      .set({
        status,
        completedAt: completedAt.toISOString(),
        durationSec,
        error,
      })
      .where(eq(taskExecutions.id, executionId))
      .run();

    // ── Update task metadata ──
    // Atomic SQL increment for runCount avoids stale-snapshot races when the
    // same task fires concurrently or was updated between mount and fire.
    const job = this.jobs.get(task.id);
    const nextRun = job?.nextRun();
    db.update(scheduledTasks)
      .set({
        lastStatus: status,
        nextRunAt: nextRun ? nextRun.toISOString() : null,
        runCount: sql`${scheduledTasks.runCount} + 1`,
        updatedAt: completedAt.toISOString(),
      })
      .where(eq(scheduledTasks.id, task.id))
      .run();

    // ── One-time tasks: auto-pause after execution ──
    if (task.runAt) {
      db.update(scheduledTasks)
        .set({
          status: 'paused',
          updatedAt: completedAt.toISOString(),
        })
        .where(eq(scheduledTasks.id, task.id))
        .run();
      this.unmountJob(task.id);
    }

    // ── Broadcast execution complete ──
    // Include the freshly-updated task row so web clients can refresh list
    // metadata (lastRunAt/lastStatus/nextRunAt/runCount/status) without an
    // extra REST roundtrip.
    const updatedTask = this.getTask(task.id);
    this.wsHandler.broadcast({
      id: randomUUID(),
      type: 'schedule_execution_complete',
      scheduleExecutionComplete: {
        taskId: task.id,
        taskName: task.name,
        executionId,
        status,
        durationSec,
        error,
        completedAt: completedAt.toISOString(),
        task: updatedTask ?? undefined,
      },
    });

    log.info(`Task ${task.name} ${status} in ${durationSec.toFixed(1)}s`);
  }
}
