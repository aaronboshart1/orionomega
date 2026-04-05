/**
 * @module routes/coding
 * REST API endpoints for Coding Mode sessions.
 *
 * Routes:
 *   POST   /api/coding/sessions         — start a coding session
 *   GET    /api/coding/sessions/:id     — get session status
 *   GET    /api/coding/sessions/:id/steps — get workflow step details
 *   DELETE /api/coding/sessions/:id     — cancel a session (marks as failed)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@orionomega/core';
import type { MainAgent } from '@orionomega/core';

const log = createLogger('routes/coding');

// ── Shared helpers ────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

// ── DB access ─────────────────────────────────────────────────────────────────

async function getDbSafe() {
  try {
    const { getDb } = await import('@orionomega/core');
    return getDb();
  } catch {
    return null;
  }
}

async function getSchemasSafe() {
  try {
    const schema = await import('@orionomega/core');
    return schema;
  } catch {
    return null;
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * POST /api/coding/sessions
 * Body: { task: string, repoUrl?: string, branch?: string }
 * Starts a coding session via MainAgent in 'code' mode.
 */
export async function handleStartCodingSession(
  req: IncomingMessage,
  res: ServerResponse,
  mainAgent: MainAgent | null,
): Promise<void> {
  try {
    const raw = await readBody(req);
    let body: { task?: string; repoUrl?: string; branch?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const task = body.task?.trim();
    if (!task) {
      json(res, 400, { error: 'Missing required field: task' });
      return;
    }

    if (!mainAgent) {
      json(res, 503, { error: 'MainAgent not yet initialised — retry in a moment' });
      return;
    }

    // Build the task string with optional repo/branch hints
    let enrichedTask = task;
    if (body.repoUrl) enrichedTask += ` repo:${body.repoUrl}`;
    if (body.branch) enrichedTask += ` branch:${body.branch}`;

    // Kick off through the agent in coding mode (fire-and-forget)
    void mainAgent.handleMessage(enrichedTask, undefined, undefined, 'code').catch((err) => {
      log.error('Coding session via API failed', { error: err instanceof Error ? err.message : String(err) });
    });

    json(res, 202, {
      status: 'accepted',
      message: 'Coding session started. Monitor progress via WebSocket events (type: coding_event).',
      task,
    });
  } catch (err) {
    log.error('handleStartCodingSession error', { error: err instanceof Error ? err.message : String(err) });
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * GET /api/coding/sessions/:id
 * Returns the session record from the database.
 */
export async function handleGetCodingSession(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  try {
    const db = await getDbSafe();
    if (!db) {
      json(res, 503, { error: 'Database not available' });
      return;
    }

    // Dynamic import to avoid hard dep at module load time
    const { eq } = await import('drizzle-orm');
    const core = await import('@orionomega/core');
    const schema = (core as unknown as { codingSessions?: unknown }).codingSessions
      ? core
      : null;

    if (!schema) {
      json(res, 503, { error: 'Database schema not available' });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await (db as any).select()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from((schema as any).codingSessions)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .where(eq((schema as any).codingSessions.id, sessionId))
      .limit(1);

    if (!results || results.length === 0) {
      json(res, 404, { error: 'Session not found' });
      return;
    }

    json(res, 200, { session: results[0] });
  } catch (err) {
    log.error('handleGetCodingSession error', { error: err instanceof Error ? err.message : String(err) });
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * GET /api/coding/sessions/:id/steps
 * Returns all workflow steps for a session.
 */
export async function handleGetCodingSteps(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  try {
    const db = await getDbSafe();
    if (!db) {
      json(res, 503, { error: 'Database not available' });
      return;
    }

    const { eq } = await import('drizzle-orm');
    const core = await import('@orionomega/core');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coreAny = core as any;
    if (!coreAny.workflowExecutions || !coreAny.workflowSteps) {
      json(res, 503, { error: 'Database schema not available' });
      return;
    }

    // Get workflow execution IDs for this session
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const executions = await (db as any).select()
      .from(coreAny.workflowExecutions)
      .where(eq(coreAny.workflowExecutions.codingSessionId, sessionId));

    if (!executions || executions.length === 0) {
      json(res, 200, { steps: [] });
      return;
    }

    // Get steps for the most recent execution
    const latestExecution = executions[executions.length - 1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = await (db as any).select()
      .from(coreAny.workflowSteps)
      .where(eq(coreAny.workflowSteps.workflowExecutionId, latestExecution.id));

    json(res, 200, { sessionId, executionId: latestExecution.id, steps: steps ?? [] });
  } catch (err) {
    log.error('handleGetCodingSteps error', { error: err instanceof Error ? err.message : String(err) });
    json(res, 500, { error: 'Internal server error' });
  }
}

/**
 * DELETE /api/coding/sessions/:id
 * Marks a session as failed (cancel). Does not stop in-progress agents.
 */
export async function handleCancelCodingSession(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  try {
    const db = await getDbSafe();
    if (!db) {
      json(res, 503, { error: 'Database not available' });
      return;
    }

    const { eq } = await import('drizzle-orm');
    const core = await import('@orionomega/core');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coreAny = core as any;

    if (!coreAny.codingSessions) {
      json(res, 503, { error: 'Database schema not available' });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).update(coreAny.codingSessions)
      .set({ status: 'failed', updatedAt: new Date().toISOString() })
      .where(eq(coreAny.codingSessions.id, sessionId));

    json(res, 200, { status: 'cancelled', sessionId });
  } catch (err) {
    log.error('handleCancelCodingSession error', { error: err instanceof Error ? err.message : String(err) });
    json(res, 500, { error: 'Internal server error' });
  }
}
