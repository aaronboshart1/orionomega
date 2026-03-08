/**
 * @module sessions
 * Session management with JSON file persistence.
 * Sessions survive gateway restarts so TUI clients can reconnect
 * and see their conversation history.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SESSIONS_DIR = join(homedir(), '.orionomega', 'sessions');
const SESSIONS_INDEX = join(SESSIONS_DIR, 'index.json');

/** A chat message within a session. */
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  type?: 'text' | 'plan' | 'orchestration-update' | 'command-result';
  metadata?: Record<string, unknown>;
}

/** A gateway session grouping one or more client connections. */
export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  activeWorkflow?: string;
  hindsightBank?: string;
  clients: Set<string>;
}

/** Serialized session shape (for disk). */
interface SessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  activeWorkflow?: string;
  hindsightBank?: string;
}

/**
 * Manages sessions with file-backed persistence.
 * Messages are persisted per-session as JSON files.
 * On startup, loads existing sessions from disk.
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor() {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    this.loadFromDisk();
  }

  createSession(): Session {
    const id = randomBytes(12).toString('hex');
    const now = new Date().toISOString();
    const session: Session = {
      id,
      createdAt: now,
      updatedAt: now,
      messages: [],
      clients: new Set(),
    };
    this.sessions.set(id, session);
    this.scheduleSave();
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  addMessage(sessionId: string, message: Message): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push(message);
    session.updatedAt = new Date().toISOString();
    this.scheduleSave();
  }

  addClient(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.clients.add(clientId);
    session.updatedAt = new Date().toISOString();
  }

  removeClient(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.clients.delete(clientId);
    session.updatedAt = new Date().toISOString();
  }

  setActiveWorkflow(sessionId: string, workflowId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activeWorkflow = workflowId;
    session.updatedAt = new Date().toISOString();
  }

  deleteSession(id: string): void {
    this.sessions.delete(id);
    this.scheduleSave();
  }

  toJSON(session: Session): Record<string, unknown> {
    return {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages,
      activeWorkflow: session.activeWorkflow ?? null,
      hindsightBank: session.hindsightBank ?? null,
      clientCount: session.clients.size,
    };
  }

  /** Force an immediate save (call before shutdown). */
  flush(): void {
    if (this.dirty) this.saveToDisk();
  }

  // ── Persistence ─────────────────────────────────────────────

  /**
   * Debounced save — writes at most once per second to avoid
   * hammering disk during streaming responses.
   */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, 1000);
  }

  private saveToDisk(): void {
    try {
      const records: SessionRecord[] = [];
      for (const session of this.sessions.values()) {
        records.push({
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messages: session.messages,
          activeWorkflow: session.activeWorkflow,
          hindsightBank: session.hindsightBank,
        });
      }
      writeFileSync(SESSIONS_INDEX, JSON.stringify(records, null, 2), 'utf-8');
      this.dirty = false;
    } catch (err) {
      console.error('[sessions] Failed to save sessions:', err);
    }
  }

  private loadFromDisk(): void {
    try {
      const data = readFileSync(SESSIONS_INDEX, 'utf-8');
      const records: SessionRecord[] = JSON.parse(data);
      for (const rec of records) {
        // Only load sessions from the last 24 hours
        const age = Date.now() - new Date(rec.updatedAt).getTime();
        if (age > 24 * 60 * 60 * 1000) continue;

        this.sessions.set(rec.id, {
          id: rec.id,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          messages: rec.messages ?? [],
          activeWorkflow: rec.activeWorkflow,
          hindsightBank: rec.hindsightBank,
          clients: new Set(),
        });
      }
      if (this.sessions.size > 0) {
        console.log(`[sessions] Loaded ${this.sessions.size} session(s) from disk`);
      }
    } catch {
      // No sessions file yet — that's fine
    }
  }
}
