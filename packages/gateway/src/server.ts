/**
 * @module server
 * Main gateway server entry point.
 *
 * Creates an HTTP server with REST routes and upgrades WebSocket connections.
 * Uses Node's native `http` module — no frameworks.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readConfig, normalizeBindAddresses, MainAgent, CommandFileLoader, createLogger, setGlobalLogLevel, enableFileLogging, discoverModels, clearModelCache, auditApiRequest } from '@orionomega/core';
import type { MainAgentConfig, MainAgentCallbacks, LogLevel } from '@orionomega/core';
import { setLogLevel as setHindsightLogLevel } from '@orionomega/hindsight';
import type { GatewayConfig, ServerMessage } from './types.js';
import { SessionManager, DEFAULT_SESSION_ID } from './sessions.js';
import { CommandHandler } from './commands.js';
import { EventStreamer } from './events.js';
import { WebSocketHandler } from './websocket.js';
import { handleHealth } from './routes/health.js';
import { handleListSessions, handleGetSession, handleCreateSession } from './routes/sessions.js';
import { handleStatus } from './routes/status.js';
import { handleGetConfig, handlePutConfig } from './routes/config.js';
import { handleGetSkills, handlePutSkillConfig } from './routes/skills.js';
import { rateLimitRest } from './rate-limit.js';
import { setSecurityHeaders } from './security-headers.js';

process.on('uncaughtException', (err) => {
  console.error('[gateway] Uncaught exception:', err);
  shutdown('uncaughtException').catch(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  console.error('[gateway] Unhandled rejection:', reason);
  shutdown('unhandledRejection').catch(() => process.exit(1));
});

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

  const VALID_LOG_LEVELS: ReadonlySet<string> = new Set(['error', 'warn', 'info', 'verbose', 'debug']);
  const rawLogLevel = fullConfig.logging?.level ?? 'info';
  const logLevel = VALID_LOG_LEVELS.has(rawLogLevel) ? rawLogLevel : 'info';
  if (rawLogLevel !== logLevel) {
    console.warn(`[gateway] Invalid log level "${rawLogLevel}", falling back to "info"`);
  }
  setGlobalLogLevel(logLevel as LogLevel);
  setHindsightLogLevel(logLevel as LogLevel);
  process.env.ORIONOMEGA_LOG_LEVEL = logLevel;
  if (fullConfig.logging?.file) {
    enableFileLogging(fullConfig.logging.file);
  }
  log.info(`Log level set to: ${logLevel}`);
} catch {
  // Fallback defaults if core config is unavailable
  config = {
    port: 8000,
    bind: '127.0.0.1',
    auth: { mode: 'none' },
    cors: { origins: ['http://localhost:*'] },
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

if (fullConfig?.commands?.directory) {
  try {
    const cmdFileLoader = new CommandFileLoader(fullConfig.commands.directory);
    commandHandler.setCommandFileLoader(cmdFileLoader);
  } catch (err) {
    log.warn('Failed to initialise file command loader for gateway', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
    commandsDir: fullConfig?.commands?.directory,
    hindsight: fullConfig?.hindsight,
    autoResume: fullConfig?.orchestration?.autoResume ?? false,
  };

  let currentTextId = randomBytes(8).toString('hex');
  let currentThinkingId = randomBytes(8).toString('hex');
  let streamBuffer = '';

  const bgStreamState = new Map<string, { textId: string; buffer: string }>();

  const callbacks: MainAgentCallbacks = {
    onText(text, streaming, done, workflowId) {
      if (workflowId) {
        let state = bgStreamState.get(workflowId);
        if (!state) {
          state = { textId: randomBytes(8).toString('hex'), buffer: '' };
          bgStreamState.set(workflowId, state);
        }

        wsHandler.broadcast({
          id: state.textId,
          type: 'text',
          content: text,
          streaming,
          done,
          workflowId,
        });

        if (streaming && !done) {
          state.buffer += text;
        }

        if (done || !streaming) {
          const fullContent = streaming ? (state.buffer + (text || '')) : text;
          if (fullContent) {
            const sid = DEFAULT_SESSION_ID;
            if (sid) {
              sessionManager.addMessage(sid, {
                id: state.textId,
                role: 'assistant',
                content: fullContent,
                timestamp: new Date().toISOString(),
                type: 'text',
                metadata: { workflowId, background: true },
              });
            }
          }
          bgStreamState.delete(workflowId);
        }
        return;
      }

      wsHandler.broadcast({
        id: currentTextId,
        type: 'text',
        content: text,
        streaming,
        done,
        workflowId,
      });

      if (streaming && !done) {
        streamBuffer += text;
      }

      if (done || !streaming) {
        const fullContent = streaming ? (streamBuffer + (text || '')) : text;

        if (fullContent) {
          const sid = DEFAULT_SESSION_ID;
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

        streamBuffer = '';
        currentTextId = randomBytes(8).toString('hex');
      }
    },
    onThinking(text, streaming, done, workflowId) {
      wsHandler.broadcast({
        id: currentThinkingId,
        type: 'thinking',
        thinking: text,
        streaming,
        done,
        workflowId,
      });
      if (done || !streaming) {
        currentThinkingId = randomBytes(8).toString('hex');
      }
    },
    onThinkingStep(step: { id: string; name: string; status: 'pending' | 'active' | 'done'; startedAt?: number; completedAt?: number; elapsedMs?: number; detail?: string }, workflowId?: string) {
      wsHandler.broadcast({
        id: randomBytes(8).toString('hex'),
        type: 'thinking_step',
        step,
        workflowId,
      });
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
      const sessionId = DEFAULT_SESSION_ID;
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
      const sessionId = DEFAULT_SESSION_ID;
      if (sessionId) sessionManager.addActiveWorkflow(sessionId, workflowId);
    },
    onWorkflowEnd(workflowId) {
      const sessionId = DEFAULT_SESSION_ID;
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
    onMemoryEvent(event) {
      wsHandler.broadcast({
        id: randomBytes(8).toString('hex'),
        type: 'memory_event',
        memoryEvent: event,
      });
      sessionManager.addMemoryEvent(DEFAULT_SESSION_ID, event);
    },

    // DAG lifecycle callbacks — route through EventStreamer for subscription filtering
    onDAGDispatched(dispatch) {
      const msgId = randomBytes(8).toString('hex');
      eventStreamer.emitDAGMessage({
        id: msgId,
        type: 'dag_dispatched',
        workflowId: dispatch.workflowId,
        dagDispatch: dispatch,
      });
      const sid = DEFAULT_SESSION_ID;
      if (sid) {
        sessionManager.addMessage(sid, {
          id: msgId,
          role: 'assistant',
          content: dispatch.summary || 'Working on it...',
          timestamp: new Date().toISOString(),
          type: 'dag-dispatched',
          metadata: {
            workflowId: dispatch.workflowId,
            dagDispatch: {
              workflowId: dispatch.workflowId,
              summary: dispatch.summary,
              nodeCount: dispatch.nodeCount,
              nodes: dispatch.nodes,
            },
          },
        });
      }
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
      const msgId = randomBytes(8).toString('hex');
      eventStreamer.emitDAGMessage({
        id: msgId,
        type: 'dag_complete',
        workflowId: result.workflowId,
        dagComplete: result,
      });
      const sid = DEFAULT_SESSION_ID;
      if (sid) {
        sessionManager.addMessage(sid, {
          id: msgId,
          role: 'assistant',
          content: result.status === 'error'
            ? `Something went wrong: ${result.summary}`
            : result.output || result.summary || 'Done.',
          timestamp: new Date().toISOString(),
          type: 'dag-complete',
          metadata: {
            workflowId: result.workflowId,
            dagComplete: {
              workflowId: result.workflowId,
              status: result.status,
              summary: result.summary,
              output: result.output,
              durationSec: result.durationSec,
              workerCount: result.workerCount,
              totalCostUsd: result.totalCostUsd,
              toolCallCount: result.toolCallCount,
              modelUsage: result.modelUsage,
              nodeOutputPaths: result.nodeOutputPaths,
            },
          },
        });
      }
    },
    onDAGConfirm(confirm) {
      const msgId = randomBytes(8).toString('hex');
      eventStreamer.emitDAGMessage({
        id: msgId,
        type: 'dag_confirm',
        workflowId: confirm.workflowId,
        dagConfirm: confirm,
      });
      const sid = DEFAULT_SESSION_ID;
      if (sid) {
        sessionManager.addMessage(sid, {
          id: msgId,
          role: 'assistant',
          content: confirm.summary,
          timestamp: new Date().toISOString(),
          type: 'dag-confirmation',
          metadata: {
            workflowId: confirm.workflowId,
            dagConfirm: {
              workflowId: confirm.workflowId,
              summary: confirm.summary,
              reasoning: confirm.reasoning,
              guardedActions: confirm.guardedActions,
            },
          },
        });
      }
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

initMainAgent().catch((err) => {
  log.error('Unhandled error during MainAgent init', { error: err instanceof Error ? err.message : String(err) });
});

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
// CORS Helpers — patterns pre-compiled at startup to prevent ReDoS
// ---------------------------------------------------------------------------

const compiledCorsPatterns: RegExp[] = config.cors.origins.map((pattern) => {
  if (pattern === '*') return /^.*$/;
  let regexStr = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      regexStr += '[a-zA-Z0-9._:-]*?';
    } else if ('.+?^${}()|[]\\'.includes(ch)) {
      regexStr += '\\' + ch;
    } else {
      regexStr += ch;
    }
  }
  return new RegExp('^' + regexStr + '$');
});

function originAllowed(origin: string): boolean {
  return compiledCorsPatterns.some((regex) => regex.test(origin));
}

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
  setSecurityHeaders(res);
  setCorsHeaders(req, res);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!rateLimitRest(req, res)) {
    return;
  }

  const rawUrl = req.url ?? '/';
  const method = req.method ?? 'GET';
  const pathname = rawUrl.split('?')[0]!.replace(/\/+$/, '') || '/';

  if (pathname !== '/api/health') {
    auditApiRequest(method, pathname, undefined, req.socket.remoteAddress);
  }

  // --- Health ---
  if (pathname === '/api/health' && method === 'GET') {
    handleHealth(req, res, startTime);
    return;
  }

  // --- Status ---
  if (pathname === '/api/status' && method === 'GET') {
    handleStatus(req, res, sessionManager, startTime, hindsightUrl).catch((err) => {
      log.error('Status route error', { error: err instanceof Error ? err.message : String(err) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
    return;
  }

  // --- Sessions ---
  if (pathname === '/api/sessions' && method === 'GET') {
    handleListSessions(req, res, sessionManager);
    return;
  }

  if (pathname === '/api/sessions' && method === 'POST') {
    handleCreateSession(req, res, sessionManager);
    return;
  }

  // GET /api/sessions/:id
  const sessionMatch = pathname.match(/^\/api\/sessions\/([a-z0-9]+)$/);
  if (sessionMatch && method === 'GET') {
    handleGetSession(req, res, sessionManager, sessionMatch[1]!);
    return;
  }

  // --- Models ---
  if (pathname === '/api/models' && method === 'GET') {
    const cfg = readConfig();
    const apiKey = cfg.models?.apiKey;
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No API key configured' }));
      return;
    }
    const queryStr = rawUrl.split('?')[1] ?? '';
    const params = new URLSearchParams(queryStr);
    if (params.get('refresh') === 'true') {
      clearModelCache();
    }
    discoverModels(apiKey)
      .then((models) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models }));
      })
      .catch((err) => {
        log.error('Models route error', { error: err instanceof Error ? err.message : String(err) });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to fetch models' }));
      });
    return;
  }

  // --- Config ---
  if (pathname === '/api/config' && method === 'GET') {
    handleGetConfig(req, res, config);
    return;
  }

  if (pathname === '/api/config' && method === 'PUT') {
    handlePutConfig(req, res, config).catch((err) => {
      log.error('Config route error', { error: err instanceof Error ? err.message : String(err) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
    return;
  }

  // --- Skills ---
  if (pathname === '/api/skills' && method === 'GET') {
    handleGetSkills(req, res, config);
    return;
  }

  const skillConfigMatch = pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/config$/);
  if (skillConfigMatch && method === 'PUT') {
    handlePutSkillConfig(req, res, skillConfigMatch[1]!, config).catch((err) => {
      log.error('Skill config route error', { error: err instanceof Error ? err.message : String(err) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
    return;
  }

  // --- File commands ---
  if (pathname === '/api/commands' && method === 'GET') {
    const fileCmds = commandHandler.getFileCommands();
    const agentCmds = mainAgent?.getFileCommands() ?? [];
    const combined = agentCmds.length > 0 ? agentCmds : fileCmds;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ commands: combined }));
    return;
  }

  // --- Shutdown ---
  if (pathname === '/api/shutdown' && method === 'POST') {
    const remote = req.socket.remoteAddress ?? '';
    const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLocal) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Lifecycle endpoints are restricted to localhost' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Shutting down…' }));
    setTimeout(() => shutdown('API_SHUTDOWN'), 500);
    return;
  }

  // --- Restart ---
  if (pathname === '/api/restart' && method === 'POST') {
    const remote = req.socket.remoteAddress ?? '';
    const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLocal) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Lifecycle endpoints are restricted to localhost' }));
      return;
    }
    const serverPath = process.argv[1];
    if (!serverPath) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot determine server entry point for restart' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Restarting…' }));

    const childEnv = { ...process.env, ORIONOMEGA_RESTART_DELAY: '1000' };
    const child = spawnProcess(process.execPath, [serverPath], {
      detached: true,
      stdio: 'ignore',
      env: childEnv,
    });
    child.unref();
    setTimeout(() => shutdown('API_RESTART'), 500);
    return;
  }

  // --- 404 ---
  log.warn('404 Not Found', { method, rawUrl, pathname });
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ---------------------------------------------------------------------------
// Start Server — multi-bind support
// ---------------------------------------------------------------------------

const bindAddresses = normalizeBindAddresses(config.bind);
const servers: import('node:http').Server[] = [];

const restartDelay = parseInt(process.env.ORIONOMEGA_RESTART_DELAY ?? '0', 10);
delete process.env.ORIONOMEGA_RESTART_DELAY;

let activeListeners = 0;
let failedListeners = 0;

function setupServerForAddress(address: string): import('node:http').Server {
  const srv = createServer(handleRequest);
  servers.push(srv);

  let listenAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const MAX_LISTEN_ATTEMPTS = 10;

  srv.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      listenAttempts++;
      if (listenAttempts >= MAX_LISTEN_ATTEMPTS) {
        log.error(`Failed to bind to ${address}:${config.port} after ${MAX_LISTEN_ATTEMPTS} attempts — skipping`);
        failedListeners++;
        checkAllBindsFailed();
        return;
      }
      log.warn(`Port ${config.port} on ${address} in use — retrying in 2 s… (attempt ${listenAttempts}/${MAX_LISTEN_ATTEMPTS})`);
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          srv.listen(config.port, address);
        }, 2000);
      }
    } else {
      log.error(`Server error on ${address}`, { error: err.message, code: err.code });
      failedListeners++;
      checkAllBindsFailed();
    }
  });

  wsHandler.attach(srv);
  return srv;
}

function checkAllBindsFailed(): void {
  if (activeListeners === 0 && failedListeners >= bindAddresses.length) {
    log.error(`All bind addresses failed — exiting`);
    process.exit(1);
  }
}

for (const address of bindAddresses) {
  setupServerForAddress(address);
}

const server = servers[0];

function startListening(): void {
  log.info(`OrionOmega Gateway v0.1.0`);
  log.info(`Bind addresses: ${bindAddresses.join(', ')}`);
  log.info(`Auth mode: ${config.auth.mode}`);
  log.info(`CORS origins: ${config.cors.origins.join(', ')}`);
  log.info(`Hindsight: ${hindsightUrl}`);

  for (let i = 0; i < bindAddresses.length; i++) {
    const address = bindAddresses[i];
    servers[i].listen(config.port, address, () => {
      activeListeners++;
      log.info(`Listening on ${address}:${config.port}`);
    });
  }
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

  wsHandler.broadcast({
    id: randomBytes(8).toString('hex'),
    type: 'command_result' as any,
    commandResult: { command: 'restart', message: 'Gateway restarting…' },
  } as any);

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

  let closed = 0;
  const total = servers.length;
  for (const srv of servers) {
    srv.close(() => {
      closed++;
      if (closed >= total) {
        log.info(' All servers closed.');
        process.exit(0);
      }
    });
  }
  setTimeout(() => {
    log.warn(' Forced exit after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { server, servers, sessionManager, commandHandler, eventStreamer, wsHandler };
