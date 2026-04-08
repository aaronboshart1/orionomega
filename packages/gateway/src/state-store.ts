/**
 * @module state-store
 * In-memory server-side session state store.
 *
 * Maintains an append-only event log and materialized DAG/cost/pending-action
 * state that supplements the SessionManager's JSON persistence.  Designed for:
 *
 * 1. Paginated activity APIs (GET /api/sessions/:id/activity)
 * 2. Full reconnection snapshots (state_snapshot message)
 * 3. Tracking DAG lifecycle state across dispatched→progress→complete
 * 4. Accumulating token/cost counters
 * 5. Managing pending user actions (plan approvals, DAG confirmations)
 */

import { createLogger } from '@orionomega/core';
import type {
  StateEvent,
  StateEventType,
  StateEventQuery,
  PaginatedResult,
  DAGState,
  DAGNodeState,
  SessionCosts,
  PendingAction,
  CodingSessionState,
  StateSnapshot,
} from './state-types.js';

const log = createLogger('state-store');

/** Maximum events to retain per session in the in-memory log. */
const MAX_EVENTS_PER_SESSION = 5000;

/** Maximum DAG states to retain per session. */
const MAX_DAGS_PER_SESSION = 100;

/** Metrics for the in-memory state store. */
export interface StateStoreMetrics {
  /** Total sessions with event logs. */
  sessionCount: number;
  /** Total events across all sessions. */
  totalEvents: number;
  /** Total materialized DAG states. */
  totalDAGs: number;
  /** Total pending user actions. */
  totalPendingActions: number;
  /** Total active coding sessions. */
  totalCodingSessions: number;
  /** Approximate memory usage in bytes. */
  estimatedMemoryBytes: number;
  /** Maximum events allowed per session. */
  maxEventsPerSession: number;
  /** Maximum DAGs allowed per session. */
  maxDAGsPerSession: number;
}

/**
 * In-memory session state store.
 *
 * All data is ephemeral — it lives only for the lifetime of the gateway process.
 * The SessionManager handles durable persistence to JSON files on disk.
 *
 * This store provides:
 * - Append-only event log for paginated activity APIs
 * - Materialized DAG lifecycle state for reconnection snapshots
 * - Cost accumulation for session-level billing
 * - Pending action tracking for plan/DAG confirmations
 *
 * Memory is bounded by per-session caps (MAX_EVENTS_PER_SESSION, MAX_DAGS_PER_SESSION).
 */
/** Maximum event IDs to retain in the deduplication set per session. */
const MAX_EVENT_ID_SET = 1000;

export class ServerSessionStore {
  /** Event log per session. */
  private events: Map<string, StateEvent[]> = new Map();
  /** Recent event IDs per session for deduplication. */
  private seenEventIds: Map<string, Set<string>> = new Map();
  /** Materialized DAG states per workflow. */
  private dags: Map<string, DAGState> = new Map();
  /** Session cost accumulators. */
  private costs: Map<string, SessionCosts> = new Map();
  /** Pending user actions (plans, DAG confirmations). */
  private pendingActions: Map<string, PendingAction> = new Map();
  /** Coding session state per session. */
  private codingSessions: Map<string, CodingSessionState> = new Map();

  constructor() {
    log.info('[state-store:init] ServerSessionStore initialised (in-memory)', {
      maxEventsPerSession: MAX_EVENTS_PER_SESSION,
      maxDAGsPerSession: MAX_DAGS_PER_SESSION,
    });
  }

  // ── Metrics ─────────────────────────────────────────────────────────────────

  /**
   * Return observable metrics for monitoring and health checks.
   */
  getMetrics(): StateStoreMetrics {
    let totalEvents = 0;
    let estimatedMemoryBytes = 0;

    for (const events of this.events.values()) {
      totalEvents += events.length;
      // Rough estimate: ~300 bytes per event
      estimatedMemoryBytes += events.length * 300;
    }

    // Rough estimate: ~2KB per DAG, ~500 per pending action, ~1KB per coding session
    estimatedMemoryBytes += this.dags.size * 2048;
    estimatedMemoryBytes += this.pendingActions.size * 500;
    estimatedMemoryBytes += this.codingSessions.size * 1024;
    estimatedMemoryBytes += this.costs.size * 128;

    return {
      sessionCount: this.events.size,
      totalEvents,
      totalDAGs: this.dags.size,
      totalPendingActions: this.pendingActions.size,
      totalCodingSessions: this.codingSessions.size,
      estimatedMemoryBytes,
      maxEventsPerSession: MAX_EVENTS_PER_SESSION,
      maxDAGsPerSession: MAX_DAGS_PER_SESSION,
    };
  }

  // ── Event Log ─────────────────────────────────────────────────────────────

  /**
   * Append an event to the session event log.
   * Events are capped at MAX_EVENTS_PER_SESSION per session.
   */
  appendEvent(event: StateEvent): void {
    const { sessionId, id } = event;

    // Deduplicate: skip if we've already seen this event ID for this session
    let seen = this.seenEventIds.get(sessionId);
    if (!seen) {
      seen = new Set();
      this.seenEventIds.set(sessionId, seen);
    }
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > MAX_EVENT_ID_SET) {
      const arr = Array.from(seen);
      const trimmed = arr.slice(arr.length - MAX_EVENT_ID_SET);
      this.seenEventIds.set(sessionId, new Set(trimmed));
    }

    let list = this.events.get(sessionId);
    if (!list) {
      list = [];
      this.events.set(sessionId, list);
    }
    list.push(event);
    if (list.length > MAX_EVENTS_PER_SESSION) {
      list.splice(0, list.length - MAX_EVENTS_PER_SESSION);
    }
  }

  /**
   * Query events with filtering and pagination.
   */
  queryEvents(query: StateEventQuery): PaginatedResult<StateEvent> {
    const { sessionId, types, workflowId, since, before, limit: rawLimit, offset: rawOffset } = query;
    const limit = Math.min(Math.max(rawLimit ?? 100, 1), 500);
    const offset = Math.max(rawOffset ?? 0, 0);

    let events = this.events.get(sessionId) ?? [];

    // Apply filters
    if (types && types.length > 0) {
      const typeSet = new Set<StateEventType>(types);
      events = events.filter((e) => typeSet.has(e.type));
    }
    if (workflowId) {
      events = events.filter((e) => e.workflowId === workflowId);
    }
    if (since) {
      events = events.filter((e) => e.timestamp > since);
    }
    if (before) {
      events = events.filter((e) => e.timestamp < before);
    }

    const total = events.length;
    const items = events.slice(offset, offset + limit);

    return {
      items,
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Get event count for a session.
   */
  getEventCount(sessionId: string): number {
    return this.events.get(sessionId)?.length ?? 0;
  }

  // ── DAG State ─────────────────────────────────────────────────────────────

  /**
   * Record a DAG dispatch event — creates a new materialized DAG state.
   */
  recordDAGDispatched(
    sessionId: string,
    workflowId: string,
    dispatch: {
      workflowId: string;
      workflowName: string;
      nodeCount: number;
      estimatedTime: number;
      estimatedCost: number;
      summary: string;
      nodes: Array<{ id: string; label: string; type: string }>;
    },
  ): void {
    const now = new Date().toISOString();
    const dag: DAGState = {
      workflowId,
      workflowName: dispatch.workflowName,
      sessionId,
      status: 'dispatched',
      nodes: dispatch.nodes.map((n) => ({
        ...n,
        status: 'pending' as const,
      })),
      nodeCount: dispatch.nodeCount,
      completedCount: 0,
      summary: dispatch.summary,
      estimatedTime: dispatch.estimatedTime,
      estimatedCost: dispatch.estimatedCost,
      createdAt: now,
      updatedAt: now,
    };
    this.dags.set(workflowId, dag);
    this.pruneDAGs(sessionId);
  }

  /**
   * Record a DAG progress update — updates node status.
   */
  recordDAGProgress(
    workflowId: string,
    progress: {
      nodeId: string;
      nodeLabel: string;
      status: string;
      message?: string;
      progress?: number;
      tool?: Record<string, unknown>;
      workerId?: string;
    },
  ): void {
    const dag = this.dags.get(workflowId);
    if (!dag) return;

    const statusMap: Record<string, DAGNodeState['status']> = {
      started: 'running',
      progress: 'running',
      done: 'done',
      error: 'error',
    };

    dag.nodes = dag.nodes.map((n) =>
      n.id === progress.nodeId
        ? {
            ...n,
            status: statusMap[progress.status] ?? 'running',
            progress: progress.progress,
            message: progress.message,
            tool: progress.tool,
            workerId: progress.workerId,
          }
        : n,
    );

    dag.completedCount = dag.nodes.filter(
      (n) => n.status === 'done' || n.status === 'error' || n.status === 'skipped' || n.status === 'cancelled',
    ).length;

    if (dag.status === 'dispatched') dag.status = 'running';
    dag.updatedAt = new Date().toISOString();
  }

  /**
   * Record a DAG completion — marks all remaining nodes and sets terminal state.
   */
  recordDAGComplete(
    workflowId: string,
    result: {
      workflowId: string;
      status: string;
      summary: string;
      output?: string;
      durationSec?: number;
      workerCount?: number;
      totalCostUsd?: number;
      toolCallCount?: number;
      modelUsage?: Array<Record<string, unknown>>;
      nodeOutputPaths?: Record<string, string[]>;
    },
  ): void {
    const dag = this.dags.get(workflowId);
    if (!dag) return;

    dag.status = result.status === 'error' ? 'error' : result.status === 'stopped' ? 'stopped' : 'complete';
    dag.completedCount = dag.nodeCount;
    dag.result = {
      status: result.status,
      summary: result.summary,
      output: result.output,
      durationSec: result.durationSec,
      workerCount: result.workerCount,
      totalCostUsd: result.totalCostUsd,
      toolCallCount: result.toolCallCount,
      modelUsage: result.modelUsage,
      nodeOutputPaths: result.nodeOutputPaths,
    };
    dag.updatedAt = new Date().toISOString();
  }

  /**
   * Record a DAG confirmation request — puts DAG in 'confirming' state.
   */
  recordDAGConfirm(
    workflowId: string,
    sessionId: string,
    confirm: {
      workflowId: string;
      summary: string;
      reasoning: string;
      estimatedCost: number;
      estimatedTime: number;
      nodes: Array<{ id: string; label: string; type: string }>;
      guardedActions: string[];
    },
  ): void {
    let dag = this.dags.get(workflowId);
    if (!dag) {
      // Create a minimal DAG entry for the confirmation
      const now = new Date().toISOString();
      dag = {
        workflowId,
        workflowName: confirm.summary,
        sessionId,
        status: 'confirming',
        nodes: confirm.nodes.map((n) => ({ ...n, status: 'pending' as const })),
        nodeCount: confirm.nodes.length,
        completedCount: 0,
        summary: confirm.summary,
        estimatedTime: confirm.estimatedTime,
        estimatedCost: confirm.estimatedCost,
        createdAt: now,
        updatedAt: now,
      };
      this.dags.set(workflowId, dag);
    }

    dag.status = 'confirming';
    dag.confirmation = {
      summary: confirm.summary,
      reasoning: confirm.reasoning,
      estimatedCost: confirm.estimatedCost,
      estimatedTime: confirm.estimatedTime,
      nodes: confirm.nodes,
      guardedActions: confirm.guardedActions,
    };
    dag.updatedAt = new Date().toISOString();
  }

  /**
   * Get all DAG states for a session.
   */
  getDAGs(sessionId: string): Record<string, DAGState> {
    const result: Record<string, DAGState> = {};
    for (const [id, dag] of this.dags) {
      if (dag.sessionId === sessionId) {
        result[id] = dag;
      }
    }
    return result;
  }

  /** Prune oldest DAGs if the session exceeds the cap. */
  private pruneDAGs(sessionId: string): void {
    const sessionDAGs: [string, DAGState][] = [];
    for (const [id, dag] of this.dags) {
      if (dag.sessionId === sessionId) {
        sessionDAGs.push([id, dag]);
      }
    }
    if (sessionDAGs.length > MAX_DAGS_PER_SESSION) {
      sessionDAGs.sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
      const toRemove = sessionDAGs.slice(0, sessionDAGs.length - MAX_DAGS_PER_SESSION);
      for (const [id] of toRemove) {
        this.dags.delete(id);
      }
    }
  }

  // ── Costs ─────────────────────────────────────────────────────────────────

  /**
   * Accumulate token/cost counters for a session.
   */
  accumulateCosts(
    sessionId: string,
    delta: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      costUsd?: number;
    },
  ): void {
    let costs = this.costs.get(sessionId);
    if (!costs) {
      costs = {
        sessionId,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        updatedAt: new Date().toISOString(),
      };
      this.costs.set(sessionId, costs);
    }
    costs.inputTokens += delta.inputTokens ?? 0;
    costs.outputTokens += delta.outputTokens ?? 0;
    costs.cacheReadTokens += delta.cacheReadTokens ?? 0;
    costs.cacheCreationTokens += delta.cacheCreationTokens ?? 0;
    costs.costUsd += delta.costUsd ?? 0;
    costs.updatedAt = new Date().toISOString();
  }

  /**
   * Get accumulated costs for a session.
   */
  getCosts(sessionId: string): SessionCosts {
    return this.costs.get(sessionId) ?? {
      sessionId,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  // ── Pending Actions ───────────────────────────────────────────────────────

  /**
   * Add a pending action (plan or DAG confirmation awaiting user approval).
   */
  addPendingAction(action: PendingAction): void {
    this.pendingActions.set(action.id, action);
  }

  /**
   * Resolve a pending action (approve/reject/modify).
   */
  resolvePendingAction(id: string, status: 'approved' | 'rejected' | 'modified'): void {
    const action = this.pendingActions.get(id);
    if (!action) return;
    action.status = status;
    action.resolvedAt = new Date().toISOString();
  }

  /**
   * Get all pending actions for a session.
   */
  getPendingActions(sessionId: string): PendingAction[] {
    return Array.from(this.pendingActions.values()).filter(
      (a) => a.sessionId === sessionId && a.status === 'pending',
    );
  }

  // ── Coding Session ────────────────────────────────────────────────────────

  /**
   * Set the coding session state for a session.
   */
  setCodingSession(sessionId: string, state: CodingSessionState | null): void {
    if (state) {
      this.codingSessions.set(sessionId, state);
    } else {
      this.codingSessions.delete(sessionId);
    }
  }

  /**
   * Get the coding session state for a session.
   */
  getCodingSession(sessionId: string): CodingSessionState | null {
    return this.codingSessions.get(sessionId) ?? null;
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  /**
   * Build a full state snapshot for reconnection.
   *
   * @param sessionId - The session to snapshot.
   * @param sessionData - Core session data from the SessionManager.
   * @returns A complete StateSnapshot for the client.
   */
  getSnapshot(
    sessionId: string,
    sessionData: {
      id: string;
      createdAt: string;
      updatedAt: string;
      agentMode?: string;
      messages: Array<Record<string, unknown>>;
      memoryEvents: Array<Record<string, unknown>>;
      runHistory: Array<Record<string, unknown>>;
      activeWorkflows: string[];
    },
  ): StateSnapshot {
    return {
      session: {
        id: sessionData.id,
        createdAt: sessionData.createdAt,
        updatedAt: sessionData.updatedAt,
        agentMode: sessionData.agentMode ?? 'orchestrate',
        messages: sessionData.messages,
        memoryEvents: sessionData.memoryEvents,
        runHistory: sessionData.runHistory,
        activeWorkflows: sessionData.activeWorkflows,
      },
      dags: this.getDAGs(sessionId),
      costs: this.getCosts(sessionId),
      pendingActions: this.getPendingActions(sessionId),
      codingSession: this.getCodingSession(sessionId),
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Clear all state for a session.
   */
  clearSession(sessionId: string): void {
    this.events.delete(sessionId);
    this.seenEventIds.delete(sessionId);
    this.costs.delete(sessionId);
    this.codingSessions.delete(sessionId);

    // Remove DAGs and pending actions for this session
    for (const [id, dag] of this.dags) {
      if (dag.sessionId === sessionId) this.dags.delete(id);
    }
    for (const [id, action] of this.pendingActions) {
      if (action.sessionId === sessionId) this.pendingActions.delete(id);
    }

    log.info(`State store cleared for session ${sessionId}`);
  }

  /**
   * Graceful shutdown — log final state metrics.
   */
  shutdown(): void {
    const metrics = this.getMetrics();
    log.info('[state-store:shutdown] ServerSessionStore shutting down', {
      sessionCount: metrics.sessionCount,
      totalEvents: metrics.totalEvents,
      totalDAGs: metrics.totalDAGs,
      totalPendingActions: metrics.totalPendingActions,
      estimatedMemoryBytes: metrics.estimatedMemoryBytes,
    });
  }
}
