/**
 * @module feed
 * Conversation feed subsystem — pagination, deduplication, and feed service.
 */

export { FeedService } from './feed-service.js';
export { DedupStore } from './dedup.js';
export type {
  FeedPaginationParams,
  FeedMessage,
  FeedPagination,
  FeedResponse,
  CreateMessageRequest,
  InsertResult,
  CursorDirection,
} from './types.js';
