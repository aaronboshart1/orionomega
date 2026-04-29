/**
 * @module __tests__/schedules-api
 * Integration tests for the /api/schedules HTTP routes — exercises the
 * handler functions directly with mocked req/res, verifying status codes,
 * Zod validation, and SchedulerService delegation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '@orionomega/core';
import { SchedulerService } from '../scheduler.js';
import {
  handleListSchedules,
  handleCreateSchedule,
  handleGetSchedule,
  handleUpdateSchedule,
  handleDeleteSchedule,
  handlePauseSchedule,
  handleResumeSchedule,
  handleTriggerSchedule,
  handleGetExecutions,
  handleDescribeCron,
} from '../routes/schedules.js';
import {
  createMockGetReq,
  createMockPostReq,
  createMockRes,
} from '../routes/__tests__/test-utils.js';
import type { GatewayConfig } from '../types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function noopAgent() {
  return { handleMessage: async () => {} };
}

function noopWs() {
  return { broadcast: () => {} };
}

function makeConfig(): GatewayConfig {
  return {
    auth: { mode: 'none', keyHash: '' },
    cors: { origins: ['*'] },
  } as unknown as GatewayConfig;
}

let originalHome: string | undefined;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('schedules routes', () => {
  let homeDir: string;
  let scheduler: SchedulerService;
  let config: GatewayConfig;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orion-sched-api-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    closeDb();
    getDb();
    scheduler = new SchedulerService(noopAgent(), noopWs());
    scheduler.start();
    config = makeConfig();
  });

  afterEach(() => {
    scheduler.stop();
    closeDb();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('GET /api/schedules returns empty list initially', () => {
    const req = createMockGetReq('/api/schedules');
    const { mock, res } = createMockRes();
    handleListSchedules(req, res, scheduler, config);
    expect(mock.statusCode).toBe(200);
    expect(JSON.parse(mock.body)).toEqual({ tasks: [] });
  });

  it('POST /api/schedules with valid body creates a task', async () => {
    const body = JSON.stringify({
      name: 'test', cronExpr: '0 9 * * *', prompt: 'do thing',
    });
    const req = createMockPostReq('/api/schedules', body);
    const { mock, res } = createMockRes();
    await handleCreateSchedule(req, res, scheduler, config);
    expect(mock.statusCode).toBe(201);
    const parsed = JSON.parse(mock.body) as { task: { id: string; name: string } };
    expect(parsed.task.name).toBe('test');
    expect(parsed.task.id).toBeTruthy();
  });

  it('POST /api/schedules with invalid cron returns 400', async () => {
    const body = JSON.stringify({
      name: 'bad', cronExpr: 'not-cron', prompt: 'p',
    });
    const req = createMockPostReq('/api/schedules', body);
    const { mock, res } = createMockRes();
    await handleCreateSchedule(req, res, scheduler, config);
    expect(mock.statusCode).toBe(400);
    expect(mock.body).toContain('Validation failed');
  });

  it('POST /api/schedules with a past runAt returns 400', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const body = JSON.stringify({
      name: 'past-once', cronExpr: '0 9 * * *', prompt: 'p', runAt: past,
    });
    const req = createMockPostReq('/api/schedules', body);
    const { mock, res } = createMockRes();
    await handleCreateSchedule(req, res, scheduler, config);
    expect(mock.statusCode).toBe(400);
    expect(mock.body).toMatch(/runAt must be a future timestamp/i);
  });

  it('POST /api/schedules with invalid IANA timezone returns 400 (not 500)', async () => {
    const body = JSON.stringify({
      name: 'tz-bad', cronExpr: '0 9 * * *', prompt: 'p',
      timezone: 'Mars/Olympus_Mons',
    });
    const req = createMockPostReq('/api/schedules', body);
    const { mock, res } = createMockRes();
    await handleCreateSchedule(req, res, scheduler, config);
    expect(mock.statusCode).toBe(400);
    expect(mock.body).toMatch(/Invalid timezone/i);
  });

  it('POST /api/schedules with missing fields returns 400', async () => {
    const body = JSON.stringify({ cronExpr: '0 9 * * *' });
    const req = createMockPostReq('/api/schedules', body);
    const { mock, res } = createMockRes();
    await handleCreateSchedule(req, res, scheduler, config);
    expect(mock.statusCode).toBe(400);
  });

  it('GET /api/schedules/:id returns 404 for unknown id', () => {
    const req = createMockGetReq('/api/schedules/nope');
    const { mock, res } = createMockRes();
    handleGetSchedule(req, res, 'nope', scheduler, config);
    expect(mock.statusCode).toBe(404);
  });

  it('GET /api/schedules/:id returns the task for known id', () => {
    const created = scheduler.createTask({
      name: 'x', cronExpr: '0 9 * * *', prompt: 'p',
    });
    const req = createMockGetReq(`/api/schedules/${created.id}`);
    const { mock, res } = createMockRes();
    handleGetSchedule(req, res, created.id, scheduler, config);
    expect(mock.statusCode).toBe(200);
    const parsed = JSON.parse(mock.body) as { task: { id: string } };
    expect(parsed.task.id).toBe(created.id);
  });

  it('PUT /api/schedules/:id updates the task', async () => {
    const created = scheduler.createTask({
      name: 'orig', cronExpr: '0 9 * * *', prompt: 'p',
    });
    const body = JSON.stringify({ name: 'renamed' });
    const req = createMockPostReq(`/api/schedules/${created.id}`, body);
    const { mock, res } = createMockRes();
    await handleUpdateSchedule(req, res, created.id, scheduler, config);
    expect(mock.statusCode).toBe(200);
    expect(JSON.parse(mock.body).task.name).toBe('renamed');
  });

  it('DELETE /api/schedules/:id soft-deletes the task', () => {
    const created = scheduler.createTask({
      name: 'to-delete', cronExpr: '0 9 * * *', prompt: 'p',
    });
    const req = createMockGetReq(`/api/schedules/${created.id}`);
    const { mock, res } = createMockRes();
    handleDeleteSchedule(req, res, created.id, scheduler, config);
    expect(mock.statusCode).toBe(200);
    expect(scheduler.listTasks()).toHaveLength(0);
  });

  it('POST /api/schedules/:id/pause toggles status to paused', () => {
    const created = scheduler.createTask({ name: 'p1', cronExpr: '0 9 * * *', prompt: 'p' });
    const req = createMockPostReq(`/api/schedules/${created.id}/pause`, '');
    const { mock, res } = createMockRes();
    handlePauseSchedule(req, res, created.id, scheduler, config);
    expect(mock.statusCode).toBe(200);
    expect(JSON.parse(mock.body).task.status).toBe('paused');
  });

  it('POST /api/schedules/:id/resume reactivates a paused task', () => {
    const created = scheduler.createTask({ name: 'r1', cronExpr: '0 9 * * *', prompt: 'p' });
    scheduler.pauseTask(created.id);
    const req = createMockPostReq(`/api/schedules/${created.id}/resume`, '');
    const { mock, res } = createMockRes();
    handleResumeSchedule(req, res, created.id, scheduler, config);
    expect(mock.statusCode).toBe(200);
    expect(JSON.parse(mock.body).task.status).toBe('active');
  });

  it('POST /api/schedules/:id/trigger returns 202', () => {
    const created = scheduler.createTask({ name: 't1', cronExpr: '0 9 * * *', prompt: 'p' });
    const req = createMockPostReq(`/api/schedules/${created.id}/trigger`, '');
    const { mock, res } = createMockRes();
    handleTriggerSchedule(req, res, created.id, scheduler, config);
    expect(mock.statusCode).toBe(202);
  });

  it('GET /api/schedules/:id/executions returns empty list initially', () => {
    const created = scheduler.createTask({ name: 'e1', cronExpr: '0 9 * * *', prompt: 'p' });
    const req = createMockGetReq(`/api/schedules/${created.id}/executions`);
    const { mock, res } = createMockRes();
    const url = new URL(`http://localhost/api/schedules/${created.id}/executions`);
    handleGetExecutions(req, res, created.id, url, scheduler, config);
    expect(mock.statusCode).toBe(200);
    expect(JSON.parse(mock.body)).toEqual({ executions: [] });
  });

  it('GET /api/schedules/:id/executions returns 404 for unknown id', () => {
    const req = createMockGetReq('/api/schedules/does-not-exist/executions');
    const { mock, res } = createMockRes();
    const url = new URL('http://localhost/api/schedules/does-not-exist/executions');
    handleGetExecutions(req, res, 'does-not-exist', url, scheduler, config);
    expect(mock.statusCode).toBe(404);
    expect(mock.body).toMatch(/not found/i);
  });

  it('GET /api/schedules/describe-cron parses expressions', () => {
    const url = new URL('http://localhost/api/schedules/describe-cron?expr=0+9+*+*+*');
    const req = createMockGetReq('/api/schedules/describe-cron?expr=0+9+*+*+*');
    const { mock, res } = createMockRes();
    handleDescribeCron(req, res, url, scheduler, config);
    expect(mock.statusCode).toBe(200);
    const parsed = JSON.parse(mock.body) as { description: string; valid: boolean };
    expect(parsed.valid).toBe(true);
    expect(parsed.description.toLowerCase()).toContain('9');
  });

  it('GET /api/schedules/describe-cron returns valid:false for invalid expr', () => {
    const url = new URL('http://localhost/api/schedules/describe-cron?expr=garbage');
    const req = createMockGetReq('/api/schedules/describe-cron?expr=garbage');
    const { mock, res } = createMockRes();
    handleDescribeCron(req, res, url, scheduler, config);
    expect(mock.statusCode).toBe(200);
    expect(JSON.parse(mock.body).valid).toBe(false);
  });

  it('GET /api/schedules/describe-cron requires expr query param', () => {
    const url = new URL('http://localhost/api/schedules/describe-cron');
    const req = createMockGetReq('/api/schedules/describe-cron');
    const { mock, res } = createMockRes();
    handleDescribeCron(req, res, url, scheduler, config);
    expect(mock.statusCode).toBe(400);
  });

  // ── Round-2 review fixes: validation tightening + 409 conflict ──

  it('POST /api/schedules rejects names with disallowed characters (regex)', async () => {
    const body = JSON.stringify({
      name: 'bad name!', cronExpr: '0 9 * * *', prompt: 'p',
    });
    const req = createMockPostReq('/api/schedules', body);
    const { mock, res } = createMockRes();
    await handleCreateSchedule(req, res, scheduler, config);
    expect(mock.statusCode).toBe(400);
    expect(mock.body).toContain('Validation failed');
  });

  it('POST /api/schedules rejects names that start with a non-alphanumeric character', async () => {
    const body = JSON.stringify({
      name: ' leading-space', cronExpr: '0 9 * * *', prompt: 'p',
    });
    const req = createMockPostReq('/api/schedules', body);
    const { mock, res } = createMockRes();
    await handleCreateSchedule(req, res, scheduler, config);
    expect(mock.statusCode).toBe(400);
  });

  it('POST /api/schedules accepts names with letters, digits, spaces, hyphens, underscores', async () => {
    const body = JSON.stringify({
      name: 'My Daily-Task_1', cronExpr: '0 9 * * *', prompt: 'p',
    });
    const req = createMockPostReq('/api/schedules', body);
    const { mock, res } = createMockRes();
    await handleCreateSchedule(req, res, scheduler, config);
    expect(mock.statusCode).toBe(201);
  });

  it('POST /api/schedules rejects maxRetries above 5', async () => {
    const body = JSON.stringify({
      name: 'retries', cronExpr: '0 9 * * *', prompt: 'p', maxRetries: 6,
    });
    const req = createMockPostReq('/api/schedules', body);
    const { mock, res } = createMockRes();
    await handleCreateSchedule(req, res, scheduler, config);
    expect(mock.statusCode).toBe(400);
  });

  it('POST /api/schedules rejects timeoutSec above 7200', async () => {
    const body = JSON.stringify({
      name: 'timeout', cronExpr: '0 9 * * *', prompt: 'p', timeoutSec: 7201,
    });
    const req = createMockPostReq('/api/schedules', body);
    const { mock, res } = createMockRes();
    await handleCreateSchedule(req, res, scheduler, config);
    expect(mock.statusCode).toBe(400);
  });

  it('POST /api/schedules rejects timezone strings longer than 64 chars', async () => {
    const body = JSON.stringify({
      name: 'tz', cronExpr: '0 9 * * *', prompt: 'p', timezone: 'A'.repeat(65),
    });
    const req = createMockPostReq('/api/schedules', body);
    const { mock, res } = createMockRes();
    await handleCreateSchedule(req, res, scheduler, config);
    expect(mock.statusCode).toBe(400);
  });

  it('POST /api/schedules returns 409 Conflict on duplicate name', async () => {
    const body = JSON.stringify({
      name: 'dup', cronExpr: '0 9 * * *', prompt: 'p',
    });
    const first = createMockPostReq('/api/schedules', body);
    const firstRes = createMockRes();
    await handleCreateSchedule(first, firstRes.res, scheduler, config);
    expect(firstRes.mock.statusCode).toBe(201);

    const second = createMockPostReq('/api/schedules', body);
    const secondRes = createMockRes();
    await handleCreateSchedule(second, secondRes.res, scheduler, config);
    expect(secondRes.mock.statusCode).toBe(409);
    expect(secondRes.mock.body).toContain('already exists');
  });
});
