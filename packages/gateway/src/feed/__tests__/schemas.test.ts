import { describe, it, expect } from 'vitest';
import { feedQuerySchema, createMessageSchema } from '../schemas.js';

describe('feedQuerySchema', () => {
  it('accepts valid params', () => {
    const result = feedQuerySchema.safeParse({ limit: 50, direction: 'before' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.direction).toBe('before');
    }
  });

  it('defaults limit to 50', () => {
    const result = feedQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
    }
  });

  it('rejects limit > 100', () => {
    const result = feedQuerySchema.safeParse({ limit: 200 });
    expect(result.success).toBe(false);
  });

  it('rejects limit < 1', () => {
    const result = feedQuerySchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid direction', () => {
    const result = feedQuerySchema.safeParse({ direction: 'sideways' });
    expect(result.success).toBe(false);
  });

  it('accepts cursor as optional', () => {
    const result = feedQuerySchema.safeParse({ limit: 10 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cursor).toBeUndefined();
    }
  });

  it('coerces string limit to number', () => {
    const result = feedQuerySchema.safeParse({ limit: '25' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(25);
    }
  });

  it('defaults direction to before', () => {
    const result = feedQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.direction).toBe('before');
    }
  });
});

describe('createMessageSchema', () => {
  it('requires role and content', () => {
    expect(createMessageSchema.safeParse({}).success).toBe(false);
    expect(createMessageSchema.safeParse({ role: 'user' }).success).toBe(false);
    expect(createMessageSchema.safeParse({ content: 'hello' }).success).toBe(false);
  });

  it('accepts valid message', () => {
    const result = createMessageSchema.safeParse({
      role: 'user',
      content: 'Hello world',
      type: 'text',
      metadata: { foo: 'bar' },
      replyToId: 'abc123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty content', () => {
    const result = createMessageSchema.safeParse({ role: 'user', content: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid role', () => {
    const result = createMessageSchema.safeParse({ role: 'bot', content: 'hello' });
    expect(result.success).toBe(false);
  });

  it('validates messageId as UUID', () => {
    const result = createMessageSchema.safeParse({
      role: 'user',
      content: 'hello',
      messageId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid UUID messageId', () => {
    const result = createMessageSchema.safeParse({
      role: 'user',
      content: 'hello',
      messageId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });
});
