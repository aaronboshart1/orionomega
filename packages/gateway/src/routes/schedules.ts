/**
 * @module routes/schedules
 * REST API handlers for scheduled task management.
 *
 * Routes (all prefixed with /api/schedules):
 *   GET    /                    — list all non-deleted tasks
 *   POST   /                    — create a new task
 *   GET    /:id                 — get task by ID
 *   PUT    /:id                 — update task
 *   DELETE /:id                 — soft-delete task
 *   POST   /:id/pause           — pause task
 *   POST   /:id/resume          — resume task
 *   POST   /:id/trigger         — manual trigger
 *   GET    /:id/executions      — execution history
 *   GET    /cron/describe       — describe cron expression (?expr=...)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from './utils.js';
import type { SchedulerService, CreateScheduleInput, UpdateScheduleInput } from '../scheduler.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonOk(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function parseIntParam(params: URLSearchParams, key: string, defaultVal: number): number {
  const raw = params.get(key);
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  return isNaN(n) ? defaultVal : n;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * GET /api/schedules — list all non-deleted tasks.
 */
export async function handleListSchedules(
  _req: IncomingMessage,
  res: ServerResponse,
  scheduler: SchedulerService,
): Promise<void> {
  const tasks = await scheduler.listTasks();
  jsonOk(res, { tasks });
}

/**
 * POST /api/schedules — create a new scheduled task.
 *
 * Body: { name, cronExpr, prompt, description?, agentMode?, timezone?,
 *         overlapPolicy?, maxRetries?, timeoutSec?, runAt? }
 */
export async function handleCreateSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  scheduler: SchedulerService,
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req, 32768);
  } catch {
    jsonError(res, 413, 'Request body too large');
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    jsonError(res, 400, 'Invalid JSON body');
    return;
  }

  if (typeof body !== 'object' || body === null) {
    jsonError(res, 400, 'Body must be a JSON object');
    return;
  }

  const b = body as Record<string, unknown>;

  if (typeof b.name !== 'string' || !b.name.trim()) {
    jsonError(res, 400, 'Field "name" is required and must be a non-empty string');
    return;
  }
  if (typeof b.cronExpr !== 'string' || !b.cronExpr.trim()) {
    jsonError(res, 400, 'Field "cronExpr" is required and must be a non-empty string');
    return;
  }
  if (typeof b.prompt !== 'string' || !b.prompt.trim()) {
    jsonError(res, 400, 'Field "prompt" is required and must be a non-empty string');
    return;
  }

  const validAgentModes = new Set(['orchestrate', 'direct', 'code']);
  if (b.agentMode !== undefined && !validAgentModes.has(b.agentMode as string)) {
    jsonError(res, 400, 'Field "agentMode" must be "orchestrate", "direct", or "code"');
    return;
  }
  const validOverlapPolicies = new Set(['skip', 'queue', 'allow']);
  if (b.overlapPolicy !== undefined && !validOverlapPolicies.has(b.overlapPolicy as string)) {
    jsonError(res, 400, 'Field "overlapPolicy" must be "skip", "queue", or "allow"');
    return;
  }

  const input: CreateScheduleInput = {
    name: (b.name as string).trim(),
    cronExpr: (b.cronExpr as string).trim(),
    prompt: (b.prompt as string).trim(),
    description: typeof b.description === 'string' ? b.description : undefined,
    agentMode: b.agentMode as CreateScheduleInput['agentMode'],
    sessionId: typeof b.sessionId === 'string' ? b.sessionId : undefined,
    timezone: typeof b.timezone === 'string' ? b.timezone : undefined,
    overlapPolicy: b.overlapPolicy as CreateScheduleInput['overlapPolicy'],
    maxRetries: typeof b.maxRetries === 'number' ? Math.max(0, b.maxRetries) : undefined,
    timeoutSec: typeof b.timeoutSec === 'number' ? Math.max(0, b.timeoutSec) : undefined,
    runAt: typeof b.runAt === 'string' ? b.runAt : undefined,
  };

  try {
    const task = await scheduler.createTask(input);
    jsonOk(res, task, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('already exists')) {
      jsonError(res, 409, `A task with this name already exists`);
    } else if (msg.toLowerCase().includes('invalid cron')) {
      jsonError(res, 400, msg);
    } else {
      jsonError(res, 500, 'Failed to create task');
    }
  }
}

/**
 * GET /api/schedules/:id — get task by ID.
 */
export async function handleGetSchedule(
  _req: IncomingMessage,
  res: ServerResponse,
  scheduler: SchedulerService,
  taskId: string,
): Promise<void> {
  const task = await scheduler.getTask(taskId);
  if (!task || task.status === 'deleted') {
    jsonError(res, 404, 'Schedule not found');
    return;
  }
  jsonOk(res, task);
}

/**
 * PUT /api/schedules/:id — update task fields.
 *
 * Body: { name?, cronExpr?, prompt?, description?, agentMode?, timezone?,
 *         overlapPolicy?, maxRetries?, timeoutSec? }
 */
export async function handleUpdateSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  scheduler: SchedulerService,
  taskId: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req, 32768);
  } catch {
    jsonError(res, 413, 'Request body too large');
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    jsonError(res, 400, 'Invalid JSON body');
    return;
  }

  if (typeof body !== 'object' || body === null) {
    jsonError(res, 400, 'Body must be a JSON object');
    return;
  }

  const b = body as Record<string, unknown>;

  const validAgentModes = new Set(['orchestrate', 'direct', 'code']);
  if (b.agentMode !== undefined && !validAgentModes.has(b.agentMode as string)) {
    jsonError(res, 400, 'Field "agentMode" must be "orchestrate", "direct", or "code"');
    return;
  }
  const validOverlapPolicies = new Set(['skip', 'queue', 'allow']);
  if (b.overlapPolicy !== undefined && !validOverlapPolicies.has(b.overlapPolicy as string)) {
    jsonError(res, 400, 'Field "overlapPolicy" must be "skip", "queue", or "allow"');
    return;
  }

  const patch: UpdateScheduleInput = {
    ...(typeof b.name === 'string' && { name: b.name.trim() }),
    ...(typeof b.description === 'string' && { description: b.description }),
    ...(typeof b.cronExpr === 'string' && { cronExpr: b.cronExpr.trim() }),
    ...(typeof b.prompt === 'string' && { prompt: b.prompt.trim() }),
    ...(b.agentMode !== undefined && { agentMode: b.agentMode as UpdateScheduleInput['agentMode'] }),
    ...(typeof b.timezone === 'string' && { timezone: b.timezone }),
    ...(b.overlapPolicy !== undefined && { overlapPolicy: b.overlapPolicy as UpdateScheduleInput['overlapPolicy'] }),
    ...(typeof b.maxRetries === 'number' && { maxRetries: Math.max(0, b.maxRetries) }),
    ...(typeof b.timeoutSec === 'number' && { timeoutSec: Math.max(0, b.timeoutSec) }),
  };

  try {
    const updated = await scheduler.updateTask(taskId, patch);
    if (!updated) {
      jsonError(res, 404, 'Schedule not found');
      return;
    }
    jsonOk(res, updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('invalid cron')) {
      jsonError(res, 400, msg);
    } else {
      jsonError(res, 500, 'Failed to update task');
    }
  }
}

/**
 * DELETE /api/schedules/:id — soft-delete task.
 */
export async function handleDeleteSchedule(
  _req: IncomingMessage,
  res: ServerResponse,
  scheduler: SchedulerService,
  taskId: string,
): Promise<void> {
  const deleted = await scheduler.deleteTask(taskId);
  if (!deleted) {
    jsonError(res, 404, 'Schedule not found');
    return;
  }
  jsonOk(res, { deleted: true, taskId });
}

/**
 * POST /api/schedules/:id/pause — pause an active task.
 */
export async function handlePauseSchedule(
  _req: IncomingMessage,
  res: ServerResponse,
  scheduler: SchedulerService,
  taskId: string,
): Promise<void> {
  const task = await scheduler.pauseTask(taskId);
  if (!task) {
    jsonError(res, 404, 'Schedule not found or not active');
    return;
  }
  jsonOk(res, task);
}

/**
 * POST /api/schedules/:id/resume — resume a paused task.
 */
export async function handleResumeSchedule(
  _req: IncomingMessage,
  res: ServerResponse,
  scheduler: SchedulerService,
  taskId: string,
): Promise<void> {
  const task = await scheduler.resumeTask(taskId);
  if (!task) {
    jsonError(res, 404, 'Schedule not found or not paused');
    return;
  }
  jsonOk(res, task);
}

/**
 * POST /api/schedules/:id/trigger — manual fire-and-forget execution.
 */
export function handleTriggerSchedule(
  _req: IncomingMessage,
  res: ServerResponse,
  scheduler: SchedulerService,
  taskId: string,
): void {
  scheduler.triggerTask(taskId);
  jsonOk(res, { triggered: true, taskId });
}

/**
 * GET /api/schedules/:id/executions — execution history.
 *
 * Query parameters:
 *   limit (optional) — max executions (default 50, max 200)
 */
export async function handleGetExecutions(
  req: IncomingMessage,
  res: ServerResponse,
  scheduler: SchedulerService,
  taskId: string,
): Promise<void> {
  const rawUrl = req.url ?? '/';
  const queryStr = rawUrl.split('?')[1] ?? '';
  const params = new URLSearchParams(queryStr);
  const limit = Math.min(parseIntParam(params, 'limit', 50), 200);

  const task = await scheduler.getTask(taskId);
  if (!task || task.status === 'deleted') {
    jsonError(res, 404, 'Schedule not found');
    return;
  }

  const executions = await scheduler.getExecutions(taskId, limit);
  jsonOk(res, { executions, taskId });
}

/**
 * GET /api/schedules/cron/describe — human-readable cron description.
 *
 * Query parameters:
 *   expr (required) — cron expression to describe
 */
export function handleDescribeCron(
  req: IncomingMessage,
  res: ServerResponse,
  scheduler: SchedulerService,
): void {
  const rawUrl = req.url ?? '/';
  const queryStr = rawUrl.split('?')[1] ?? '';
  const params = new URLSearchParams(queryStr);
  const expr = params.get('expr');

  if (!expr) {
    jsonError(res, 400, 'Missing required query parameter: expr');
    return;
  }

  const description = scheduler.describeCron(expr);
  jsonOk(res, { expr, description });
}
