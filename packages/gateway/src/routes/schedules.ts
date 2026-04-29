/**
 * @module routes/schedules
 * REST endpoints for managing scheduled tasks (cron jobs).
 *
 * All handlers expect a `SchedulerService` instance — when scheduling is
 * disabled in config the calling site in `server.ts` should NOT register
 * these routes, so service availability is the caller's responsibility.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { Cron } from 'croner';
import type { SchedulerService } from '../scheduler.js';
import type { GatewayConfig } from '../types.js';
import { readBody } from './utils.js';
import { checkAuth } from './auth-utils.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

const cronExprSchema = z
  .string()
  .min(1, 'cronExpr is required')
  .refine(
    (expr) => {
      try {
        new Cron(expr, { paused: true }, () => {});
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid cron expression' },
  );

const isoDateTimeSchema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: 'Must be a valid ISO 8601 datetime',
  });

/**
 * Spec rule: name must start alphanumeric and contain only letters, digits,
 * spaces, hyphens, and underscores. Bound length to 100 chars.
 */
const nameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/,
    'Name must start with alphanumeric and contain only letters, digits, spaces, hyphens, or underscores',
  );

const timezoneSchema = z.string().min(1).max(64);

const createScheduleSchema = z.object({
  name: nameSchema,
  description: z.string().max(500).optional(),
  cronExpr: cronExprSchema,
  prompt: z.string().min(1).max(10_000),
  agentMode: z.enum(['orchestrate', 'direct', 'code']).optional(),
  sessionId: z.string().max(128).optional(),
  timezone: timezoneSchema.optional(),
  overlapPolicy: z.enum(['skip', 'queue', 'allow']).optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
  timeoutSec: z.number().int().min(0).max(7_200).optional(),
  // One-shot run timestamp must be in the future at submission time so that
  // a stale form (or replayed request) cannot enqueue a task that would
  // immediately fire the moment it's mounted. Parity with the UI guard.
  runAt: isoDateTimeSchema
    .refine((iso) => Date.parse(iso) > Date.now(), {
      message: 'runAt must be a future timestamp',
    })
    .optional(),
});

const updateScheduleSchema = z.object({
  name: nameSchema.optional(),
  description: z.string().max(500).optional(),
  cronExpr: cronExprSchema.optional(),
  prompt: z.string().min(1).max(10_000).optional(),
  agentMode: z.enum(['orchestrate', 'direct', 'code']).optional(),
  timezone: timezoneSchema.optional(),
  overlapPolicy: z.enum(['skip', 'queue', 'allow']).optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
  timeoutSec: z.number().int().min(0).max(7_200).optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function errorResponse(res: ServerResponse, status: number, message: string, details?: unknown): void {
  jsonResponse(res, status, details === undefined ? { error: message } : { error: message, details });
}

async function readJsonBody<T>(
  req: IncomingMessage,
  schema: z.ZodSchema<T>,
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string; details?: unknown }> {
  try {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, status: 400, message: 'Invalid JSON body' };
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        status: 400,
        message: 'Validation failed',
        details: result.error.flatten(),
      };
    }
    return { ok: true, data: result.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read body';
    const status = message.includes('exceeds limit') ? 413 : 400;
    return { ok: false, status, message };
  }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export function handleListSchedules(
  req: IncomingMessage,
  res: ServerResponse,
  scheduler: SchedulerService,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;
  try {
    const tasks = scheduler.listTasks();
    jsonResponse(res, 200, { tasks });
  } catch (err) {
    errorResponse(res, 500, err instanceof Error ? err.message : 'Failed to list schedules');
  }
}

export function handleGetSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  scheduler: SchedulerService,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;
  const task = scheduler.getTask(id);
  if (!task) {
    errorResponse(res, 404, `Schedule ${id} not found`);
    return;
  }
  jsonResponse(res, 200, { task });
}

export async function handleCreateSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  scheduler: SchedulerService,
  gatewayConfig: GatewayConfig,
): Promise<void> {
  if (!checkAuth(req, res, gatewayConfig)) return;
  const parsed = await readJsonBody(req, createScheduleSchema);
  if (!parsed.ok) {
    errorResponse(res, parsed.status, parsed.message, parsed.details);
    return;
  }
  try {
    const task = scheduler.createTask(parsed.data);
    jsonResponse(res, 201, { task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create schedule';
    // Surface SQLite UNIQUE constraint violations on `name` as 409 Conflict.
    if (/UNIQUE constraint failed/i.test(msg)) {
      errorResponse(res, 409, `A schedule named "${parsed.data.name}" already exists`);
      return;
    }
    // Service-layer fail-fast validation (cron / timezone) → 400, not 500.
    if (/^Invalid (cron expression|timezone)/i.test(msg)) {
      errorResponse(res, 400, msg);
      return;
    }
    errorResponse(res, 500, msg);
  }
}

export async function handleUpdateSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  scheduler: SchedulerService,
  gatewayConfig: GatewayConfig,
): Promise<void> {
  if (!checkAuth(req, res, gatewayConfig)) return;
  const parsed = await readJsonBody(req, updateScheduleSchema);
  if (!parsed.ok) {
    errorResponse(res, parsed.status, parsed.message, parsed.details);
    return;
  }
  try {
    const task = scheduler.updateTask(id, parsed.data);
    jsonResponse(res, 200, { task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update schedule';
    if (/UNIQUE constraint failed/i.test(msg)) {
      errorResponse(res, 409, `A schedule named "${parsed.data.name}" already exists`);
      return;
    }
    if (/^Invalid (cron expression|timezone)/i.test(msg)) {
      errorResponse(res, 400, msg);
      return;
    }
    errorResponse(res, msg.includes('not found') ? 404 : 500, msg);
  }
}

export function handleDeleteSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  scheduler: SchedulerService,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;
  try {
    scheduler.deleteTask(id);
    jsonResponse(res, 200, { ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to delete schedule';
    errorResponse(res, msg.includes('not found') ? 404 : 500, msg);
  }
}

export function handlePauseSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  scheduler: SchedulerService,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;
  try {
    const task = scheduler.pauseTask(id);
    jsonResponse(res, 200, { task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to pause schedule';
    errorResponse(res, msg.includes('not found') ? 404 : 500, msg);
  }
}

export function handleResumeSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  scheduler: SchedulerService,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;
  try {
    const task = scheduler.resumeTask(id);
    jsonResponse(res, 200, { task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to resume schedule';
    errorResponse(res, msg.includes('not found') ? 404 : 500, msg);
  }
}

export function handleTriggerSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  scheduler: SchedulerService,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;
  try {
    scheduler.triggerTask(id);
    jsonResponse(res, 202, { ok: true, message: 'Triggered' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to trigger schedule';
    errorResponse(res, msg.includes('not found') ? 404 : 500, msg);
  }
}

export function handleGetExecutions(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
  scheduler: SchedulerService,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;
  // Strict 404 for unknown schedule id (rather than returning an empty list,
  // which masks typos and hides real client bugs).
  if (!scheduler.getTask(id)) {
    errorResponse(res, 404, `Schedule ${id} not found`);
    return;
  }
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
  try {
    const executions = scheduler.getExecutions(id, Number.isFinite(limit) ? limit : 50);
    jsonResponse(res, 200, { executions });
  } catch (err) {
    errorResponse(res, 500, err instanceof Error ? err.message : 'Failed to list executions');
  }
}

export function handleDescribeCron(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  scheduler: SchedulerService,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;
  const expr = url.searchParams.get('expr');
  if (!expr) {
    errorResponse(res, 400, 'Missing required query parameter: expr');
    return;
  }
  // Validate first via Cron — describeCron returns "Invalid expression" on failure.
  try {
    new Cron(expr, { paused: true }, () => {});
  } catch {
    jsonResponse(res, 200, { description: 'Invalid expression', valid: false });
    return;
  }
  const description = scheduler.describeCron(expr);
  jsonResponse(res, 200, { description, valid: true });
}
