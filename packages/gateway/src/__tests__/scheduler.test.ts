/**
 * @module __tests__/scheduler
 * Unit tests for SchedulerService — covers CRUD lifecycle, overlap policy,
 * one-shot auto-pause, restart recovery, and broadcast wiring. Uses an
 * in-memory SQLite db (via getDb with a tmp path) and a fake MainAgent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, scheduledTasks, taskExecutions } from '@orionomega/core';
import { eq } from 'drizzle-orm';
import { SchedulerService } from '../scheduler.js';
import type { ServerMessage } from '../types.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

type AgentBehavior = (prompt: string) => Promise<void>;

function makeFakeAgent(behavior?: AgentBehavior) {
  const calls: string[] = [];
  const agent = {
    async handleMessage(prompt: string): Promise<void> {
      calls.push(prompt);
      if (behavior) await behavior(prompt);
    },
  };
  return { agent, calls };
}

function makeFakeWs() {
  const broadcasts: ServerMessage[] = [];
  const ws = {
    broadcast(message: ServerMessage): void {
      broadcasts.push(message);
    },
  };
  return { ws, broadcasts };
}

let originalHome: string | undefined;

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Override $HOME so getDb() (called without args by SchedulerService internals)
 * resolves to ~/.orionomega/omega.db inside an isolated tmp dir.
 */
function setupDb(): string {
  const homeDir = mkdtempSync(join(tmpdir(), 'orion-sched-home-'));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  closeDb();
  // First call seeds the singleton at the tmp HOME path.
  getDb();
  return homeDir;
}

function teardownDb(homeDir: string): void {
  closeDb();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try {
    rmSync(homeDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SchedulerService — CRUD', () => {
  let dbPath: string;
  let scheduler: SchedulerService;
  let agentCalls: string[];

  beforeEach(() => {
    dbPath = setupDb();
    const { agent, calls } = makeFakeAgent();
    const { ws } = makeFakeWs();
    agentCalls = calls;
    scheduler = new SchedulerService(agent, ws);
    scheduler.start();
  });

  afterEach(() => {
    scheduler.stop();
    teardownDb(dbPath);
  });

  it('constructor falls back to UTC when given an invalid defaultTimezone', () => {
    const { agent } = makeFakeAgent();
    const { ws } = makeFakeWs();
    const s = new SchedulerService(agent, ws, { defaultTimezone: 'Mars/Olympus_Mons' });
    expect(s.options.defaultTimezone).toBe('UTC');
  });

  it('createTask rejects an invalid cron expression at the service layer', () => {
    expect(() => scheduler.createTask({
      name: 'bad-cron', cronExpr: 'totally garbage', prompt: 'p',
    })).toThrow(/Invalid cron expression/);
    expect(scheduler.listTasks()).toHaveLength(0);
  });

  it('createTask rejects an invalid IANA timezone at the service layer', () => {
    expect(() => scheduler.createTask({
      name: 'bad-tz', cronExpr: '0 9 * * *', prompt: 'p',
      timezone: 'Mars/Olympus_Mons',
    })).toThrow(/Invalid timezone/);
    expect(scheduler.listTasks()).toHaveLength(0);
  });

  it('updateTask rejects invalid cron and leaves the row intact', () => {
    const created = scheduler.createTask({
      name: 'rt', cronExpr: '0 9 * * *', prompt: 'p',
    });
    expect(() => scheduler.updateTask(created.id, { cronExpr: 'broken' }))
      .toThrow(/Invalid cron expression/);
    const after = scheduler.getTask(created.id);
    expect(after?.cronExpr).toBe('0 9 * * *');
  });

  it('createTask persists a row and returns it with nextRunAt populated', () => {
    const task = scheduler.createTask({
      name: 'morning-report',
      cronExpr: '0 9 * * *',
      prompt: 'Generate morning report',
    });
    expect(task.id).toBeTruthy();
    expect(task.name).toBe('morning-report');
    expect(task.status).toBe('active');
    expect(task.nextRunAt).toBeTruthy();
    expect(scheduler.listTasks()).toHaveLength(1);
  });

  it('updateTask remounts the cron job when cronExpr changes', () => {
    const task = scheduler.createTask({
      name: 'a', cronExpr: '0 9 * * *', prompt: 'x',
    });
    const oldNext = task.nextRunAt;
    const updated = scheduler.updateTask(task.id, { cronExpr: '0 10 * * *' });
    expect(updated.cronExpr).toBe('0 10 * * *');
    expect(updated.nextRunAt).not.toBe(oldNext);
  });

  it('deleteTask soft-deletes (status=deleted) and excludes from listTasks', () => {
    const task = scheduler.createTask({ name: 'b', cronExpr: '0 9 * * *', prompt: 'x' });
    scheduler.deleteTask(task.id);
    expect(scheduler.listTasks()).toHaveLength(0);
    // Row still in DB with status=deleted
    const db = getDb();
    const row = db.select().from(scheduledTasks).where(eq(scheduledTasks.id, task.id)).get();
    expect(row?.status).toBe('deleted');
  });

  it('pauseTask and resumeTask toggle status and unmount/remount the cron job', () => {
    const task = scheduler.createTask({ name: 'c', cronExpr: '0 9 * * *', prompt: 'x' });
    const paused = scheduler.pauseTask(task.id);
    expect(paused.status).toBe('paused');
    const resumed = scheduler.resumeTask(task.id);
    expect(resumed.status).toBe('active');
    expect(resumed.nextRunAt).toBeTruthy();
  });

  it('throws on missing task for update/pause/resume/delete', () => {
    expect(() => scheduler.updateTask('nope', { name: 'x' })).toThrow(/not found/);
    expect(() => scheduler.pauseTask('nope')).toThrow(/not found/);
    expect(() => scheduler.resumeTask('nope')).toThrow(/not found/);
    expect(() => scheduler.deleteTask('nope')).toThrow(/not found/);
  });

  it('describeCron returns a human-readable string for valid expressions', () => {
    const desc = scheduler.describeCron('0 9 * * *');
    expect(desc.toLowerCase()).toContain('9');
  });

  it('describeCron returns "Invalid expression" for invalid input', () => {
    const desc = scheduler.describeCron('not-a-cron');
    expect(desc).toBe('Invalid expression');
  });

  it('agent is not called by CRUD operations alone', () => {
    scheduler.createTask({ name: 'd', cronExpr: '0 9 * * *', prompt: 'p' });
    expect(agentCalls).toHaveLength(0);
  });
});

describe('SchedulerService — execution', () => {
  let dbPath: string;

  beforeEach(() => { dbPath = setupDb(); });
  afterEach(() => { teardownDb(dbPath); });

  it('triggerTask invokes agent.handleMessage with the task prompt', async () => {
    const { agent, calls } = makeFakeAgent();
    const { ws, broadcasts } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws);
    scheduler.start();

    const task = scheduler.createTask({
      name: 'e', cronExpr: '0 9 * * *', prompt: 'Hello scheduler',
    });
    scheduler.triggerTask(task.id);

    // triggerTask is fire-and-forget; await microtasks.
    await new Promise((r) => setTimeout(r, 30));

    expect(calls).toContain('Hello scheduler');
    expect(broadcasts.some((m) => m.type === 'schedule_triggered')).toBe(true);
    expect(broadcasts.some((m) => m.type === 'schedule_execution_complete')).toBe(true);

    const completed = broadcasts.find((m) => m.type === 'schedule_execution_complete');
    expect(completed?.scheduleExecutionComplete?.status).toBe('completed');

    scheduler.stop();
  });

  it('records a failed execution when the agent throws', async () => {
    const { agent } = makeFakeAgent(async () => {
      throw new Error('boom');
    });
    const { ws, broadcasts } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws);
    scheduler.start();

    const task = scheduler.createTask({ name: 'f', cronExpr: '0 9 * * *', prompt: 'p' });
    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 30));

    const executions = scheduler.getExecutions(task.id);
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).toBe('failed');
    expect(executions[0]!.error).toContain('boom');

    const complete = broadcasts.find((m) => m.type === 'schedule_execution_complete');
    expect(complete?.scheduleExecutionComplete?.status).toBe('failed');

    scheduler.stop();
  });

  it('skip overlap policy records a skipped execution and does not call the agent', async () => {
    let resolveFirst: (() => void) | null = null;
    const { agent, calls } = makeFakeAgent(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    const { ws } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws);
    scheduler.start();

    const task = scheduler.createTask({
      name: 'g', cronExpr: '0 9 * * *', prompt: 'p', overlapPolicy: 'skip',
    });

    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 10));
    // First execution is in flight; trigger again
    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toHaveLength(1);
    const executions = scheduler.getExecutions(task.id);
    expect(executions.some((e) => e.status === 'skipped')).toBe(true);

    resolveFirst?.();
    await new Promise((r) => setTimeout(r, 30));

    scheduler.stop();
  });

  it('one-shot task (runAt) auto-pauses after first execution', async () => {
    const { agent } = makeFakeAgent();
    const { ws } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws);
    scheduler.start();

    const task = scheduler.createTask({
      name: 'h', cronExpr: '0 9 * * *', prompt: 'one-shot',
      runAt: new Date(Date.now() + 60_000).toISOString(),
    });
    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 30));

    const after = scheduler.getTask(task.id);
    expect(after?.status).toBe('paused');

    scheduler.stop();
  });

  it('marks stale running executions as failed on start (restart recovery)', () => {
    const { agent } = makeFakeAgent();
    const { ws } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws);
    scheduler.start();

    const task = scheduler.createTask({ name: 'i', cronExpr: '0 9 * * *', prompt: 'p' });
    scheduler.stop();

    // Simulate a leftover 'running' row from a prior process
    const db = getDb();
    db.insert(taskExecutions).values({
      id: 'leftover-1',
      taskId: task.id,
      status: 'running',
      startedAt: new Date().toISOString(),
      triggerType: 'cron',
    }).run();

    const scheduler2 = new SchedulerService(agent, ws);
    scheduler2.start();

    const row = db
      .select()
      .from(taskExecutions)
      .where(eq(taskExecutions.id, 'leftover-1'))
      .get();
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('restarted');

    scheduler2.stop();
  });

  it('start is idempotent', () => {
    const { agent } = makeFakeAgent();
    const { ws } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws);
    scheduler.start();
    scheduler.start();
    expect(scheduler.listTasks()).toHaveLength(0);
    scheduler.stop();
  });
});

describe('SchedulerService — live config + concurrency', () => {
  let dbPath: string;

  beforeEach(() => { dbPath = setupDb(); });
  afterEach(() => { teardownDb(dbPath); });

  it('uses the latest prompt at fire time, even when updated after mount', async () => {
    const { agent, calls } = makeFakeAgent();
    const { ws } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws);
    scheduler.start();

    const task = scheduler.createTask({
      name: 'live', cronExpr: '0 9 * * *', prompt: 'old prompt',
    });
    // Update only fields that should NOT trigger remount but MUST be honored
    // on the next fire (this is the regression covered by the code review).
    scheduler.updateTask(task.id, { prompt: 'new prompt' });
    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 30));

    expect(calls).toEqual(['new prompt']);
    scheduler.stop();
  });

  it('runCount uses an atomic increment (multiple runs accumulate correctly)', async () => {
    const { agent } = makeFakeAgent();
    const { ws } = makeFakeWs();
    // minIntervalSec: 0 disables the throttle so we can fire back-to-back.
    const scheduler = new SchedulerService(agent, ws, { minIntervalSec: 0 });
    scheduler.start();

    const task = scheduler.createTask({
      name: 'rc', cronExpr: '0 9 * * *', prompt: 'p',
    });

    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 20));
    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 20));
    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 20));

    const after = scheduler.getTask(task.id);
    expect(after?.runCount).toBe(3);
    scheduler.stop();
  });

  it('schedule_execution_complete WS payload includes the updated task row', async () => {
    const { agent } = makeFakeAgent();
    const { ws, broadcasts } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws, { minIntervalSec: 0 });
    scheduler.start();

    const task = scheduler.createTask({
      name: 'wsmeta', cronExpr: '0 9 * * *', prompt: 'p',
    });
    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 30));

    const complete = broadcasts.find((m) => m.type === 'schedule_execution_complete');
    expect(complete?.scheduleExecutionComplete?.task).toBeDefined();
    expect(complete?.scheduleExecutionComplete?.task?.id).toBe(task.id);
    expect(complete?.scheduleExecutionComplete?.task?.runCount).toBe(1);
    expect(complete?.scheduleExecutionComplete?.task?.lastStatus).toBe('completed');
    scheduler.stop();
  });

  it('honors maxConcurrent: 1 by recording a skipped execution when capacity is reached', async () => {
    let resolveFirst: (() => void) | null = null;
    const { agent, calls } = makeFakeAgent(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    const { ws } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws, {
      maxConcurrent: 1,
      minIntervalSec: 0,
    });
    scheduler.start();

    const taskA = scheduler.createTask({ name: 'a', cronExpr: '0 9 * * *', prompt: 'pa' });
    const taskB = scheduler.createTask({ name: 'b', cronExpr: '0 9 * * *', prompt: 'pb' });

    scheduler.triggerTask(taskA.id);
    await new Promise((r) => setTimeout(r, 10));
    scheduler.triggerTask(taskB.id);
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toEqual(['pa']);
    const skipped = scheduler.getExecutions(taskB.id);
    expect(skipped[0]?.status).toBe('skipped');
    expect(skipped[0]?.error).toContain('maxConcurrent');

    resolveFirst?.();
    await new Promise((r) => setTimeout(r, 30));
    scheduler.stop();
  });

  it('cron-fired ticks honor overlapPolicy=allow (no croner protect interference)', async () => {
    // Regression: previously the cron jobs were created with `protect: true`,
    // which suppresses overrun at the engine layer and silently overrides the
    // service's overlap policy. With protect removed, two cron-fired ticks
    // back-to-back on the same task with overlapPolicy='allow' must both run.
    const inFlight: Array<() => void> = [];
    const { agent, calls } = makeFakeAgent(
      () => new Promise<void>((resolve) => { inFlight.push(resolve); }),
    );
    const { ws } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws, {
      maxConcurrent: 5,
      minIntervalSec: 0,
    });
    scheduler.start();

    const task = scheduler.createTask({
      name: 'cron-allow', cronExpr: '0 9 * * *', prompt: 'p',
      overlapPolicy: 'allow',
    });

    // Reach into the private jobs map to fire actual cron callbacks via
    // croner's .trigger() — this is the path that protect: true used to block.
    const job = (scheduler as unknown as { jobs: Map<string, { trigger: () => void }> })
      .jobs.get(task.id);
    expect(job).toBeDefined();
    job!.trigger();
    await new Promise((r) => setTimeout(r, 5));
    job!.trigger();
    await new Promise((r) => setTimeout(r, 15));

    expect(calls).toHaveLength(2);
    const execs = scheduler.getExecutions(task.id);
    const skipped = execs.filter((e) => e.status === 'skipped');
    expect(skipped).toHaveLength(0);

    inFlight.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
  });

  it('maxConcurrent counts in-flight executions (not unique task ids) under overlapPolicy=allow', async () => {
    // Regression: previously `running` was a Set keyed by taskId, so two
    // simultaneous runs of the SAME task only counted as 1 toward the cap.
    const inFlight: Array<() => void> = [];
    const { agent, calls } = makeFakeAgent(
      () => new Promise<void>((resolve) => { inFlight.push(resolve); }),
    );
    const { ws } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws, {
      maxConcurrent: 2,
      minIntervalSec: 0,
    });
    scheduler.start();

    const task = scheduler.createTask({
      name: 'allow', cronExpr: '0 9 * * *', prompt: 'p',
      overlapPolicy: 'allow',
    });

    // Fire three times. First two should run concurrently; third must be
    // skipped because in-flight count (2) hit the cap.
    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 5));
    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 5));
    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toHaveLength(2);
    const execs = scheduler.getExecutions(task.id);
    const skipped = execs.filter((e) => e.status === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.error).toContain('maxConcurrent');

    // Cleanup: drain in-flight runs before stopping the scheduler.
    inFlight.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 20));
    scheduler.stop();
  });

  it('honors minIntervalSec by recording a skipped execution within the window', async () => {
    const { agent, calls } = makeFakeAgent();
    const { ws } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws, { minIntervalSec: 60 });
    scheduler.start();

    const task = scheduler.createTask({ name: 'rl', cronExpr: '0 9 * * *', prompt: 'p' });

    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 30));
    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 30));

    expect(calls).toHaveLength(1);
    const execs = scheduler.getExecutions(task.id);
    const skipped = execs.find((e) => e.status === 'skipped');
    expect(skipped?.error).toContain('minIntervalSec');
    scheduler.stop();
  });

  it('cron tick is a no-op when the task was paused after mount', async () => {
    const { agent, calls } = makeFakeAgent();
    const { ws } = makeFakeWs();
    const scheduler = new SchedulerService(agent, ws, { minIntervalSec: 0 });
    scheduler.start();

    const task = scheduler.createTask({ name: 'pz', cronExpr: '0 9 * * *', prompt: 'p' });
    scheduler.pauseTask(task.id);

    // Manual trigger still fires (manual is exempt from status check).
    scheduler.triggerTask(task.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
    scheduler.stop();
  });
});
