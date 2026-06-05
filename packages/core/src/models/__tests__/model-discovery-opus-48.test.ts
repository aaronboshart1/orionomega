/**
 * @module models/__tests__/model-discovery-opus-48
 *
 * Opus 4.8 compatibility tests for the model-discovery module.
 *
 * Covers:
 * - discoverModels() assigns 'opus' tier to claude-opus-4-8 (tier inference)
 * - discoverModels() sorts models newest-first so opus-4-8 precedes opus-4-6
 * - pickModelByTier() selects claude-opus-4-8 as the best opus model
 * - buildModelGuide() presents claude-opus-4-8 correctly as the heavyweight option
 * - Backward compatibility: opus-4-6, sonnet-4-6, haiku-4-5 tier correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  discoverModels,
  pickModelByTier,
  buildModelGuide,
  clearModelCache,
  type DiscoveredModel,
} from '../model-discovery.js';

/** Minimal DiscoveredModel factory for fixtures that bypass the live API. */
function makeModel(
  id: string,
  tier: DiscoveredModel['tier'],
  createdAt = '2026-01-01T00:00:00Z',
): DiscoveredModel {
  return { id, displayName: id, createdAt, tier };
}

// ── discoverModels — tier inference via mocked fetch ─────────────────────────

describe('discoverModels — Opus 4.8 tier detection', () => {
  beforeEach(() => {
    clearModelCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearModelCache();
  });

  it("assigns 'opus' tier to claude-opus-4-8", async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'claude-opus-4-8',
            display_name: 'Claude Opus 4.8',
            created_at: '2026-06-01T00:00:00Z',
          },
        ],
        has_more: false,
      }),
    }));

    const models = await discoverModels('test-key');
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe('claude-opus-4-8');
    expect(models[0]!.tier).toBe('opus');
  });

  it("assigns 'opus' tier to a timestamped claude-opus-4-8 variant", async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-opus-4-8-20260601', created_at: '2026-06-01T00:00:00Z' },
        ],
        has_more: false,
      }),
    }));

    const models = await discoverModels('test-key');
    expect(models[0]!.tier).toBe('opus');
  });

  it('returns claude-opus-4-8 before claude-opus-4-6 (newest-first sort)', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        data: [
          // API may return in any order; discoverModels must sort by created_at desc.
          { id: 'claude-opus-4-6', created_at: '2025-06-01T00:00:00Z' },
          { id: 'claude-opus-4-8', created_at: '2026-06-01T00:00:00Z' },
        ],
        has_more: false,
      }),
    }));

    const models = await discoverModels('test-key');
    expect(models[0]!.id).toBe('claude-opus-4-8');
    expect(models[1]!.id).toBe('claude-opus-4-6');
  });

  it('correctly tiers a mixed Claude 4 model list', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-opus-4-8',          created_at: '2026-06-01T00:00:00Z' },
          { id: 'claude-sonnet-4-6',         created_at: '2025-06-01T00:00:00Z' },
          { id: 'claude-haiku-4-5-20251001', created_at: '2025-10-01T00:00:00Z' },
        ],
        has_more: false,
      }),
    }));

    const models = await discoverModels('test-key');
    const byId = Object.fromEntries(models.map((m) => [m.id, m.tier]));
    expect(byId['claude-opus-4-8']).toBe('opus');
    expect(byId['claude-sonnet-4-6']).toBe('sonnet');
    expect(byId['claude-haiku-4-5-20251001']).toBe('haiku');
  });
});

// ── pickModelByTier — Opus 4.8 selection ─────────────────────────────────────

describe('pickModelByTier — Opus 4.8 selection', () => {
  const opus48  = makeModel('claude-opus-4-8',          'opus',   '2026-06-01T00:00:00Z');
  const opus46  = makeModel('claude-opus-4-6',          'opus',   '2025-06-01T00:00:00Z');
  const sonnet46 = makeModel('claude-sonnet-4-6',       'sonnet');
  const haiku45  = makeModel('claude-haiku-4-5',        'haiku');

  it('picks claude-opus-4-8 when it is the sole opus model', () => {
    const models = [opus48, sonnet46, haiku45];
    expect(pickModelByTier(models, 'opus')?.id).toBe('claude-opus-4-8');
  });

  it('picks claude-opus-4-8 over claude-opus-4-6 when sorted newest-first', () => {
    // List is already sorted newest-first (as discoverModels delivers it).
    const models = [opus48, opus46, sonnet46, haiku45];
    expect(pickModelByTier(models, 'opus')?.id).toBe('claude-opus-4-8');
  });

  it('falls back to the first available model when no opus model exists', () => {
    const models = [sonnet46, haiku45];
    // Falls back to models[0] — matches documented fallback behaviour.
    expect(pickModelByTier(models, 'opus')?.id).toBe('claude-sonnet-4-6');
  });

  it('returns undefined when the model list is empty', () => {
    expect(pickModelByTier([], 'opus')).toBeUndefined();
  });

  it('picks the correct tier for sonnet requests', () => {
    const models = [opus48, sonnet46, haiku45];
    expect(pickModelByTier(models, 'sonnet')?.id).toBe('claude-sonnet-4-6');
  });

  it('picks the correct tier for haiku requests', () => {
    const models = [opus48, sonnet46, haiku45];
    expect(pickModelByTier(models, 'haiku')?.id).toBe('claude-haiku-4-5');
  });
});

// ── buildModelGuide — Opus 4.8 guide presentation ────────────────────────────

describe('buildModelGuide — Opus 4.8 presentation', () => {
  const opus48  = makeModel('claude-opus-4-8',   'opus');
  const sonnet46 = makeModel('claude-sonnet-4-6', 'sonnet');
  const haiku45  = makeModel('claude-haiku-4-5',  'haiku');
  const allModels = [opus48, sonnet46, haiku45];

  it('includes claude-opus-4-8 in the guide as the HEAVYWEIGHT option', () => {
    const guide = buildModelGuide(allModels, 'claude-sonnet-4-6');
    expect(guide).toContain('claude-opus-4-8');
    expect(guide).toContain('HEAVYWEIGHT');
  });

  it('marks claude-opus-4-8 as the main-model fallback when it is the default', () => {
    const guide = buildModelGuide(allModels, 'claude-opus-4-8');
    expect(guide).toContain('"claude-opus-4-8"');
  });

  it('includes tier selection rules for opus, sonnet, and haiku tiers', () => {
    const guide = buildModelGuide(allModels, 'claude-sonnet-4-6');
    expect(guide).toContain('opus-tier');
    expect(guide).toContain('sonnet-tier');
    expect(guide).toContain('haiku-tier');
  });

  it('instructs the planner to use only models from the list', () => {
    const guide = buildModelGuide(allModels, 'claude-sonnet-4-6');
    expect(guide).toContain('Do not invent newer or older variants');
  });

  it('returns a non-empty fallback guide when no models are discovered', () => {
    const guide = buildModelGuide([], 'claude-opus-4-8');
    expect(guide).toContain('claude-opus-4-8');
    expect(guide.length).toBeGreaterThan(0);
  });
});

// ── Backward compatibility — existing model tier detection ────────────────────

describe('discoverModels — backward compatibility (existing models)', () => {
  beforeEach(() => clearModelCache());
  afterEach(() => { vi.unstubAllGlobals(); clearModelCache(); });

  it("assigns 'opus' tier to claude-opus-4-6", async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-opus-4-6', created_at: '2025-06-01T00:00:00Z' }],
        has_more: false,
      }),
    }));
    const models = await discoverModels('test-key');
    expect(models[0]!.tier).toBe('opus');
  });

  it("assigns 'sonnet' tier to claude-sonnet-4-6", async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-sonnet-4-6', created_at: '2025-06-01T00:00:00Z' }],
        has_more: false,
      }),
    }));
    const models = await discoverModels('test-key');
    expect(models[0]!.tier).toBe('sonnet');
  });

  it("assigns 'haiku' tier to claude-haiku-4-5-20251001", async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'claude-haiku-4-5-20251001', created_at: '2025-10-01T00:00:00Z' }],
        has_more: false,
      }),
    }));
    const models = await discoverModels('test-key');
    expect(models[0]!.tier).toBe('haiku');
  });
});
