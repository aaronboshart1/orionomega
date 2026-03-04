/**
 * @module sessions
 * In-memory session management for gateway connections.
 */

import { randomBytes } from 'node:crypto';

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

/**
 * Manages in-memory sessions. Each session can have multiple client connections
 * (e.g. a TUI and a web dashboard viewing the same workflow).
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();

  /**
   * Create a new session and return it.
   * @returns The newly created session.
   */
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
    return session;
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
   * @param sessionId - Target session ID.
   * @param message - The message to add.
   */
  addMessage(sessionId: string, message: Message): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push(message);
    session.updatedAt = new Date().toISOString();
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
   * Associate an active workflow with a session.
   * @param sessionId - Target session ID.
   * @param workflowId - The workflow identifier.
   */
  setActiveWorkflow(sessionId: string, workflowId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activeWorkflow = workflowId;
    session.updatedAt = new Date().toISOString();
  }

  /**
   * Delete a session entirely.
   * @param id - Session identifier.
   */
  deleteSession(id: string): void {
    this.sessions.delete(id);
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
      activeWorkflow: session.activeWorkflow ?? null,
      hindsightBank: session.hindsightBank ?? null,
      clientCount: session.clients.size,
    };
  }
}
