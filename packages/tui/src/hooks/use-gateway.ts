/**
 * @module hooks/use-gateway
 * WebSocket connection hook for communicating with the OrionOmega gateway.
 * Manages connection lifecycle, message routing, and reconnection logic.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { GraphState, WorkerEvent, PlannerOutput } from '@orionomega/core';

// Gateway types are inlined here since the gateway package doesn't export them
// from its main entry point. These mirror the definitions in gateway/src/types.ts.

/** Client → Gateway message envelope. */
interface ClientMessage {
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
  type: 'text' | 'thinking' | 'plan' | 'event' | 'status' | 'command_result' | 'error' | 'ack';
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
}

/** A display-ready message for the chat view. */
export interface DisplayMessage {
  /** Unique message identifier. */
  id: string;
  /** Who sent the message. */
  role: 'user' | 'assistant' | 'system';
  /** Message content (may be multi-line). */
  content: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Optional emoji prefix for system messages. */
  emoji?: string;
}

/** Options for the useGateway hook. */
export interface UseGatewayOptions {
  /** Gateway WebSocket URL (e.g. ws://localhost:18790/ws). */
  url: string;
  /** Authentication token. */
  token: string;
  /** Optional session identifier for reconnection. */
  sessionId?: string;
}

/** Return value of the useGateway hook. */
export interface UseGatewayReturn {
  /** Whether the WebSocket is currently connected. */
  connected: boolean;
  /** Accumulated chat messages. */
  messages: DisplayMessage[];
  /** Current streaming thinking content (empty when not thinking). */
  thinking: string;
  /** Current plan awaiting approval, or null. */
  activePlan: PlannerOutput | null;
  /** Active plan's ID for responding. */
  activePlanId: string | null;
  /** Latest orchestration graph state. */
  graphState: GraphState | null;
  /** Last 20 worker events for the status display. */
  recentEvents: WorkerEvent[];
  /** Send a raw ClientMessage. */
  send: (msg: ClientMessage) => void;
  /** Send a chat message. */
  sendChat: (content: string) => void;
  /** Send a slash command. */
  sendCommand: (command: string) => void;
  /** Respond to a plan prompt. */
  respondToPlan: (planId: string, action: 'approve' | 'reject' | 'modify', modification?: string) => void;
}

let messageCounter = 0;

/** Generate a unique message ID. */
function nextId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}

/**
 * Hook that manages the WebSocket connection to the OrionOmega gateway.
 * Handles connect/reconnect, message parsing, and state routing.
 */
export function useGateway(options: UseGatewayOptions): UseGatewayReturn {
  const { url, token, sessionId } = options;

  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [thinking, setThinking] = useState('');
  const [activePlan, setActivePlan] = useState<PlannerOutput | null>(null);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [graphState, setGraphState] = useState<GraphState | null>(null);
  const [recentEvents, setRecentEvents] = useState<WorkerEvent[]>([]);

  const wsRef = useRef<import('ws').WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Send a raw ClientMessage over the WebSocket. */
  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === 1 /* OPEN */) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  /** Send a user chat message. */
  const sendChat = useCallback((content: string) => {
    const id = nextId();
    // Add to local messages immediately
    setMessages(prev => [...prev, {
      id,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    }]);
    send({ id, type: 'chat', content });
  }, [send]);

  /** Send a slash command. */
  const sendCommand = useCallback((command: string) => {
    const id = nextId();
    setMessages(prev => [...prev, {
      id,
      role: 'system',
      content: `/${command}`,
      timestamp: new Date().toISOString(),
      emoji: '⚡',
    }]);
    send({ id, type: 'command', command });
  }, [send]);

  /** Respond to a plan approval prompt. */
  const respondToPlan = useCallback((planId: string, action: 'approve' | 'reject' | 'modify', modification?: string) => {
    const id = nextId();
    send({ id, type: 'plan_response', planId, action, modification });
    setActivePlan(null);
    setActivePlanId(null);

    const actionLabel = action === 'approve' ? '✅ Approved' : action === 'reject' ? '❌ Rejected' : '✏️ Modified';
    setMessages(prev => [...prev, {
      id,
      role: 'system',
      content: `Plan ${actionLabel.toLowerCase()}${modification ? `: ${modification}` : ''}`,
      timestamp: new Date().toISOString(),
      emoji: actionLabel.split(' ')[0],
    }]);
  }, [send]);

  /** Handle an incoming ServerMessage. */
  const handleMessage = useCallback((raw: string) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'text': {
        if (msg.streaming && !msg.done) {
          // Streaming text — update the last assistant message or create one
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant' && last.id === msg.id) {
              return [...prev.slice(0, -1), { ...last, content: last.content + (msg.content ?? '') }];
            }
            return [...prev, {
              id: msg.id,
              role: 'assistant',
              content: msg.content ?? '',
              timestamp: new Date().toISOString(),
            }];
          });
        } else if (msg.done) {
          // Streaming complete — finalise last assistant message
          setThinking('');
          if (msg.content) {
            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && last.id === msg.id) {
                return [...prev.slice(0, -1), { ...last, content: msg.content! }];
              }
              return [...prev, {
                id: msg.id,
                role: 'assistant',
                content: msg.content!,
                timestamp: new Date().toISOString(),
              }];
            });
          }
        } else {
          // Non-streaming text
          setMessages(prev => [...prev, {
            id: msg.id,
            role: 'assistant',
            content: msg.content ?? '',
            timestamp: new Date().toISOString(),
          }]);
        }
        break;
      }

      case 'thinking': {
        setThinking(msg.thinking ?? '');
        break;
      }

      case 'plan': {
        setActivePlan(msg.plan as PlannerOutput);
        setActivePlanId(msg.id);
        break;
      }

      case 'event': {
        const event = msg.event as WorkerEvent;
        if (event) {
          setRecentEvents(prev => [...prev.slice(-19), event]);

          // Show findings and errors in chat
          if (event.type === 'finding' || event.type === 'error' || event.type === 'done') {
            const emoji = event.type === 'finding' ? '💡' : event.type === 'error' ? '❌' : '✅';
            setMessages(prev => [...prev, {
              id: nextId(),
              role: 'system',
              content: `[${event.nodeId}] ${event.message ?? event.error ?? 'Complete'}`,
              timestamp: event.timestamp,
              emoji,
            }]);
          }
        }

        // Update graph state if included
        if (msg.graphState) {
          setGraphState(msg.graphState as GraphState);
        }
        break;
      }

      case 'status': {
        if (msg.graphState) {
          setGraphState(msg.graphState as GraphState);
        }
        break;
      }

      case 'command_result': {
        if (msg.commandResult) {
          const emoji = msg.commandResult.success ? '✅' : '❌';
          setMessages(prev => [...prev, {
            id: msg.id,
            role: 'system',
            content: msg.commandResult!.message,
            timestamp: new Date().toISOString(),
            emoji,
          }]);
        }
        break;
      }

      case 'error': {
        setMessages(prev => [...prev, {
          id: msg.id,
          role: 'system',
          content: msg.error ?? 'Unknown error',
          timestamp: new Date().toISOString(),
          emoji: '⚠️',
        }]);
        break;
      }

      case 'ack':
        // Silent acknowledgment — no UI update needed
        break;
    }
  }, []);

  /** Establish the WebSocket connection with reconnection logic. */
  useEffect(() => {
    let disposed = false;

    function connect() {
      if (disposed) return;

      const wsUrl = sessionId ? `${url}?session=${sessionId}` : url;
      // Dynamic import to work in ESM
      import('ws').then(({ WebSocket: WS }) => {
        if (disposed) return;

        const ws = new WS(wsUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });

        ws.on('open', () => {
          if (disposed) { ws.close(); return; }
          setConnected(true);
          wsRef.current = ws;

          // Set up ping interval
          pingTimer.current = setInterval(() => {
            if (ws.readyState === 1) ws.ping();
          }, 30_000);
        });

        ws.on('message', (data: import('ws').RawData) => {
          handleMessage(data.toString());
        });

        ws.on('close', () => {
          setConnected(false);
          wsRef.current = null;
          if (pingTimer.current) clearInterval(pingTimer.current);

          // Reconnect after 3 seconds
          if (!disposed) {
            reconnectTimer.current = setTimeout(connect, 3_000);
          }
        });

        ws.on('error', () => {
          // Error will trigger close, which handles reconnection
        });
      }).catch(() => {
        // ws import failed — retry
        if (!disposed) {
          reconnectTimer.current = setTimeout(connect, 5_000);
        }
      });
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pingTimer.current) clearInterval(pingTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [url, token, sessionId, handleMessage]);

  return {
    connected,
    messages,
    thinking,
    activePlan,
    activePlanId,
    graphState,
    recentEvents,
    send,
    sendChat,
    sendCommand,
    respondToPlan,
  };
}
