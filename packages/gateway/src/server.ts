/**
 * @module server
 * Main gateway server entry point.
 *
 * Creates an HTTP server with REST routes and upgrades WebSocket connections.
 * Uses Node's native `http` module — no frameworks.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readConfig } from '@orionomega/core';
import type { GatewayConfig } from './types.js';
import { SessionManager } from './sessions.js';
import { CommandHandler } from './commands.js';
import { EventStreamer } from './events.js';
import { WebSocketHandler } from './websocket.js';
import { handleHealth } from './routes/health.js';
import { handleListSessions, handleGetSession, handleCreateSession } from './routes/sessions.js';
import { handleStatus } from './routes/status.js';

const startTime = Date.now();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

let config: GatewayConfig;
let hindsightUrl: string;

try {
  const fullConfig = readConfig();
  config = fullConfig.gateway;
  hindsightUrl = fullConfig.hindsight.url;
} catch {
  // Fallback defaults if core config is unavailable
  config = {
    port: 7800,
    bind: '127.0.0.1',
    auth: { mode: 'none' },
    cors: { origins: ['http://localhost:*'] },
  };
  hindsightUrl = 'http://localhost:8888';
  console.warn('[gateway] Could not load config from @orionomega/core — using defaults');
}

// ---------------------------------------------------------------------------
// Shared Services
// ---------------------------------------------------------------------------

const sessionManager = new SessionManager();
const commandHandler = new CommandHandler(sessionManager);
const eventStreamer = new EventStreamer();
const wsHandler = new WebSocketHandler(config, sessionManager, commandHandler, eventStreamer);

// ---------------------------------------------------------------------------
// CORS Helpers
// ---------------------------------------------------------------------------

/**
 * Check if an origin matches the configured CORS patterns.
 * Supports wildcard `*` in patterns (e.g. `http://localhost:*`).
 */
function originAllowed(origin: string): boolean {
  return config.cors.origins.some((pattern) => {
    if (pattern === '*') return true;
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(origin);
  });
}

/** Set CORS headers on a response. */
function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin ?? '';
  if (originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ---------------------------------------------------------------------------
// HTTP Router
// ---------------------------------------------------------------------------

/**
 * Minimal pattern-matching router for REST endpoints.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  setCorsHeaders(req, res);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // --- Health ---
  if (url === '/api/health' && method === 'GET') {
    handleHealth(req, res, startTime);
    return;
  }

  // --- Status ---
  if (url === '/api/status' && method === 'GET') {
    handleStatus(req, res, sessionManager, startTime, hindsightUrl).catch((err) => {
      console.error('[gateway] Status route error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
    return;
  }

  // --- Sessions ---
  if (url === '/api/sessions' && method === 'GET') {
    handleListSessions(req, res, sessionManager);
    return;
  }

  if (url === '/api/sessions' && method === 'POST') {
    handleCreateSession(req, res, sessionManager);
    return;
  }

  // GET /api/sessions/:id
  const sessionMatch = url.match(/^\/api\/sessions\/([a-f0-9]+)$/);
  if (sessionMatch && method === 'GET') {
    handleGetSession(req, res, sessionManager, sessionMatch[1]!);
    return;
  }

  // --- 404 ---
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

const server = createServer(handleRequest);

wsHandler.attach(server);

server.listen(config.port, config.bind, () => {
  console.log(`[gateway] OrionOmega Gateway v0.1.0`);
  console.log(`[gateway] Listening on ${config.bind}:${config.port}`);
  console.log(`[gateway] Auth mode: ${config.auth.mode}`);
  console.log(`[gateway] CORS origins: ${config.cors.origins.join(', ')}`);
  console.log(`[gateway] Hindsight: ${hindsightUrl}`);
});

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  console.log(`\n[gateway] ${signal} received — shutting down gracefully…`);
  wsHandler.shutdown();
  eventStreamer.destroy();
  server.close(() => {
    console.log('[gateway] Server closed.');
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => {
    console.warn('[gateway] Forced exit after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { server, sessionManager, commandHandler, eventStreamer, wsHandler };
