/**
 * @module sessions
 * Session management with disk persistence for the gateway.
 *
 * Sessions are persisted to ~/.orionomega/sessions/{id}.json so that
 * conversations survive gateway restarts — the TUI reconnects with its
 * saved session ID and gets the full history back, like a console session.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@orionomega/core';

const log = createLogger('sessions');

/** Directory where session files are persisted. */
const SESSIONS_DIR = join(homedir(), '.orionomega', 'sessions');

/** The fixed ID for the single persistent default session. */
export const DEFAULT_SESSION_ID = 'default';

/** Maximum messages per session before oldest are pruned. */
const MAX_MESSAGES_PER_SESSION = 1000;

/** Maximum age (ms) before a session is eligible for archival — 24 hours. */
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How often to run the cleanup sweep (ms) — every 30 minutes. */
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

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
}

/** Maximum memory events to persist per session. */
const MAX_MEMORY_EVENTS = 200;

/** Maximum run summaries to persist per session. */
const MAX_RUN_HISTORY = 100;

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
}

/**
 * Manages sessions with automatic disk persistence.
 * Each session is saved to a JSON file on every mutation so that
 * conversations survive gateway restarts.
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private writeQueue: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor() {
    this.ensureSessionsDir();
    this.loadAllFromDisk();
    this.ensureDefaultSession();
    this.startCleanupLoop();
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
   * @returns The default session.
   */
  createSession(): Session {
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
   * with a 500ms delay. Ensures we don't thrash the disk during
   * high-frequency message additions.
   */
  private schedulePersist(sessionId: string): void {
    const existing = this.writeQueue.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.writeQueue.delete(sessionId);
      this.persistToDisk(sessionId);
    }, 500);

    this.writeQueue.set(sessionId, timer);
  }

  /** Write a session to disk. */
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
    };

    try {
      writeFileSync(this.sessionFilePath(sessionId), JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      log.error(`Failed to persist session ${sessionId}`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Load all session files from disk on startup. */
  private loadAllFromDisk(): void {
    try {
      const files = readdirSync(SESSIONS_DIR).filter(
        (f) => f.endsWith('.json') && f !== 'hot-window.json',
      );

      for (const file of files) {
        try {
          const raw = readFileSync(join(SESSIONS_DIR, file), 'utf-8');
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
          };

          this.sessions.set(session.id, session);
          log.verbose(`Loaded session from disk: ${session.id} (${session.messages.length} messages)`);
        } catch (err) {
          log.warn(`Failed to load session file ${file}`, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      log.info(`Loaded ${this.sessions.size} session(s) from disk`);
    } catch (err) {
      log.warn('Could not read sessions directory', { error: err instanceof Error ? err.message : String(err) });
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
        this.deleteSession(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log.info(`Cleaned up ${cleaned} stale session(s)`);
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
    };
    this.sessions.set(DEFAULT_SESSION_ID, session);
    this.schedulePersist(DEFAULT_SESSION_ID);
    log.info('Default session created');
  }
}
