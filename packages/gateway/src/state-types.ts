/**
 * @module state-types
 * Type definitions for the server-side session state store.
 *
 * The state store maintains an in-memory event log and materialized DAG/cost
 * state that supplements the SessionManager's JSON persistence.  It provides
 * the data needed for paginated activity APIs and full reconnection snapshots.
 */

// ── Event Log ─────────────────────────────────────────────────────────────────

/** Discriminated event types stored in the event log. */
export type StateEventType =
  | 'message'
  | 'thinking'
  | 'thinking_step'
  | 'plan'
  | 'plan_response'
  | 'event'
  | 'graph_state'
  | 'session_status'
  | 'direct_complete'
  | 'dag_dispatched'
  | 'dag_progress'
  | 'dag_complete'
  | 'dag_confirm'
  | 'dag_response'
  | 'command_result'
  | 'hindsight_status'
  | 'memory_event'
  | 'coding_event';

/** A single immutable event in the session event log. */
export interface StateEvent {
  id: string;
  sessionId: string;
  type: StateEventType;
  timestamp: string;
  data: Record<string, unknown>;
  workflowId?: string;
}

/** Query parameters for paginated event retrieval. */
export interface StateEventQuery {
  sessionId: string;
  /** Filter to specific event types. */
  types?: StateEventType[];
  /** Filter to a specific workflow. */
  workflowId?: string;
  /** Return events after this timestamp (exclusive). */
  since?: string;
  /** Return events before this timestamp (exclusive). */
  before?: string;
  /** Maximum number of events to return (default 100, max 500). */
  limit?: number;
  /** Number of events to skip (for offset-based pagination). */
  offset?: number;
}

/** Paginated result wrapper. */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ── Materialized DAG State ────────────────────────────────────────────────────

/** Status of a single DAG node. */
export interface DAGNodeState {
  id: string;
  label: string;
  type: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'cancelled';
  progress?: number;
  message?: string;
  tool?: Record<string, unknown>;
  workerId?: string;
}

/** Full materialized state of a DAG execution. */
export interface DAGState {
  workflowId: string;
  workflowName: string;
  sessionId: string;
  status: 'dispatched' | 'running' | 'complete' | 'error' | 'stopped' | 'confirming';
  nodes: DAGNodeState[];
  nodeCount: number;
  completedCount: number;
  summary: string;
  estimatedTime?: number;
  estimatedCost?: number;
  /** Present when status is 'complete' or 'error'. */
  result?: {
    status: string;
    summary: string;
    output?: string;
    durationSec?: number;
    workerCount?: number;
    totalCostUsd?: number;
    toolCallCount?: number;
    modelUsage?: Array<Record<string, unknown>>;
    nodeOutputPaths?: Record<string, string[]>;
  };
  /** Present when status is 'confirming'. */
  confirmation?: {
    summary: string;
    reasoning: string;
    estimatedCost: number;
    estimatedTime: number;
    nodes: Array<{ id: string; label: string; type: string }>;
    guardedActions: string[];
  };
  createdAt: string;
  updatedAt: string;
}

// ── Session Costs ─────────────────────────────────────────────────────────────

/** Cumulative cost/token counters for a session. */
export interface SessionCosts {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  updatedAt: string;
}

// ── Pending Actions ───────────────────────────────────────────────────────────

/** An action awaiting user approval (plan or DAG confirmation). */
export interface PendingAction {
  id: string;
  sessionId: string;
  type: 'plan' | 'dag_confirm';
  data: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'modified';
  createdAt: string;
  resolvedAt?: string;
}

// ── Coding Session ────────────────────────────────────────────────────────────

/** Server-side coding session state. */
export interface CodingSessionState {
  sessionId: string;
  repoUrl?: string;
  branch?: string;
  status: 'running' | 'reviewing' | 'completed' | 'failed';
  steps: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  currentIteration: number;
}

// ── State Snapshot ────────────────────────────────────────────────────────────

/** Full state snapshot sent to clients on connect/reconnect. */
export interface StateSnapshot {
  session: {
    id: string;
    createdAt: string;
    updatedAt: string;
    agentMode: string;
    messages: Array<Record<string, unknown>>;
    memoryEvents: Array<Record<string, unknown>>;
    runHistory: Array<Record<string, unknown>>;
    activeWorkflows: string[];
  };
  dags: Record<string, DAGState>;
  costs: SessionCosts;
  pendingActions: PendingAction[];
  codingSession: CodingSessionState | null;
  /** ISO timestamp of when this snapshot was generated. */
  generatedAt: string;
}
