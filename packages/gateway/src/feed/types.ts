/**
 * @module feed/types
 * Type definitions for the conversation feed subsystem.
 */

/** Supported cursor directions for feed pagination. */
export type CursorDirection = 'before' | 'after';

/** Parsed pagination parameters from a feed request. */
export interface FeedPaginationParams {
  /** Max items to return (1–100, default 50). */
  limit: number;
  /** Opaque cursor string — the `id` of the boundary message. */
  cursor?: string;
  /** Direction relative to cursor: 'before' = older, 'after' = newer. */
  direction: CursorDirection;
}

/** Shape of a single message in a feed response (public API). */
export interface FeedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  type?: string;
  metadata?: Record<string, unknown>;
  replyToId?: string;
  /** True if this message was a duplicate submission (deduped). */
  deduplicated?: boolean;
}

/** Pagination metadata returned alongside feed results. */
export interface FeedPagination {
  /** Number of items returned in this page. */
  count: number;
  /** Limit that was applied. */
  limit: number;
  /** True if there are more items in this direction. */
  hasMore: boolean;
  /** Cursor pointing to the oldest item in this page (use with direction=before for next older page). */
  oldestCursor: string | null;
  /** Cursor pointing to the newest item in this page (use with direction=after for next newer page). */
  newestCursor: string | null;
}

/** Full feed response envelope. */
export interface FeedResponse {
  sessionId: string;
  data: FeedMessage[];
  pagination: FeedPagination;
}

/** Shape of a POST /messages request body. */
export interface CreateMessageRequest {
  role: 'user' | 'assistant' | 'system';
  content: string;
  type?: string;
  metadata?: Record<string, unknown>;
  replyToId?: string;
  /** Client-supplied idempotency key (UUID). If omitted, server generates one. */
  messageId?: string;
}

/** Result of an idempotent message insert. */
export interface InsertResult {
  message: FeedMessage;
  /** True if this was a new insert; false if deduplicated. */
  created: boolean;
}
