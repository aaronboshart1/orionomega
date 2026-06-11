/**
 * @module orchestration/__tests__/model-fallback
 *
 * Task #230 — unit tests for the "model unavailable / forbidden / not entitled"
 * classification helpers and the registry-driven fallback selector.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ModelUnavailableError,
  isModelUnavailableMessage,
  isModelUnavailableError,
} from '../model-fallback.js';
import {
  selectFallbackModel,
  resetModelRegistry,
  TIER_RANK,
  type ModelCapability,
} from '../../models/model-registry.js';

beforeEach(() => {
  resetModelRegistry();
});

describe('isModelUnavailableMessage — positive cases', () => {
  const positives = [
    'Your account does not have access to the model claude-fable-5',
    'You are not entitled to use this model',
    'Missing entitlement for claude-fable-5',
    'model_not_found: claude-fable-5',
    'No access to model claude-fable-5',
    'Error: unknown model "claude-fable-5"',
    'invalid model: claude-foo',
    'unsupported model requested',
    'This model requires special access',
    'The model claude-fable-5 is not available in your region',
    'model claude-fable-5 is gated',
    'not allowed for model claude-fable-5',
    'access-gated model',
  ];
  for (const msg of positives) {
    it(`matches: ${msg}`, () => {
      expect(isModelUnavailableMessage(msg)).toBe(true);
    });
  }
});

describe('isModelUnavailableMessage — negative cases (no false positives)', () => {
  const negatives = [
    '',
    'Request timed out after 30s',
    'ECONNRESET',
    'rate limit exceeded (429)',
    'internal server error (500)',
    'Agent failed: schema validation error',
    'Invalid API key',
    'file not found: ./missing.txt',
    'authentication failed',
  ];
  for (const msg of negatives) {
    it(`does not match: ${msg || '(empty)'}`, () => {
      expect(isModelUnavailableMessage(msg)).toBe(false);
    });
  }

  it('handles null/undefined safely', () => {
    expect(isModelUnavailableMessage(undefined)).toBe(false);
    expect(isModelUnavailableMessage(null)).toBe(false);
  });
});

describe('ModelUnavailableError', () => {
  it('carries requestedModel + reason and is detected by isModelUnavailableError', () => {
    const err = new ModelUnavailableError('claude-fable-5', 'not entitled');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ModelUnavailableError');
    expect(err.requestedModel).toBe('claude-fable-5');
    expect(err.reason).toBe('not entitled');
    expect(isModelUnavailableError(err)).toBe(true);
  });

  it('isModelUnavailableError also matches plain Error messages and strings', () => {
    expect(isModelUnavailableError(new Error('does not have access to model x'))).toBe(true);
    expect(isModelUnavailableError('not entitled')).toBe(true);
    expect(isModelUnavailableError(new Error('timeout'))).toBe(false);
    expect(isModelUnavailableError(42)).toBe(false);
  });
});

describe('selectFallbackModel — registry-driven tier degradation', () => {
  it('degrades a gated mythos model (Fable 5) to opus-4-8', () => {
    const fb = selectFallbackModel('claude-fable-5');
    expect(fb).not.toBeNull();
    expect(fb!.id).toBe('claude-opus-4-8');
    expect(fb!.tier).toBe('opus');
  });

  it('prefers the newer dated variant on a tier tie (opus-4-8 over opus-4-6)', () => {
    const fb = selectFallbackModel('claude-fable-5');
    expect(fb!.id).toBe('claude-opus-4-8');
  });

  it('excludes already-tried models and walks one tier further', () => {
    // Exclude both opus entries → next-best available tier is sonnet.
    const fb = selectFallbackModel('claude-fable-5', {
      exclude: ['claude-opus-4-8', 'claude-opus-4-6'],
    });
    expect(fb).not.toBeNull();
    expect(fb!.tier).toBe('sonnet');
    expect(fb!.id).toBe('claude-sonnet-4-6');
  });

  it('degrades opus → sonnet', () => {
    const fb = selectFallbackModel('claude-opus-4-8');
    expect(fb!.tier).toBe('sonnet');
  });

  it('returns null when nothing lower-tier is available (haiku is the floor)', () => {
    expect(selectFallbackModel('claude-haiku-4-5')).toBeNull();
  });

  it('never selects an access-gated model as the fallback', () => {
    // Seed a second gated model below mythos is impossible (mythos is top), but
    // assert the default gated fable model is never returned for an opus request.
    const fb = selectFallbackModel('claude-opus-4-8');
    expect(fb!.accessGated).toBe(false);
  });

  it('honours an explicitly supplied capabilities pool (requested tier still from registry)', () => {
    // The requested model's tier is resolved from the shared registry
    // (claude-fable-5 → mythos); the supplied list is the candidate pool.
    const caps: ModelCapability[] = [
      { id: 'o-mid', aliases: [], tier: 'opus', contextWindow: 1, maxOutput: 1, defaultMaxOutput: 1, thinking: 'budget', supportsSampling: true, supportsForcedToolChoice: true, supportsMidConversationSystem: false, supportedEfforts: ['low'], effortAliases: {}, pricing: { in: 1, out: 1, cacheRead: 1, cacheWrite: 1 }, betaHeaders: [], accessGated: false },
      { id: 'g-gated', aliases: [], tier: 'opus', contextWindow: 1, maxOutput: 1, defaultMaxOutput: 1, thinking: 'budget', supportsSampling: true, supportsForcedToolChoice: true, supportsMidConversationSystem: false, supportedEfforts: ['low'], effortAliases: {}, pricing: { in: 1, out: 1, cacheRead: 1, cacheWrite: 1 }, betaHeaders: [], accessGated: true },
    ];
    const fb = selectFallbackModel('claude-fable-5', { capabilities: caps });
    // g-gated is skipped (accessGated); o-mid is the only eligible candidate.
    expect(fb!.id).toBe('o-mid');
  });
});

describe('TIER_RANK ordering', () => {
  it('ranks mythos > opus > sonnet > haiku > unknown', () => {
    expect(TIER_RANK.mythos).toBeGreaterThan(TIER_RANK.opus);
    expect(TIER_RANK.opus).toBeGreaterThan(TIER_RANK.sonnet);
    expect(TIER_RANK.sonnet).toBeGreaterThan(TIER_RANK.haiku);
    expect(TIER_RANK.haiku).toBeGreaterThan(TIER_RANK.unknown);
    expect(TIER_RANK.unknown).toBe(0);
  });
});
