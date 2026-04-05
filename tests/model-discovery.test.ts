#!/usr/bin/env tsx
/**
 * Unit tests for models/model-discovery.ts
 * Tests: pickModelByTier, buildModelGuide
 */

import { suite, section, assert, assertEq, printSummary, resetResults } from './test-harness.js';
import { pickModelByTier, buildModelGuide } from '../packages/core/src/models/model-discovery.js';
import type { DiscoveredModel } from '../packages/core/src/models/model-discovery.js';

// ── Helper ──────────────────────────────────────────────────────

function makeModel(id: string, tier: DiscoveredModel['tier'], createdAt = '2025-01-01'): DiscoveredModel {
  return {
    id,
    displayName: id.replace(/-/g, ' '),
    createdAt,
    tier,
  };
}

const sampleModels: DiscoveredModel[] = [
  makeModel('claude-opus-4-6', 'opus', '2025-05-01'),
  makeModel('claude-sonnet-4-6', 'sonnet', '2025-05-01'),
  makeModel('claude-sonnet-4-5-20250514', 'sonnet', '2025-04-01'),
  makeModel('claude-haiku-4-5-20251001', 'haiku', '2025-03-01'),
];

// ── Tests ───────────────────────────────────────────────────────

resetResults();
suite('Model Discovery — pickModelByTier, buildModelGuide');

// ── pickModelByTier ─────────────────────────────────────────────

section('pickModelByTier — exact tier match');
{
  const result = pickModelByTier(sampleModels, 'opus');
  assertEq(result?.id, 'claude-opus-4-6', 'finds opus model');
}

section('pickModelByTier — sonnet returns first sonnet');
{
  const result = pickModelByTier(sampleModels, 'sonnet');
  assertEq(result?.id, 'claude-sonnet-4-6', 'returns newest sonnet');
}

section('pickModelByTier — haiku');
{
  const result = pickModelByTier(sampleModels, 'haiku');
  assertEq(result?.id, 'claude-haiku-4-5-20251001', 'finds haiku model');
}

section('pickModelByTier — fallback when tier not found');
{
  const sonnetsOnly = sampleModels.filter(m => m.tier === 'sonnet');
  const result = pickModelByTier(sonnetsOnly, 'opus');
  assertEq(result?.id, 'claude-sonnet-4-6', 'falls back to first model when tier missing');
}

section('pickModelByTier — empty list');
{
  const result = pickModelByTier([], 'opus');
  assertEq(result, undefined, 'returns undefined for empty list');
}

// ── buildModelGuide ─────────────────────────────────────────────

section('buildModelGuide — empty models');
{
  const guide = buildModelGuide([], 'claude-sonnet-4-6');
  assert(guide.includes('claude-sonnet-4-6'), 'mentions fallback model');
  assert(guide.includes('no model list available'), 'indicates no models');
}

section('buildModelGuide — with full model list');
{
  const guide = buildModelGuide(sampleModels, 'claude-sonnet-4-6');
  assert(guide.includes('claude-opus-4-6'), 'includes opus model');
  assert(guide.includes('claude-sonnet-4-6'), 'includes sonnet model');
  assert(guide.includes('claude-haiku-4-5-20251001'), 'includes haiku model');
  assert(guide.includes('HEAVYWEIGHT'), 'labels opus as heavyweight');
  assert(guide.includes('MIDWEIGHT'), 'labels sonnet as midweight');
  assert(guide.includes('LIGHTWEIGHT'), 'labels haiku as lightweight');
}

section('buildModelGuide — model selection rules');
{
  const guide = buildModelGuide(sampleModels, 'claude-sonnet-4-6');
  assert(guide.includes('Model selection rules'), 'contains selection rules');
  assert(guide.includes('Default to the midweight'), 'recommends midweight default');
  assert(guide.includes('main agent model'), 'mentions main agent model');
}

section('buildModelGuide — partial tiers');
{
  const haikuOnly = [makeModel('claude-haiku-4-5-20251001', 'haiku')];
  const guide = buildModelGuide(haikuOnly, 'claude-haiku-4-5-20251001');
  assert(guide.includes('LIGHTWEIGHT'), 'includes haiku tier');
  assert(!guide.includes('HEAVYWEIGHT'), 'no opus label when not present');
  assert(!guide.includes('MIDWEIGHT'), 'no sonnet label when not present');
}

const ok = printSummary('Model Discovery Tests');
process.exit(ok ? 0 : 1);
