/**
 * @module routes/health
 * Health-check endpoint for load balancers and monitoring.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

const VERSION = '0.1.0';

/**
 * Handle GET /api/health requests.
 * @param _req - The incoming HTTP request.
 * @param res - The HTTP response.
 * @param startTime - Server start timestamp (ms) for uptime calculation.
 */
export function handleHealth(_req: IncomingMessage, res: ServerResponse, startTime: number): void {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const body = JSON.stringify({ status: 'ok', version: VERSION, uptime });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}
