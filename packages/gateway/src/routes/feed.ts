/**
 * @module routes/feed
 * REST endpoints for the conversation feed.
 *
 *   GET  /api/sessions/:id/feed              — paginated message list
 *   GET  /api/sessions/:id/feed/messages/:mid — single message by ID
 *   POST /api/sessions/:id/feed/messages      — idempotent message insert
 *   GET  /api/sessions/:id/feed/count         — total message count
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FeedService } from '../feed/feed-service.js';
import { feedQuerySchema, createMessageSchema } from '../feed/schemas.js';
import { readBody } from './utils.js';

/**
 * GET /api/sessions/:id/feed
 *
 * Query params:
 *   limit     — max messages to return (1-100, default 50)
 *   cursor    — message ID to paginate from
 *   direction — 'before' (older, default) or 'after' (newer)
 *
 * Returns: { sessionId, data: FeedMessage[], pagination: {...} }
 */
export function handleGetFeed(
  req: IncomingMessage,
  res: ServerResponse,
  feedService: FeedService,
  sessionId: string,
): void {
  const rawUrl = req.url ?? '/';
  const queryStr = rawUrl.split('?')[1] ?? '';
  const params = new URLSearchParams(queryStr);

  // Parse and validate query params
  const parseResult = feedQuerySchema.safeParse({
    limit: params.get('limit') ?? undefined,
    cursor: params.get('cursor') ?? undefined,
    direction: params.get('direction') ?? undefined,
  });

  if (!parseResult.success) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Invalid query parameters',
      details: parseResult.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }));
    return;
  }

  const result = feedService.getMessages(sessionId, parseResult.data);
  if (!result) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

/**
 * GET /api/sessions/:id/feed/messages/:messageId
 *
 * Returns a single message scoped to the session.
 */
export function handleGetFeedMessage(
  _req: IncomingMessage,
  res: ServerResponse,
  feedService: FeedService,
  sessionId: string,
  messageId: string,
): void {
  const message = feedService.getMessage(sessionId, messageId);
  if (!message) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Message not found' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message }));
}

/**
 * POST /api/sessions/:id/feed/messages
 *
 * Body (JSON): { role, content, type?, metadata?, replyToId?, messageId? }
 *
 * Idempotent: if messageId matches an existing message, returns it with 200.
 * New inserts return 201.
 */
export async function handlePostFeedMessage(
  req: IncomingMessage,
  res: ServerResponse,
  feedService: FeedService,
  sessionId: string,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req, 1_048_576); // 1 MiB
  } catch {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request body too large (max 1 MiB)' }));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const parseResult = createMessageSchema.safeParse(parsed);
  if (!parseResult.success) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Validation failed',
      details: parseResult.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }));
    return;
  }

  const result = feedService.insertMessage(sessionId, parseResult.data);
  if (!result) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const status = result.created ? 201 : 200;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!result.created) {
    headers['X-Deduplicated'] = 'true';
  }

  res.writeHead(status, headers);
  res.end(JSON.stringify({ message: result.message, created: result.created }));
}

/**
 * GET /api/sessions/:id/feed/count
 *
 * Returns: { sessionId, count }
 */
export function handleGetFeedCount(
  _req: IncomingMessage,
  res: ServerResponse,
  feedService: FeedService,
  sessionId: string,
): void {
  const count = feedService.getMessageCount(sessionId);
  if (count === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ sessionId, count }));
}
