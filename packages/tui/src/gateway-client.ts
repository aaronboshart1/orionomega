/**
 * @module gateway-client
 * WebSocket client for communicating with the OrionOmega gateway.
 * Plain class — no React, no hooks.
 */

import type { GraphState, WorkerEvent, PlannerOutput } from '@orionomega/core';
import { EventEmitter } from 'node:events';

/** Client → Gateway message envelope. */
export interface ClientMessage {
  id: string;
  type: 'chat' | 'command' | 'plan_response' | 'subscribe';
  content?: string;
  command?: string;
  planId?: string;
  action?: 'approve' | 'reject' | 'modify';
  modification?: string;
  workflowId?: string;
}

/** Gateway → Client message envelope. */
interface ServerMessage {
  id: string;
  type: 'text' | 'thinking' | 'plan' | 'event' | 'status' | 'command_result' | 'session_status' | 'error' | 'ack';
  content?: string;
  streaming?: boolean;
  done?: boolean;
  thinking?: string;
  plan?: unknown;
  event?: unknown;
  graphState?: unknown;
  status?: unknown;
  commandResult?: { command: string; success: boolean; message: string };
  error?: string;
  sessionStatus?: { model: string; inputTokens: number; outputTokens: number; maxContextTokens: number };
}

/** A display-ready message. */
export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  emoji?: string;
  /** Pre-formatted ANSI string — rendered as-is, bypassing markdown. */
  raw?: string;
}

let messageCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}

export interface GatewayClientEvents {
  connected: [];
  disconnected: [];
  message: [DisplayMessage];
  streaming: [DisplayMessage];
  streamingDone: [];
  thinking: [string];
  plan: [PlannerOutput, string];
  planCleared: [];
  graphState: [GraphState];
  event: [WorkerEvent];
  sessionStatus: [{ model: string; inputTokens: number; outputTokens: number; maxContextTokens: number }];
}

/**
 * Manages the WebSocket connection to the OrionOmega gateway.
 * Emits events for each message type — UI components subscribe to these.
 */
export class GatewayClient extends EventEmitter<GatewayClientEvents> {
  private ws: import('ws').WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private streamingAcc: { id: string; content: string } | null = null;
  private seenIds = new Set<string>();
  private disposed = false;

  connected = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    super();
  }

  /** Establish the WebSocket connection with auto-reconnect. */
  async connect(): Promise<void> {
    const { WebSocket: WS } = await import('ws');

    const doConnect = () => {
      if (this.disposed) return;

      const ws = new WS(this.url, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
      });

      ws.on('open', () => {
        if (this.disposed) { ws.close(); return; }
        this.connected = true;
        this.ws = ws;
        this.emit('connected');
        this.pingTimer = setInterval(() => {
          if (ws.readyState === 1) ws.ping();
        }, 30_000);
      });

      ws.on('message', (data: import('ws').RawData) => {
        this.handleMessage(data.toString());
      });

      ws.on('close', () => {
        this.connected = false;
        this.ws = null;
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.emit('disconnected');
        if (!this.disposed) {
          this.reconnectTimer = setTimeout(doConnect, 3_000);
        }
      });

      ws.on('error', () => { /* close event handles reconnect */ });
    };

    doConnect();
  }

  /** Send a raw message to the gateway. */
  send(msg: ClientMessage): void {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Send a user chat message. Returns the display message. */
  sendChat(content: string): DisplayMessage {
    const id = nextId();
    const msg: DisplayMessage = {
      id,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };
    this.send({ id, type: 'chat', content });
    this.emit('message', msg);
    return msg;
  }

  /** Send a slash command. Returns the display message. */
  sendCommand(command: string): DisplayMessage {
    const id = nextId();
    const msg: DisplayMessage = {
      id,
      role: 'system',
      content: `/${command}`,
      timestamp: new Date().toISOString(),
      emoji: '⚡',
    };
    this.send({ id, type: 'command', command });
    this.emit('message', msg);
    return msg;
  }

  /** Respond to a plan prompt. */
  respondToPlan(planId: string, action: 'approve' | 'reject' | 'modify', modification?: string): void {
    const id = nextId();
    this.send({ id, type: 'plan_response', planId, action, modification });
    const label = action === 'approve' ? '✅ Approved' : action === 'reject' ? '❌ Rejected' : '✏️ Modified';
    this.emit('message', {
      id,
      role: 'system',
      content: `Plan ${label.toLowerCase()}${modification ? `: ${modification}` : ''}`,
      timestamp: new Date().toISOString(),
      emoji: label.split(' ')[0],
    });
    this.emit('planCleared');
  }

  /** Disconnect and clean up. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) this.ws.close();
  }

  private handleMessage(raw: string): void {
    let msg: ServerMessage;
    try { msg = JSON.parse(raw) as ServerMessage; } catch { return; }

    switch (msg.type) {
      case 'text': {
        if (msg.streaming && !msg.done) {
          const acc = this.streamingAcc;
          if (acc && acc.id === msg.id) {
            acc.content += msg.content ?? '';
          } else {
            this.streamingAcc = { id: msg.id, content: msg.content ?? '' };
          }
          this.emit('streaming', {
            id: this.streamingAcc!.id,
            role: 'assistant',
            content: this.streamingAcc!.content,
            timestamp: new Date().toISOString(),
          });
        } else if (msg.done) {
          this.emit('thinking', '');
          const acc = this.streamingAcc;
          const finalId = acc?.id ?? msg.id;
          if (!this.seenIds.has(finalId)) {
            this.seenIds.add(finalId);
            const finalContent = msg.content || acc?.content || '';
            if (finalContent) {
              this.emit('message', {
                id: finalId,
                role: 'assistant',
                content: finalContent,
                timestamp: new Date().toISOString(),
              });
            }
          }
          this.streamingAcc = null;
          this.emit('streamingDone');
        } else {
          if (!this.seenIds.has(msg.id)) {
            this.seenIds.add(msg.id);
            this.emit('message', {
              id: msg.id,
              role: 'assistant',
              content: msg.content ?? '',
              timestamp: new Date().toISOString(),
            });
          }
        }
        break;
      }

      case 'thinking':
        this.emit('thinking', msg.done ? '' : (msg.thinking ?? ''));
        break;

      case 'plan':
        this.emit('plan', msg.plan as PlannerOutput, msg.id);
        break;

      case 'event': {
        const event = msg.event as WorkerEvent;
        if (event) {
          this.emit('event', event);
          if (event.type === 'finding' || event.type === 'error' || event.type === 'done') {
            const emojiMap: Record<string, string> = { finding: '💡', error: '❌', done: '✅' };
            this.emit('message', {
              id: nextId(),
              role: 'system',
              content: `[${event.nodeId}] ${event.message ?? 'Complete'}`,
              timestamp: event.timestamp,
              emoji: emojiMap[event.type] ?? '📊',
            });
          } else if (event.type === 'tool_call' && event.tool) {
            this.emit('thinking', `${event.nodeId}: ${event.tool.name}${event.tool.summary ? ' — ' + event.tool.summary : ''}`);
          } else if (event.type === 'status' && event.message) {
            this.emit('thinking', `${event.nodeId}: ${event.message}`);
          }
        }
        if (msg.graphState) this.emit('graphState', msg.graphState as GraphState);
        break;
      }

      case 'status':
        if (msg.graphState) this.emit('graphState', msg.graphState as GraphState);
        break;

      case 'command_result':
        if (msg.commandResult) {
          this.emit('message', {
            id: msg.id,
            role: 'system',
            content: msg.commandResult.message,
            timestamp: new Date().toISOString(),
            emoji: msg.commandResult.success ? '✅' : '❌',
          });
        }
        break;

      case 'error':
        this.emit('message', {
          id: msg.id,
          role: 'system',
          content: msg.error ?? 'Unknown error',
          timestamp: new Date().toISOString(),
          emoji: '⚠️',
        });
        break;

      case "session_status":
        if (msg.sessionStatus) {
          this.emit("sessionStatus", msg.sessionStatus);
        }
        break;

      case 'ack':
        break;
    }
  }
}
