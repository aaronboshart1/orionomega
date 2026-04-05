/**
 * @module feed/feed-service
 * Feed service layer — cursor-based pagination and idempotent message insertion.
 *
 * Operates on the SessionManager's in-memory message arrays.
 * No direct disk I/O; persistence is handled by SessionManager.schedulePersist().
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@orionomega/core';
import type { SessionManager, Message } from '../sessions.js';
import { DedupStore } from './dedup.js';
import type {
  FeedPaginationParams,
  FeedMessage,
  FeedResponse,
  CreateMessageRequest,
  InsertResult,
} from './types.js';

const log = createLogger('feed-service');

export class FeedService {
  private dedup: DedupStore;

  constructor(private sessionManager: SessionManager) {
    this.dedup = new DedupStore();
  }

  /**
   * Retrieve a paginated slice of messages from a session's feed.
   *
   * Pagination is cursor-based using message `id` as the cursor.
   *   - direction='before' (default): return messages *older* than cursor, newest-first.
   *   - direction='after': return messages *newer* than cursor, oldest-first (for catching up).
   *
   * When no cursor is provided, returns the most recent `limit` messages.
   *
   * @returns FeedResponse or null if session not found.
   */
  getMessages(sessionId: string, params: FeedPaginationParams): FeedResponse | null {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return null;

    const allMessages = session.messages; // ordered chronologically (oldest first)
    const { limit, cursor, direction } = params;

    let slice: Message[];
    let hasMore: boolean;

    if (!cursor) {
      // No cursor — return the last `limit` messages (most recent)
      const startIdx = Math.max(0, allMessages.length - limit);
      slice = allMessages.slice(startIdx);
      hasMore = startIdx > 0;
    } else {
      const cursorIdx = allMessages.findIndex((m) => m.id === cursor);
      if (cursorIdx === -1) {
        // Cursor not found — treat as if no cursor (return latest)
        const startIdx = Math.max(0, allMessages.length - limit);
        slice = allMessages.slice(startIdx);
        hasMore = startIdx > 0;
      } else if (direction === 'before') {
        // Messages older than cursor
        const endIdx = cursorIdx; // exclusive — don't include the cursor message
        const startIdx = Math.max(0, endIdx - limit);
        slice = allMessages.slice(startIdx, endIdx);
        hasMore = startIdx > 0;
      } else {
        // direction === 'after' — messages newer than cursor
        const startIdx = cursorIdx + 1;
        const endIdx = Math.min(allMessages.length, startIdx + limit);
        slice = allMessages.slice(startIdx, endIdx);
        hasMore = endIdx < allMessages.length;
      }
    }

    const data: FeedMessage[] = slice.map(toFeedMessage);

    return {
      sessionId,
      data,
      pagination: {
        count: data.length,
        limit,
        hasMore,
        oldestCursor: data.length > 0 ? data[0]!.id : null,
        newestCursor: data.length > 0 ? data[data.length - 1]!.id : null,
      },
    };
  }

  /**
   * Retrieve a single message by ID within a session.
   *
   * @returns FeedMessage or null if session or message not found.
   */
  getMessage(sessionId: string, messageId: string): FeedMessage | null {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return null;
    const msg = session.messages.find((m) => m.id === messageId);
    return msg ? toFeedMessage(msg) : null;
  }

  /**
   * Idempotent message insertion.
   *
   * If `messageId` is provided and has been seen before, returns the existing
   * message with `created: false`. Otherwise inserts and returns `created: true`.
   *
   * @returns InsertResult or null if session not found.
   */
  insertMessage(sessionId: string, req: CreateMessageRequest): InsertResult | null {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return null;

    const messageId = req.messageId ?? randomUUID();

    // Dedup check — first check if the message already exists in the session
    const existing = session.messages.find((m) => m.id === messageId);
    if (existing) {
      return {
        message: { ...toFeedMessage(existing), deduplicated: true },
        created: false,
      };
    }

    // Check dedup store for recently-seen IDs (covers race conditions)
    if (this.dedup.checkAndMark(messageId)) {
      // Was seen very recently — scan messages again (might have been added between checks)
      const justAdded = session.messages.find((m) => m.id === messageId);
      if (justAdded) {
        return {
          message: { ...toFeedMessage(justAdded), deduplicated: true },
          created: false,
        };
      }
      // Dedup store says duplicate but message not in session — edge case, insert anyway
      log.warn('Dedup store hit but message not found in session — inserting', { messageId, sessionId });
    }

    // Insert new message
    const message: Message = {
      id: messageId,
      role: req.role,
      content: req.content,
      timestamp: new Date().toISOString(),
      type: req.type as Message['type'],
      metadata: req.metadata,
      replyToId: req.replyToId,
    };

    this.sessionManager.addMessage(sessionId, message);
    log.info('Message inserted via feed', { sessionId, messageId, role: req.role });

    return {
      message: toFeedMessage(message),
      created: true,
    };
  }

  /**
   * Return the total message count for a session.
   * @returns count or null if session not found.
   */
  getMessageCount(sessionId: string): number | null {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return null;
    return session.messages.length;
  }

  /** Cleanup on shutdown. */
  destroy(): void {
    this.dedup.destroy();
  }
}

/** Convert internal Message to public FeedMessage. */
function toFeedMessage(msg: Message): FeedMessage {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
    type: msg.type,
    metadata: msg.metadata,
    replyToId: msg.replyToId,
  };
}
