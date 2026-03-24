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
  type: 'chat' | 'command' | 'plan_response' | 'subscribe' | 'dag_response';
  content?: string;
  command?: string;
  planId?: string;
  action?: 'approve' | 'reject' | 'modify';
  modification?: string;
  workflowId?: string;
  /** DAG confirmation response fields. */
  dagAction?: 'approve' | 'reject';
}

/** Gateway → Client message envelope. */
export interface ServerMessage {
  id: string;
  type:
    | 'text' | 'thinking' | 'plan' | 'event' | 'status'
    | 'command_result' | 'session_status' | 'error' | 'ack' | 'history'
    | 'dag_dispatched' | 'dag_progress' | 'dag_complete' | 'dag_confirm'
    | 'hindsight_status';
  /** Identifies which workflow this message relates to (events, status updates, plans). */
  workflowId?: string;
  /** The user message ID this response is answering (set by handleChat). */
  replyTo?: string;
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
  hindsightStatus?: { connected: boolean; busy: boolean };
  error?: string;
  history?: Array<{ id: string; role: string; content: string; timestamp: string }>;

  // New DAG lifecycle fields
  dagDispatch?: {
    workflowId: string;
    workflowName: string;
    nodeCount: number;
    estimatedTime: number;
    estimatedCost: number;
    summary: string;
    nodes: Array<{ id: string; label: string; type: string }>;
  };
  dagProgress?: {
    workflowId: string;
    nodeId: string;
    nodeLabel: string;
    status: 'started' | 'progress' | 'done' | 'error';
    message?: string;
    progress?: number;
    layerProgress?: { completed: number; total: number };
  };
  dagComplete?: {
    workflowId: string;
    status: 'complete' | 'error' | 'stopped';
    summary: string;
    output?: string;
    findings?: string[];
    outputPaths?: string[];
    durationSec: number;
    workerCount: number;
    totalCostUsd: number;
    modelUsage?: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      workerCount: number;
      costUsd: number;
    }>;
  };
  dagConfirm?: {
    workflowId: string;
    summary: string;
    reasoning: string;
    estimatedCost: number;
    estimatedTime: number;
    nodes: Array<{ id: string; label: string; type: string }>;
    guardedActions: string[];
  };
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
