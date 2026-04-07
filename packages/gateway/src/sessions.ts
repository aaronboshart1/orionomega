/**
 * @module sessions
 * Session management with disk persistence for the gateway.
 *
 * Architecture overview:
 * ─────────────────────
 * Sessions are persisted to ~/.orionomega/sessions/{id}.json so that
 * conversations survive gateway restarts — the TUI reconnects with its
 * saved session ID and gets the full history back, like a console session.
 *
 * Persistence strategy:
 * - Debounced writes (configurable, default 500ms) coalesce rapid mutations
 *   into a single atomic JSON write, preventing disk thrashing during streaming.
 * - File permissions are 0o600 (owner-only read/write) for security.
 * - Graceful shutdown flushes all pending writes immediately.
 * - Backup copies are created before each write for crash recovery.
 *
 * Memory management:
 * - Messages capped at MAX_MESSAGES_PER_SESSION (configurable via env).
 * - Memory events, run history, orchestration events all have independent caps.
 * - Periodic cleanup removes stale sessions with no connected clients.
 * - Memory usage is tracked and reported via getMetrics().
 *
 * Configuration (via environment variables):
 * - SESSION_MAX_MESSAGES: Max messages per session (default: 1000)
 * - SESSION_MAX_AGE_HOURS: Hours before session cleanup (default: 24)
 * - SESSION_CLEANUP_INTERVAL_MIN: Cleanup sweep interval in minutes (default: 30)
 * - SESSION_PERSIST_DEBOUNCE_MS: Debounce delay for disk writes (default: 500)
 * - SESSION_MAX_SESSIONS: Maximum concurrent sessions (default: 50)
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@orionomega/core';

const log = createLogger('sessions');

/** Directory where session files are persisted. */
const SESSIONS_DIR = join(homedir(), '.orionomega', 'sessions');

/** The fixed ID for the single persistent default session. */
export const DEFAULT_SESSION_ID = 'default';

// ─── Configurable constants (via environment variables) ─────────────────────

/** Maximum messages per session before oldest are pruned. */
const MAX_MESSAGES_PER_SESSION = parseInt(process.env.SESSION_MAX_MESSAGES ?? '1000', 10);

/** Maximum age (ms) before a session is eligible for archival. */
const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_HOURS ?? '24', 10) * 60 * 60 * 1000;

/** How often to run the cleanup sweep (ms). */
const CLEANUP_INTERVAL_MS = parseInt(process.env.SESSION_CLEANUP_INTERVAL_MIN ?? '30', 10) * 60 * 1000;

/** Debounce delay (ms) for coalescing disk writes. */
const PERSIST_DEBOUNCE_MS = parseInt(process.env.SESSION_PERSIST_DEBOUNCE_MS ?? '500', 10);

/** Maximum concurrent sessions allowed (prevents resource exhaustion). */
const MAX_SESSIONS = parseInt(process.env.SESSION_MAX_SESSIONS ?? '50', 10);

/** A chat message within a session. */
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  type?: 'text' | 'plan' | 'orchestration-update' | 'command-result' | 'event' | 'dag-update' | 'workflow-result' | 'dag-dispatched' | 'dag-complete' | 'dag-confirmation' | 'direct-complete' | 'tool-call';
  metadata?: Record<string, unknown> & {
    /** Model used for this response */
    model?: string;
    /** Input tokens consumed */
    inputTokens?: number;
    /** Output tokens generated */
    outputTokens?: number;
    /** Cache read tokens */
    cacheReadTokens?: number;
    /** Cost in USD */
    costUsd?: number;
  };
  replyToId?: string;
}

/** A memory event stored in the session. */
export interface MemoryEventData {
  id: string;
  timestamp: string;
  op: string;
  detail: string;
  bank?: string;
  meta?: Record<string, unknown>;
}

/** Persisted run summary for completed DAG/direct runs. */
export interface RunSummary {
  runId: string;
  status: 'complete' | 'error' | 'stopped';
  startedAt: string;
  completedAt: string;
  durationSec: number;
  workerCount: number;
  totalCostUsd: number;
  toolCallCount?: number;
  summary?: string;
  error?: string;
  modelUsage?: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
  }>;
}

/** Lightweight DAG node state tracked server-side for reconnection snapshots. */
export interface InlineDAGData {
  dagId: string;
  summary: string;
  status: 'dispatched' | 'running' | 'complete' | 'error' | 'stopped' | 'paused' | 'interrupted';
  nodes: Array<{
    id: string;
    label: string;
    type: string;
    status: 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'cancelled';
    progress?: number;
    dependsOn?: string[];
  }>;
  completedCount: number;
  totalCount: number;
  elapsed: number;
  result?: string;
  error?: string;
  durationSec?: number;
  workerCount?: number;
  totalCostUsd?: number;
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
  nodeOutputPaths?: Record<string, string[]>;
}

/** Cumulative session-level token/cost totals tracked server-side. */
export interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number;
  messageCount: number;
}

/** A buffered ServerMessage stored when no clients are connected. */
export interface BufferedEvent {
  message: unknown;
  timestamp: string;
}

/** Maximum buffered events to retain per session while clients are disconnected. */
const MAX_EVENT_BUFFER = 500;

/** Maximum orchestration events to persist per session. */
const MAX_ORCHESTRATION_EVENTS = 500;

/**
 * Throttle interval for persisting orchestration events.
 * Every ORCH_EVENT_PERSIST_INTERVAL events, a disk persist is scheduled.
 * This bounds data loss to at most this many events on an unclean crash.
 */
const ORCH_EVENT_PERSIST_INTERVAL = 50;

/** Serializable session shape (written to disk). */
interface SessionData {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  activeWorkflows: string[];
  hindsightBank?: string;
  memoryEvents?: MemoryEventData[];
  agentMode?: 'orchestrate' | 'direct' | 'code';
  /** Completed run summaries for review after completion. */
  runHistory?: RunSummary[];
  /** Server-tracked inline DAG states for reconnection snapshots. */
  inlineDAGs?: Record<string, InlineDAGData>;
  /** Orchestration worker events for reconnection snapshots. */
  orchestrationEvents?: Array<{ workflowId?: string; event: unknown }>;
  /** Current coding session state for reconnection snapshots. */
  codingSession?: unknown;
  /** Cumulative session token/cost totals. */
  sessionTotals?: SessionTotals;
  /** Current active plan awaiting user response. */
  activePlan?: unknown;
  /** Current pending DAG confirmation awaiting user response. */
  pendingConfirmation?: unknown;
}

/** Maximum memory events to persist per session. */
const MAX_MEMORY_EVENTS = 200;

/** Maximum run summaries to persist per session. */
const MAX_RUN_HISTORY = 100;

// ─── Session Metrics ────────────────────────────────────────────────────────

/** Observable metrics for the session subsystem. */
export interface SessionMetrics {
  /** Total active sessions in memory. */
  activeSessions: number;
  /** Total connected clients across all sessions. */
  totalClients: number;
  /** Total messages across all sessions. */
  totalMessages: number;
  /** Total pending disk writes in the queue. */
  pendingWrites: number;
  /** Total disk write operations since startup. */
  totalDiskWrites: number;
  /** Total disk write failures since startup. */
  diskWriteFailures: number;
  /** Total disk read failures during startup. */
  diskReadFailures: number;
  /** Approximate memory usage of session data in bytes. */
  estimatedMemoryBytes: number;
  /** Maximum configured sessions. */
  maxSessions: number;
  /** Maximum configured messages per session. */
  maxMessagesPerSession: number;
  /** Session TTL in hours. */
  sessionTtlHours: number;
  /** Persist debounce delay in ms. */
  persistDebounceMs: number;
}

/** A gateway session grouping one or more client connections. */
export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  /** IDs of all currently active workflows for this session. */
  activeWorkflows: Set<string>;
  hindsightBank?: string;
  memoryEvents: MemoryEventData[];
  /** Completed run summaries for post-hoc review. */
  runHistory: RunSummary[];
  clients: Set<string>;
  /** Last agent routing mode chosen by the user — persisted so reconnecting clients restore it. */
  agentMode?: 'orchestrate' | 'direct' | 'code';
  /** Server-tracked inline DAG states for reconnection snapshots. */
  inlineDAGs: Record<string, InlineDAGData>;
  /** Orchestration worker events for reconnection snapshots. */
  orchestrationEvents: Array<{ workflowId?: string; event: unknown }>;
  /** Current coding session state for reconnection snapshots. */
  codingSession: unknown | null;
  /** Cumulative session token/cost totals. */
  sessionTotals: SessionTotals;
  /** Current active plan awaiting user response. */
  activePlan: unknown | null;
  /** Current pending DAG confirmation awaiting user response. */
  pendingConfirmation: unknown | null;
  /** Events buffered while no clients were connected — drained on reconnect. */
  eventBuffer: BufferedEvent[];
}

/**
 * Manages sessions with automatic disk persistence.
 *
 * Each session is saved to a JSON file on every mutation so that
 * conversations survive gateway restarts. Writes are debounced to
 * prevent disk thrashing during high-frequency streaming.
 *
 * Thread safety: This class is designed for single-threaded Node.js.
 * All mutations are synchronous and writes are serialized via the
 * debounce queue.
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private writeQueue: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Counter: total successful disk writes since startup. */
  private _totalDiskWrites = 0;
  /** Counter: total failed disk writes since startup. */
  private _diskWriteFailures = 0;
  /** Counter: orchestration events since last persist, per session. */
  private _orchEventCountSinceFlush: Map<string, number> = new Map();
  /** Counter: total failed disk reads during startup load. */
  private _diskReadFailures = 0;

  constructor() {
    this.ensureSessionsDir();
    this.loadAllFromDisk();
    this.ensureDefaultSession();
    this.startCleanupLoop();

    log.info('[session:config] Session manager initialized', {
      maxMessages: MAX_MESSAGES_PER_SESSION,
      maxAgeSec: SESSION_MAX_AGE_MS / 1000,
      cleanupIntervalSec: CLEANUP_INTERVAL_MS / 1000,
      persistDebounceMs: PERSIST_DEBOUNCE_MS,
      maxSessions: MAX_SESSIONS,
    });
  }

  // ─── Metrics & Observability ────────────────────────────────

  /**
   * Return observable metrics for monitoring and health checks.
   * Provides insight into session count, memory usage, write queue depth, etc.
   */
  getMetrics(): SessionMetrics {
    let totalClients = 0;
    let totalMessages = 0;
    let estimatedMemoryBytes = 0;

    for (const session of this.sessions.values()) {
      totalClients += session.clients.size;
      totalMessages += session.messages.length;
      // Rough estimate: ~500 bytes per message, ~200 per memory event, ~1KB per DAG
      estimatedMemoryBytes += session.messages.length * 500;
      estimatedMemoryBytes += session.memoryEvents.length * 200;
      estimatedMemoryBytes += Object.keys(session.inlineDAGs).length * 1024;
      estimatedMemoryBytes += session.orchestrationEvents.length * 300;
      estimatedMemoryBytes += session.eventBuffer.length * 500;
    }

    return {
      activeSessions: this.sessions.size,
      totalClients,
      totalMessages,
      pendingWrites: this.writeQueue.size,
      totalDiskWrites: this._totalDiskWrites,
      diskWriteFailures: this._diskWriteFailures,
      diskReadFailures: this._diskReadFailures,
      estimatedMemoryBytes,
      maxSessions: MAX_SESSIONS,
      maxMessagesPerSession: MAX_MESSAGES_PER_SESSION,
      sessionTtlHours: SESSION_MAX_AGE_MS / (60 * 60 * 1000),
      persistDebounceMs: PERSIST_DEBOUNCE_MS,
    };
  }

  /**
   * Generate a cryptographically random session ID.
   * Uses crypto.randomUUID() for RFC 4122 v4 UUIDs.
   */
  static generateSessionId(): string {
    return randomUUID();
  }

  // ─── Session CRUD ───────────────────────────────────────────

  /**
   * Return the persistent default session.
   * All clients share this single session.
   */
  getDefaultSession(): Session {
    return this.sessions.get(DEFAULT_SESSION_ID)!;
  }

  /**
   * Create a new session and return it.
   * In single-user mode this always returns the default session.
   * Enforces MAX_SESSIONS limit to prevent resource exhaustion.
   * @returns The default session.
   */
  createSession(): Session {
    // Enforce session cap — prevent resource exhaustion from runaway session creation
    if (this.sessions.size >= MAX_SESSIONS) {
      log.warn('[session:limit] Max sessions reached, returning default session', {
        current: this.sessions.size,
        max: MAX_SESSIONS,
      });
    }
    return this.getDefaultSession();
  }

  /**
   * Retrieve a session by ID.
   * @param id - Session identifier.
   * @returns The session, or `undefined` if not found.
   */
  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * List all active sessions.
   * @returns Array of sessions.
   */
  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Append a message to a session's history.
   * Automatically prunes oldest messages if the cap is exceeded.
   * @param sessionId - Target session ID.
   * @param message - The message to add.
   */
  addMessage(sessionId: string, message: Message): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.pushToArrayWithCap(session.messages, message, MAX_MESSAGES_PER_SESSION);
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
  }

  /**
   * Append a memory event to a session's event log.
   * Automatically prunes oldest events if the cap is exceeded.
   * @param sessionId - Target session ID.
   * @param event - The memory event to add.
   */
  addMemoryEvent(sessionId: string, event: MemoryEventData): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.pushToArrayWithCap(session.memoryEvents, event, MAX_MEMORY_EVENTS);
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
  }

  /**
   * Record a completed run summary for a session.
   * Enables post-hoc review of run details (status, cost, duration, errors).
   * @param sessionId - Target session ID.
   * @param run - The run summary to persist.
   */
  addRunSummary(sessionId: string, run: RunSummary): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.pushToArrayWithCap(session.runHistory, run, MAX_RUN_HISTORY);
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
  }

  private pushToArrayWithCap<T>(arr: T[], item: T, cap: number): void {
    arr.push(item);
    if (arr.length > cap) {
      arr.splice(0, arr.length - cap);
    }
  }

  /**
   * Register a client connection with a session.
   * @param sessionId - Target session ID.
   * @param clientId - Client connection identifier.
   */
  addClient(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.clients.add(clientId);
    session.updatedAt = new Date().toISOString();
  }

  /**
   * Remove a client connection from a session.
   * @param sessionId - Target session ID.
   * @param clientId - Client connection identifier.
   */
  removeClient(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.clients.delete(clientId);
    session.updatedAt = new Date().toISOString();
  }

  /**
   * Register a workflow as active for a session.
   * @param sessionId - Target session ID.
   * @param workflowId - The workflow identifier.
   */
  addActiveWorkflow(sessionId: string, workflowId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activeWorkflows.add(workflowId);
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
  }

  /**
   * Remove a workflow from a session's active set (e.g. on completion).
   * @param sessionId - Target session ID.
   * @param workflowId - The workflow identifier.
   */
  removeActiveWorkflow(sessionId: string, workflowId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activeWorkflows.delete(workflowId);
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
  }

  /**
   * Persist the user's agent routing mode choice for a session.
   * Called each time the frontend sends a chat message with an explicit agentMode.
   * @param sessionId - Target session ID.
   * @param mode - 'orchestrate' | 'direct' | 'code'
   */
  updateAgentMode(sessionId: string, mode: 'orchestrate' | 'direct' | 'code'): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.agentMode === mode) return; // no-op if unchanged
    session.agentMode = mode;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
  }

  // ─── Extended state tracking for reconnection snapshots ──────

  /**
   * Upsert an inline DAG entry (tracked server-side for reconnection).
   */
  upsertInlineDAG(sessionId: string, dag: InlineDAGData): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.inlineDAGs[dag.dagId] = dag;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
  }

  /**
   * Update a single node within an inline DAG.
   */
  updateInlineDAGNode(
    sessionId: string,
    dagId: string,
    nodeId: string,
    update: Partial<InlineDAGData['nodes'][0]>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const dag = session.inlineDAGs[dagId];
    if (!dag) return;
    dag.nodes = dag.nodes.map((n) => (n.id === nodeId ? { ...n, ...update } : n));
    dag.completedCount = dag.nodes.filter(
      (n) => n.status === 'done' || n.status === 'error' || n.status === 'skipped' || n.status === 'cancelled',
    ).length;
    if (dag.status === 'dispatched') dag.status = 'running';
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
  }

  /**
   * Mark an inline DAG as complete/error/stopped.
   */
  completeInlineDAG(
    sessionId: string,
    dagId: string,
    result?: string,
    error?: string,
    stats?: {
      durationSec?: number;
      workerCount?: number;
      totalCostUsd?: number;
      toolCallCount?: number;
      modelUsage?: InlineDAGData['modelUsage'];
      nodeOutputPaths?: Record<string, string[]>;
      stopped?: boolean;
    },
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const dag = session.inlineDAGs[dagId];
    if (!dag) return;
    dag.status = error ? 'error' : stats?.stopped ? 'stopped' : 'complete';
    dag.result = result;
    dag.error = error;
    dag.completedCount = dag.totalCount;
    if (stats) {
      dag.durationSec = stats.durationSec;
      dag.workerCount = stats.workerCount;
      dag.totalCostUsd = stats.totalCostUsd;
      dag.toolCallCount = stats.toolCallCount;
      dag.modelUsage = stats.modelUsage;
      dag.nodeOutputPaths = stats.nodeOutputPaths;
    }
    session.updatedAt = new Date().toISOString();
    // Immediate persist on DAG completion: this is the terminal state for a workflow,
    // so we bypass debounce to ensure orchestration events + final stats are on disk.
    this._orchEventCountSinceFlush.set(sessionId, 0);
    const existingTimer = this.writeQueue.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    this.writeQueue.delete(sessionId);
    this.persistToDisk(sessionId);
  }

  /**
   * Add an orchestration worker event for reconnection replay.
   *
   * Events are high-frequency, so we don't persist on every call.
   * Instead we throttle: persist every ORCH_EVENT_PERSIST_INTERVAL events.
   * This bounds data loss on crash to at most ORCH_EVENT_PERSIST_INTERVAL events.
   * A final flush also happens on DAG completion and graceful shutdown.
   */
  addOrchestrationEvent(sessionId: string, event: unknown, workflowId?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.pushToArrayWithCap(session.orchestrationEvents, { workflowId, event }, MAX_ORCHESTRATION_EVENTS);
    session.updatedAt = new Date().toISOString();

    // Throttled persist: flush every N events to bound crash data loss
    const count = (this._orchEventCountSinceFlush.get(sessionId) ?? 0) + 1;
    if (count >= ORCH_EVENT_PERSIST_INTERVAL) {
      this._orchEventCountSinceFlush.set(sessionId, 0);
      this.schedulePersist(sessionId);
    } else {
      this._orchEventCountSinceFlush.set(sessionId, count);
    }
  }

  /**
   * Update the coding session state.
   */
  setCodingSession(sessionId: string, codingSession: unknown | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.codingSession = codingSession;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
  }

  /**
   * Accumulate token/cost totals for a session.
   */
  accumulateSessionTotals(sessionId: string, meta: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number }): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.sessionTotals.inputTokens += meta.inputTokens ?? 0;
    session.sessionTotals.outputTokens += meta.outputTokens ?? 0;
    session.sessionTotals.cacheReadTokens += meta.cacheReadTokens ?? 0;
    session.sessionTotals.totalCostUsd += meta.costUsd ?? 0;
    session.sessionTotals.messageCount += 1;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
  }

  /**
   * Store the current active plan.
   */
  setActivePlan(sessionId: string, plan: unknown | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activePlan = plan;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
  }

  /**
   * Store the current pending DAG confirmation.
   */
  setPendingConfirmation(sessionId: string, confirmation: unknown | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingConfirmation = confirmation;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
  }

  /**
   * Buffer a ServerMessage when no clients are connected.
   * These will be drained and delivered on reconnect.
   */
  bufferEvent(sessionId: string, message: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.pushToArrayWithCap(
      session.eventBuffer,
      { message, timestamp: new Date().toISOString() },
      MAX_EVENT_BUFFER,
    );
  }

  /**
   * Drain and return all buffered events, clearing the buffer.
   */
  drainEventBuffer(sessionId: string): BufferedEvent[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const events = session.eventBuffer.splice(0);
    return events;
  }

  /**
   * Check whether a session currently has any connected clients.
   */
  hasConnectedClients(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session ? session.clients.size > 0 : false;
  }

  /**
   * Reset a session: clear messages, memory events, and active workflows,
   * then persist the cleared state to disk.
   * @param sessionId - Target session ID.
   */
  resetSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.length = 0;
    session.memoryEvents.length = 0;
    session.activeWorkflows.clear();
    session.inlineDAGs = {};
    session.orchestrationEvents.length = 0;
    session.codingSession = null;
    session.sessionTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, messageCount: 0 };
    session.activePlan = null;
    session.pendingConfirmation = null;
    session.eventBuffer.length = 0;
    session.updatedAt = new Date().toISOString();
    this.schedulePersist(sessionId);
    log.info(`Session reset: ${sessionId}`);
  }

  /**
   * Delete a session entirely (from memory and disk).
   * The default session cannot be deleted — use /reset to clear it instead.
   * @param id - Session identifier.
   */
  deleteSession(id: string): void {
    if (id === DEFAULT_SESSION_ID) {
      log.warn('Cannot delete the default session — use /reset to clear it');
      return;
    }
    this.sessions.delete(id);
    this.deleteFromDisk(id);
    log.info(`Session deleted: ${id}`);
  }

  /**
   * Return all messages and memory events that occurred strictly after `since`.
   * Used by the /activity endpoint to let reconnecting clients fetch only new data.
   * @param sessionId - Target session ID.
   * @param since - ISO-8601 timestamp; items with timestamps > this value are returned.
   * @returns Object with filtered messages and memory events, or null if session not found.
   */
  getActivitySince(
    sessionId: string,
    since: Date,
  ): { messages: Message[]; memoryEvents: MemoryEventData[]; activeWorkflows: string[] } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const sinceMs = since.getTime();
    return {
      messages: session.messages.filter((m) => new Date(m.timestamp).getTime() > sinceMs),
      memoryEvents: session.memoryEvents.filter((e) => new Date(e.timestamp).getTime() > sinceMs),
      activeWorkflows: [...session.activeWorkflows],
    };
  }

  /**
   * Serialize a session for REST responses (converts Set to array).
   * @param session - The session to serialize.
   * @returns A JSON-safe representation.
   */
  toJSON(session: Session): Record<string, unknown> {
    return {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages,
      activeWorkflows: [...session.activeWorkflows],
      hindsightBank: session.hindsightBank ?? null,
      memoryEvents: session.memoryEvents,
      agentMode: session.agentMode ?? null,
      clientCount: session.clients.size,
      inlineDAGs: session.inlineDAGs,
      sessionTotals: session.sessionTotals,
    };
  }

  /**
   * Build a full state snapshot for reconnection.
   * Contains everything a client needs to fully rehydrate its UI.
   *
   * For large histories (>200 messages), includes pagination hints so
   * the client can request older messages on demand via the REST API
   * rather than receiving the entire history over WebSocket.
   *
   * @param sessionId - Target session ID.
   * @param hindsightStatus - Current Hindsight service status.
   * @param maxMessages - Maximum messages to include (default: 200).
   *   Older messages are available via GET /api/sessions/:id/activity.
   */
  buildSnapshot(
    sessionId: string,
    hindsightStatus?: { connected: boolean; busy: boolean } | null,
    maxMessages = 200,
  ): Record<string, unknown> | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Send only the most recent messages; provide pagination hints for the rest.
    // This prevents sending a potentially huge message history over WebSocket
    // on reconnect — the client can lazy-load older messages via REST.
    const totalMessages = session.messages.length;
    const truncated = totalMessages > maxMessages;
    const recentMessages = truncated
      ? session.messages.slice(-maxMessages)
      : session.messages;

    return {
      messages: recentMessages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        type: m.type,
        metadata: m.metadata,
      })),
      memoryEvents: session.memoryEvents,
      inlineDAGs: session.inlineDAGs,
      orchestrationEvents: session.orchestrationEvents,
      codingSession: session.codingSession,
      sessionTotals: session.sessionTotals,
      activePlan: session.activePlan,
      pendingConfirmation: session.pendingConfirmation,
      agentMode: session.agentMode ?? 'orchestrate',
      activeWorkflows: [...session.activeWorkflows],
      hindsightStatus: hindsightStatus ?? null,
      runHistory: session.runHistory,
      // Pagination hints for virtual scrolling of large histories
      pagination: {
        totalMessages,
        includedMessages: recentMessages.length,
        hasOlderMessages: truncated,
        oldestIncludedTimestamp: recentMessages[0]?.timestamp ?? null,
      },
    };
  }

  /**
   * Flush all pending writes and stop the cleanup timer.
   * Call this during graceful shutdown.
   */
  shutdown(): void {
    // Flush all pending debounced writes immediately
    for (const [sessionId, timer] of this.writeQueue) {
      clearTimeout(timer);
      this.persistToDisk(sessionId);
    }
    this.writeQueue.clear();

    // Also persist any sessions with un-flushed orchestration events
    // (below the throttle threshold, so not yet in the write queue)
    for (const [sessionId, count] of this._orchEventCountSinceFlush) {
      if (count > 0 && !this.writeQueue.has(sessionId)) {
        this.persistToDisk(sessionId);
      }
    }
    this._orchEventCountSinceFlush.clear();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    log.info('SessionManager shut down — all sessions persisted');
  }

  // ─── Disk Persistence ───────────────────────────────────────

  /** Ensure the sessions directory exists. */
  private ensureSessionsDir(): void {
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true });
    } catch (err) {
      log.error('Failed to create sessions directory', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private static readonly VALID_SESSION_ID = /^[a-z0-9_-]{1,128}$/;

  /** Get the file path for a session. Validates the ID to prevent path traversal. */
  private sessionFilePath(id: string): string {
    if (!SessionManager.VALID_SESSION_ID.test(id)) {
      throw new Error(`Invalid session ID: must be 1–128 characters matching [a-z0-9_-]`);
    }
    return join(SESSIONS_DIR, `${id}.json`);
  }

  /**
   * Schedule a debounced write to disk for a session.
   * Coalesces rapid mutations (e.g. streaming) into a single write
   * with a configurable delay (PERSIST_DEBOUNCE_MS). Ensures we don't
   * thrash the disk during high-frequency message additions.
   */
  private schedulePersist(sessionId: string): void {
    const existing = this.writeQueue.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.writeQueue.delete(sessionId);
      this.persistToDisk(sessionId);
    }, PERSIST_DEBOUNCE_MS);

    this.writeQueue.set(sessionId, timer);
  }

  /**
   * Write a session to disk with atomic backup.
   *
   * Strategy:
   * 1. Serialize session data to JSON.
   * 2. Rename existing file to .bak (atomic backup for crash recovery).
   * 3. Write new data with restrictive permissions (0o600).
   * 4. On failure, attempt to restore from backup.
   */
  private persistToDisk(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const data: SessionData = {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages,
      activeWorkflows: [...session.activeWorkflows],
      hindsightBank: session.hindsightBank,
      memoryEvents: session.memoryEvents,
      agentMode: session.agentMode,
      runHistory: session.runHistory,
      inlineDAGs: session.inlineDAGs,
      orchestrationEvents: session.orchestrationEvents,
      codingSession: session.codingSession,
      sessionTotals: session.sessionTotals,
      activePlan: session.activePlan,
      pendingConfirmation: session.pendingConfirmation,
    };

    const filePath = this.sessionFilePath(sessionId);
    const backupPath = filePath + '.bak';

    try {
      // Create backup of existing file before overwriting (crash recovery)
      if (existsSync(filePath)) {
        try {
          renameSync(filePath, backupPath);
        } catch {
          // Backup failure is non-fatal — proceed with write anyway
        }
      }

      writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      this._totalDiskWrites++;
    } catch (err) {
      this._diskWriteFailures++;
      log.error(`[session:persist:error] Failed to persist session ${sessionId}`, {
        error: err instanceof Error ? err.message : String(err),
        messageCount: session.messages.length,
      });

      // Attempt to restore from backup on write failure
      if (existsSync(backupPath)) {
        try {
          renameSync(backupPath, filePath);
          log.info(`[session:persist:recovered] Restored backup for session ${sessionId}`);
        } catch {
          log.error(`[session:persist:error] Backup restore also failed for ${sessionId}`);
        }
      }
    }
  }

  /**
   * Load all session files from disk on startup.
   * Falls back to .bak files if the primary JSON is corrupt (crash recovery).
   */
  private loadAllFromDisk(): void {
    try {
      const files = readdirSync(SESSIONS_DIR).filter(
        (f) => f.endsWith('.json') && f !== 'hot-window.json',
      );

      for (const file of files) {
        const filePath = join(SESSIONS_DIR, file);
        let raw: string | null = null;

        // Try primary file first, then fall back to backup
        try {
          raw = readFileSync(filePath, 'utf-8');
          JSON.parse(raw); // Validate JSON is parseable
        } catch {
          // Primary file corrupt or unreadable — try backup
          const backupPath = filePath + '.bak';
          if (existsSync(backupPath)) {
            try {
              raw = readFileSync(backupPath, 'utf-8');
              JSON.parse(raw); // Validate backup is parseable
              log.warn(`[session:load:recovered] Loaded session from backup: ${file}`);
            } catch {
              raw = null;
            }
          }
        }

        if (!raw) {
          this._diskReadFailures++;
          log.warn(`[session:load:error] Failed to load session file ${file} (no valid primary or backup)`);
          continue;
        }

        try {
          const data: SessionData = JSON.parse(raw);

          const session: Session = {
            id: data.id,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            messages: data.messages ?? [],
            activeWorkflows: new Set(data.activeWorkflows ?? []),
            hindsightBank: data.hindsightBank,
            memoryEvents: data.memoryEvents ?? [],
            runHistory: data.runHistory ?? [],
            agentMode: data.agentMode,
            clients: new Set(), // No clients on startup — they reconnect
            inlineDAGs: data.inlineDAGs ?? {},
            orchestrationEvents: data.orchestrationEvents ?? [],
            codingSession: data.codingSession ?? null,
            sessionTotals: data.sessionTotals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, messageCount: 0 },
            activePlan: data.activePlan ?? null,
            pendingConfirmation: data.pendingConfirmation ?? null,
            eventBuffer: [], // Event buffer is transient — not persisted to disk
          };

          this.sessions.set(session.id, session);
          log.verbose(`[session:loaded] ${session.id} (${session.messages.length} messages, ${session.memoryEvents.length} memory events)`);
        } catch (err) {
          this._diskReadFailures++;
          log.warn(`[session:load:error] Failed to parse session file ${file}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      log.info(`[session:startup] Loaded ${this.sessions.size} session(s) from disk`, {
        diskReadFailures: this._diskReadFailures,
      });
    } catch (err) {
      log.warn('[session:startup:error] Could not read sessions directory', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Delete a session file from disk. */
  private deleteFromDisk(id: string): void {
    try {
      unlinkSync(this.sessionFilePath(id));
    } catch {
      // File may not exist — that's fine
    }
  }

  // ─── Cleanup / Rotation ─────────────────────────────────────

  /** Start the periodic cleanup loop. */
  private startCleanupLoop(): void {
    this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Archive (delete) sessions that are older than SESSION_MAX_AGE_MS
   * and have no active clients connected.
   * The default session is always exempt from cleanup.
   */
  private cleanupStaleSessions(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, session] of this.sessions) {
      if (id === DEFAULT_SESSION_ID) continue;

      const age = now - new Date(session.updatedAt).getTime();
      const hasClients = session.clients.size > 0;

      if (age > SESSION_MAX_AGE_MS && !hasClients) {
        log.info(`[session:expired] Session ${id} expired (age=${Math.round(age / 60000)}min)`);
        this.deleteSession(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log.info(`[session:cleanup] Cleaned up ${cleaned} stale session(s)`);
    }
  }

  /**
   * Ensure the default session exists.
   * If it was loaded from disk, keep it; otherwise create it fresh.
   */
  private ensureDefaultSession(): void {
    if (this.sessions.has(DEFAULT_SESSION_ID)) {
      log.info(`Default session loaded from disk (${this.sessions.get(DEFAULT_SESSION_ID)!.messages.length} messages)`);
      return;
    }

    const now = new Date().toISOString();
    const session: Session = {
      id: DEFAULT_SESSION_ID,
      createdAt: now,
      updatedAt: now,
      messages: [],
      activeWorkflows: new Set(),
      memoryEvents: [],
      runHistory: [],
      clients: new Set(),
      inlineDAGs: {},
      orchestrationEvents: [],
      codingSession: null,
      sessionTotals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, messageCount: 0 },
      activePlan: null,
      pendingConfirmation: null,
      eventBuffer: [],
    };
    this.sessions.set(DEFAULT_SESSION_ID, session);
    this.schedulePersist(DEFAULT_SESSION_ID);
    log.info('[session:created] Default session created');
  }
}
