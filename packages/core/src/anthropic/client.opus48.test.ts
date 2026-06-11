import { describe, it, expect } from 'vitest';
import {
  AnthropicClient,
  isOpus48,
  modelMaxOutputCeiling,
  type CreateMessageOptions,
} from './client.js';

const OPUS_48 = 'claude-opus-4-8';
const SONNET = 'claude-sonnet-4-6';
const FABLE = 'claude-fable-5';

function buildBody(options: CreateMessageOptions): Record<string, unknown> {
  const client = new AnthropicClient('test-key');
  // buildRequestBody is private but pure — exercise it directly.
  return (
    client as unknown as {
      buildRequestBody: (o: CreateMessageOptions, s: boolean) => Record<string, unknown>;
    }
  ).buildRequestBody(options, false);
}

describe('isOpus48', () => {
  it('matches opus 4.8 model ids case-insensitively', () => {
    expect(isOpus48('claude-opus-4-8')).toBe(true);
    expect(isOpus48('Claude-Opus-4-8-20260101')).toBe(true);
  });
  it('does not match other models', () => {
    expect(isOpus48('claude-opus-4-6')).toBe(false);
    expect(isOpus48('claude-sonnet-4-6')).toBe(false);
    expect(isOpus48('claude-3-5-haiku')).toBe(false);
  });
});

describe('modelMaxOutputCeiling', () => {
  it('caps opus 4.8 at 128000 (not 131072)', () => {
    expect(modelMaxOutputCeiling(OPUS_48)).toBe(128_000);
  });
  it('caps other opus/sonnet at 64000', () => {
    expect(modelMaxOutputCeiling(SONNET)).toBe(64_000);
    expect(modelMaxOutputCeiling('claude-opus-4-6')).toBe(64_000);
  });
  it('falls back to 8192 for unknown models', () => {
    expect(modelMaxOutputCeiling('some-other-model')).toBe(8_192);
  });
});

describe('buildRequestBody — Opus 4.8 sanitisation', () => {
  it('clamps max_tokens to 128000 for opus 4.8', () => {
    const body = buildBody({ model: OPUS_48, messages: [], maxTokens: 131_072 });
    expect(body.max_tokens).toBe(128_000);
  });

  it('does not raise max_tokens that are already under the ceiling', () => {
    const body = buildBody({ model: OPUS_48, messages: [], maxTokens: 16_384 });
    expect(body.max_tokens).toBe(16_384);
  });

  it('strips temperature for opus 4.8 (would otherwise 400)', () => {
    const body = buildBody({ model: OPUS_48, messages: [], temperature: 0.7 });
    expect(body.temperature).toBeUndefined();
  });

  it('keeps temperature for non-opus-4.8 models', () => {
    const body = buildBody({ model: SONNET, messages: [], temperature: 0.7 });
    expect(body.temperature).toBe(0.7);
  });

  it('forces adaptive thinking and drops manual budget_tokens for opus 4.8', () => {
    const body = buildBody({
      model: OPUS_48,
      messages: [],
      thinking: { type: 'enabled', budget_tokens: 16_000 },
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
  });

  it('passes through enabled thinking with budget_tokens for non-opus-4.8 models', () => {
    const body = buildBody({
      model: SONNET,
      messages: [],
      thinking: { type: 'enabled', budget_tokens: 16_000 },
    });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16_000 });
  });
});

describe('buildRequestBody — forced tool_choice sanitisation', () => {
  const forced = { type: 'tool', name: 'submit_plan' } as const;

  it('downgrades a forced tool_choice to auto for mythos models (Fable 5)', () => {
    const body = buildBody({ model: FABLE, messages: [], toolChoice: forced });
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('downgrades tool_choice:any to auto for mythos models', () => {
    const body = buildBody({ model: FABLE, messages: [], toolChoice: { type: 'any' } });
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('passes a forced tool_choice through unchanged for sonnet', () => {
    const body = buildBody({ model: SONNET, messages: [], toolChoice: forced });
    expect(body.tool_choice).toEqual(forced);
  });

  it('passes a forced tool_choice through unchanged for opus 4.8 (only mythos rejects it)', () => {
    const body = buildBody({ model: OPUS_48, messages: [], toolChoice: forced });
    expect(body.tool_choice).toEqual(forced);
  });

  it('leaves an explicit auto tool_choice as auto for mythos models', () => {
    const body = buildBody({ model: FABLE, messages: [], toolChoice: { type: 'auto' } });
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });
});
