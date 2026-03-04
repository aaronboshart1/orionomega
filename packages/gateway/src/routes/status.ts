/**
 * @module routes/status
 * Full system status endpoint.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SystemStatus } from '../types.js';
import { SessionManager } from '../sessions.js';

/**
 * Handle GET /api/status — full system status overview.
 * @param _req - The incoming HTTP request.
 * @param res - The HTTP response.
 * @param sessionManager - The session manager instance.
 * @param startTime - Server start timestamp (ms).
 * @param hindsightUrl - Hindsight server URL for connectivity check.
 */
export async function handleStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionManager: SessionManager,
  startTime: number,
  hindsightUrl: string,
): Promise<void> {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const sessions = sessionManager.listSessions();

  // Quick hindsight connectivity check
  let hindsightConnected = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`${hindsightUrl}/v1/health`, { signal: controller.signal });
    clearTimeout(timeout);
    hindsightConnected = resp.ok;
  } catch {
    hindsightConnected = false;
  }

  // Collect workflow summaries from active sessions
  const activeWorkflows = sessions
    .filter((s) => s.activeWorkflow)
    .map((s) => ({
      id: s.activeWorkflow!,
      name: s.activeWorkflow!,
      status: 'running',
      progress: 0,
      workerCount: 0,
      startedAt: s.updatedAt,
    }));

  const status: SystemStatus = {
    activeWorkflows,
    systemHealth: hindsightConnected ? 'ok' : 'degraded',
    hindsightConnected,
    uptime,
  };

  const body = JSON.stringify({
    gateway: { status: 'ok', version: '0.1.0', uptime },
    sessions: { total: sessions.length, active: sessions.filter((s) => s.clients.size > 0).length },
    hindsight: { connected: hindsightConnected, url: hindsightUrl },
    workflows: { active: activeWorkflows.length, details: activeWorkflows },
    systemHealth: status.systemHealth,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}
