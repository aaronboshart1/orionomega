/**
 * @module routes/health
 * Health-check and metrics endpoints for load balancers and monitoring.
 *
 * Two endpoints:
 * - GET /api/health — lightweight liveness check (for load balancers)
 * - GET /api/metrics — detailed session/store/connection metrics (for monitoring dashboards)
 *
 * The /api/health response includes a structured `system` block describing
 * the state of the memory subsystem, database, and session summariser.
 * Operators can poll this endpoint to detect Hindsight outages, missing
 * migrations, or summariser failures without trawling the logs (Task #123).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseStatus, SummarizerStatus } from '@orionomega/core';
import type { HindsightStatus } from '@orionomega/hindsight';
import type { SessionManager, SessionMetrics } from '../sessions.js';
import type { ServerSessionStore, StateStoreMetrics } from '../state-store.js';

const VERSION = '0.1.0';

/**
 * Pull the latest system-health snapshots on demand. The provider is
 * called once per `/api/health` request, so the underlying getters must
 * be cheap (single in-memory reads or a one-shot SQL query).
 *
 * Each field returns `null` when the corresponding subsystem is not
 * configured for the running session — for example, Hindsight is null
 * when the user has not provided a memory backend URL.
 */
export interface SystemHealthProvider {
  hindsight: () => HindsightStatus | null;
  database: () => DatabaseStatus | null;
  summarizer: () => SummarizerStatus | null;
}

/** Roll up subsystem statuses into a single 'ok' | 'degraded' verdict. */
function rollupStatus(
  hindsight: HindsightStatus | null,
  database: DatabaseStatus | null,
  summarizer: SummarizerStatus | null,
): 'ok' | 'degraded' {
  // A null subsystem means "not configured" — that is a healthy state, not
  // a degraded one. Only flip to degraded for active failure signals.
  // For Hindsight we look at the rolled-up `status` field (which already
  // accounts for circuit state, suppressed endpoints, and disabled mental
  // models) rather than reading just the circuit state — otherwise the
  // top-level health would still report 'ok' while individual subsystems
  // are clearly degraded.
  if (hindsight && hindsight.status !== 'up') return 'degraded';
  if (database && database.status !== 'ok') return 'degraded';
  if (summarizer && summarizer.status !== 'ok') return 'degraded';
  return 'ok';
}

/**
 * Handle GET /api/health requests.
 *
 * Returns a JSON response suitable for load balancer health checks and
 * operator dashboards. Includes basic uptime, memory usage, and a
 * structured `system` block describing memory, database, and summariser
 * health. The HTTP status is always 200 — the JSON `status` field
 * indicates `'ok'` or `'degraded'`.
 *
 * @param _req - The incoming HTTP request.
 * @param res - The HTTP response.
 * @param startTime - Server start timestamp (ms) for uptime calculation.
 * @param systemHealth - Optional provider returning subsystem snapshots.
 *                      When omitted, the `system` block is reported as
 *                      all-null (used in test contexts and before
 *                      MainAgent is wired up).
 */
export function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  startTime: number,
  systemHealth?: SystemHealthProvider,
): void {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const memUsage = process.memoryUsage();

  const hindsight = systemHealth?.hindsight() ?? null;
  const database = systemHealth?.database() ?? null;
  const summarizer = systemHealth?.summarizer() ?? null;
  const status = rollupStatus(hindsight, database, summarizer);

  const body = JSON.stringify({
    status,
    version: VERSION,
    uptime,
    memory: {
      heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      rssMB: Math.round(memUsage.rss / 1024 / 1024),
    },
    system: {
      hindsight,
      database,
      summarizer,
    },
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

/**
 * Handle GET /api/metrics requests.
 *
 * Returns comprehensive metrics for the session subsystem, state store,
 * and WebSocket connections. Useful for monitoring dashboards and alerting.
 *
 * Response shape:
 * {
 *   status: 'ok' | 'degraded',
 *   version: string,
 *   uptime: number (seconds),
 *   process: { heapUsedMB, heapTotalMB, rssMB, uptimeSeconds },
 *   sessions: SessionMetrics,
 *   stateStore: StateStoreMetrics,
 *   connections: { active: number },
 *   generatedAt: string
 * }
 */
export function handleMetrics(
  _req: IncomingMessage,
  res: ServerResponse,
  startTime: number,
  sessionManager: SessionManager,
  stateStore: ServerSessionStore | undefined,
  connectionCount: number,
): void {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const memUsage = process.memoryUsage();

  const sessionMetrics: SessionMetrics = sessionManager.getMetrics();
  const storeMetrics: StateStoreMetrics | null = stateStore?.getMetrics() ?? null;

  // Determine overall health: degraded if disk write failures are high
  const status = sessionMetrics.diskWriteFailures > 5 ? 'degraded' : 'ok';

  const body = JSON.stringify({
    status,
    version: VERSION,
    uptime,
    process: {
      heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      rssMB: Math.round(memUsage.rss / 1024 / 1024),
      uptimeSeconds: Math.floor(process.uptime()),
    },
    sessions: sessionMetrics,
    stateStore: storeMetrics,
    connections: {
      active: connectionCount,
    },
    generatedAt: new Date().toISOString(),
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}
