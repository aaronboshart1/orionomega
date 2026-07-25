/**
 * Pure scoring primitives for hybrid lexical+vector recall.
 *
 * These cover the pure helpers exported by `@orionomega/shared/similarity`.
 * They are standalone primitives, not the live retrieval path: recall ranks
 * records with `computeClientRelevance` alone (lexical keyword + trigram), so
 * the vector/hybrid helpers below are exercised here and nowhere else.
 */

import { describe, it, expect } from 'vitest';
import {
  cosineSimilarity, combineRelevance, computeHybridRelevance,
  localEmbedding, computeClientRelevance,
} from '../similarity.js';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors, 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns 0 for empty or zero vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('compares only the overlapping prefix for mismatched lengths', () => {
    expect(cosineSimilarity([1, 0, 5], [1, 0])).toBeCloseTo(1, 6);
  });
});

describe('combineRelevance', () => {
  it('passes lexical through unchanged when no vector', () => {
    expect(combineRelevance(0.42, undefined)).toBeCloseTo(0.42, 6);
    expect(combineRelevance(0.42, NaN)).toBeCloseTo(0.42, 6);
  });

  it('clamps negative cosine to zero (anti-correlation is no signal)', () => {
    expect(combineRelevance(0.5, -0.9, 0.5)).toBeCloseTo(0.25, 6);
  });

  it('honours vectorWeight extremes', () => {
    expect(combineRelevance(0.2, 0.8, 0)).toBeCloseTo(0.2, 6); // lexical only
    expect(combineRelevance(0.2, 0.8, 1)).toBeCloseTo(0.8, 6); // vector only
  });

  it('clamps weight outside [0,1]', () => {
    expect(combineRelevance(0.2, 0.8, 5)).toBeCloseTo(0.8, 6);
    expect(combineRelevance(0.2, 0.8, -5)).toBeCloseTo(0.2, 6);
  });
});

describe('computeHybridRelevance', () => {
  it('equals the lexical score when embeddings absent', () => {
    const q = 'how do I configure the gateway port';
    const c = 'the gateway port can be configured via env';
    expect(computeHybridRelevance(q, c)).toBeCloseTo(computeClientRelevance(q, c), 6);
  });

  it('lifts the score when a synonym embedding aligns', () => {
    const q = 'car';
    const c = 'automobile';
    const lexical = computeClientRelevance(q, c);
    // Hand-built aligned vectors stand in for a semantic model.
    const hybrid = computeHybridRelevance(q, c, {
      queryEmbedding: [1, 0, 0],
      contentEmbedding: [1, 0, 0],
      vectorWeight: 0.6,
    });
    expect(hybrid).toBeGreaterThan(lexical);
  });
});

describe('localEmbedding', () => {
  it('is deterministic and L2-normalised', () => {
    const a = localEmbedding('the quick brown fox');
    const b = localEmbedding('the quick brown fox');
    expect(a).toEqual(b);
    const mag = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(mag).toBeCloseTo(1, 6);
  });

  it('produces an all-zero vector for empty input', () => {
    const v = localEmbedding('');
    expect(v.every((x) => x === 0)).toBe(true);
  });
});
