/**
 * Tests for hybrid lexical+vector recall.
 *
 * Covers the pure scoring primitives (cosine, combine, hybrid) and the
 * end-to-end client behaviour: when an EmbeddingProvider is wired up, the
 * all-zero-relevance fallback path blends a vector channel so a synonym-only
 * match outranks a lexically-closer-but-semantically-wrong one. Embedding
 * failures must degrade to lexical-only without throwing.
 *
 * global.fetch is mocked so no server is required.
 */

import { describe, it, expect, vi } from 'vitest';
import { HindsightClient } from '../client.js';
import {
  cosineSimilarity, combineRelevance, computeHybridRelevance,
  localEmbedding, computeClientRelevance,
  type EmbeddingProvider,
} from '../similarity.js';

const BASE_URL = 'http://test-server';

function makeRecallFetch(results: Array<{ content: string; context?: string; timestamp?: string; relevance?: number }>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      results: results.map((r) => ({
        content: r.content,
        context: r.context ?? 'lesson',
        timestamp: r.timestamp ?? new Date().toISOString(),
        relevance: r.relevance ?? 0,
      })),
    }),
  } as unknown as Response);
}

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

describe('HindsightClient hybrid recall (all-zero fallback path)', () => {
  // A toy semantic provider: maps known phrases to fixed unit vectors so we
  // can assert ranking deterministically.
  function provider(map: Record<string, number[]>): EmbeddingProvider {
    const fallback = [0, 0, 1];
    return {
      dimensions: 3,
      async embed(texts: string[]) {
        return texts.map((t) => map[t] ?? fallback);
      },
    };
  }

  it('re-ranks via the vector channel so the semantic match wins', async () => {
    const query = 'feline';
    const semanticHit = 'a cat sat on the mat';
    const lexicalDecoy = 'feline feline feline unrelated topic entirely';

    // Vectors: query aligns strongly with the semantic hit, weakly with decoy.
    const emb = provider({
      [query]: [1, 0, 0],
      [semanticHit]: [1, 0, 0],
      [lexicalDecoy]: [0, 1, 0],
    });

    const client = new HindsightClient(BASE_URL, 'default', undefined, {
      embeddingProvider: emb,
      vectorWeight: 0.9,
    });
    expect(client.vectorRecallEnabled).toBe(true);

    global.fetch = makeRecallFetch([
      { content: lexicalDecoy, relevance: 0 },
      { content: semanticHit, relevance: 0 },
    ]);

    const res = await client.recall('bank', query, { minRelevance: 0 });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].content).toBe(semanticHit);
  });

  it('falls back to lexical-only when the provider throws', async () => {
    const failing: EmbeddingProvider = {
      async embed() { throw new Error('model offline'); },
    };
    const client = new HindsightClient(BASE_URL, 'default', undefined, {
      embeddingProvider: failing,
    });

    global.fetch = makeRecallFetch([
      { content: 'the gateway port binds to 8000', relevance: 0 },
    ]);

    // Should not throw; results scored by lexical proxy.
    const res = await client.recall('bank', 'gateway port', { minRelevance: 0 });
    expect(res.results.length).toBe(1);
    expect(res.results[0].relevance).toBeGreaterThan(0);
  });

  it('falls back to lexical-only on batch-size mismatch', async () => {
    const wrongSize: EmbeddingProvider = {
      async embed() { return [[1, 0, 0]]; }, // too few vectors
    };
    const client = new HindsightClient(BASE_URL, 'default', undefined, {
      embeddingProvider: wrongSize,
    });

    global.fetch = makeRecallFetch([
      { content: 'alpha content here', relevance: 0 },
      { content: 'beta content here', relevance: 0 },
    ]);

    const res = await client.recall('bank', 'alpha', { minRelevance: 0 });
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('does not invoke embeddings when the API already returned relevance', async () => {
    const spy = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
    const client = new HindsightClient(BASE_URL, 'default', undefined, {
      embeddingProvider: { embed: spy },
    });

    global.fetch = makeRecallFetch([
      { content: 'already scored', relevance: 0.7 },
    ]);

    await client.recall('bank', 'query', { minRelevance: 0 });
    expect(spy).not.toHaveBeenCalled();
  });
});
