/**
 * @module websocket
 * WebSocket connection handler for the gateway.
 *
 * Architecture overview:
 * ─────────────────────
 * Manages the full client lifecycle: authentication, session binding,
 * message routing, state tracking for reconnection, and graceful disconnect
 * with ping/pong keep-alive.
 *
 * Connection flow:
 * 1. Client connects to /ws with optional ?session= parameter
 * 2. Rate limiting and authentication are applied
 * 3. Client joins the default session (single-user system)
 * 4. Server sends 'ack' with client/session IDs
 * 5. Client sends 'init' message to request full state
 * 6. Server responds with 'session' containing paginated state snapshot
 * 7. Bidirectional message routing begins
 *
 * State tracking:
 * - All broadcast messages are tracked server-side (trackMessageState)
 * - DAG lifecycle, costs, plans, coding sessions are materialized
 * - Events are buffered when no clients are connected
 * - On reconnect, buffered events are drained and delivered
 *
 * Large message optimization:
 * - State snapshots are paginated (only recent messages sent over WS)
 * - Messages >64KB are compressed with zlib before sending
 * - Virtual scrolling hints included for large activity logs
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { auditAuthEvent, readConfig } from '@orionomega/core';
import type { Server as HTTPServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { URL } from 'node:url';
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { resolve as resolvePath, normalize } from 'node:path';

import type { ClientConnection, ClientMessage, ServerMessage, GatewayConfig } from './types.js';
import type { MainAgent } from '@orionomega/core';
import { createLogger } from '@orionomega/core';
import { validateToken } from './auth.js';
import { SessionManager } from './sessions.js';
import type { Message, Session } from './sessions.js';
import { CommandHandler } from './commands.js';
import { EventStreamer } from './events.js';
import { rateLimitWsConnection } from './rate-limit.js';
import { validateClientMessage, sanitizeChatInput } from './ws-schemas.js';
import type { ActivityService } from './activity.js';
import type { ServerSessionStore } from './state-store.js';
import type { PersistenceService } from './persistence.js';

const log = createLogger('websocket');

const PING_INTERVAL_MS = 30_000;

/**
 * Threshold (bytes) above which outgoing WS messages are compressed.
 * Only applies to JSON-serialized messages sent via the `send()` method.
 */
const COMPRESS_THRESHOLD_BYTES = 64 * 1024;

/**
 * Maximum messages to include in WebSocket state snapshots.
 * Older messages are available via the REST paginated activity API.
 */
const SNAPSHOT_MAX_MESSAGES = 200;

/** Regex for validating session IDs to prevent injection attacks. */
const VALID_SESSION_ID_RE = /^[a-z0-9_-]{1,128}$/;

/**
 * Manages WebSocket connections, routing messages between clients and internal handlers.
 */
export class WebSocketHandler {
  private wss: WebSocketServer;
  private connections: Map<string, ClientConnection> = new Map();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private mainAgent: MainAgent | null = null;
  private getHindsightStatus: (() => { connected: boolean; busy: boolean }) | null = null;

  constructor(
    private config: GatewayConfig,
    private sessionManager: SessionManager,
    private commandHandler: CommandHandler,
    private eventStreamer: EventStreamer,
    private activityService?: ActivityService,
    private stateStore?: ServerSessionStore,
    private persistenceService?: PersistenceService,
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });
  }

  setHindsightStatusProvider(fn: () => { connected: boolean; busy: boolean }): void {
    this.getHindsightStatus = fn;
  }

  /**
   * Bind the MainAgent so that chat/command/plan_response messages are
   * routed to it rather than returning placeholder responses.
   *
   * @param agent - The MainAgent instance to wire up.
   */
  setMainAgent(agent: MainAgent): void {
    this.mainAgent = agent;
  }

  private storeSessionMessage(sessionId: string, message: Omit<Message, 'timestamp'>): void {
    this.sessionManager.addMessage(sessionId, {
      ...message,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Attach the WebSocket handler to an HTTP server for upgrade handling.
   * @param server - The Node HTTP server instance.
   */
  attach(server: HTTPServer): void {
    server.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }

      if (!rateLimitWsConnection(req)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.startPingLoop();
  }

  /**
   * Gracefully shut down all connections and clean up timers.
   */
  shutdown(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    for (const conn of this.connections.values()) {
      try {
        conn.ws.close(1001, 'Server shutting down');
      } catch {
        // ignore close errors during shutdown
      }
    }
    this.connections.clear();
    this.wss.close();
  }

  /** Get the number of active connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Handle a new WebSocket connection. */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const token = url.searchParams.get('token') ?? '';
    const clientType = (url.searchParams.get('client') ?? 'web') as 'tui' | 'web';
    const rawSessionId = url.searchParams.get('session') ?? '';

    // Validate session ID format to prevent injection attacks
    if (rawSessionId && !VALID_SESSION_ID_RE.test(rawSessionId)) {
      log.warn('[ws:rejected] Invalid session ID format', {
        from: req.socket.remoteAddress ?? 'unknown',
        sessionIdLength: rawSessionId.length,
      });
      ws.close(4002, 'Invalid session ID format');
      return;
    }

    // Authenticate if auth mode is api-key
    if (this.config.auth.mode === 'api-key' && this.config.auth.keyHash) {
      const result = validateToken(token, this.config.auth.keyHash);
      if (!result.valid) {
        ws.close(4001, 'Authentication failed');
        log.warn('[ws:auth:failed] WebSocket authentication rejected', {
          from: req.socket.remoteAddress ?? 'unknown',
        });
        auditAuthEvent('ws_auth_failed', 'Invalid token', req.socket.remoteAddress ?? 'unknown');
        return;
      }
      auditAuthEvent('ws_auth_success', undefined, req.socket.remoteAddress ?? undefined);
    }

    // Always join the default session — single-user system shares one persistent session
    const session = this.sessionManager.getDefaultSession();

    // Use cryptographically random UUID for client IDs (RFC 4122 v4)
    const clientId = randomUUID();
    const conn: ClientConnection = {
      id: clientId,
      clientType,
      sessionId: session.id,
      connectedAt: new Date().toISOString(),
      eventMode: clientType === 'tui' ? 'throttled' : 'full',
      ws,
      workflowSubscriptions: new Set(),
    };

    this.connections.set(clientId, conn);
    this.sessionManager.addClient(session.id, clientId);
    this.eventStreamer.addClient(conn);

    log.info(`[ws:connected] Client ${clientId} (${clientType}) → session ${session.id}`, {
      sessionId: session.id,
      clientType,
      clientCount: session.clients.size,
      remoteAddress: req.socket.remoteAddress ?? 'unknown',
    });

    this.activityService?.log(session.id, 'client_connect', {
      clientType,
      remoteAddress: req.socket.remoteAddress ?? null,
    }, clientId);

    // Send connection acknowledgement
    this.send(ws, {
      id: randomBytes(8).toString('hex'),
      type: 'ack',
      content: JSON.stringify({
        clientId,
        sessionId: session.id,
        clientType,
      }),
    });

    // State rehydration is deferred to the 'init' message handler (handleInit).
    // The client sends 'init' immediately after connecting and receives a full
    // 'session' response with paginated state, buffered events, and hindsight
    // status. Sending state here would be redundant and doubles bandwidth.

    ws.on('message', (data) => {
      this.handleMessage(clientId, data);
    });

    ws.on('close', (code, _reason) => {
      log.info(`[session:disconnected] Client ${clientId} (code=${code})`, { sessionId: session.id });
      this.handleDisconnect(clientId);
    });

    ws.on('error', (err) => {
      log.error(`WebSocket error for ${clientId}`, { error: err.message });
      this.handleDisconnect(clientId);
    });

    ws.on('pong', () => {
      // Client is alive — nothing else to do
    });
  }

  /** Route an incoming message from a client. */
  private handleMessage(clientId: string, raw: unknown): void {
    const conn = this.connections.get(clientId);
    if (!conn) return;

    let parsed: unknown;
    try {
      const text = typeof raw === 'string' ? raw : raw instanceof Buffer ? raw.toString('utf-8') : String(raw);
      parsed = JSON.parse(text);
    } catch {
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'error',
        error: 'Invalid JSON',
      });
      return;
    }

    const validation = validateClientMessage(parsed);
    if (!validation.success) {
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'error',
        error: validation.error,
      });
      return;
    }

    const msg = validation.data as ClientMessage;

    const session = this.sessionManager.getSession(conn.sessionId);
    if (!session) {
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'error',
        error: 'Session not found',
      });
      return;
    }

    switch (msg.type) {
      case 'chat':
        this.handleChat(conn, session, msg);
        break;
      case 'command':
        this.handleCommand(conn, session, msg);
        break;
      case 'plan_response':
        this.handlePlanResponse(conn, session, msg);
        break;
      case 'dag_response':
        this.handleDAGResponse(conn, msg);
        break;
      case 'subscribe':
        this.handleSubscribe(conn, msg);
        break;
      case 'init':
        this.handleInit(conn, msg);
        break;
      case 'ping':
        this.send(conn.ws, {
          id: msg.id,
          type: 'pong',
        });
        break;
      case 'file_read':
        this.handleFileRead(conn, msg);
        break;
      case 'client_state':
        this.handleClientState(conn, msg);
        break;
      default:
        this.send(conn.ws, {
          id: randomBytes(8).toString('hex'),
          type: 'error',
          error: 'Unknown message type',
        });
    }
  }

  /** Handle a chat message — store it, acknowledge, and route to MainAgent. */
  private handleChat(conn: ClientConnection, session: ReturnType<SessionManager['getSession']> & object, msg: ClientMessage): void {
    const content = sanitizeChatInput(msg.content ?? '');
    log.info(`Chat message from ${conn.id}`, {
      sessionId: conn.sessionId,
      messageId: msg.id,
      contentLength: content.length,
    });

    this.storeSessionMessage(conn.sessionId, {
      id: msg.id,
      role: 'user',
      content,
      type: 'text',
      replyToId: msg.replyToId,
    });

    // Track this message ID so onDAGDispatched can link the DAG back to it
    this.sessionManager.setLastUserMessageId(conn.sessionId, msg.id);

    // Also persist to SQLite state store for full history
    if (this.stateStore) {
      this.stateStore.appendEvent({
        id: msg.id,
        sessionId: conn.sessionId,
        type: 'message',
        timestamp: new Date().toISOString(),
        data: { role: 'user', content, replyToId: msg.replyToId },
      });
    }

    // Acknowledge receipt
    this.send(conn.ws, {
      id: randomBytes(8).toString('hex'),
      type: 'ack',
      content: msg.id,
    });

    let replyContext: { messageId: string; content: string; role: string; dagId?: string; workflowId?: string } | undefined;
    if (msg.replyToId) {
      const sessionMessages = session.messages ?? [];
      const referencedMsg = sessionMessages.find((m: { id: string }) => m.id === msg.replyToId);
      if (referencedMsg) {
        replyContext = {
          messageId: referencedMsg.id,
          content: referencedMsg.content,
          role: referencedMsg.role,
          dagId: referencedMsg.metadata?.dagId as string | undefined,
          workflowId: referencedMsg.metadata?.workflowId as string | undefined,
        };
      } else if (msg.replyToContent) {
        replyContext = {
          messageId: msg.replyToId,
          content: msg.replyToContent,
          role: msg.replyToRole || 'assistant',
          dagId: msg.replyToDagId,
          workflowId: msg.replyToDagId,
        };
      }
    }

    const attachments = Array.isArray(msg.attachments) ? (msg.attachments as { name: string; size: number; type: string; data?: string; textContent?: string }[]) : undefined;

    if (this.mainAgent) {
      const agentMode = (msg.agentMode === 'direct' || msg.agentMode === 'orchestrate' || msg.agentMode === 'code') ? msg.agentMode : undefined;
      if (agentMode) {
        this.sessionManager.updateAgentMode(conn.sessionId, agentMode);
      }
      log.verbose('Routing to MainAgent', { hasReplyContext: !!replyContext, attachmentCount: attachments?.length ?? 0, agentMode });
      this.mainAgent.handleMessage(content, replyContext, attachments, agentMode).catch((err) => {
        log.error('MainAgent.handleMessage error', { error: err instanceof Error ? err.message : String(err) });
        this.send(conn.ws, {
          id: randomBytes(8).toString('hex'),
          type: 'error',
          error: 'Internal agent error',
        });
      });
    } else {
      const fallbackContent = 'Message received. Orchestration engine not yet connected.';
      this.storeSessionMessage(conn.sessionId, {
        id: randomBytes(8).toString('hex'),
        role: 'assistant',
        content: fallbackContent,
        type: 'text',
      });
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'text',
        content: fallbackContent,
        streaming: false,
        done: true,
      });
    }
  }

  /** Handle a slash command — route through MainAgent if available, else fallback. */
  private async handleCommand(conn: ClientConnection, session: ReturnType<SessionManager['getSession']> & object, msg: ClientMessage): Promise<void> {
    const command = msg.command ?? msg.content ?? '';

    if (this.mainAgent) {
      try {
        await this.mainAgent.handleCommand(command, msg.workflowId);
        if (command.trim().toLowerCase() === '/reset') {
          this.sessionManager.resetSession(conn.sessionId);
        }
      } catch (err) {
        log.error('MainAgent.handleCommand error', { error: err instanceof Error ? err.message : String(err) });
        this.send(conn.ws, {
          id: randomBytes(8).toString('hex'),
          type: 'error',
          error: 'Internal command error',
        });
      }
      return;
    }

    // Fallback to gateway-level CommandHandler
    const result = await this.commandHandler.handle(command, session as Session);

    this.storeSessionMessage(conn.sessionId, {
      id: randomBytes(8).toString('hex'),
      role: 'system',
      content: result.message,
      type: 'command-result',
      metadata: { command: result.command, success: result.success },
    });

    this.send(conn.ws, {
      id: randomBytes(8).toString('hex'),
      type: 'command_result',
      commandResult: result,
    });
  }

  /** Handle a plan approval/rejection/modification — route to MainAgent. */
  private handlePlanResponse(conn: ClientConnection, _session: object, msg: ClientMessage): void {
    // Record plan response in state store
    if (this.stateStore && msg.planId && msg.action) {
      this.stateStore.appendEvent({
        id: randomBytes(8).toString('hex'),
        sessionId: conn.sessionId,
        type: 'plan_response',
        timestamp: new Date().toISOString(),
        data: { planId: msg.planId, action: msg.action, modification: msg.modification },
      });
      const resolveStatus = msg.action === 'approve' ? 'approved' as const
        : msg.action === 'reject' ? 'rejected' as const
        : 'modified' as const;
      this.stateStore.resolvePendingAction(msg.planId, resolveStatus);
    }

    if (this.mainAgent && msg.planId && msg.action) {
      this.mainAgent
        .handlePlanResponse(msg.planId, msg.action, msg.modification)
        .catch((err) => {
          log.error('MainAgent.handlePlanResponse error', { error: err instanceof Error ? err.message : String(err) });
          this.send(conn.ws, {
            id: randomBytes(8).toString('hex'),
            type: 'error',
            error: 'Internal plan-response error',
          });
        });
    } else {
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'ack',
        content: `Plan response (${msg.action}) for ${msg.planId} received. Orchestration engine not yet connected.`,
      });
    }
  }

  /** Handle a DAG confirmation response (approve/reject for guarded operations). */
  private handleDAGResponse(conn: ClientConnection, msg: ClientMessage): void {
    // Record DAG response in state store
    if (this.stateStore && msg.workflowId && msg.dagAction) {
      this.stateStore.appendEvent({
        id: randomBytes(8).toString('hex'),
        sessionId: conn.sessionId,
        type: 'dag_response',
        timestamp: new Date().toISOString(),
        data: { workflowId: msg.workflowId, action: msg.dagAction },
        workflowId: msg.workflowId,
      });
      const resolveStatus = msg.dagAction === 'approve' ? 'approved' as const : 'rejected' as const;
      this.stateStore.resolvePendingAction(msg.workflowId, resolveStatus);
    }

    if (this.mainAgent && msg.workflowId && msg.dagAction) {
      this.mainAgent
        .handleDAGResponse(msg.workflowId, msg.dagAction)
        .catch((err) => {
          log.error('MainAgent.handleDAGResponse error', { error: err instanceof Error ? err.message : String(err) });
          this.send(conn.ws, {
            id: randomBytes(8).toString('hex'),
            type: 'error',
            error: 'Internal DAG response error',
          });
        });
    } else {
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'ack',
        content: `DAG response (${msg.dagAction}) received. Agent not connected or missing fields.`,
      });
    }
  }

  /** Handle a workflow subscription request. */
  private handleSubscribe(conn: ClientConnection, msg: ClientMessage): void {
    if (msg.workflowId) {
      // Subscribe to a specific workflow's events
      conn.workflowSubscriptions.add(msg.workflowId);
      log.info(`Client ${conn.id} subscribed to workflow ${msg.workflowId}`);
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'ack',
        content: `Subscribed to workflow ${msg.workflowId}. Events for this workflow will be streamed.`,
      });
    } else {
      // Subscribe to all workflows (clear per-workflow filter)
      conn.workflowSubscriptions.clear();
      log.info(`Client ${conn.id} subscribed to all workflow events`);
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'ack',
        content: 'Subscribed to all workflow events.',
      });
    }
  }

  /**
   * Handle an `init` message — the reconnection protocol entry point.
   *
   * Sends a paginated state snapshot so the client can rehydrate. Only the
   * most recent SNAPSHOT_MAX_MESSAGES are included; the snapshot includes
   * pagination hints so the client can lazy-load older messages via the
   * REST API (GET /api/sessions/:id/activity) for virtual scrolling.
   */
  private handleInit(conn: ClientConnection, msg: ClientMessage): void {
    const rehydrateStart = Date.now();
    const session = this.sessionManager.getSession(conn.sessionId);
    if (!session) {
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'error',
        error: 'Session not found',
      });
      return;
    }

    const hindsightStatus = this.getHindsightStatus ? this.getHindsightStatus() : null;
    const lastSeenSeq = msg.lastSeenSeq ?? 0;

    // Delta sync: if client provides lastSeenSeq > 0, send snapshot + missed events
    if (lastSeenSeq > 0 && this.persistenceService) {
      const snapshot = this.persistenceService.buildSnapshot(conn.sessionId, SNAPSHOT_MAX_MESSAGES);
      const missedEvents = this.persistenceService.getEventsSince(conn.sessionId, lastSeenSeq, 500);

      // Overlay in-memory-only fields
      const inMemSession = this.sessionManager.getSession(conn.sessionId);
      const enrichedSnapshot = snapshot ? {
        ...snapshot,
        hindsightStatus: hindsightStatus ?? null,
        orchestrationEvents: inMemSession?.orchestrationEvents ?? [],
        codingSession: inMemSession?.codingSession ?? null,
        activePlan: inMemSession?.activePlan ?? null,
        pendingConfirmation: inMemSession?.pendingConfirmation ?? null,
      } : undefined;

      this.send(conn.ws, {
        id: msg.id,
        type: 'session',
        sessionId: session.id,
        snapshot: enrichedSnapshot,
        bufferedEvents: missedEvents.map((e) => ({
          seq: e.seq,
          type: e.eventType,
          timestamp: e.timestamp,
          payload: e.payload ? JSON.parse(e.payload) : null,
          workflowId: e.workflowId,
        })),
      });

      const rehydrateMs = Date.now() - rehydrateStart;
      log.info(`[ws:rehydrated:delta] Sent delta sync to ${conn.id}`, {
        sessionId: session.id,
        lastSeenSeq,
        missedEventCount: missedEvents.length,
        rehydrateMs,
      });
    } else {
      // Full sync: no lastSeenSeq or no persistence service
      const snapshot = this.sessionManager.buildSnapshot(
        conn.sessionId,
        hindsightStatus,
        SNAPSHOT_MAX_MESSAGES,
      );

      // Drain any events that were buffered while no clients were connected
      const buffered = this.sessionManager.drainEventBuffer(conn.sessionId);
      const bufferedMessages = buffered.map((b) => b.message);

      this.send(conn.ws, {
        id: msg.id,
        type: 'session',
        sessionId: session.id,
        snapshot: snapshot ?? undefined,
        bufferedEvents: bufferedMessages,
      });

      const rehydrateMs = Date.now() - rehydrateStart;
      log.info(`[ws:rehydrated] Sent state snapshot to ${conn.id}`, {
        sessionId: session.id,
        totalMessages: session.messages.length,
        sentMessages: Math.min(session.messages.length, SNAPSHOT_MAX_MESSAGES),
        bufferedEventCount: bufferedMessages.length,
        dagCount: Object.keys(session.inlineDAGs).length,
        rehydrateMs,
      });
    }

    // Also send standalone hindsight status so the connection indicator updates
    if (hindsightStatus) {
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'hindsight_status',
        hindsightStatus,
      });
    }
  }

  /**
   * Clean up after a client disconnects and summarize session if last client.
   * Handles rapid disconnect/reconnect by checking connection state before cleanup.
   */
  private handleDisconnect(clientId: string): void {
    const conn = this.connections.get(clientId);
    if (!conn) return; // Already cleaned up (e.g. rapid disconnect/reconnect race)

    const sessionId = conn.sessionId;
    const connectionDuration = Date.now() - new Date(conn.connectedAt).getTime();

    this.sessionManager.removeClient(sessionId, clientId);
    this.eventStreamer.removeClient(clientId);
    this.connections.delete(clientId);

    const session = this.sessionManager.getSession(sessionId);
    const remainingClients = session?.clients.size ?? 0;

    log.info(`[ws:disconnected] Client ${clientId} disconnected`, {
      sessionId,
      clientType: conn.clientType,
      connectionDurationMs: connectionDuration,
      remainingClients,
    });

    // When the last client disconnects from a session, summarize to persistent memory
    if (session && remainingClients === 0 && this.mainAgent) {
      log.info('[ws:summarize] Last client disconnected — summarizing session', { sessionId });
      this.mainAgent.summarizeSession().catch((err) => {
        log.warn('[ws:summarize:error] Session summarization failed on disconnect', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private handleFileRead(conn: ClientConnection, msg: ClientMessage): void {
    const filePath = msg.path ?? '';
    try {
      const cfg = readConfig();
      const workspaceDir = cfg.workspace?.path ?? resolvePath('.');
      let resolved = resolvePath(normalize(filePath));

      const wsMarker = '/orionomega/workspace/';
      const markerIdx = resolved.indexOf(wsMarker);
      if (markerIdx !== -1) {
        const relPart = resolved.slice(markerIdx + wsMarker.length);
        const remapped = resolvePath(workspaceDir, relPart);
        if (existsSync(remapped)) {
          resolved = remapped;
        } else if (!existsSync(resolved)) {
          resolved = remapped;
        }
      }

      if (!existsSync(resolved)) {
        this.send(conn.ws, { id: msg.id, type: 'file_content', path: filePath, error: 'File not found' });
        return;
      }

      let realResolved: string;
      try {
        realResolved = realpathSync(resolved);
      } catch {
        this.send(conn.ws, { id: msg.id, type: 'file_content', path: filePath, error: 'File not found' });
        return;
      }

      let realWorkspace: string;
      try {
        realWorkspace = realpathSync(workspaceDir);
      } catch {
        realWorkspace = workspaceDir;
      }
      if (!realResolved.startsWith(realWorkspace + '/') && realResolved !== realWorkspace) {
        this.send(conn.ws, { id: msg.id, type: 'file_content', path: filePath, error: 'Access denied' });
        return;
      }

      const st = statSync(realResolved);
      if (!st.isFile()) {
        this.send(conn.ws, { id: msg.id, type: 'file_content', path: filePath, error: 'Not a file' });
        return;
      }
      if (st.size > 5 * 1024 * 1024) {
        this.send(conn.ws, { id: msg.id, type: 'file_content', path: filePath, error: 'File too large (>5MB)' });
        return;
      }

      const content = readFileSync(realResolved, 'utf-8');
      this.send(conn.ws, { id: msg.id, type: 'file_content', path: realResolved, content });
    } catch (err) {
      log.error('file_read error', { error: err instanceof Error ? err.message : String(err) });
      this.send(conn.ws, { id: msg.id, type: 'file_content', path: filePath, error: 'Failed to read file' });
    }
  }

  /** Handle a client_state message — persist UI state to DB. */
  private handleClientState(conn: ClientConnection, msg: ClientMessage): void {
    if (!this.persistenceService || !msg.clientState) return;

    try {
      this.persistenceService.updateClientState(conn.id, conn.sessionId, {
        agentMode: msg.clientState.agentMode,
        scrollPosition: msg.clientState.scrollPosition,
        activePanel: msg.clientState.activePanel,
        lastSeenSeq: msg.clientState.lastSeenSeq,
      });
    } catch (err) {
      log.warn('[ws:client_state] Failed to persist client state', {
        clientId: conn.id, error: (err as Error).message,
      });
    }

    // Acknowledge
    this.send(conn.ws, {
      id: msg.id,
      type: 'ack',
      content: 'client_state_saved',
    });
  }

  /** Start the ping/pong keep-alive loop. */
  private startPingLoop(): void {
    this.pingTimer = setInterval(() => {
      for (const conn of this.connections.values()) {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.ping();
        }
      }
    }, PING_INTERVAL_MS);
  }

  /**
   * Broadcast a ServerMessage to all connected clients.
   * Also tracks state server-side for reconnection snapshots and buffers
   * events when no clients are connected.
   *
   * @param message - The message to send.
   */
  broadcast(message: ServerMessage): void {
    // Track state server-side for reconnection snapshots
    const defaultSession = this.sessionManager.getDefaultSession();
    if (defaultSession) {
      this.trackMessageState(defaultSession.id, message);
    }

    // If no clients are connected, buffer the event for later delivery
    if (this.connections.size === 0 && defaultSession) {
      this.sessionManager.bufferEvent(defaultSession.id, message);
      return;
    }

    for (const conn of this.connections.values()) {
      this.send(conn.ws, message);
    }
  }

  /**
   * Track state changes from broadcast messages server-side.
   * This enables full state snapshots on reconnection.
   */
  private trackMessageState(sessionId: string, message: ServerMessage): void {
    switch (message.type) {
      case 'dag_dispatched': {
        const d = message.dagDispatch;
        if (!d) break;
        this.sessionManager.upsertInlineDAG(sessionId, {
          dagId: d.workflowId,
          summary: d.summary,
          status: 'dispatched',
          nodes: d.nodes.map((n) => ({ ...n, status: 'pending' as const })),
          completedCount: 0,
          totalCount: d.nodeCount,
          elapsed: 0,
        });
        break;
      }
      case 'dag_progress': {
        const p = message.dagProgress;
        if (!p) break;
        const statusMap: Record<string, 'pending' | 'running' | 'done' | 'error'> = {
          started: 'running', progress: 'running', done: 'done', error: 'error',
        };
        this.sessionManager.updateInlineDAGNode(sessionId, p.workflowId, p.nodeId, {
          status: statusMap[p.status] ?? 'running',
          progress: p.progress,
        });
        break;
      }
      case 'dag_complete': {
        const c = message.dagComplete;
        if (!c) break;
        this.sessionManager.completeInlineDAG(sessionId, c.workflowId, c.output ?? c.summary, c.status === 'error' ? c.summary : undefined, {
          durationSec: c.durationSec,
          workerCount: c.workerCount,
          totalCostUsd: c.totalCostUsd,
          toolCallCount: c.toolCallCount,
          modelUsage: c.modelUsage,
          nodeOutputPaths: c.nodeOutputPaths,
          stopped: c.status === 'stopped',
        });
        break;
      }
      case 'dag_confirm': {
        const cf = message.dagConfirm;
        if (cf) {
          this.sessionManager.setPendingConfirmation(sessionId, cf);
        }
        break;
      }
      case 'plan':
        this.sessionManager.setActivePlan(sessionId, message.plan ?? null);
        break;
      case 'event':
        if (message.event) {
          this.sessionManager.addOrchestrationEvent(sessionId, message.event, message.workflowId);
        }
        break;
      case 'text': {
        // Track session totals from completed text messages with metadata
        const meta = (message as unknown as Record<string, unknown>).metadata as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number } | undefined;
        if (meta && !message.streaming && message.done && (meta.inputTokens || meta.outputTokens)) {
          this.sessionManager.accumulateSessionTotals(sessionId, meta);
        }
        break;
      }
      case 'coding_event': {
        const ce = message.codingEvent;
        if (ce) {
          // Store the raw coding event — the client rebuilds the full session from these
          const session = this.sessionManager.getSession(sessionId);
          if (session) {
            // Track simplified coding session state server-side
            if (ce.type === 'coding:session:started') {
              this.sessionManager.setCodingSession(sessionId, {
                sessionId: ce.payload.sessionId,
                repoUrl: ce.payload.repoUrl,
                branch: ce.payload.branch,
                status: 'running',
                steps: [],
                reviews: [],
                currentIteration: 0,
              });
            } else if (ce.type === 'coding:session:completed') {
              const existing = session.codingSession as Record<string, unknown> | null;
              if (existing) {
                this.sessionManager.setCodingSession(sessionId, {
                  ...existing,
                  status: 'completed',
                });
              }
            }
          }
        }
        break;
      }
      case 'direct_complete': {
        const dc = message.directComplete;
        if (!dc) break;
        // Create an InlineDAG entry like the client does
        this.sessionManager.upsertInlineDAG(sessionId, {
          dagId: dc.runId,
          summary: 'Direct response',
          status: 'dispatched',
          nodes: [],
          completedCount: 0,
          totalCount: 1,
          elapsed: 0,
        });
        this.sessionManager.completeInlineDAG(sessionId, dc.runId, undefined, undefined, {
          durationSec: dc.durationSec,
          workerCount: 1,
          totalCostUsd: dc.totalCostUsd,
          modelUsage: dc.modelUsage,
        });
        break;
      }
      // Other message types don't need server-side state tracking
    }
  }

  /**
   * Safely send a ServerMessage over a WebSocket.
   *
   * Large messages (>COMPRESS_THRESHOLD_BYTES) are compressed using zlib deflate
   * before sending to reduce bandwidth usage on reconnection snapshots and
   * large history payloads. The message is wrapped with a `compressed: true`
   * flag so the client knows to decompress.
   */
  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      if (ws.readyState !== WebSocket.OPEN) {
        log.warn('[ws:send:dropped] Message dropped — WebSocket not open', {
          readyState: ws.readyState,
          messageType: message.type,
        });
        return;
      }

      const json = JSON.stringify(message);

      // Compress large messages to reduce bandwidth (state snapshots, large histories)
      if (json.length > COMPRESS_THRESHOLD_BYTES) {
        try {
          const compressed = deflateSync(Buffer.from(json, 'utf-8'));
          // Send as binary frame with a 4-byte 'ZLIB' magic prefix so client can detect
          const prefix = Buffer.from('ZLIB');
          const frame = Buffer.concat([prefix, compressed]);
          ws.send(frame);
          log.verbose('[ws:send:compressed] Sent compressed message', {
            type: message.type,
            originalSize: json.length,
            compressedSize: frame.length,
            ratio: ((1 - frame.length / json.length) * 100).toFixed(1) + '%',
          });
          return;
        } catch {
          // Compression failed — fall through to uncompressed send
        }
      }

      ws.send(json);
    } catch (err) {
      log.error('[ws:send:error] Send failed', {
        error: err instanceof Error ? err.message : String(err),
        messageType: message.type,
      });
    }
  }
}
