/**
 * @module types
 * Gateway-specific type definitions for client/server communication.
 */

import type { WebSocket } from 'ws';

/** Represents a connected client (TUI or Web). */
export interface ClientConnection {
  id: string;
  clientType: 'tui' | 'web';
  sessionId: string;
  connectedAt: string;
  eventMode: 'full' | 'throttled';
  ws: WebSocket;
  /**
   * Workflow IDs this client is subscribed to.
   * When non-empty, only events matching one of these IDs (plus non-workflow events) are delivered.
   * When empty (default), all events are delivered.
   */
  workflowSubscriptions: Set<string>;
}

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
export interface ServerMessage {
  id: string;
  type: 'text' | 'thinking' | 'plan' | 'event' | 'status' | 'command_result' | 'session_status' | 'error' | 'ack' | 'history';
  /** Identifies which workflow this message relates to (events, status updates, plans). */
  workflowId?: string;
  content?: string;
  streaming?: boolean;
  done?: boolean;
  thinking?: string;
  plan?: unknown;
  event?: unknown;
  graphState?: unknown;
  status?: SystemStatus;
  commandResult?: CommandResult;
  sessionStatus?: { model: string; inputTokens: number; outputTokens: number; maxContextTokens: number };
  error?: string;
  history?: Array<{ id: string; role: string; content: string; timestamp: string }>;
}

/** Aggregate system health status. */
export interface SystemStatus {
  activeWorkflows: WorkflowSummary[];
  systemHealth: 'ok' | 'degraded' | 'error';
  hindsightConnected: boolean;
  uptime: number;
}

/** Summary of a running workflow. */
export interface WorkflowSummary {
  id: string;
  name: string;
  status: string;
  progress: number;
  workerCount: number;
  startedAt: string;
}

/** Result of a slash command. */
export interface CommandResult {
  command: string;
  success: boolean;
  message: string;
}

/** Gateway configuration (mirrors core config gateway section). */
export interface GatewayConfig {
  port: number;
  bind: string;
  auth: {
    mode: 'api-key' | 'none';
    keyHash?: string;
  };
  cors: {
    origins: string[];
  };
}
