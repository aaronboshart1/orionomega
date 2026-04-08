/**
 * @module persistence
 * Central database access layer for unified session persistence.
 *
 * Replaces the combination of SessionManager (JSON files), ServerSessionStore
 * (in-memory events), and ActivityService with a single SQLite-backed service
 * using Drizzle ORM.
 *
 * Features:
 * - Session CRUD with LRU caching
 * - Append-only event log with cursor-based pagination
 * - Message storage with cursor pagination
 * - Workflow and workflow event tracking
 * - Memory event and run history storage
 * - Per-client UI state persistence
 * - Full state snapshot materialization for reconnection
 * - Write batching via transaction wrapper
 */

import { LRUCache } from 'lru-cache';
import { eq, and, gt, lt, desc, asc, sql } from 'drizzle-orm';
import {
  createLogger,
  getDb,
  sessions,
  events,
  messages,
  workflows,
  workflowEvents,
  memoryEvents,
  runHistory,
  clientState,
} from '@orionomega/core';
import type {
  CodingDb,
  Session,
  NewSession,
  Event,
  NewEvent,
  Message as DbMessage,
  NewMessage,
  Workflow,
  NewWorkflow,
  WorkflowEvent,
  NewWorkflowEvent,
  DbMemoryEvent as MemoryEvent,
  NewMemoryEvent,
  RunHistory,
  NewRunHistory,
  ClientState,
  NewClientState,
} from '@orionomega/core';

const log = createLogger('persistence');

// ── Input types for public API ──────────────────────────────────────────────

/** Input shape for appendMessage — callers provide these fields. */
export interface MessageInput {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
  replyToId?: string;
  attachments?: unknown[];
  status?: string;
}

/** Input shape for upsertWorkflow. */
export interface WorkflowInput {
  id: string;
  sessionId: string;
  name?: string;
  status?: string;
  template?: string;
  nodeCount?: number;
  startedAt?: string;
  completedAt?: string;
  durationSec?: number;
  costUsd?: number;
  summary?: string;
  graphState?: Record<string, unknown>;
  /** ID of the chat message that triggered this workflow run. */
  triggeringMessageId?: string;
}

/** Input shape for appendWorkflowEvent. */
export interface WorkflowEventInput {
  id: string;
  workflowId: string;
  sessionId: string;
  seq: number;
  eventType: string;
  nodeId?: string;
  payload?: Record<string, unknown>;
}

/** Input shape for appendMemoryEvent. */
export interface MemoryEventInput {
  id: string;
  sessionId: string;
  op: string;
  detail?: string;
  bank?: string;
  meta?: Record<string, unknown>;
}

/** Input shape for appendRunHistory. */
export interface RunHistoryInput {
  id: string;
  sessionId: string;
  workflowId?: string;
  model?: string;
  durationSec?: number;
  costUsd?: number;
  workerCount?: number;
  modelUsage?: unknown;
  toolCallCount?: number;
}

/** Input shape for updateClientState. */
export interface ClientStateInput {
  agentMode?: 'orchestrate' | 'direct' | 'code';
  scrollPosition?: number;
  activePanel?: string;
  lastSeenSeq?: number;
}

// ── PersistenceService ──────────────────────────────────────────────────────

/**
 * Central database access layer for unified session persistence.
 *
 * All database operations go through this class, which provides:
 * - LRU caching for hot-path reads
 * - Prepared statements for frequently-used writes
 * - Transaction batching for bulk operations
 * - Consistent error handling
 */
export class PersistenceService {
  private db: CodingDb;

  // ── LRU Caches ──────────────────────────────────────────────────────────

  /** Session metadata cache: max 100 entries, 60s TTL. */
  private sessionCache = new LRUCache<string, Session>({
    max: 100,
    ttl: 60_000,
  });

  /** Latest seq number per session: max 200, no TTL (manually invalidated). */
  private latestSeqCache = new LRUCache<string, number>({
    max: 200,
    ttl: 0,
  });

  /** Message page cache: max 50, 30s TTL. */
  private messagePageCache = new LRUCache<string, DbMessage[]>({
    max: 50,
    ttl: 30_000,
  });

  constructor(db?: CodingDb) {
    this.db = db ?? getDb();
    log.info('[persistence:init] PersistenceService initialized');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Session CRUD
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create a new session.
   */
  createSession(
    id: string,
    name?: string,
    agentMode?: 'orchestrate' | 'direct' | 'code',
  ): Session {
    const now = new Date().toISOString();
    const row: NewSession = {
      id,
      name: name ?? null,
      createdAt: now,
      updatedAt: now,
      agentMode: agentMode ?? null,
    };

    try {
      this.db.insert(sessions).values(row).run();
      const session: Session = {
        id,
        name: name ?? null,
        createdAt: now,
        updatedAt: now,
        agentMode: agentMode ?? null,
        model: null,
        totalCostUsd: null,
        totalInputTokens: null,
        totalOutputTokens: null,
      };
      this.sessionCache.set(id, session);
      return session;
    } catch (err) {
      log.error('[persistence:createSession] Failed', { id, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Get a session by ID. Uses LRU cache (TTL 60s).
   */
  getSession(id: string): Session | null {
    const cached = this.sessionCache.get(id);
    if (cached) return cached;

    try {
      const row = this.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, id))
        .get();
      if (row) {
        this.sessionCache.set(id, row);
      }
      return row ?? null;
    } catch (err) {
      log.error('[persistence:getSession] Failed', { id, error: (err as Error).message });
      return null;
    }
  }

  /**
   * Update session fields. Invalidates cache.
   */
  updateSession(
    id: string,
    updates: Partial<Pick<Session, 'name' | 'model' | 'agentMode' | 'totalCostUsd' | 'totalInputTokens' | 'totalOutputTokens'>>,
  ): void {
    try {
      this.db
        .update(sessions)
        .set({ ...updates, updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, id))
        .run();
      this.sessionCache.delete(id);
    } catch (err) {
      log.error('[persistence:updateSession] Failed', { id, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * List all sessions ordered by updated_at DESC.
   */
  listSessions(): Session[] {
    try {
      return this.db
        .select()
        .from(sessions)
        .orderBy(desc(sessions.updatedAt))
        .all();
    } catch (err) {
      log.error('[persistence:listSessions] Failed', { error: (err as Error).message });
      return [];
    }
  }

  /**
   * Delete a session. Cascades to all related tables.
   */
  deleteSession(id: string): void {
    try {
      this.db.delete(sessions).where(eq(sessions.id, id)).run();
      this.sessionCache.delete(id);
      this.latestSeqCache.delete(id);
      // Invalidate any message page cache entries for this session
      for (const key of this.messagePageCache.keys()) {
        if (key.startsWith(id + ':')) {
          this.messagePageCache.delete(key);
        }
      }
    } catch (err) {
      log.error('[persistence:deleteSession] Failed', { id, error: (err as Error).message });
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event Log (append-only)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Append an event to the session event log.
   * SYNCHRONOUS — returns the seq number immediately.
   * Uses a prepared statement for performance.
   */
  appendEvent(
    sessionId: string,
    eventType: string,
    payload: Record<string, unknown> | null,
    workflowId?: string,
  ): number {
    try {
      const result = this.db
        .insert(events)
        .values({
          sessionId,
          timestamp: new Date().toISOString(),
          eventType,
          workflowId: workflowId ?? null,
          payload: payload ? JSON.stringify(payload) : null,
        })
        .run();

      const seq = Number(result.lastInsertRowid);

      // Invalidate latest seq cache
      this.latestSeqCache.set(sessionId, seq);

      return seq;
    } catch (err) {
      log.error('[persistence:appendEvent] Failed', { sessionId, eventType, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Get events after a given sequence number (cursor-based forward pagination).
   */
  getEventsSince(sessionId: string, afterSeq: number, limit = 500): Event[] {
    try {
      return this.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.sessionId, sessionId),
            gt(events.seq, afterSeq),
          ),
        )
        .orderBy(asc(events.seq))
        .limit(limit)
        .all();
    } catch (err) {
      log.error('[persistence:getEventsSince] Failed', { sessionId, afterSeq, error: (err as Error).message });
      return [];
    }
  }

  /**
   * Get events before a given sequence number (backward pagination).
   */
  getEventsBefore(sessionId: string, beforeSeq: number, limit = 50): Event[] {
    try {
      return this.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.sessionId, sessionId),
            lt(events.seq, beforeSeq),
          ),
        )
        .orderBy(desc(events.seq))
        .limit(limit)
        .all()
        .reverse(); // Return in ascending order
    } catch (err) {
      log.error('[persistence:getEventsBefore] Failed', { sessionId, beforeSeq, error: (err as Error).message });
      return [];
    }
  }

  /**
   * Get the latest event seq for a session. Uses LRU cache (invalidated on append).
   */
  getLatestSeq(sessionId: string): number {
    const cached = this.latestSeqCache.get(sessionId);
    if (cached !== undefined) return cached;

    try {
      const result = this.db
        .select({ maxSeq: sql<number>`MAX(${events.seq})` })
        .from(events)
        .where(eq(events.sessionId, sessionId))
        .get();
      const seq = result?.maxSeq ?? 0;
      this.latestSeqCache.set(sessionId, seq);
      return seq;
    } catch (err) {
      log.error('[persistence:getLatestSeq] Failed', { sessionId, error: (err as Error).message });
      return 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Messages
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Append a message to a session.
   */
  appendMessage(sessionId: string, message: MessageInput, seq?: number): void {
    try {
      const resolvedSeq = seq ?? this.getLatestSeq(sessionId) + 1;

      this.db
        .insert(messages)
        .values({
          id: message.id,
          sessionId,
          seq: resolvedSeq,
          role: message.role,
          content: message.content,
          metadata: message.metadata ? JSON.stringify(message.metadata) : null,
          replyToId: message.replyToId ?? null,
          attachments: message.attachments ? JSON.stringify(message.attachments) : null,
          status: message.status ?? null,
        })
        .run();

      // Invalidate message page cache for this session
      for (const key of this.messagePageCache.keys()) {
        if (key.startsWith(sessionId + ':')) {
          this.messagePageCache.delete(key);
        }
      }
    } catch (err) {
      log.error('[persistence:appendMessage] Failed', { sessionId, messageId: message.id, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Get messages with cursor-based pagination.
   */
  getMessages(
    sessionId: string,
    options?: { afterSeq?: number; beforeSeq?: number; limit?: number },
  ): DbMessage[] {
    const limit = options?.limit ?? 200;
    const cacheKey = `${sessionId}:${options?.afterSeq ?? 0}:${options?.beforeSeq ?? 0}:${limit}`;

    const cached = this.messagePageCache.get(cacheKey);
    if (cached) return cached;

    try {
      const conditions = [eq(messages.sessionId, sessionId)];

      if (options?.afterSeq !== undefined) {
        conditions.push(gt(messages.seq, options.afterSeq));
      }
      if (options?.beforeSeq !== undefined) {
        conditions.push(lt(messages.seq, options.beforeSeq));
      }

      const result = this.db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(asc(messages.seq))
        .limit(limit)
        .all();

      this.messagePageCache.set(cacheKey, result);
      return result;
    } catch (err) {
      log.error('[persistence:getMessages] Failed', { sessionId, error: (err as Error).message });
      return [];
    }
  }

  /**
   * Update a message's status and optionally its content.
   */
  updateMessageStatus(messageId: string, status: string, content?: string): void {
    try {
      const updates: Record<string, unknown> = { status };
      if (content !== undefined) {
        updates.content = content;
      }

      this.db
        .update(messages)
        .set(updates)
        .where(eq(messages.id, messageId))
        .run();

      // Invalidate all message page caches (message could be in any page)
      this.messagePageCache.clear();
    } catch (err) {
      log.error('[persistence:updateMessageStatus] Failed', { messageId, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Get the total message count for a session.
   */
  getMessageCount(sessionId: string): number {
    try {
      const result = this.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .get();
      return result?.count ?? 0;
    } catch (err) {
      log.error('[persistence:getMessageCount] Failed', { sessionId, error: (err as Error).message });
      return 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Workflows
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Insert or replace a workflow record.
   */
  upsertWorkflow(workflow: WorkflowInput): void {
    try {
      const row: NewWorkflow = {
        id: workflow.id,
        sessionId: workflow.sessionId,
        name: workflow.name ?? null,
        status: workflow.status ?? null,
        template: workflow.template ?? null,
        nodeCount: workflow.nodeCount ?? null,
        startedAt: workflow.startedAt ?? null,
        completedAt: workflow.completedAt ?? null,
        durationSec: workflow.durationSec ?? null,
        costUsd: workflow.costUsd ?? null,
        summary: workflow.summary ?? null,
        graphState: workflow.graphState ? JSON.stringify(workflow.graphState) : null,
        triggeringMessageId: workflow.triggeringMessageId ?? null,
      };

      this.db
        .insert(workflows)
        .values(row)
        .onConflictDoUpdate({
          target: workflows.id,
          set: {
            name: row.name,
            status: row.status,
            template: row.template,
            nodeCount: row.nodeCount,
            startedAt: row.startedAt,
            completedAt: row.completedAt,
            durationSec: row.durationSec,
            costUsd: row.costUsd,
            summary: row.summary,
            graphState: row.graphState,
            // triggeringMessageId is intentionally excluded: preserve initial value on updates
          },
        })
        .run();
    } catch (err) {
      log.error('[persistence:upsertWorkflow] Failed', { id: workflow.id, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Get a workflow by ID.
   */
  getWorkflow(id: string): Workflow | null {
    try {
      const row = this.db
        .select()
        .from(workflows)
        .where(eq(workflows.id, id))
        .get();
      return row ?? null;
    } catch (err) {
      log.error('[persistence:getWorkflow] Failed', { id, error: (err as Error).message });
      return null;
    }
  }

  /**
   * Get all workflows for a session.
   */
  getWorkflows(sessionId: string): Workflow[] {
    try {
      return this.db
        .select()
        .from(workflows)
        .where(eq(workflows.sessionId, sessionId))
        .all();
    } catch (err) {
      log.error('[persistence:getWorkflows] Failed', { sessionId, error: (err as Error).message });
      return [];
    }
  }

  /**
   * Append a workflow event.
   */
  appendWorkflowEvent(event: WorkflowEventInput): void {
    try {
      this.db
        .insert(workflowEvents)
        .values({
          id: event.id,
          workflowId: event.workflowId,
          sessionId: event.sessionId,
          seq: event.seq,
          eventType: event.eventType,
          nodeId: event.nodeId ?? null,
          payload: event.payload ? JSON.stringify(event.payload) : null,
        })
        .run();
    } catch (err) {
      log.error('[persistence:appendWorkflowEvent] Failed', { id: event.id, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Get all workflow events for a workflow, ordered by seq.
   */
  getWorkflowEvents(workflowId: string): WorkflowEvent[] {
    try {
      return this.db
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.workflowId, workflowId))
        .orderBy(asc(workflowEvents.seq))
        .all();
    } catch (err) {
      log.error('[persistence:getWorkflowEvents] Failed', { workflowId, error: (err as Error).message });
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Memory Events
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Append a memory event.
   */
  appendMemoryEvent(event: MemoryEventInput, seq?: number): void {
    try {
      const resolvedSeq = seq ?? this.getLatestSeq(event.sessionId) + 1;

      this.db
        .insert(memoryEvents)
        .values({
          id: event.id,
          sessionId: event.sessionId,
          seq: resolvedSeq,
          op: event.op,
          detail: event.detail ?? null,
          bank: event.bank ?? null,
          meta: event.meta ? JSON.stringify(event.meta) : null,
        })
        .run();
    } catch (err) {
      log.error('[persistence:appendMemoryEvent] Failed', { id: event.id, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Get memory events for a session, ordered by seq DESC (most recent first).
   */
  getMemoryEvents(sessionId: string, limit = 50): MemoryEvent[] {
    try {
      return this.db
        .select()
        .from(memoryEvents)
        .where(eq(memoryEvents.sessionId, sessionId))
        .orderBy(desc(memoryEvents.seq))
        .limit(limit)
        .all();
    } catch (err) {
      log.error('[persistence:getMemoryEvents] Failed', { sessionId, error: (err as Error).message });
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Run History
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Append a run history record.
   */
  appendRunHistory(run: RunHistoryInput): void {
    try {
      this.db
        .insert(runHistory)
        .values({
          id: run.id,
          sessionId: run.sessionId,
          workflowId: run.workflowId ?? null,
          model: run.model ?? null,
          durationSec: run.durationSec ?? null,
          costUsd: run.costUsd ?? null,
          workerCount: run.workerCount ?? null,
          modelUsage: run.modelUsage ? JSON.stringify(run.modelUsage) : null,
          toolCallCount: run.toolCallCount ?? null,
        })
        .run();
    } catch (err) {
      log.error('[persistence:appendRunHistory] Failed', { id: run.id, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Get run history for a session, ordered by most recent first.
   */
  getRunHistory(sessionId: string, limit = 20): RunHistory[] {
    try {
      return this.db
        .select()
        .from(runHistory)
        .where(eq(runHistory.sessionId, sessionId))
        .orderBy(desc(runHistory.id))
        .limit(limit)
        .all();
    } catch (err) {
      log.error('[persistence:getRunHistory] Failed', { sessionId, error: (err as Error).message });
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Client State
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Insert or replace client UI state.
   */
  updateClientState(clientId: string, sessionId: string, state: ClientStateInput): void {
    try {
      this.db
        .insert(clientState)
        .values({
          clientId,
          sessionId,
          agentMode: state.agentMode ?? null,
          scrollPosition: state.scrollPosition ?? null,
          activePanel: state.activePanel ?? null,
          lastSeenSeq: state.lastSeenSeq ?? null,
        })
        .onConflictDoUpdate({
          target: [clientState.clientId, clientState.sessionId],
          set: {
            agentMode: state.agentMode ?? null,
            scrollPosition: state.scrollPosition ?? null,
            activePanel: state.activePanel ?? null,
            lastSeenSeq: state.lastSeenSeq ?? null,
          },
        })
        .run();
    } catch (err) {
      log.error('[persistence:updateClientState] Failed', { clientId, sessionId, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Get client UI state.
   */
  getClientState(clientId: string, sessionId: string): ClientState | null {
    try {
      const row = this.db
        .select()
        .from(clientState)
        .where(
          and(
            eq(clientState.clientId, clientId),
            eq(clientState.sessionId, sessionId),
          ),
        )
        .get();
      return row ?? null;
    } catch (err) {
      log.error('[persistence:getClientState] Failed', { clientId, sessionId, error: (err as Error).message });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Snapshots
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Materialize a full state snapshot from the database.
   *
   * Returns a format compatible with the existing `state_snapshot` WebSocket
   * message so that clients can rehydrate their UI on reconnect.
   */
  buildSnapshot(
    sessionId: string,
    maxMessages = 200,
  ): Record<string, unknown> | null {
    try {
      const session = this.getSession(sessionId);
      if (!session) return null;

      // Recent messages (last maxMessages, ordered by seq)
      const totalMessages = this.getMessageCount(sessionId);
      const recentMessages = this.db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(desc(messages.seq))
        .limit(maxMessages)
        .all()
        .reverse(); // Flip to ascending order

      // Active workflows with graph_state
      const activeWorkflows = this.db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.sessionId, sessionId),
            sql`${workflows.status} IN ('dispatched', 'running', 'confirming')`,
          ),
        )
        .all();

      // Recent memory events (last 50)
      const recentMemoryEvents = this.getMemoryEvents(sessionId, 50);

      // Recent run history (last 20)
      const recentRunHistory = this.getRunHistory(sessionId, 20);

      // Latest seq number
      const latestSeq = this.getLatestSeq(sessionId);

      // Parse JSON fields for messages
      const parsedMessages = recentMessages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        seq: m.seq,
        metadata: m.metadata ? JSON.parse(m.metadata) : undefined,
        replyToId: m.replyToId,
        attachments: m.attachments ? JSON.parse(m.attachments) : undefined,
        status: m.status,
      }));

      // Parse JSON fields for memory events
      const parsedMemoryEvents = recentMemoryEvents.map((me) => ({
        id: me.id,
        seq: me.seq,
        op: me.op,
        detail: me.detail,
        bank: me.bank,
        meta: me.meta ? JSON.parse(me.meta) : undefined,
      }));

      // Parse JSON fields for run history
      const parsedRunHistory = recentRunHistory.map((rh) => ({
        id: rh.id,
        workflowId: rh.workflowId,
        model: rh.model,
        durationSec: rh.durationSec,
        costUsd: rh.costUsd,
        workerCount: rh.workerCount,
        modelUsage: rh.modelUsage ? JSON.parse(rh.modelUsage) : undefined,
        toolCallCount: rh.toolCallCount,
      }));

      // Build DAG state from active workflows
      const dags: Record<string, unknown> = {};
      for (const wf of activeWorkflows) {
        dags[wf.id] = {
          workflowId: wf.id,
          workflowName: wf.name,
          sessionId: wf.sessionId,
          status: wf.status,
          nodeCount: wf.nodeCount,
          graphState: wf.graphState ? JSON.parse(wf.graphState) : undefined,
          startedAt: wf.startedAt,
          completedAt: wf.completedAt,
          durationSec: wf.durationSec,
          costUsd: wf.costUsd,
          summary: wf.summary,
          triggeringMessageId: wf.triggeringMessageId ?? undefined,
        };
      }

      return {
        session: {
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          agentMode: session.agentMode ?? 'orchestrate',
          model: session.model,
          totalCostUsd: session.totalCostUsd,
          totalInputTokens: session.totalInputTokens,
          totalOutputTokens: session.totalOutputTokens,
          messages: parsedMessages,
          memoryEvents: parsedMemoryEvents,
          runHistory: parsedRunHistory,
          activeWorkflows: activeWorkflows.map((w) => w.id),
        },
        dags,
        latestSeq,
        generatedAt: new Date().toISOString(),
        pagination: {
          totalMessages,
          includedMessages: recentMessages.length,
          hasOlderMessages: totalMessages > maxMessages,
          oldestIncludedSeq: recentMessages[0]?.seq ?? null,
        },
      };
    } catch (err) {
      log.error('[persistence:buildSnapshot] Failed', { sessionId, error: (err as Error).message });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Write Batching
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Execute multiple operations in a single SQLite transaction.
   *
   * Use this for bulk imports or operations that should be atomic.
   * Individual appendEvent calls should NOT use this — they need
   * immediate seq numbers.
   *
   * @example
   *   persistence.batch(() => {
   *     persistence.appendMessage(sessionId, msg1);
   *     persistence.appendMessage(sessionId, msg2);
   *     persistence.appendMemoryEvent(event1);
   *   });
   */
  batch<T>(fn: () => T): T {
    try {
      // Access the underlying better-sqlite3 instance for transaction support
      const rawDb = (this.db as unknown as { session: { client: { transaction: (fn: () => T) => T } } }).session.client;
      return rawDb.transaction(fn);
    } catch (err) {
      log.error('[persistence:batch] Transaction failed', { error: (err as Error).message });
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Shutdown
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Flush any pending operations and clean up resources.
   */
  shutdown(): void {
    this.sessionCache.clear();
    this.latestSeqCache.clear();
    this.messagePageCache.clear();
    log.info('[persistence:shutdown] PersistenceService shut down');
  }
}
