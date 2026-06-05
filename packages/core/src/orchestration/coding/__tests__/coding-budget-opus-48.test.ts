/**
 * @module orchestration/coding/__tests__/coding-budget-opus-48
 *
 * Opus 4.8 compatibility tests for the coding-budget module.
 *
 * Opus 4.8 has distinct pricing from earlier opus models:
 *   Input:  $5/MTok  (vs $15/MTok for opus-4-6 and older)
 *   Output: $25/MTok (vs $75/MTok for opus-4-6 and older)
 *   Cache read:  $0.50/MTok
 *   Cache write: $6.25/MTok
 *
 * Covers:
 * - MODEL_COST_RATES has a separate 'opus-4-8' entry at $5/$25
 * - calculateTokenCost() uses $5/MTok for claude-opus-4-8 input
 * - calculateTokenCost() uses $25/MTok for claude-opus-4-8 output
 * - calculateTokenCost() uses $15/MTok for claude-opus-4-6 input (backward compat)
 * - calculateTokenCost() uses $75/MTok for claude-opus-4-6 output (backward compat)
 * - calculateTokenCost() handles cache tokens with correct opus-4-8 rates
 * - estimateTokenBudget() produces a larger estimate for opus-4-8 vs opus (lower input cost)
 */

import { describe, it, expect } from 'vitest';
import {
  MODEL_COST_RATES,
  calculateTokenCost,
  estimateTokenBudget,
} from '../coding-budget.js';

// ── MODEL_COST_RATES structure ────────────────────────────────────────────────

describe('MODEL_COST_RATES — Opus 4.8 separate pricing entry', () => {
  it("has a dedicated 'opus-4-8' entry distinct from the generic 'opus' entry", () => {
    expect(MODEL_COST_RATES['opus-4-8']).toBeDefined();
    expect(MODEL_COST_RATES['opus']).toBeDefined();
    // The two entries must have different prices.
    expect(MODEL_COST_RATES['opus-4-8']!.input).not.toBe(MODEL_COST_RATES['opus']!.input);
  });

  it("'opus-4-8' input rate is $5/MTok", () => {
    expect(MODEL_COST_RATES['opus-4-8']!.input).toBe(5.00);
  });

  it("'opus-4-8' output rate is $25/MTok", () => {
    expect(MODEL_COST_RATES['opus-4-8']!.output).toBe(25.00);
  });

  it("'opus-4-8' cache-read rate is $0.50/MTok", () => {
    expect(MODEL_COST_RATES['opus-4-8']!.cacheRead).toBe(0.50);
  });

  it("'opus-4-8' cache-write rate is $6.25/MTok", () => {
    expect(MODEL_COST_RATES['opus-4-8']!.cacheWrite).toBe(6.25);
  });
});

describe('MODEL_COST_RATES — backward compatibility (generic opus and other tiers)', () => {
  it("generic 'opus' input rate is $15/MTok (covers opus-4-6 and older)", () => {
    expect(MODEL_COST_RATES['opus']!.input).toBe(15.00);
  });

  it("generic 'opus' output rate is $75/MTok", () => {
    expect(MODEL_COST_RATES['opus']!.output).toBe(75.00);
  });

  it("'sonnet' input rate is $3/MTok", () => {
    expect(MODEL_COST_RATES['sonnet']!.input).toBe(3.00);
  });

  it("'haiku' input rate is $0.80/MTok", () => {
    expect(MODEL_COST_RATES['haiku']!.input).toBe(0.80);
  });
});

// ── calculateTokenCost — Opus 4.8 pricing ────────────────────────────────────

describe('calculateTokenCost — Opus 4.8 ($5/$25 pricing)', () => {
  it('calculates $5.00 for 1M input tokens with claude-opus-4-8', () => {
    const cost = calculateTokenCost('claude-opus-4-8', 1_000_000, 0);
    expect(cost).toBeCloseTo(5.00, 4);
  });

  it('calculates $25.00 for 1M output tokens with claude-opus-4-8', () => {
    const cost = calculateTokenCost('claude-opus-4-8', 0, 1_000_000);
    expect(cost).toBeCloseTo(25.00, 4);
  });

  it('handles a timestamped claude-opus-4-8 variant correctly', () => {
    const cost = calculateTokenCost('claude-opus-4-8-20260601', 1_000_000, 0);
    expect(cost).toBeCloseTo(5.00, 4);
  });

  it('calculates combined input+output cost correctly', () => {
    // 500K input @ $5/MTok = $2.50; 100K output @ $25/MTok = $2.50 → total $5.00
    const cost = calculateTokenCost('claude-opus-4-8', 500_000, 100_000);
    expect(cost).toBeCloseTo(5.00, 4);
  });

  it('includes cache-read tokens at $0.50/MTok', () => {
    // Isolate cache-read cost: pass 0 input/output so only cacheRead contributes.
    // 1M cache reads @ $0.50/MTok = $0.50
    const cost = calculateTokenCost('claude-opus-4-8', 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(0.50, 4);
  });

  it('includes cache-write tokens at $6.25/MTok', () => {
    // 1M cache writes @ $6.25/MTok = $6.25
    const cost = calculateTokenCost('claude-opus-4-8', 0, 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(6.25, 4);
  });
});

// ── calculateTokenCost — backward compat (existing models) ───────────────────

describe('calculateTokenCost — backward compatibility (opus-4-6 at $15/$75)', () => {
  it('calculates $15.00 for 1M input tokens with claude-opus-4-6', () => {
    const cost = calculateTokenCost('claude-opus-4-6', 1_000_000, 0);
    expect(cost).toBeCloseTo(15.00, 4);
  });

  it('calculates $75.00 for 1M output tokens with claude-opus-4-6', () => {
    const cost = calculateTokenCost('claude-opus-4-6', 0, 1_000_000);
    expect(cost).toBeCloseTo(75.00, 4);
  });
});

describe('calculateTokenCost — backward compatibility (sonnet and haiku)', () => {
  it('calculates $3.00 for 1M input tokens with claude-sonnet-4-6', () => {
    const cost = calculateTokenCost('claude-sonnet-4-6', 1_000_000, 0);
    expect(cost).toBeCloseTo(3.00, 4);
  });

  it('calculates $0.80 for 1M input tokens with claude-haiku-4-5', () => {
    const cost = calculateTokenCost('claude-haiku-4-5-20251001', 1_000_000, 0);
    expect(cost).toBeCloseTo(0.80, 4);
  });
});

// ── estimateTokenBudget — Opus 4.8 budget efficiency ─────────────────────────

describe('estimateTokenBudget — Opus 4.8 vs generic opus budget efficiency', () => {
  it('estimates a larger input token budget for opus-4-8 vs opus-4-6 at the same USD budget', () => {
    // opus-4-8 input is $5/MTok; opus-4-6 is $15/MTok — so same USD buys 3× more tokens.
    const budgetFor48 = estimateTokenBudget('reviewer', 5.00, 'claude-opus-4-8');
    const budgetFor46 = estimateTokenBudget('reviewer', 5.00, 'claude-opus-4-6');
    expect(budgetFor48).toBeGreaterThan(budgetFor46);
  });

  it('returns 0 for validator role (TOOL node — no token budget)', () => {
    expect(estimateTokenBudget('validator', 5.00, 'claude-opus-4-8')).toBe(0);
  });
});
