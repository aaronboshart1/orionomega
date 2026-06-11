/**
 * @module models/__tests__/model-registry
 *
 * Tests for the declarative model capability registry (Task #229 / R2).
 *
 * Covers:
 * - Capability lookup by canonical ID, alias, and dated-variant substring
 * - opus-4-8 entry (128K ceiling, adaptive thinking, fast mode, $5/$25 pricing)
 * - fable-5 entry (mythos tier, access-gated)
 * - Tier inference incl. the mythos tier for fable models
 * - Tier-default synthesis for unknown models
 * - Override precedence: config > discovery > defaults
 * - Effort alias normalisation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getModelCapability,
  inferModelTier,
  seedRegistryFromDiscovery,
  applyRegistryOverrides,
  resetModelRegistry,
  normalizeModelEffort,
  ModelRegistry,
} from '../model-registry.js';

beforeEach(() => {
  resetModelRegistry();
});

// ── Lookup ────────────────────────────────────────────────────────────────────

describe('getModelCapability — lookup', () => {
  it('resolves opus-4-8 by canonical ID with the right capabilities', () => {
    const cap = getModelCapability('claude-opus-4-8');
    expect(cap.tier).toBe('opus');
    expect(cap.maxOutput).toBe(128_000);
    expect(cap.defaultMaxOutput).toBe(128_000);
    expect(cap.thinking).toBe('adaptive');
    expect(cap.supportsSampling).toBe(false);
    // Opus 4.8 still accepts a forced tool_choice (only mythos rejects it).
    expect(cap.supportsForcedToolChoice).toBe(true);
    expect(cap.supportsMidConversationSystem).toBe(true);
    expect(cap.fastMode?.betaHeader).toBe('fast-mode-2026-02-01');
    expect(cap.accessGated).toBe(false);
    expect(cap.pricing).toEqual({ in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  it('resolves a dated opus-4-8 variant via alias substring', () => {
    const cap = getModelCapability('claude-opus-4-8-20260601');
    expect(cap.tier).toBe('opus');
    expect(cap.maxOutput).toBe(128_000);
    expect(cap.pricing.in).toBe(5);
  });

  it('is case-insensitive', () => {
    expect(getModelCapability('Claude-Opus-4-8').maxOutput).toBe(128_000);
  });

  it('resolves opus-4-6 to generic opus defaults (64K ceiling, $15/$75)', () => {
    const cap = getModelCapability('claude-opus-4-6');
    expect(cap.tier).toBe('opus');
    expect(cap.maxOutput).toBe(64_000);
    expect(cap.defaultMaxOutput).toBe(16_384);
    expect(cap.pricing.in).toBe(15);
    expect(cap.thinking).toBe('budget');
    expect(cap.supportsSampling).toBe(true);
  });

  it('resolves fable-5 as a gated mythos-tier model', () => {
    const cap = getModelCapability('claude-fable-5');
    expect(cap.tier).toBe('mythos');
    expect(cap.accessGated).toBe(true);
    expect(cap.thinking).toBe('adaptive');
    expect(cap.supportsSampling).toBe(false);
    // Mythos rejects a forced tool_choice (400) — must run with auto.
    expect(cap.supportsForcedToolChoice).toBe(false);
    expect(cap.maxOutput).toBe(128_000);
  });

  it('resolves the `fable` alias to the mythos entry', () => {
    expect(getModelCapability('claude-fable-5-20260901').tier).toBe('mythos');
  });

  it('synthesises sonnet-tier defaults for an unknown model', () => {
    const cap = getModelCapability('some-unknown-model-v99');
    expect(cap.tier).toBe('unknown');
    expect(cap.maxOutput).toBe(8_192);
    // Unknown pricing mirrors sonnet (historical fallback).
    expect(cap.pricing.in).toBe(3);
  });

  it('synthesises opus-tier defaults for an unregistered opus variant', () => {
    const cap = getModelCapability('claude-opus-4-9');
    expect(cap.tier).toBe('opus');
    expect(cap.maxOutput).toBe(64_000);
    expect(cap.pricing.in).toBe(15);
  });
});

// ── Tier inference ──────────────────────────────────────────────────────────

describe('inferModelTier', () => {
  it('maps fable models to the mythos tier (above opus)', () => {
    expect(inferModelTier('claude-fable-5')).toBe('mythos');
    expect(inferModelTier('something-mythos')).toBe('mythos');
  });

  it('maps the classic families', () => {
    expect(inferModelTier('claude-opus-4-8')).toBe('opus');
    expect(inferModelTier('claude-sonnet-4-6')).toBe('sonnet');
    expect(inferModelTier('claude-haiku-4-5')).toBe('haiku');
  });

  it('returns unknown for unrecognised IDs', () => {
    expect(inferModelTier('gpt-9')).toBe('unknown');
  });
});

// ── Override precedence: config > discovery > defaults ────────────────────────

describe('registry precedence', () => {
  it('config overrides win over built-in defaults', () => {
    applyRegistryOverrides([{ id: 'claude-opus-4-8', pricing: { in: 9, out: 40, cacheRead: 1, cacheWrite: 11 } }]);
    const cap = getModelCapability('claude-opus-4-8');
    expect(cap.pricing.in).toBe(9);
    expect(cap.pricing.out).toBe(40);
    // Non-overridden fields are preserved.
    expect(cap.maxOutput).toBe(128_000);
    expect(cap.thinking).toBe('adaptive');
  });

  it('discovery adds genuinely-new models but never overwrites defaults', () => {
    // opus-4-8 is a default; discovery claiming a different tier must NOT win.
    seedRegistryFromDiscovery([
      { id: 'claude-opus-4-8', tier: 'sonnet' },
      { id: 'claude-newmodel-1', tier: 'haiku' },
    ]);
    expect(getModelCapability('claude-opus-4-8').tier).toBe('opus');
    expect(getModelCapability('claude-newmodel-1').tier).toBe('haiku');
  });

  it('config beats discovery for the same model', () => {
    seedRegistryFromDiscovery([{ id: 'claude-experimental-1', tier: 'sonnet' }]);
    applyRegistryOverrides([{ id: 'claude-experimental-1', tier: 'opus', pricing: { in: 20, out: 80, cacheRead: 2, cacheWrite: 25 } }]);
    const cap = getModelCapability('claude-experimental-1');
    expect(cap.tier).toBe('opus');
    expect(cap.pricing.in).toBe(20);
  });

  it('registers a brand-new model entirely from a config override', () => {
    applyRegistryOverrides([{ id: 'claude-custom-9', tier: 'mythos', accessGated: false }]);
    const cap = getModelCapability('claude-custom-9');
    expect(cap.tier).toBe('mythos');
    expect(cap.accessGated).toBe(false);
    // Tier defaults fill the rest.
    expect(cap.thinking).toBe('adaptive');
  });
});

// ── Effort normalisation ─────────────────────────────────────────────────────

describe('normalizeModelEffort', () => {
  it('passes max through unchanged for opus-4-8 (supports max natively)', () => {
    expect(normalizeModelEffort('claude-opus-4-8', 'max')).toBe('max');
  });

  it('aliases max → xhigh for sonnet-tier models', () => {
    expect(normalizeModelEffort('claude-sonnet-4-6', 'max')).toBe('xhigh');
  });

  it('aliases xhigh → high for haiku-tier models', () => {
    expect(normalizeModelEffort('claude-haiku-4-5', 'xhigh')).toBe('high');
  });
});

// ── Isolated instances ───────────────────────────────────────────────────────

describe('ModelRegistry (isolated instance)', () => {
  it('does not share state with the singleton', () => {
    const reg = new ModelRegistry();
    reg.applyOverrides([{ id: 'claude-opus-4-8', pricing: { in: 1, out: 1, cacheRead: 1, cacheWrite: 1 } }]);
    expect(reg.resolve('claude-opus-4-8').pricing.in).toBe(1);
    // Singleton is unaffected.
    expect(getModelCapability('claude-opus-4-8').pricing.in).toBe(5);
  });
});
