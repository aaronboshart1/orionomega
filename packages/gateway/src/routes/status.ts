/**
 * @module routes/status
 * Full system status endpoint.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { SystemStatus } from '../types.js';
import { SessionManager } from '../sessions.js';
import { BUILD_INFO as CORE_BUILD_INFO, getStaleBuildStatus } from '@orionomega/core';
import { BUILD_INFO as GATEWAY_BUILD_INFO } from '../generated/build-info.js';

// Derive a deterministic anchor for `.git` discovery. This file lives at
// packages/gateway/dist/routes/status.js after build, so walking up from
// here reaches the workspace root regardless of process.cwd() (which may be
// "/" when running under systemd / launchd / a service supervisor).
const STATUS_MODULE_DIR = dirname(fileURLToPath(import.meta.url));

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
    const resp = await fetch(`${hindsightUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    hindsightConnected = resp.ok;
  } catch {
    hindsightConnected = false;
  }

  // Collect workflow summaries from active sessions
  const activeWorkflows = sessions.flatMap((s) =>
    [...s.activeWorkflows].map((wfId) => ({
      id: wfId,
      name: wfId,
      status: 'running',
      progress: 0,
      workerCount: 0,
      startedAt: s.updatedAt,
    })),
  );

  const status: SystemStatus = {
    activeWorkflows,
    systemHealth: hindsightConnected ? 'ok' : 'degraded',
    hindsightConnected,
    uptime,
  };

  // Stale-build detection: if EITHER the gateway or the core dist/ was
  // compiled from a different commit than the current source tree, surface
  // that to the web UI so the user sees a "rebuild required" indicator
  // instead of being told everything is fine while their gateway runs old
  // code. We must check both packages independently because a half-finished
  // monorepo build can leave one package fresh and the other stale (the
  // exact failure mode this whole feature exists to detect).
  let staleBuild;
  try {
    const candidateDirs = [STATUS_MODULE_DIR];
    const gatewayStatus = getStaleBuildStatus({ buildInfo: GATEWAY_BUILD_INFO, candidateDirs });
    const coreStatus = getStaleBuildStatus({ buildInfo: CORE_BUILD_INFO, candidateDirs });
    const reasons: string[] = [];
    if (gatewayStatus.isStale) reasons.push(`gateway: ${gatewayStatus.reason}`);
    if (coreStatus.isStale) reasons.push(`core: ${coreStatus.reason}`);
    const isStale = gatewayStatus.isStale || coreStatus.isStale;
    // Source commit comes from whichever check resolved it (both walk the
    // same tree, so prefer gateway then fall back to core).
    const sourceCommit = gatewayStatus.sourceCommit ?? coreStatus.sourceCommit;
    const sourceShortCommit = gatewayStatus.sourceShortCommit ?? coreStatus.sourceShortCommit;
    staleBuild = {
      isStale,
      reason: isStale ? reasons.join(' | ') : '',
      builtDirty: gatewayStatus.builtDirty || coreStatus.builtDirty,
      gateway: {
        commit: GATEWAY_BUILD_INFO.commit,
        shortCommit: GATEWAY_BUILD_INFO.shortCommit,
        buildTime: GATEWAY_BUILD_INFO.buildTime,
        dirty: GATEWAY_BUILD_INFO.dirty,
        isStale: gatewayStatus.isStale,
      },
      core: {
        commit: CORE_BUILD_INFO.commit,
        shortCommit: CORE_BUILD_INFO.shortCommit,
        buildTime: CORE_BUILD_INFO.buildTime,
        dirty: CORE_BUILD_INFO.dirty,
        isStale: coreStatus.isStale,
      },
      sourceCommit,
      sourceShortCommit,
    };
  } catch {
    staleBuild = { isStale: false, reason: '', builtDirty: false };
  }

  const body = JSON.stringify({
    gateway: {
      status: 'ok',
      version: '0.1.0',
      uptime,
      buildCommit: GATEWAY_BUILD_INFO.commit,
      buildShortCommit: GATEWAY_BUILD_INFO.shortCommit,
      buildTime: GATEWAY_BUILD_INFO.buildTime,
    },
    sessions: { total: sessions.length, active: sessions.filter((s) => s.clients.size > 0).length },
    hindsight: { connected: hindsightConnected, url: hindsightUrl },
    workflows: { active: activeWorkflows.length, details: activeWorkflows },
    systemHealth: status.systemHealth,
    build: staleBuild,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}
