/**
 * @module activity
 * Activity log persistence for gateway sessions.
 *
 * Each user action (chat, command, plan response, DAG confirmation, etc.) is
 * appended as a JSONL line to ~/.orionomega/activity/{sessionId}.jsonl.
 * An in-memory ring buffer per session allows fast reads for the REST API
 * without re-reading the full file on every request.
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, mkdirSync, readdirSync, statSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@orionomega/core';

const log = createLogger('activity');

/** Directory where per-session activity logs are stored. */
const ACTIVITY_DIR = join(homedir(), '.orionomega', 'activity');

/** Maximum in-memory entries per session before oldest are dropped. */
const MAX_BUFFER_SIZE = 1_000;

/** Rotate log file when it exceeds this size in bytes (~10 MB). */
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;

/** Number of entries to load from disk into the memory buffer on startup. */
const PRELOAD_ENTRIES = 500;

/** Supported action types for activity logging. */
export type ActivityAction =
  | 'client_connect'
  | 'client_disconnect'
  | 'chat'
  | 'command'
  | 'plan_approve'
  | 'plan_reject'
  | 'plan_modify'
  | 'dag_approve'
  | 'dag_reject'
  | 'workflow_subscribe'
  | 'tool_invocation'
  | 'memory_event'
  | 'config_change'
  | 'skill_update'
  | 'session_reset'
  | 'custom';

/** A single persisted activity entry. */
export interface ActivityEntry {
  /** Unique entry identifier. */
  id: string;
  /** Session this entry belongs to. */
  sessionId: string;
  /** The action that occurred. */
  action: ActivityAction | string;
  /** ISO 8601 timestamp when the action occurred. */
  timestamp: string;
  /** Arbitrary action-specific payload. */
  data?: Record<string, unknown>;
  /** Who performed the action: client ID or remote IP. */
  actor?: string;
}

/**
 * Manages persistent activity logging for all sessions.
 *
 * Each session gets its own JSONL file. An in-memory ring buffer per session
 * enables low-latency reads without disk access on every API call.
 */
export class ActivityService {
  /** Per-session in-memory ring buffers. */
  private buffers: Map<string, ActivityEntry[]> = new Map();

  /** Set of session IDs whose log files have been opened / preloaded. */
  private initializedSessions: Set<string> = new Set();

  constructor() {
    this.ensureActivityDir();
    this.preloadExistingSessions();
  }

  // ─── Public API ────────────────────────────────────────────

  /**
   * Append an activity entry for a session.
   *
   * @param sessionId - Target session.
   * @param action - The action type being logged.
   * @param data - Optional context data (will be shallow-copied; large blobs like
   *               `dataUrl` should be omitted by callers).
   * @param actor - Who performed the action (client ID, IP, or omitted for server).
   * @returns The persisted entry.
   */
  log(
    sessionId: string,
    action: ActivityAction | string,
    data?: Record<string, unknown>,
    actor?: string,
  ): ActivityEntry {
    const entry: ActivityEntry = {
      id: randomBytes(8).toString('hex'),
      sessionId,
      action,
      timestamp: new Date().toISOString(),
      ...(data && Object.keys(data).length > 0 && { data }),
      ...(actor && { actor }),
    };

    this.addToBuffer(sessionId, entry);
    this.appendToDisk(sessionId, entry);

    return entry;
  }

  /**
   * Retrieve paginated activity entries for a session.
   *
   * Reads from the in-memory buffer (fast path). If the buffer has fewer
   * entries than requested and the session log file exists, falls back to
   * reading the full file from disk.
   *
   * @param sessionId - Target session.
   * @param limit - Maximum entries to return (1–1000, default 100).
   * @param offset - Number of entries to skip from the start (default 0).
   * @param actionFilter - When set, only return entries matching this action.
   * @returns Paginated result.
   */
  getActivity(
    sessionId: string,
    limit = 100,
    offset = 0,
    actionFilter?: string,
  ): { entries: ActivityEntry[]; total: number } {
    const safeLimit = Math.min(Math.max(1, limit), 1_000);
    const safeOffset = Math.max(0, offset);

    // Ensure this session's disk log is preloaded into the buffer
    if (!this.initializedSessions.has(sessionId)) {
      this.preloadSession(sessionId);
    }

    const buffer = this.buffers.get(sessionId) ?? [];

    // Apply action filter
    const filtered = actionFilter
      ? buffer.filter((e) => e.action === actionFilter)
      : buffer;

    const total = filtered.length;
    const entries = filtered.slice(safeOffset, safeOffset + safeLimit);

    return { entries, total };
  }

  /**
   * List all session IDs that have activity logs.
   * Combines in-memory keys with JSONL files found on disk.
   */
  listSessionsWithActivity(): string[] {
    const fromMemory = new Set(this.buffers.keys());
    try {
      const files = readdirSync(ACTIVITY_DIR).filter((f) => f.endsWith('.jsonl'));
      for (const file of files) {
        const sessionId = file.replace(/\.jsonl$/, '');
        fromMemory.add(sessionId);
      }
    } catch {
      // Directory may not exist yet — that's fine
    }
    return [...fromMemory];
  }

  // ─── Internal helpers ───────────────────────────────────────

  /** Append an entry to the per-session JSONL file, rotating if needed. */
  private appendToDisk(sessionId: string, entry: ActivityEntry): void {
    const filePath = this.logFilePath(sessionId);
    const line = JSON.stringify(entry) + '\n';
    try {
      this.maybeRotate(filePath);
      appendFileSync(filePath, line, { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      log.error(`Failed to write activity log for session ${sessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Rotate the log file if it exceeds MAX_LOG_FILE_BYTES. */
  private maybeRotate(filePath: string): void {
    try {
      if (!existsSync(filePath)) return;
      const { size } = statSync(filePath);
      if (size >= MAX_LOG_FILE_BYTES) {
        const rotated = `${filePath}.${Date.now()}.bak`;
        renameSync(filePath, rotated);
        log.info(`Rotated activity log: ${filePath} → ${rotated}`);
      }
    } catch {
      // Non-fatal — the append will create a new file if needed
    }
  }

  /** Push an entry onto a session's ring buffer, evicting the oldest if full. */
  private addToBuffer(sessionId: string, entry: ActivityEntry): void {
    if (!this.buffers.has(sessionId)) {
      this.buffers.set(sessionId, []);
    }
    const buf = this.buffers.get(sessionId)!;
    buf.push(entry);
    if (buf.length > MAX_BUFFER_SIZE) {
      buf.splice(0, buf.length - MAX_BUFFER_SIZE);
    }
  }

  /** Preload the last PRELOAD_ENTRIES lines from a session's log file. */
  private preloadSession(sessionId: string): void {
    this.initializedSessions.add(sessionId);
    const filePath = this.logFilePath(sessionId);
    if (!existsSync(filePath)) return;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      // Take only the last PRELOAD_ENTRIES lines to respect the buffer cap
      const tail = lines.slice(-PRELOAD_ENTRIES);
      const entries: ActivityEntry[] = [];
      for (const line of tail) {
        try {
          entries.push(JSON.parse(line) as ActivityEntry);
        } catch {
          // Skip malformed lines
        }
      }
      if (entries.length > 0) {
        this.buffers.set(sessionId, entries);
        log.verbose(`Preloaded ${entries.length} activity entries for session ${sessionId}`);
      }
    } catch (err) {
      log.warn(`Failed to preload activity log for session ${sessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Discover and preload all existing session activity files on startup. */
  private preloadExistingSessions(): void {
    try {
      const files = readdirSync(ACTIVITY_DIR).filter((f) => f.endsWith('.jsonl'));
      for (const file of files) {
        const sessionId = file.replace(/\.jsonl$/, '');
        this.preloadSession(sessionId);
      }
      if (files.length > 0) {
        log.info(`Preloaded activity logs for ${files.length} session(s)`);
      }
    } catch {
      // Directory may not exist yet — created lazily on first write
    }
  }

  /** Ensure the activity directory exists. */
  private ensureActivityDir(): void {
    try {
      mkdirSync(ACTIVITY_DIR, { recursive: true });
    } catch (err) {
      log.error('Failed to create activity directory', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Path-safe log file path for a session. */
  private logFilePath(sessionId: string): string {
    // Validate to prevent path traversal
    if (!/^[a-z0-9_-]{1,128}$/.test(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    return join(ACTIVITY_DIR, `${sessionId}.jsonl`);
  }
}
