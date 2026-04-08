/**
 * @module server
 * Main gateway server entry point.
 *
 * Creates an HTTP server with REST routes and upgrades WebSocket connections.
 * Uses Node's native `http` module — no frameworks.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve as resolvePath, normalize } from 'node:path';
import { homedir } from 'node:os';
import { spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readConfig, normalizeBindAddresses, MainAgent, CommandFileLoader, createLogger, setGlobalLogLevel, enableFileLogging, discoverModels, clearModelCache, auditApiRequest, setCodingOrchestatorEmitters } from '@orionomega/core';
import type { MainAgentConfig, MainAgentCallbacks, LogLevel, PlannerOutput } from '@orionomega/core';
import { setLogLevel as setHindsightLogLevel } from '@orionomega/hindsight';
import type { GatewayConfig } from './types.js';
import { SessionManager, DEFAULT_SESSION_ID } from './sessions.js';
import { CommandHandler } from './commands.js';
import { EventStreamer } from './events.js';
import { WebSocketHandler } from './websocket.js';
import { ServerSessionStore } from './state-store.js';
import { handleHealth, handleMetrics } from './routes/health.js';
import { handleListSessions, handleGetSession, handleCreateSession, handleDeleteSession, handleGetSessionActivityPaginated } from './routes/sessions.js';
import { handleLogActivity, handleGetActivity } from './routes/activity.js';
import { ActivityService } from './activity.js';
import { handleStatus } from './routes/status.js';
import { handleGetConfig, handlePutConfig } from './routes/config.js';
import { handleGetSkills, handlePutSkillConfig } from './routes/skills.js';
import { rateLimitRest } from './rate-limit.js';
import { setSecurityHeaders } from './security-headers.js';
import { handleStartCodingSession, handleGetCodingSession, handleGetCodingSteps, handleCancelCodingSession } from './routes/coding.js';
import { setCodingEventStreamer, emitCodingSessionStarted, emitCodingWorkflowStarted, emitCodingStepStarted, emitCodingStepProgress, emitCodingStepCompleted, emitCodingStepFailed, emitCodingReviewStarted, emitCodingReviewCompleted, emitCodingCommitCompleted, emitCodingSessionCompleted } from './coding-events.js';
import { FeedService } from './feed/index.js';
import { handleGetFeed, handleGetFeedMessage, handlePostFeedMessage, handleGetFeedCount } from './routes/feed.js';

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
const stateStore = new ServerSessionStore();
const feedService = new FeedService(sessionManager);
const activityService = new ActivityService();
const commandHandler = new CommandHandler(sessionManager);
const eventStreamer = new EventStreamer();
eventStreamer.setSessionManager(sessionManager, DEFAULT_SESSION_ID);
const wsHandler = new WebSocketHandler(config, sessionManager, commandHandler, eventStreamer, activityService, stateStore);

// Wire the EventStreamer into the coding-events emitter module so that
// emitCoding* functions can broadcast to all connected WebSocket clients.
setCodingEventStreamer(eventStreamer);

// Wire the CodingOrchestrator legacy emitters to the gateway coding event system.
// This ensures coding_event messages are broadcast to WebSocket clients in real time.
setCodingOrchestatorEmitters({
  sessionStarted: (p) => emitCodingSessionStarted(p, p.sessionId),
  workflowStarted: (p) => emitCodingWorkflowStarted(p, p.workflowId),
  stepStarted: (p) => emitCodingStepStarted(p),
  stepProgress: (p) => emitCodingStepProgress(p),
  stepCompleted: (p) => emitCodingStepCompleted(p),
  stepFailed: (p) => emitCodingStepFailed(p),
  reviewStarted: (p) => emitCodingReviewStarted(p),
  reviewCompleted: (p) => emitCodingReviewCompleted(p),
  commitCompleted: (p) => emitCodingCommitCompleted(p),
  sessionCompleted: (p) => emitCodingSessionCompleted(p),
});
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

/** Assemble the final streamed text from a buffer and latest chunk. */
function getFullContent(buffer: string, text: string, streaming: boolean): string {
  return streaming ? (buffer + (text || '')) : text;
}

/**
 * Wire the MainAgent into the gateway.
 * Callbacks broadcast ServerMessages to all connected WebSocket clients.
 * Re-reads config fresh so it picks up API keys saved after startup.
 */
async function initMainAgent(): Promise<void> {
  let freshConfig: ReturnType<typeof readConfig>;
  try {
    freshConfig = readConfig();
  } catch {
    log.warn('Cannot read config — MainAgent will not be available');
    return;
  }

  const apiKey = freshConfig.models?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    log.warn(' No Anthropic API key — MainAgent will not be available');
    return;
  }

  if (mainAgent) {
    log.info('MainAgent already initialised — skipping re-init');
    return;
  }

  const agentConfig: MainAgentConfig = {
    model: freshConfig.models?.default || 'claude-sonnet-4-20250514',
    cheapModel: freshConfig.models?.cheap || 'claude-haiku-4-5-20251001',
    apiKey,
    systemPrompt: '',
    workspaceDir: freshConfig.workspace?.path ?? '',
    checkpointDir: freshConfig.workspace?.path
      ? freshConfig.workspace.path + '/checkpoints'
      : '/tmp/orionomega-checkpoints',
    workerTimeout: freshConfig.orchestration?.workerTimeout ?? 300,
    maxRetries: freshConfig.orchestration?.maxRetries ?? 2,
    skillsDir: freshConfig.skills?.directory,
    commandsDir: freshConfig.commands?.directory,
    hindsight: freshConfig.hindsight,
    autoResume: freshConfig.orchestration?.autoResume ?? false,
    codingRepoDir: resolvePath(homedir(), '.orionomega', 'src'),
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

        // Store to state store BEFORE broadcasting
        if (done || !streaming) {
          const fullContent = getFullContent(state.buffer, text, streaming);
          stateStore.appendEvent({
            id: state.textId,
            sessionId: DEFAULT_SESSION_ID,
            type: 'message',
            timestamp: new Date().toISOString(),
            data: { role: 'assistant', content: fullContent, workflowId, background: true },
            workflowId,
          });
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
          const fullContent = getFullContent(state.buffer, text, streaming);
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

      // Store completed messages to state store BEFORE broadcasting
      if (done || !streaming) {
        const fullContent = getFullContent(streamBuffer, text, streaming);
        if (fullContent) {
          stateStore.appendEvent({
            id: currentTextId,
            sessionId: DEFAULT_SESSION_ID,
            type: 'message',
            timestamp: new Date().toISOString(),
            data: { role: 'assistant', content: fullContent },
          });
        }
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
        const fullContent = getFullContent(streamBuffer, text, streaming);

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
      // Store thinking content to state store (only on completion to avoid noise)
      if (done || !streaming) {
        stateStore.appendEvent({
          id: currentThinkingId,
          sessionId: DEFAULT_SESSION_ID,
          type: 'thinking',
          timestamp: new Date().toISOString(),
          data: { thinking: text, streaming, done },
          workflowId,
        });
      }

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
      const evtId = randomBytes(8).toString('hex');

      // Store thinking steps to state store
      stateStore.appendEvent({
        id: evtId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'thinking_step',
        timestamp: new Date().toISOString(),
        data: { step },
        workflowId,
      });

      wsHandler.broadcast({
        id: evtId,
        type: 'thinking_step',
        step,
        workflowId,
      });
    },
    onPlan(plan) {
      // Use graph.id as the message ID so the TUI can send it back
      // in plan_response and the MainAgent can match it to pendingPlanId.
      const graph = (plan as PlannerOutput).graph;
      const planId = graph?.id ?? randomBytes(8).toString('hex');

      // Clone plan for transport — MUST NOT mutate the original.
      // The executor still needs graph.nodes as a Map.
      const transportPlan = JSON.parse(JSON.stringify(plan, (key, value) =>
        value instanceof Map ? Object.fromEntries(value) : value,
      ));

      const now = new Date().toISOString();

      // Store plan to state store BEFORE broadcasting
      stateStore.appendEvent({
        id: planId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'plan',
        timestamp: now,
        data: { plan: transportPlan },
      });

      // Track as pending action awaiting approval
      stateStore.addPendingAction({
        id: planId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'plan',
        data: transportPlan as Record<string, unknown>,
        status: 'pending',
        createdAt: now,
      });

      // Store plan in session history
      const sessionId = DEFAULT_SESSION_ID;
      if (sessionId) {
        sessionManager.addMessage(sessionId, {
          id: planId,
          role: 'assistant',
          content: JSON.stringify(transportPlan),
          timestamp: now,
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

      // Store orchestration events to state store
      stateStore.appendEvent({
        id: randomBytes(8).toString('hex'),
        sessionId: DEFAULT_SESSION_ID,
        type: 'event',
        timestamp: new Date().toISOString(),
        data: event as unknown as Record<string, unknown>,
        workflowId: workerEvent.workflowId,
      });

      // Persist orchestration events to durable session storage
      // (eventStreamer.emit bypasses wsHandler.broadcast/trackMessageState,
      //  so we must persist directly here)
      sessionManager.addOrchestrationEvent(
        DEFAULT_SESSION_ID,
        event,
        workerEvent.workflowId,
      );

      eventStreamer.emit(event, workerEvent.type, workerEvent.workflowId);
    },
    onGraphState(state) {
      const evtId = randomBytes(8).toString('hex');

      // Store graph state snapshots
      stateStore.appendEvent({
        id: evtId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'graph_state',
        timestamp: new Date().toISOString(),
        data: state as unknown as Record<string, unknown>,
        workflowId: (state as { workflowId?: string }).workflowId,
      });

      wsHandler.broadcast({
        id: evtId,
        type: 'status',
        workflowId: state.workflowId,
        graphState: state,
      });
    },
    onSessionStatus(status) {
      const evtId = randomBytes(8).toString("hex");

      // Store session status and accumulate costs
      stateStore.appendEvent({
        id: evtId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'session_status',
        timestamp: new Date().toISOString(),
        data: status as Record<string, unknown>,
      });

      // Accumulate token costs from session status updates
      const s = status as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; sessionCostUsd?: number };
      if (s.inputTokens || s.outputTokens || s.sessionCostUsd) {
        stateStore.accumulateCosts(DEFAULT_SESSION_ID, {
          inputTokens: s.inputTokens ?? 0,
          outputTokens: s.outputTokens ?? 0,
          cacheReadTokens: s.cacheReadTokens ?? 0,
          cacheCreationTokens: s.cacheCreationTokens ?? 0,
          costUsd: s.sessionCostUsd ?? 0,
        });
      }

      wsHandler.broadcast({
        id: evtId,
        type: "session_status",
        sessionStatus: status,
      });
    },
    onDirectComplete(info) {
      const msgId = randomBytes(8).toString("hex");
      const now = new Date().toISOString();

      // Store to state store BEFORE broadcasting
      stateStore.appendEvent({
        id: msgId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'direct_complete',
        timestamp: now,
        data: { directComplete: info },
      });

      // Accumulate costs from direct completion
      if (info.totalCostUsd) {
        stateStore.accumulateCosts(DEFAULT_SESSION_ID, {
          costUsd: info.totalCostUsd,
        });
      }

      wsHandler.broadcast({
        id: msgId,
        type: "direct_complete",
        directComplete: info,
      });
      const sid = DEFAULT_SESSION_ID;
      if (sid) {
        sessionManager.addMessage(sid, {
          id: msgId,
          role: "assistant",
          content: "",
          timestamp: now,
          type: "direct-complete",
          metadata: {
            runId: info.runId,
            directComplete: info,
          },
        });
      }
    },
    onWorkflowStart(workflowId, _workflowName) {
      const sessionId = DEFAULT_SESSION_ID;

      // Store workflow start event
      stateStore.appendEvent({
        id: randomBytes(8).toString('hex'),
        sessionId,
        type: 'event',
        timestamp: new Date().toISOString(),
        data: { type: 'workflow_start', workflowId, workflowName: _workflowName },
        workflowId,
      });

      if (sessionId) sessionManager.addActiveWorkflow(sessionId, workflowId);
    },
    onWorkflowEnd(workflowId) {
      const sessionId = DEFAULT_SESSION_ID;

      // Store workflow end event
      stateStore.appendEvent({
        id: randomBytes(8).toString('hex'),
        sessionId,
        type: 'event',
        timestamp: new Date().toISOString(),
        data: { type: 'workflow_end', workflowId },
        workflowId,
      });

      if (sessionId) sessionManager.removeActiveWorkflow(sessionId, workflowId);
    },
    onCommandResult(result) {
      const evtId = randomBytes(8).toString('hex');

      // Store command results
      stateStore.appendEvent({
        id: evtId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'command_result',
        timestamp: new Date().toISOString(),
        data: { commandResult: result },
      });

      wsHandler.broadcast({
        id: evtId,
        type: 'command_result',
        commandResult: result,
      });
    },
    onHindsightActivity(status) {
      const evtId = randomBytes(8).toString('hex');

      // Store hindsight status changes
      stateStore.appendEvent({
        id: evtId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'hindsight_status',
        timestamp: new Date().toISOString(),
        data: { hindsightStatus: status },
      });

      wsHandler.broadcast({
        id: evtId,
        type: 'hindsight_status',
        hindsightStatus: status,
      });
    },
    onMemoryEvent(event) {
      const evtId = randomBytes(8).toString('hex');

      // Store memory events to state store BEFORE broadcasting
      stateStore.appendEvent({
        id: evtId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'memory_event',
        timestamp: new Date().toISOString(),
        data: { memoryEvent: event },
      });

      wsHandler.broadcast({
        id: evtId,
        type: 'memory_event',
        memoryEvent: event,
      });
      sessionManager.addMemoryEvent(DEFAULT_SESSION_ID, event);
    },

    // DAG lifecycle callbacks — route through EventStreamer for subscription filtering
    onDAGDispatched(dispatch) {
      const msgId = randomBytes(8).toString('hex');
      const now = new Date().toISOString();

      // Store DAG dispatch to state store BEFORE broadcasting
      stateStore.appendEvent({
        id: msgId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'dag_dispatched',
        timestamp: now,
        data: { dagDispatch: dispatch },
        workflowId: dispatch.workflowId,
      });

      // Record materialized DAG state
      stateStore.recordDAGDispatched(DEFAULT_SESSION_ID, dispatch.workflowId, {
        workflowId: dispatch.workflowId,
        workflowName: dispatch.workflowName,
        nodeCount: dispatch.nodeCount,
        estimatedTime: dispatch.estimatedTime,
        estimatedCost: dispatch.estimatedCost,
        summary: dispatch.summary,
        nodes: dispatch.nodes,
      });

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
          timestamp: now,
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
      const evtId = randomBytes(8).toString('hex');

      // Store DAG progress to state store BEFORE broadcasting
      stateStore.appendEvent({
        id: evtId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'dag_progress',
        timestamp: new Date().toISOString(),
        data: { dagProgress: progress },
        workflowId: progress.workflowId,
      });

      // Update materialized DAG node state
      stateStore.recordDAGProgress(progress.workflowId, {
        nodeId: progress.nodeId,
        nodeLabel: progress.nodeLabel,
        status: progress.status,
        message: progress.message,
        progress: progress.progress,
        tool: progress.tool as Record<string, unknown> | undefined,
        workerId: progress.workerId,
      });

      eventStreamer.emitDAGMessage({
        id: evtId,
        type: 'dag_progress',
        workflowId: progress.workflowId,
        dagProgress: progress,
      });
    },
    onDAGComplete(result) {
      const msgId = randomBytes(8).toString('hex');
      const now = new Date().toISOString();

      // Store DAG completion to state store BEFORE broadcasting
      stateStore.appendEvent({
        id: msgId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'dag_complete',
        timestamp: now,
        data: { dagComplete: result },
        workflowId: result.workflowId,
      });

      // Update materialized DAG state
      stateStore.recordDAGComplete(result.workflowId, {
        workflowId: result.workflowId,
        status: result.status,
        summary: result.summary,
        output: result.output,
        durationSec: result.durationSec,
        workerCount: result.workerCount,
        totalCostUsd: result.totalCostUsd,
        toolCallCount: result.toolCallCount,
        modelUsage: result.modelUsage as unknown as Array<Record<string, unknown>> | undefined,
        nodeOutputPaths: result.nodeOutputPaths,
      });

      // Accumulate DAG costs
      if (result.totalCostUsd) {
        stateStore.accumulateCosts(DEFAULT_SESSION_ID, {
          costUsd: result.totalCostUsd,
        });
      }

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
          timestamp: now,
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
      const now = new Date().toISOString();

      // Store DAG confirmation to state store BEFORE broadcasting
      stateStore.appendEvent({
        id: msgId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'dag_confirm',
        timestamp: now,
        data: { dagConfirm: confirm },
        workflowId: confirm.workflowId,
      });

      // Record as materialized DAG state
      stateStore.recordDAGConfirm(confirm.workflowId, DEFAULT_SESSION_ID, {
        workflowId: confirm.workflowId,
        summary: confirm.summary,
        reasoning: confirm.reasoning,
        estimatedCost: confirm.estimatedCost,
        estimatedTime: confirm.estimatedTime,
        nodes: confirm.nodes,
        guardedActions: confirm.guardedActions,
      });

      // Track as pending action awaiting user approval
      stateStore.addPendingAction({
        id: confirm.workflowId,
        sessionId: DEFAULT_SESSION_ID,
        type: 'dag_confirm',
        data: {
          workflowId: confirm.workflowId,
          summary: confirm.summary,
          reasoning: confirm.reasoning,
          guardedActions: confirm.guardedActions,
        },
        status: 'pending',
        createdAt: now,
      });

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
          timestamp: now,
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

/** Probe hindsight health with a 2-second timeout. */
async function checkHindsightHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`${hindsightUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

/** Poll hindsight health every 15 seconds and broadcast changes. */
const hindsightHealthTimer = setInterval(async () => {
  const connected = await checkHindsightHealth();
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
  const connected = await checkHindsightHealth();
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

  // --- Metrics (detailed observability) ---
  if (pathname === '/api/metrics' && method === 'GET') {
    handleMetrics(req, res, startTime, sessionManager, stateStore, wsHandler.connectionCount);
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

  // GET /api/sessions/:id  |  DELETE /api/sessions/:id
  const sessionMatch = pathname.match(/^\/api\/sessions\/([a-z0-9_-]+)$/);
  if (sessionMatch) {
    if (method === 'GET') {
      handleGetSession(req, res, sessionManager, sessionMatch[1]!);
      return;
    }
    if (method === 'DELETE') {
      handleDeleteSession(req, res, sessionManager, stateStore, sessionMatch[1]!);
      return;
    }
  }

  // --- Activity log ---
  // POST /api/sessions/:id/activity — log a custom action
  // GET  /api/sessions/:id/activity — fetch activity history (paginated from state store)
  const activityMatch = pathname.match(/^\/api\/sessions\/([a-z0-9_-]+)\/activity$/);
  if (activityMatch) {
    if (method === 'POST') {
      handleLogActivity(req, res, sessionManager, activityService, activityMatch[1]!).catch((err) => {
        log.error('Activity log route error', { error: err instanceof Error ? err.message : String(err) });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      });
      return;
    }
    if (method === 'GET') {
      // Use paginated state store activity if limit/offset params are present
      const qs = rawUrl.split('?')[1] ?? '';
      const qp = new URLSearchParams(qs);
      if (qp.has('limit') || qp.has('offset') || qp.has('types')) {
        handleGetSessionActivityPaginated(req, res, sessionManager, stateStore, activityMatch[1]!);
      } else {
        handleGetActivity(req, res, sessionManager, activityService, activityMatch[1]!);
      }
      return;
    }
  }
  // --- Conversation Feed ---

  // GET /api/sessions/:id/feed — paginated message feed
  const feedMatch = pathname.match(/^\/api\/sessions\/([a-z0-9_-]+)\/feed$/);
  if (feedMatch && method === 'GET') {
    handleGetFeed(req, res, feedService, feedMatch[1]!);
    return;
  }

  // GET /api/sessions/:id/feed/count — message count
  const feedCountMatch = pathname.match(/^\/api\/sessions\/([a-z0-9_-]+)\/feed\/count$/);
  if (feedCountMatch && method === 'GET') {
    handleGetFeedCount(req, res, feedService, feedCountMatch[1]!);
    return;
  }

  // POST /api/sessions/:id/feed/messages — create a message (idempotent)
  // GET  /api/sessions/:id/feed/messages/:messageId — single message
  const feedMsgMatch = pathname.match(/^\/api\/sessions\/([a-z0-9_-]+)\/feed\/messages(?:\/([a-z0-9_-]+))?$/);
  if (feedMsgMatch) {
    const fSessionId = feedMsgMatch[1]!;
    const fMessageId = feedMsgMatch[2];
    if (method === 'POST' && !fMessageId) {
      handlePostFeedMessage(req, res, feedService, fSessionId).catch((err) => {
        log.error('Feed POST error', { error: err instanceof Error ? err.message : String(err) });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      });
      return;
    }
    if (method === 'GET' && fMessageId) {
      handleGetFeedMessage(req, res, feedService, fSessionId, fMessageId);
      return;
    }
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
    handlePutConfig(req, res, config).then((saved) => {
      if (saved && !mainAgent) {
        initMainAgent().catch((err) => {
          log.error('Failed to init MainAgent after config update', { error: err instanceof Error ? err.message : String(err) });
        });
      }
    }).catch((err) => {
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

  // --- Coding sessions ---

  // POST /api/coding/sessions — start a coding session
  if (pathname === '/api/coding/sessions' && method === 'POST') {
    handleStartCodingSession(req, res, mainAgent).catch((err) => {
      log.error('Coding session start route error', { error: err instanceof Error ? err.message : String(err) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
    return;
  }

  // GET /api/coding/sessions/:id/steps
  const codingStepsMatch = pathname.match(/^\/api\/coding\/sessions\/([a-z0-9_-]+)\/steps$/);
  if (codingStepsMatch && method === 'GET') {
    handleGetCodingSteps(req, res, codingStepsMatch[1]!).catch((err) => {
      log.error('Coding steps route error', { error: err instanceof Error ? err.message : String(err) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
    return;
  }

  // GET /api/coding/sessions/:id  |  DELETE /api/coding/sessions/:id
  const codingSessionMatch = pathname.match(/^\/api\/coding\/sessions\/([a-z0-9_-]+)$/);
  if (codingSessionMatch) {
    if (method === 'GET') {
      handleGetCodingSession(req, res, codingSessionMatch[1]!).catch((err) => {
        log.error('Coding session get route error', { error: err instanceof Error ? err.message : String(err) });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      });
      return;
    }
    if (method === 'DELETE') {
      handleCancelCodingSession(req, res, codingSessionMatch[1]!).catch((err) => {
        log.error('Coding session cancel route error', { error: err instanceof Error ? err.message : String(err) });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      });
      return;
    }
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

  // --- File read ---
  if (pathname === '/api/files' && method === 'GET') {
    const queryStr = rawUrl.split('?')[1] ?? '';
    const params = new URLSearchParams(queryStr);
    const filePath = params.get('path');
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ?path= parameter' }));
      return;
    }
    let resolved = resolvePath(normalize(filePath));
    try {
      const cfg = readConfig();
      const workspaceRoot = realpathSync(cfg.workspace?.path ?? resolvePath('.'));

      const wsMarker = '/orionomega/workspace/';
      const markerIdx = resolved.indexOf(wsMarker);
      if (markerIdx !== -1) {
        const relPart = resolved.slice(markerIdx + wsMarker.length);
        const remapped = resolvePath(workspaceRoot, relPart);
        if (existsSync(remapped)) {
          resolved = remapped;
        } else if (!existsSync(resolved)) {
          resolved = remapped;
        }
      }

      if (!existsSync(resolved)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }
      const realResolved = realpathSync(resolved);
      if (!realResolved.startsWith(workspaceRoot + '/') && realResolved !== workspaceRoot) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid path: outside workspace' }));
        return;
      }
      const st = statSync(realResolved);
      if (!st.isFile()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Path is not a file' }));
        return;
      }
      if (st.size > 5 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large (>5MB)' }));
        return;
      }
      const content = readFileSync(realResolved, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: realResolved, content }));
    } catch (err) {
      log.error('File read error', { error: err instanceof Error ? err.message : String(err) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read file' }));
    }
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
    type: 'command_result',
    commandResult: { command: 'restart', success: true, message: 'Gateway restarting…' },
  });

  clearInterval(hindsightHealthTimer);
  wsHandler.shutdown();
  eventStreamer.destroy();

  const serversClosed = new Promise<void>((resolve) => {
    let closed = 0;
    const total = servers.length;
    if (total === 0) { resolve(); return; }
    for (const srv of servers) {
      srv.close(() => {
        closed++;
        if (closed >= total) {
          log.info(' All servers closed — port released.');
          resolve();
        }
      });
    }
  });

  await Promise.race([
    serversClosed,
    new Promise<void>((resolve) => setTimeout(() => {
      log.warn(' Server close timed out after 3 s — port may still be held.');
      resolve();
    }, 3000)),
  ]);

  if (mainAgent) {
    try {
      await Promise.race([
        mainAgent.summarizeSession(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      log.info('Session summarized during shutdown');
    } catch (err) {
      log.warn('Session summarization failed during shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  sessionManager.shutdown();
  stateStore.shutdown();
  feedService.destroy();

  log.info(' Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { server, servers, sessionManager, stateStore, activityService, commandHandler, eventStreamer, wsHandler };
