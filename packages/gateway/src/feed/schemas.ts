/**
 * @module feed/schemas
 * Zod schemas for feed endpoint request validation.
 */

import { z } from 'zod';

// UUID v4 regex (loose — accepts any hex pattern in 8-4-4-4-12 form)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(128).optional(),
  direction: z.enum(['before', 'after']).default('before'),
});

export const createMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1).max(1_048_576), // 1 MiB
  type: z.string().max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  replyToId: z.string().max(128).optional(),
  messageId: z.string().max(128).refine((val) => UUID_RE.test(val), {
    message: 'messageId must be a valid UUID',
  }).optional(),
});

export type FeedQueryInput = z.infer<typeof feedQuerySchema>;
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
