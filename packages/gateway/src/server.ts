/**
 * @module server
 * Main gateway server entry point.
 *
 * Creates an HTTP server with REST routes and upgrades WebSocket connections.
 * Uses Node's native `http` module — no frameworks.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readConfig, MainAgent, createLogger, setGlobalLogLevel, enableFileLogging } from '@orionomega/core';
import type { MainAgentConfig, MainAgentCallbacks, LogLevel } from '@orionomega/core';
import { setLogLevel as setHindsightLogLevel } from '@orionomega/hindsight';
import type { GatewayConfig, ServerMessage } from './types.js';
import { SessionManager } from './sessions.js';
import { CommandHandler } from './commands.js';
import { EventStreamer } from './events.js';
import { WebSocketHandler } from './websocket.js';
import { handleHealth } from './routes/health.js';
import { handleListSessions, handleGetSession, handleCreateSession } from './routes/sessions.js';
import { handleStatus } from './routes/status.js';
import { handleGetConfig, handlePutConfig } from './routes/config.js';

const startTime = Date.now();
const log = createLogger('gateway');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

let config: GatewayConfig;
let hindsightUrl: string;

try {
  const fullConfig = readConfig();
  config = fullConfig.gateway;
  hindsightUrl = fullConfig.hindsight.url;

  // Apply logging config from config.yaml — sets level for ALL packages
  const logLevel = fullConfig.logging?.level ?? 'info';
  setGlobalLogLevel(logLevel as LogLevel);
  setHindsightLogLevel(logLevel as LogLevel);
  // Propagate to child processes (skill executor reads this)
  process.env.ORIONOMEGA_LOG_LEVEL = logLevel;
  if (fullConfig.logging?.file) {
    enableFileLogging(fullConfig.logging.file);
  }
  log.info(`Log level set to: ${logLevel}`);
} catch {
  // Fallback defaults if core config is unavailable
  config = {
    port: 8000,
    bind: '0.0.0.0',
    auth: { mode: 'none' },
    cors: { origins: ['http://*:*', 'http://localhost:*', 'https://*'] },
  };
  hindsightUrl = 'http://localhost:8888';
  log.warn('Could not load config from @orionomega/core — using defaults');
}

// ---------------------------------------------------------------------------
// Shared Services
// ---------------------------------------------------------------------------

const sessionManager = new SessionManager();
const commandHandler = new CommandHandler(sessionManager);
const eventStreamer = new EventStreamer();
const wsHandler = new WebSocketHandler(config, sessionManager, commandHandler, eventStreamer);
wsHandler.setHindsightStatusProvider(() => ({
  connected: lastHindsightConnected ?? false,
  busy: false,
}));

/** Module-level reference to the MainAgent for shutdown summarization. */
let mainAgent: MainAgent | null = null;

// ---------------------------------------------------------------------------
// Main Agent Integration
// ---------------------------------------------------------------------------

let fullConfig: ReturnType<typeof readConfig> | undefined;
try {
  fullConfig = readConfig();
} catch {
  // already handled above — fullConfig stays undefined
}

/**
 * Wire the MainAgent into the gateway.
 * Callbacks broadcast ServerMessages to all connected WebSocket clients.
 */
async function initMainAgent(): Promise<void> {
  const apiKey = fullConfig?.models?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    log.warn(' No Anthropic API key — MainAgent will not be available');
    return;
  }

  const agentConfig: MainAgentConfig = {
    model: fullConfig?.models?.default ?? 'claude-sonnet-4-20250514',
    cheapModel: fullConfig?.models?.cheap || 'claude-haiku-4-5-20251001',
    apiKey,
    systemPrompt: '',
    workspaceDir: fullConfig?.workspace?.path ?? '',
    checkpointDir: fullConfig?.workspace?.path
      ? fullConfig.workspace.path + '/checkpoints'
      : '/tmp/orionomega-checkpoints',
    workerTimeout: fullConfig?.orchestration?.workerTimeout ?? 300,
    maxRetries: fullConfig?.orchestration?.maxRetries ?? 2,
    skillsDir: fullConfig?.skills?.directory,
    hindsight: fullConfig?.hindsight,
  };

  // Stable IDs for streaming — each new response starts a fresh ID,
  // but all chunks within the same stream share it so the TUI can
  // assemble them into a single message bubble.
  let currentTextId = randomBytes(8).toString('hex');
  let currentThinkingId = randomBytes(8).toString('hex');

  // Accumulate streamed text so we can persist the FULL response,
  // not just the empty "done" signal.
  let streamBuffer = '';

  const callbacks: MainAgentCallbacks = {
    onText(text, streaming, done, workflowId) {
      wsHandler.broadcast({
        id: currentTextId,
        type: 'text',
        content: text,
        streaming,
        done,
        workflowId,
      });

      // Accumulate streamed chunks
      if (streaming && !done) {
        streamBuffer += text;
      }

      // Store the full accumulated response when the stream completes
      if (done || !streaming) {
        // For non-streaming messages, use the text directly.
        // For streaming, use the accumulated buffer.
        const fullContent = streaming ? streamBuffer : text;

        if (fullContent) {
          const sid = sessionManager.listSessions()[0]?.id;
          if (sid) {
            sessionManager.addMessage(sid, {
              id: currentTextId,
              role: 'assistant',
              content: fullContent,
              timestamp: new Date().toISOString(),
              type: 'text',
            });
          }
        }

        // Reset buffer and rotate ID for the next response
        streamBuffer = '';
        currentTextId = randomBytes(8).toString('hex');
      }
    },
    onThinking(text, streaming, done) {
      wsHandler.broadcast({
        id: currentThinkingId,
        type: 'thinking',
        thinking: text,
        streaming,
        done,
      });
      if (done || !streaming) {
        currentThinkingId = randomBytes(8).toString('hex');
      }
    },
    onPlan(plan) {
      // Use graph.id as the message ID so the TUI can send it back
      // in plan_response and the MainAgent can match it to pendingPlanId.
      const graph = (plan as any)?.graph;
      const planId = graph?.id ?? randomBytes(8).toString('hex');

      // Clone plan for transport — MUST NOT mutate the original.
      // The executor still needs graph.nodes as a Map.
      const transportPlan = JSON.parse(JSON.stringify(plan, (key, value) =>
        value instanceof Map ? Object.fromEntries(value) : value,
      ));

      // Store plan in session history
      const sessionId = sessionManager.listSessions()[0]?.id;
      if (sessionId) {
        sessionManager.addMessage(sessionId, {
          id: planId,
          role: 'assistant',
          content: JSON.stringify(transportPlan),
          timestamp: new Date().toISOString(),
          type: 'plan',
        });
      }

      wsHandler.broadcast({
        id: planId,
        type: 'plan',
        plan: transportPlan,
      });
    },
    onEvent(event) {
      const workerEvent = event as { workflowId?: string; type?: string };
      eventStreamer.emit(event, workerEvent.type, workerEvent.workflowId);
    },
    onGraphState(state) {
      wsHandler.broadcast({
        id: randomBytes(8).toString('hex'),
        type: 'status',
        workflowId: state.workflowId,
        graphState: state,
      });
    },
    onSessionStatus(status) {
      wsHandler.broadcast({
        id: randomBytes(8).toString("hex"),
        type: "session_status",
        sessionStatus: status,
      });
    },
    onWorkflowStart(workflowId, _workflowName) {
      const sessionId = sessionManager.listSessions()[0]?.id;
      if (sessionId) sessionManager.addActiveWorkflow(sessionId, workflowId);
    },
    onWorkflowEnd(workflowId) {
      const sessionId = sessionManager.listSessions()[0]?.id;
      if (sessionId) sessionManager.removeActiveWorkflow(sessionId, workflowId);
    },
    onCommandResult(result) {
      wsHandler.broadcast({
        id: randomBytes(8).toString('hex'),
        type: 'command_result',
        commandResult: result,
      });
    },
    onHindsightActivity(status) {
      wsHandler.broadcast({
        id: randomBytes(8).toString('hex'),
        type: 'hindsight_status',
        hindsightStatus: status,
      });
    },

    // DAG lifecycle callbacks — route through EventStreamer for subscription filtering
    onDAGDispatched(dispatch) {
      eventStreamer.emitDAGMessage({
        id: randomBytes(8).toString('hex'),
        type: 'dag_dispatched',
        workflowId: dispatch.workflowId,
        dagDispatch: dispatch,
      });
    },
    onDAGProgress(progress) {
      eventStreamer.emitDAGMessage({
        id: randomBytes(8).toString('hex'),
        type: 'dag_progress',
        workflowId: progress.workflowId,
        dagProgress: progress,
      });
    },
    onDAGComplete(result) {
      eventStreamer.emitDAGMessage({
        id: randomBytes(8).toString('hex'),
        type: 'dag_complete',
        workflowId: result.workflowId,
        dagComplete: result,
      });
    },
    onDAGConfirm(confirm) {
      eventStreamer.emitDAGMessage({
        id: randomBytes(8).toString('hex'),
        type: 'dag_confirm',
        workflowId: confirm.workflowId,
        dagConfirm: confirm,
      });
    },
  };

  try {
    mainAgent = new MainAgent(agentConfig, callbacks);
    await mainAgent.init();
    wsHandler.setMainAgent(mainAgent);
    log.info(' MainAgent connected');
  } catch (err) {
    log.error('Failed to initialise MainAgent', { error: err instanceof Error ? err.message : String(err) });
  }
}

initMainAgent();

// ---------------------------------------------------------------------------
// Periodic Hindsight Health Check
// ---------------------------------------------------------------------------

let lastHindsightConnected: boolean | null = null;

/** Poll hindsight health every 15 seconds and broadcast changes. */
const hindsightHealthTimer = setInterval(async () => {
  let connected = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`${hindsightUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    connected = resp.ok;
  } catch {
    connected = false;
  }

  // Only broadcast on state change (or first check)
  if (connected !== lastHindsightConnected) {
    lastHindsightConnected = connected;
    wsHandler.broadcast({
      id: randomBytes(8).toString('hex'),
      type: 'hindsight_status',
      hindsightStatus: { connected, busy: false },
    });
  }
}, 15_000);

// Run an initial check immediately
(async () => {
  let connected = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`${hindsightUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    connected = resp.ok;
  } catch {
    connected = false;
  }
  lastHindsightConnected = connected;
  wsHandler.broadcast({
    id: randomBytes(8).toString('hex'),
    type: 'hindsight_status',
    hindsightStatus: { connected, busy: false },
  });
})();

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
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
      log.error('Status route error', { error: err instanceof Error ? err.message : String(err) });
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

  // --- Config ---
  if (url === '/api/config' && method === 'GET') {
    handleGetConfig(req, res, config);
    return;
  }

  if (url === '/api/config' && method === 'PUT') {
    handlePutConfig(req, res, config).catch((err) => {
      log.error('Config route error', { error: err instanceof Error ? err.message : String(err) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
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

const restartDelay = parseInt(process.env.ORIONOMEGA_RESTART_DELAY ?? '0', 10);
delete process.env.ORIONOMEGA_RESTART_DELAY;

function startListening(): void {
  server.listen(config.port, config.bind, () => {
    log.info(`OrionOmega Gateway v0.1.0`);
    log.info(`Listening on ${config.bind}:${config.port}`);
    log.info(`Auth mode: ${config.auth.mode}`);
    log.info(`CORS origins: ${config.cors.origins.join(', ')}`);
    log.info(`Hindsight: ${hindsightUrl}`);
  });
}

if (restartDelay > 0) {
  log.info(`Restart delay: waiting ${restartDelay}ms for old process to release port...`);
  setTimeout(startListening, restartDelay);
} else {
  startListening();
}

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  log.info(` ${signal} received — shutting down gracefully…`);

  // Summarize session to persistent memory before closing
  if (mainAgent) {
    try {
      await mainAgent.summarizeSession();
      log.info('Session summarized during shutdown');
    } catch (err) {
      log.warn('Session summarization failed during shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  clearInterval(hindsightHealthTimer);
  sessionManager.shutdown();
  wsHandler.shutdown();
  eventStreamer.destroy();
  server.close(() => {
    log.info(' Server closed.');
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => {
    log.warn(' Forced exit after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { server, sessionManager, commandHandler, eventStreamer, wsHandler };
