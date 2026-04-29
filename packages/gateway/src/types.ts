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
  type: 'chat' | 'command' | 'plan_response' | 'subscribe' | 'dag_response' | 'ping' | 'file_read' | 'init' | 'client_state';
  /** Session ID for reconnection — sent with 'init' message. */
  sessionId?: string;
  /** Last event sequence number seen by this client (sent with 'init' for delta sync). */
  lastSeenSeq?: number;
  /** Client UI state to persist (sent with 'client_state' message). */
  clientState?: {
    agentMode?: 'orchestrate' | 'direct' | 'code';
    scrollPosition?: number;
    activePanel?: string;
    lastSeenSeq?: number;
  };
  content?: string;
  command?: string;
  planId?: string;
  action?: 'approve' | 'reject' | 'modify';
  modification?: string;
  workflowId?: string;
  path?: string;
  /** DAG confirmation response fields. */
  dagAction?: 'approve' | 'reject';
  /** ID of the message being replied to (reply-to-message feature). */
  replyToId?: string;
  /** Content of the referenced message (sent by client for reliable context). */
  replyToContent?: string;
  /** Role of the referenced message sender. */
  replyToRole?: string;
  /** DAG/workflow ID associated with the referenced message. */
  replyToDagId?: string;
  /** File attachments sent with the message. */
  attachments?: { name: string; size: number; type: string; data?: string; textContent?: string }[];
  /**
   * Agent routing mode chosen by the user.
   * 'orchestrate' (default) — full planner DAG execution.
   * 'direct' — bypass DAG, respond conversationally even for complex tasks.
   * 'code' — activate coding mode, trigger the coding DAG workflow.
   */
  agentMode?: 'orchestrate' | 'direct' | 'code';
}

// ── Coding Mode Event Types ───────────────────────────────────────────────────

/** All Coding Mode WebSocket event type names. */
export type CodingEventType =
  | 'coding:session:started'
  | 'coding:workflow:started'
  | 'coding:step:started'
  | 'coding:step:progress'
  | 'coding:step:completed'
  | 'coding:step:failed'
  | 'coding:review:started'
  | 'coding:review:completed'
  | 'coding:commit:completed'
  | 'coding:session:completed';

/** Payload for `coding:session:started` — emitted when a coding session begins. */
export interface CodingSessionStartedPayload {
  repoUrl: string;
  branch: string;
  sessionId: string;
}

/** Payload for `coding:workflow:started` — emitted when the DAG workflow starts executing. */
export interface CodingWorkflowStartedPayload {
  workflowId: string;
  /** The DAG template selected for this session. */
  template: string;
  nodeCount: number;
}

/** Payload for `coding:step:started` — emitted when a workflow node begins. */
export interface CodingStepStartedPayload {
  nodeId: string;
  label: string;
  /** The coding role of this node (e.g. 'architect', 'implementer'). */
  type: string;
}

/** Payload for `coding:step:progress` — progress updates during step execution. */
export interface CodingStepProgressPayload {
  nodeId: string;
  message: string;
  /** 0–100 completion percentage. */
  percentage: number;
}

/** Payload for `coding:step:completed` — emitted when a step finishes successfully. */
export interface CodingStepCompletedPayload {
  nodeId: string;
  status: 'success';
  /** Brief prose summary of the step's output. */
  outputSummary: string;
}

/** Payload for `coding:step:failed` — emitted when a step fails. */
export interface CodingStepFailedPayload {
  nodeId: string;
  error: string;
}

/** Payload for `coding:review:started` — emitted when architect review begins. */
export interface CodingReviewStartedPayload {
  /** 1-indexed iteration counter. */
  iteration: number;
}

/** Payload for `coding:review:completed` — emitted with review results. */
export interface CodingReviewCompletedPayload {
  decision: 'approve' | 'reject' | 'request-changes';
  feedback: string;
  metrics?: Record<string, unknown>;
}

/** Payload for `coding:commit:completed` — emitted when code is committed and pushed. */
export interface CodingCommitCompletedPayload {
  commitHash: string;
  branch: string;
}

/** Payload for `coding:session:completed` — emitted when the entire coding session finishes. */
export interface CodingSessionCompletedPayload {
  summary: string;
  filesModified?: string[];
  filesCreated?: string[];
  totalDurationMs?: number;
}

/** Discriminated union of all Coding Mode event payloads, keyed by event type. */
export type CodingEventPayload =
  | { type: 'coding:session:started'; payload: CodingSessionStartedPayload }
  | { type: 'coding:workflow:started'; payload: CodingWorkflowStartedPayload }
  | { type: 'coding:step:started'; payload: CodingStepStartedPayload }
  | { type: 'coding:step:progress'; payload: CodingStepProgressPayload }
  | { type: 'coding:step:completed'; payload: CodingStepCompletedPayload }
  | { type: 'coding:step:failed'; payload: CodingStepFailedPayload }
  | { type: 'coding:review:started'; payload: CodingReviewStartedPayload }
  | { type: 'coding:review:completed'; payload: CodingReviewCompletedPayload }
  | { type: 'coding:commit:completed'; payload: CodingCommitCompletedPayload }
  | { type: 'coding:session:completed'; payload: CodingSessionCompletedPayload };

// ── Server Message ────────────────────────────────────────────────────────────

/** Gateway → Client message envelope. */
export interface ServerMessage {
  id: string;
  type:
    | 'text' | 'thinking' | 'thinking_step' | 'plan' | 'event' | 'status'
    | 'command_result' | 'session_status' | 'error' | 'ack' | 'history'
    | 'dag_dispatched' | 'dag_progress' | 'dag_complete' | 'dag_confirm'
    | 'pong' | 'file_content'
    | 'hindsight_status' | 'memory_event' | 'memory_history'
    | 'coding_event'
    | 'direct_complete'
    | 'session'
    | 'schedule_triggered'
    | 'schedule_execution_complete';
  /** Identifies which workflow this message relates to (events, status updates, plans). */
  workflowId?: string;
  /** Monotonically increasing event sequence number from PersistenceService. */
  seq?: number;
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
  sessionStatus?: { model: string; inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number; maxContextTokens: number; sessionCostUsd?: number };
  hindsightStatus?: { connected: boolean; busy: boolean };
  memoryEvent?: { id: string; timestamp: string; op: string; detail: string; bank?: string; meta?: Record<string, unknown> };
  step?: { id: string; name: string; status: 'pending' | 'active' | 'done'; startedAt?: number; completedAt?: number; elapsedMs?: number; detail?: string };
  error?: string;
  path?: string;
  history?: Array<{ id: string; role: string; content: string; timestamp: string; type?: string; metadata?: Record<string, unknown> }>;
  memoryEvents?: Array<{ id: string; timestamp: string; op: string; detail: string; bank?: string; meta?: Record<string, unknown> }>;

  // New DAG lifecycle fields
  dagDispatch?: {
    workflowId: string;
    workflowName: string;
    nodeCount: number;
    estimatedTime: number;
    estimatedCost: number;
    summary: string;
    nodes: Array<{ id: string; label: string; type: string; dependsOn?: string[] }>;
  };
  dagProgress?: {
    workflowId: string;
    nodeId: string;
    nodeLabel: string;
    status: 'started' | 'progress' | 'done' | 'error';
    message?: string;
    progress?: number;
    layerProgress?: { completed: number; total: number };
    /** Tool call data forwarded from the underlying WorkerEvent */
    tool?: { name: string; action?: string; file?: string; summary?: string };
    /** Worker ID that emitted this progress */
    workerId?: string;
  };
  dagComplete?: {
    workflowId: string;
    status: 'complete' | 'error' | 'stopped';
    summary: string;
    output?: string;
    findings?: string[];
    outputPaths?: string[];
    nodeOutputPaths?: Record<string, string[]>;
    durationSec: number;
    workerCount: number;
    totalCostUsd: number;
    toolCallCount?: number;
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

  /** Coding Mode lifecycle event. Present when `type === 'coding_event'`. */
  codingEvent?: CodingEventPayload;
  /** Full state snapshot for reconnection. Present when `type === 'session'`. */
  snapshot?: Record<string, unknown>;
  /** Session ID. Present when `type === 'session'`. */
  sessionId?: string;
  /** Buffered events that occurred while client was disconnected. Present when `type === 'session'`. */
  bufferedEvents?: unknown[];

  /** Payload when `type === 'schedule_triggered'`. */
  scheduleTriggered?: {
    taskId: string;
    taskName: string;
    executionId: string;
    triggerType: 'cron' | 'manual';
  };

  /** Payload when `type === 'schedule_execution_complete'`. */
  scheduleExecutionComplete?: {
    taskId: string;
    taskName: string;
    executionId: string;
    status: string;
    durationSec?: number;
    error?: string;
  };

  /** Per-run stats for direct (non-DAG) conversation turns. Present when `type === 'direct_complete'`. */
  directComplete?: {
    runId: string;
    model: string;
    durationSec: number;
    modelUsage: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      workerCount: number;
      costUsd: number;
    }>;
    totalCostUsd: number;
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
  bind: string | string[];
  auth: {
    mode: 'api-key' | 'none';
    keyHash?: string;
  };
  cors: {
    origins: string[];
  };
}
