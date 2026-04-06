/**
 * @module routes/health
 * Health-check and metrics endpoints for load balancers and monitoring.
 *
 * Two endpoints:
 * - GET /api/health — lightweight liveness check (for load balancers)
 * - GET /api/metrics — detailed session/store/connection metrics (for monitoring dashboards)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionManager, SessionMetrics } from '../sessions.js';
import type { ServerSessionStore, StateStoreMetrics } from '../state-store.js';

const VERSION = '0.1.0';

/**
 * Handle GET /api/health requests.
 *
 * Returns a lightweight JSON response suitable for load balancer health checks.
 * Includes basic uptime and version info. For detailed metrics, use /api/metrics.
 *
 * @param _req - The incoming HTTP request.
 * @param res - The HTTP response.
 * @param startTime - Server start timestamp (ms) for uptime calculation.
 */
export function handleHealth(_req: IncomingMessage, res: ServerResponse, startTime: number): void {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const memUsage = process.memoryUsage();
  const body = JSON.stringify({
    status: 'ok',
    version: VERSION,
    uptime,
    memory: {
      heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      rssMB: Math.round(memUsage.rss / 1024 / 1024),
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
