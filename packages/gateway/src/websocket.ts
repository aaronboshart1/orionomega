/**
 * @module websocket
 * WebSocket connection handler for the gateway.
 *
 * Manages client lifecycle: authentication, session binding, message routing,
 * and graceful disconnect with ping/pong keep-alive.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server as HTTPServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';

import type { ClientConnection, ClientMessage, ServerMessage, GatewayConfig } from './types.js';
import type { MainAgent } from '@orionomega/core';
import { createLogger } from '@orionomega/core';
import { validateToken } from './auth.js';
import { SessionManager } from './sessions.js';
import { CommandHandler } from './commands.js';
import { EventStreamer } from './events.js';

const log = createLogger('websocket');

const PING_INTERVAL_MS = 30_000;

/**
 * Manages WebSocket connections, routing messages between clients and internal handlers.
 */
export class WebSocketHandler {
  private wss: WebSocketServer;
  private connections: Map<string, ClientConnection> = new Map();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private mainAgent: MainAgent | null = null;

  constructor(
    private config: GatewayConfig,
    private sessionManager: SessionManager,
    private commandHandler: CommandHandler,
    private eventStreamer: EventStreamer,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
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

  /**
   * Attach the WebSocket handler to an HTTP server for upgrade handling.
   * @param server - The Node HTTP server instance.
   */
  attach(server: HTTPServer): void {
    server.on('upgrade', (req, socket, head) => {
      // Only upgrade requests to /ws
      const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
      if (pathname !== '/ws') {
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
    const sessionId = url.searchParams.get('session') ?? '';

    // Authenticate if auth mode is api-key
    if (this.config.auth.mode === 'api-key' && this.config.auth.keyHash) {
      const result = validateToken(token, this.config.auth.keyHash);
      if (!result.valid) {
        ws.close(4001, 'Authentication failed');
        log.warn('WebSocket auth failed', { from: req.socket.remoteAddress ?? 'unknown' });
        return;
      }
    }

    // Create or join session
    let session = sessionId ? this.sessionManager.getSession(sessionId) : undefined;
    if (!session) {
      session = this.sessionManager.createSession();
    }

    const clientId = randomBytes(12).toString('hex');
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

    log.info(` Client connected: ${clientId} (${clientType}) → session ${session.id}`);

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

    // Send message history if rejoining an existing session
    if (session.messages.length > 0) {
      this.send(ws, {
        id: randomBytes(8).toString('hex'),
        type: 'history' as any,
        history: session.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          type: m.type,
        })),
      } as any);
    }

    ws.on('message', (data) => {
      this.handleMessage(clientId, data);
    });

    ws.on('close', (code, reason) => {
      log.info(` Client disconnected: ${clientId} (code=${code})`);
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

    let msg: ClientMessage;
    try {
      const text = typeof raw === 'string' ? raw : raw instanceof Buffer ? raw.toString('utf-8') : String(raw);
      msg = JSON.parse(text) as ClientMessage;
    } catch {
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'error',
        error: 'Invalid JSON',
      });
      return;
    }

    if (!msg.id || !msg.type) {
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'error',
        error: 'Missing required fields: id, type',
      });
      return;
    }

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
      default:
        this.send(conn.ws, {
          id: randomBytes(8).toString('hex'),
          type: 'error',
          error: `Unknown message type: ${msg.type}`,
        });
    }
  }

  /** Handle a chat message — store it, acknowledge, and route to MainAgent. */
  private handleChat(conn: ClientConnection, session: ReturnType<SessionManager['getSession']> & object, msg: ClientMessage): void {
    let content = msg.content ?? '';

    // ------------------------------------------------------------------
    // Process file attachments
    // Decode each attachment and append its content to the chat message
    // so the MainAgent can read it without needing API changes.
    // ------------------------------------------------------------------
    if (msg.attachments && msg.attachments.length > 0) {
      const fileContexts = msg.attachments.map((file) => {
        const isText =
          file.type.startsWith('text/') ||
          file.type === 'application/json' ||
          file.type === 'application/xml' ||
          file.type === 'application/javascript' ||
          file.type === 'application/typescript';
        const isImage = file.type.startsWith('image/');
        const kb = (file.size / 1024).toFixed(1);

        if (isText) {
          try {
            const decoded = Buffer.from(file.data, 'base64').toString('utf-8');
            return `\n\n<attached_file name="${file.name}" type="${file.type}">\n${decoded}\n</attached_file>`;
          } catch {
            return `\n\n<attached_file name="${file.name}" type="${file.type}" size="${kb} KB" error="could not decode" />`;
          }
        } else if (isImage) {
          // Pass image as a data URL so the agent can reference it
          return `\n\n<attached_image name="${file.name}" type="${file.type}" size="${kb} KB" data="data:${file.type};base64,${file.data}" />`;
        } else {
          return `\n\n<attached_file name="${file.name}" type="${file.type}" size="${kb} KB" note="binary file — content not decoded" />`;
        }
      });
      content = content + fileContexts.join('');
      log.info(`Processed ${msg.attachments.length} attachment(s) for message ${msg.id}`);
    }

    log.verbose(`Chat message from ${conn.id}`, {
      sessionId: conn.sessionId,
      messageId: msg.id,
      contentLength: content.length,
      contentPreview: content.slice(0, 200),
      attachmentCount: msg.attachments?.length ?? 0,
    });

    this.sessionManager.addMessage(conn.sessionId, {
      id: msg.id,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      type: 'text',
    });

    // Acknowledge receipt
    this.send(conn.ws, {
      id: randomBytes(8).toString('hex'),
      type: 'ack',
      content: msg.id,
    });

    // Route to MainAgent if available
    if (this.mainAgent) {
      log.verbose('Routing to MainAgent');
      this.mainAgent.handleMessage(content).catch((err) => {
        log.error('MainAgent.handleMessage error', { error: err instanceof Error ? err.message : String(err) });
        this.send(conn.ws, {
          id: randomBytes(8).toString('hex'),
          type: 'error',
          error: 'Internal agent error',
        });
      });
    } else {
      this.send(conn.ws, {
        id: randomBytes(8).toString('hex'),
        type: 'text',
        content: 'Message received. Orchestration engine not yet connected.',
      });
    }
  }

  /** Handle a slash command — route through MainAgent if available, else fallback. */
  private async handleCommand(conn: ClientConnection, session: ReturnType<SessionManager['getSession']> & object, msg: ClientMessage): Promise<void> {
    const command = msg.command ?? msg.content ?? '';

    if (this.mainAgent) {
      try {
        await this.mainAgent.handleCommand(command);
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
    const result = await this.commandHandler.handle(command, session as any);

    this.sessionManager.addMessage(conn.sessionId, {
      id: randomBytes(8).toString('hex'),
      role: 'system',
      content: result.message,
      timestamp: new Date().toISOString(),
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

  /** Clean up after a client disconnects and summarize session if last client. */
  private handleDisconnect(clientId: string): void {
    const conn = this.connections.get(clientId);
    if (!conn) return;

    const sessionId = conn.sessionId;
    this.sessionManager.removeClient(sessionId, clientId);
    this.eventStreamer.removeClient(clientId);
    this.connections.delete(clientId);

    // When the last client disconnects from a session, summarize to persistent memory
    const session = this.sessionManager.getSession(sessionId);
    if (session && session.clients.size === 0 && this.mainAgent) {
      log.info('Last client disconnected — summarizing session', { sessionId });
      this.mainAgent.summarizeSession().catch((err) => {
        log.warn('Session summarization failed on disconnect', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
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
   *
   * @param message - The message to send.
   */
  broadcast(message: ServerMessage): void {
    for (const conn of this.connections.values()) {
      this.send(conn.ws, message);
    }
  }

  /** Safely send a ServerMessage over a WebSocket. */
  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    } catch (err) {
      log.error('Send error', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
