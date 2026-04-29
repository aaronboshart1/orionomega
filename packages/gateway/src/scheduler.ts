/**
 * @module scheduler
 * Core scheduling engine for OrionOmega task automation.
 *
 * Manages cron-based and one-shot scheduled tasks, persists state to SQLite,
 * and routes task execution through MainAgent.
 */

import { Cron } from 'croner';
import cronstrue from 'cronstrue';
import { randomUUID } from 'node:crypto';
import { eq, ne, desc } from 'drizzle-orm';
import {
  getDb,
  scheduledTasks,
  taskExecutions,
  createLogger,
} from '@orionomega/core';
import type {
  ScheduledTask,
  NewScheduledTask,
  TaskExecution,
  TriggerType,
} from '@orionomega/core';
import type { MainAgent } from '@orionomega/core';
import type { WebSocketHandler } from './websocket.js';

const log = createLogger('scheduler');

// ── Input types ───────────────────────────────────────────────────────────────

export interface CreateScheduleInput {
  name: string;
  description?: string;
  cronExpr: string;
  prompt: string;
  agentMode?: 'orchestrate' | 'direct' | 'code';
  sessionId?: string;
  timezone?: string;
  overlapPolicy?: 'skip' | 'queue' | 'allow';
  maxRetries?: number;
  timeoutSec?: number;
  runAt?: string;
}

export interface UpdateScheduleInput {
  name?: string;
  description?: string;
  cronExpr?: string;
  prompt?: string;
  agentMode?: 'orchestrate' | 'direct' | 'code';
  timezone?: string;
  overlapPolicy?: 'skip' | 'queue' | 'allow';
  maxRetries?: number;
  timeoutSec?: number;
}

// ── SchedulerService ──────────────────────────────────────────────────────────

export class SchedulerService {
  private jobs = new Map<string, Cron>();
  private running = new Set<string>();

  constructor(
    private mainAgent: MainAgent,
    private wsHandler: WebSocketHandler,
  ) {}

  /**
   * Load active tasks from DB and mount cron jobs.
   * Also clears any stale 'running' executions left over from a crash.
   */
  async start(): Promise<void> {
    const db = getDb();

    // Clear stale running executions from previous crash
    try {
      await db
        .update(taskExecutions)
        .set({ status: 'failed', error: 'Gateway restarted', completedAt: new Date().toISOString() })
        .where(eq(taskExecutions.status, 'running'));
    } catch (err) {
      log.warn('Failed to clear stale running executions', { error: (err as Error).message });
    }

    // Load active tasks
    let tasks: ScheduledTask[] = [];
    try {
      tasks = await db
        .select()
        .from(scheduledTasks)
        .where(eq(scheduledTasks.status, 'active'));
    } catch (err) {
      log.error('Failed to load scheduled tasks from DB', { error: (err as Error).message });
      return;
    }

    for (const task of tasks) {
      this.mountJob(task);
    }

    log.info(`Scheduler started — mounted ${tasks.length} task(s)`);
  }

  /** Stop all cron jobs. */
  stop(): void {
    for (const [id, job] of this.jobs) {
      try {
        job.stop();
      } catch { /* ignore */ }
      this.jobs.delete(id);
    }
    log.info('Scheduler stopped');
  }

  /** Validate input, insert into DB, mount cron job, return created task. */
  async createTask(input: CreateScheduleInput): Promise<ScheduledTask> {
    // Validate cron expression
    try {
      const testJob = new Cron(input.cronExpr);
      testJob.stop();
    } catch (err) {
      throw new Error(`Invalid cron expression: ${(err as Error).message}`);
    }

    const now = new Date().toISOString();
    const id = randomUUID();

    // Calculate nextRunAt
    let nextRunAt: string | null = null;
    try {
      const job = new Cron(input.cronExpr, { timezone: input.timezone ?? 'UTC' });
      const next = job.nextRun();
      nextRunAt = next ? next.toISOString() : null;
      job.stop();
    } catch { /* ignore — nextRunAt stays null */ }

    const newTask: NewScheduledTask = {
      id,
      name: input.name,
      description: input.description ?? '',
      cronExpr: input.cronExpr,
      prompt: input.prompt,
      agentMode: input.agentMode ?? 'orchestrate',
      sessionId: input.sessionId ?? 'default',
      status: 'active',
      timezone: input.timezone ?? 'UTC',
      overlapPolicy: input.overlapPolicy ?? 'skip',
      maxRetries: input.maxRetries ?? 0,
      timeoutSec: input.timeoutSec ?? 0,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      nextRunAt,
      lastStatus: null,
      runCount: 0,
      runAt: input.runAt ?? null,
    };

    const db = getDb();
    await db.insert(scheduledTasks).values(newTask);

    const task = await this.getTask(id);
    if (!task) throw new Error('Task not found after insert');

    this.mountJob(task);
    log.info(`Task created: ${task.name} (${task.id})`);
    return task;
  }

  /** Get a task by ID. */
  async getTask(id: string): Promise<ScheduledTask | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.id, id));
    return rows[0] ?? null;
  }

  /** List all non-deleted tasks. */
  async listTasks(): Promise<ScheduledTask[]> {
    const db = getDb();
    return db
      .select()
      .from(scheduledTasks)
      .where(ne(scheduledTasks.status, 'deleted'));
  }

  /** Update task fields, remount cron if schedule/timezone changed. */
  async updateTask(id: string, patch: UpdateScheduleInput): Promise<ScheduledTask | null> {
    const existing = await this.getTask(id);
    if (!existing || existing.status === 'deleted') return null;

    // Validate new cron expression if provided
    if (patch.cronExpr) {
      try {
        const testJob = new Cron(patch.cronExpr);
        testJob.stop();
      } catch (err) {
        throw new Error(`Invalid cron expression: ${(err as Error).message}`);
      }
    }

    const now = new Date().toISOString();
    const cronChanged = patch.cronExpr !== undefined || patch.timezone !== undefined;

    // Recalculate nextRunAt if cron or timezone changed
    let nextRunAt = existing.nextRunAt;
    if (cronChanged) {
      try {
        const expr = patch.cronExpr ?? existing.cronExpr;
        const tz = patch.timezone ?? existing.timezone;
        const job = new Cron(expr, { timezone: tz });
        const next = job.nextRun();
        nextRunAt = next ? next.toISOString() : null;
        job.stop();
      } catch { /* keep existing nextRunAt */ }
    }

    const db = getDb();
    await db
      .update(scheduledTasks)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.cronExpr !== undefined && { cronExpr: patch.cronExpr }),
        ...(patch.prompt !== undefined && { prompt: patch.prompt }),
        ...(patch.agentMode !== undefined && { agentMode: patch.agentMode }),
        ...(patch.timezone !== undefined && { timezone: patch.timezone }),
        ...(patch.overlapPolicy !== undefined && { overlapPolicy: patch.overlapPolicy }),
        ...(patch.maxRetries !== undefined && { maxRetries: patch.maxRetries }),
        ...(patch.timeoutSec !== undefined && { timeoutSec: patch.timeoutSec }),
        ...(cronChanged && { nextRunAt }),
        updatedAt: now,
      })
      .where(eq(scheduledTasks.id, id));

    const updated = await this.getTask(id);
    if (!updated) return null;

    // Remount if cron or timezone changed and task is active
    if (cronChanged && updated.status === 'active') {
      this.unmountJob(id);
      this.mountJob(updated);
    }

    log.info(`Task updated: ${updated.name} (${id})`);
    return updated;
  }

  /** Soft delete — sets status to 'deleted', unmounts job. */
  async deleteTask(id: string): Promise<boolean> {
    const existing = await this.getTask(id);
    if (!existing || existing.status === 'deleted') return false;

    this.unmountJob(id);

    const db = getDb();
    await db
      .update(scheduledTasks)
      .set({ status: 'deleted', updatedAt: new Date().toISOString() })
      .where(eq(scheduledTasks.id, id));

    log.info(`Task deleted: ${id}`);
    return true;
  }

  /** Pause task — sets status to 'paused', unmounts job. */
  async pauseTask(id: string): Promise<ScheduledTask | null> {
    const existing = await this.getTask(id);
    if (!existing || existing.status !== 'active') return null;

    this.unmountJob(id);

    const db = getDb();
    await db
      .update(scheduledTasks)
      .set({ status: 'paused', updatedAt: new Date().toISOString() })
      .where(eq(scheduledTasks.id, id));

    log.info(`Task paused: ${id}`);
    return this.getTask(id);
  }

  /** Resume task — sets status to 'active', mounts job. */
  async resumeTask(id: string): Promise<ScheduledTask | null> {
    const existing = await this.getTask(id);
    if (!existing || existing.status !== 'paused') return null;

    const db = getDb();
    await db
      .update(scheduledTasks)
      .set({ status: 'active', updatedAt: new Date().toISOString() })
      .where(eq(scheduledTasks.id, id));

    const updated = await this.getTask(id);
    if (!updated) return null;

    this.mountJob(updated);
    log.info(`Task resumed: ${id}`);
    return updated;
  }

  /** Fire-and-forget manual execution. */
  triggerTask(id: string): void {
    this.getTask(id).then((task) => {
      if (!task || task.status === 'deleted') {
        log.warn(`Cannot trigger task — not found or deleted: ${id}`);
        return;
      }
      this.executeTask(task, 'manual').catch((err) => {
        log.error(`Manual trigger error for task ${id}`, { error: (err as Error).message });
      });
    }).catch((err) => {
      log.error(`Failed to fetch task for manual trigger: ${id}`, { error: (err as Error).message });
    });
  }

  /** Get execution history for a task. */
  async getExecutions(taskId: string, limit = 50): Promise<TaskExecution[]> {
    const db = getDb();
    return db
      .select()
      .from(taskExecutions)
      .where(eq(taskExecutions.taskId, taskId))
      .orderBy(desc(taskExecutions.startedAt))
      .limit(limit);
  }

  /** Return human-readable description of a cron expression. */
  describeCron(expr: string): string {
    try {
      return cronstrue.toString(expr, { throwExceptionOnParseError: true });
    } catch {
      return 'Invalid cron expression';
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** Create and register a Cron instance for a task. */
  private mountJob(task: ScheduledTask): void {
    if (this.jobs.has(task.id)) {
      this.unmountJob(task.id);
    }

    try {
      const job = new Cron(
        task.cronExpr,
        {
          timezone: task.timezone,
          protect: true,
          catch: (err) => {
            log.error(`Cron catch handler for task ${task.id}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          },
        },
        () => {
          this.executeTask(task, 'cron').catch((err) => {
            log.error(`Execution error for task ${task.id}`, { error: (err as Error).message });
          });
        },
      );
      this.jobs.set(task.id, job);
      log.verbose(`Mounted cron job for task ${task.name} (${task.id}): ${task.cronExpr}`);
    } catch (err) {
      log.error(`Failed to mount cron job for task ${task.id}`, { error: (err as Error).message });
    }
  }

  /** Stop and remove the cron job for a task. */
  private unmountJob(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      try { job.stop(); } catch { /* ignore */ }
      this.jobs.delete(id);
    }
  }

  /** Execute a task: record execution, call MainAgent, update state. */
  private async executeTask(task: ScheduledTask, triggerType: TriggerType): Promise<void> {
    // Overlap policy: skip if already running and policy is 'skip'
    if (this.running.has(task.id) && task.overlapPolicy === 'skip') {
      log.info(`Task ${task.id} skipped — already running (overlap policy: skip)`);

      // Record skipped execution
      const db = getDb();
      await db.insert(taskExecutions).values({
        id: randomUUID(),
        taskId: task.id,
        status: 'skipped',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationSec: 0,
        triggerType,
      });
      return;
    }

    const executionId = randomUUID();
    const startedAt = new Date().toISOString();

    this.running.add(task.id);

    const db = getDb();

    try {
      // Insert execution record
      await db.insert(taskExecutions).values({
        id: executionId,
        taskId: task.id,
        status: 'running',
        startedAt,
        triggerType,
      });

      // Update task lastRunAt
      await db
        .update(scheduledTasks)
        .set({ lastRunAt: startedAt, updatedAt: startedAt })
        .where(eq(scheduledTasks.id, task.id));

      // Broadcast schedule_triggered
      this.wsHandler.broadcast({
        id: randomUUID(),
        type: 'schedule_triggered',
        scheduleTriggered: {
          taskId: task.id,
          taskName: task.name,
          executionId,
          triggerType,
        },
      });

      log.info(`Executing task ${task.name} (${task.id})`, { executionId, triggerType });

      // Execute via MainAgent
      const agentMode = task.agentMode as 'orchestrate' | 'direct' | 'code' | undefined;
      const executePromise = this.mainAgent.handleMessage(
        task.prompt,
        undefined,
        undefined,
        agentMode,
      );

      // Apply timeout if configured
      if (task.timeoutSec > 0) {
        await Promise.race([
          executePromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Task execution timed out')), task.timeoutSec * 1000),
          ),
        ]);
      } else {
        await executePromise;
      }

      const completedAt = new Date().toISOString();
      const durationSec = (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000;

      // Update execution record — success
      await db
        .update(taskExecutions)
        .set({ status: 'completed', completedAt, durationSec })
        .where(eq(taskExecutions.id, executionId));

      // Recalculate nextRunAt
      let nextRunAt: string | null = null;
      try {
        const nextJob = new Cron(task.cronExpr, { timezone: task.timezone });
        const next = nextJob.nextRun();
        nextRunAt = next ? next.toISOString() : null;
        nextJob.stop();
      } catch { /* keep null */ }

      // Update task metadata
      await db
        .update(scheduledTasks)
        .set({
          lastStatus: 'completed',
          nextRunAt,
          runCount: task.runCount + 1,
          updatedAt: completedAt,
        })
        .where(eq(scheduledTasks.id, task.id));

      // Auto-pause one-shot tasks (runAt set)
      if (task.runAt) {
        this.unmountJob(task.id);
        await db
          .update(scheduledTasks)
          .set({ status: 'paused', updatedAt: completedAt })
          .where(eq(scheduledTasks.id, task.id));
      }

      // Broadcast completion
      this.wsHandler.broadcast({
        id: randomUUID(),
        type: 'schedule_execution_complete',
        scheduleExecutionComplete: {
          taskId: task.id,
          taskName: task.name,
          executionId,
          status: 'completed',
          durationSec,
        },
      });

      log.info(`Task ${task.name} completed in ${durationSec.toFixed(1)}s`, { executionId });
    } catch (err) {
      const completedAt = new Date().toISOString();
      const durationSec = (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errorMsg.includes('timed out');
      const status = isTimeout ? 'timeout' : 'failed';

      log.error(`Task ${task.name} ${status}`, { executionId, error: errorMsg });

      try {
        await db
          .update(taskExecutions)
          .set({ status, completedAt, durationSec, error: errorMsg })
          .where(eq(taskExecutions.id, executionId));

        await db
          .update(scheduledTasks)
          .set({
            lastStatus: status,
            runCount: task.runCount + 1,
            updatedAt: completedAt,
          })
          .where(eq(scheduledTasks.id, task.id));
      } catch (dbErr) {
        log.error('Failed to update task execution record', { error: (dbErr as Error).message });
      }

      // Broadcast failure
      this.wsHandler.broadcast({
        id: randomUUID(),
        type: 'schedule_execution_complete',
        scheduleExecutionComplete: {
          taskId: task.id,
          taskName: task.name,
          executionId,
          status,
          durationSec,
          error: errorMsg,
        },
      });
    } finally {
      this.running.delete(task.id);
    }
  }
}
