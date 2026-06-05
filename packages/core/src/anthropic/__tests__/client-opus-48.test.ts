/**
 * @module anthropic/__tests__/client-opus-48
 *
 * Opus 4.8 compatibility tests for the Anthropic client module.
 *
 * Covers:
 * - maxOutputTokensForModel() returns 128000 (128K) for claude-opus-4-8
 * - maxOutputTokensForModel() backward compatibility for opus-4-6, sonnet-4-6, haiku-4-5
 * - MessageResponse.stop_reason accepts 'refusal' (new Opus 4.8 stop reason)
 * - CreateMessageOptions.thinking accepts { type: 'adaptive' } (Opus 4.8 thinking style)
 * - CreateMessageOptions.thinking still accepts { type: 'enabled', budget_tokens } (backward compat)
 * - temperature is accepted for non-opus-4-8 models (backward compat)
 */

import { describe, it, expect } from 'vitest';
import { maxOutputTokensForModel } from '../client.js';
import type { MessageResponse, CreateMessageOptions } from '../client.js';

// ── maxOutputTokensForModel ────────────────────────────────────────────────────

describe('maxOutputTokensForModel — Opus 4.8 (128K output)', () => {
  it('returns 128000 for claude-opus-4-8', () => {
    expect(maxOutputTokensForModel('claude-opus-4-8')).toBe(128_000);
  });

  it('returns 128000 for a timestamped claude-opus-4-8 variant', () => {
    // Anthropic appends a date suffix to model IDs; the check must still match.
    expect(maxOutputTokensForModel('claude-opus-4-8-20260601')).toBe(128_000);
  });

  it('is case-insensitive for the opus-4-8 check', () => {
    expect(maxOutputTokensForModel('Claude-Opus-4-8')).toBe(128_000);
  });
});

describe('maxOutputTokensForModel — backward compatibility', () => {
  it('returns 16384 for claude-opus-4-6', () => {
    expect(maxOutputTokensForModel('claude-opus-4-6')).toBe(16_384);
  });

  it('returns 16384 for claude-sonnet-4-6', () => {
    expect(maxOutputTokensForModel('claude-sonnet-4-6')).toBe(16_384);
  });

  it('returns 8192 for claude-haiku-4-5-20251001', () => {
    expect(maxOutputTokensForModel('claude-haiku-4-5-20251001')).toBe(8_192);
  });

  it('returns 8192 for an unknown model (safe fallback)', () => {
    expect(maxOutputTokensForModel('some-unknown-model-v99')).toBe(8_192);
  });
});

// ── MessageResponse.stop_reason ───────────────────────────────────────────────

describe("MessageResponse.stop_reason — 'refusal' support for Opus 4.8", () => {
  it("accepts 'refusal' as a stop_reason at runtime", () => {
    const response: MessageResponse = {
      id: 'msg_opus48_refusal_test',
      model: 'claude-opus-4-8',
      role: 'assistant',
      content: [],
      stop_reason: 'refusal',
      usage: { input_tokens: 10, output_tokens: 0 },
    };
    expect(response.stop_reason).toBe('refusal');
  });

  it('preserves all four stop_reason variants (backward compat)', () => {
    // Each value must be assignable to MessageResponse['stop_reason'].
    const reasons: Array<MessageResponse['stop_reason']> = [
      'end_turn',
      'tool_use',
      'max_tokens',
      'refusal',
    ];
    expect(reasons).toHaveLength(4);
    expect(reasons).toContain('end_turn');
    expect(reasons).toContain('tool_use');
    expect(reasons).toContain('max_tokens');
    expect(reasons).toContain('refusal');
  });

  it("accepts 'end_turn' on a non-refusal response (most common case)", () => {
    const response: MessageResponse = {
      id: 'msg_normal',
      model: 'claude-opus-4-8',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    expect(response.stop_reason).toBe('end_turn');
  });
});

// ── CreateMessageOptions.thinking ────────────────────────────────────────────

describe("CreateMessageOptions.thinking — 'adaptive' type for Opus 4.8", () => {
  it("accepts { type: 'adaptive' } without budget_tokens", () => {
    const opts: CreateMessageOptions = {
      model: 'claude-opus-4-8',
      messages: [],
      thinking: { type: 'adaptive' },
    };
    expect(opts.thinking).toEqual({ type: 'adaptive' });
  });

  it("accepts { type: 'enabled', budget_tokens } for backward compatibility", () => {
    const opts: CreateMessageOptions = {
      model: 'claude-opus-4-6',
      messages: [],
      thinking: { type: 'enabled', budget_tokens: 8_000 },
    };
    expect(opts.thinking).toEqual({ type: 'enabled', budget_tokens: 8_000 });
  });

  it('accepts undefined thinking (thinking disabled)', () => {
    const opts: CreateMessageOptions = {
      model: 'claude-sonnet-4-6',
      messages: [],
    };
    expect(opts.thinking).toBeUndefined();
  });
});

// ── CreateMessageOptions.temperature ─────────────────────────────────────────

describe('CreateMessageOptions.temperature — backward compatibility', () => {
  it('accepts temperature for claude-sonnet-4-6', () => {
    const opts: CreateMessageOptions = {
      model: 'claude-sonnet-4-6',
      messages: [],
      temperature: 0.7,
    };
    expect(opts.temperature).toBe(0.7);
  });

  it('accepts temperature for claude-haiku-4-5-20251001', () => {
    const opts: CreateMessageOptions = {
      model: 'claude-haiku-4-5-20251001',
      messages: [],
      temperature: 0.5,
    };
    expect(opts.temperature).toBe(0.5);
  });

  it('accepts temperature=0 (deterministic mode)', () => {
    const opts: CreateMessageOptions = {
      model: 'claude-sonnet-4-6',
      messages: [],
      temperature: 0,
    };
    expect(opts.temperature).toBe(0);
  });
});
