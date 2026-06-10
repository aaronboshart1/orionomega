/**
 * Tests for the dedup speedup primitives.
 *
 * The central correctness property: the bloom + size-blocked pre-filter must
 * produce *byte-for-byte identical* results to a naive O(n²) brute-force
 * trigram scan — the pre-filter is an optimisation, never a behaviour change.
 * We verify that on randomised inputs, plus BloomFilter no-false-negative and
 * DedupIndex streaming semantics.
 */

import { describe, it, expect } from 'vitest';
import {
  deduplicateByContent, trigramSimilarity, isDuplicateInBatch,
  BloomFilter, DedupIndex,
} from '../similarity.js';

type Item = { content: string; relevance?: number };

/** Reference implementation: naive O(n²) trigram dedup, keep first seen. */
function bruteForceDedup(items: Item[], threshold: number): Item[] {
  const kept: Item[] = [];
  for (const item of items) {
    let dup = false;
    for (const k of kept) {
      if (trigramSimilarity(item.content, k.content) >= threshold) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(item);
  }
  return kept;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCorpus(rng: () => number, n: number): Item[] {
  const bases = [
    'the gateway binds to port 8000 on startup',
    'configure the anthropic api key in the environment',
    'mental models refresh after every retention call',
    'cross project lessons roll up into the core bank',
    'the bloom filter has no false negatives by design',
    'trigram similarity uses a jaccard style overlap',
  ];
  const out: Item[] = [];
  for (let i = 0; i < n; i++) {
    const base = bases[Math.floor(rng() * bases.length)];
    // Sometimes mutate slightly, sometimes duplicate exactly.
    const roll = rng();
    let content = base;
    if (roll < 0.3) {
      content = base + ' ' + Math.floor(rng() * 5);
    } else if (roll < 0.5) {
      content = base.split(' ').slice(0, 4 + Math.floor(rng() * 4)).join(' ');
    }
    out.push({ content, relevance: rng() });
  }
  return out;
}

describe('deduplicateByContent — matches brute force', () => {
  for (const threshold of [0.7, 0.85, 0.95]) {
    it(`identical output to naive O(n^2) at threshold ${threshold}`, () => {
      for (let seed = 1; seed <= 8; seed++) {
        const rng = mulberry32(seed);
        const corpus = randomCorpus(rng, 60);
        const fast = deduplicateByContent(corpus, threshold);
        const slow = bruteForceDedup(corpus, threshold);
        expect(fast.map((x) => x.content)).toEqual(slow.map((x) => x.content));
      }
    });
  }

  it('handles empty and singleton inputs', () => {
    expect(deduplicateByContent([], 0.85)).toEqual([]);
    const one = [{ content: 'solo' }];
    expect(deduplicateByContent(one, 0.85)).toEqual(one);
  });

  it('keeps very short (sub-trigram) contents that brute force keeps', () => {
    const items = [{ content: 'a' }, { content: 'b' }, { content: 'a' }];
    const fast = deduplicateByContent(items, 0.85);
    const slow = bruteForceDedup(items, 0.85);
    expect(fast.map((x) => x.content)).toEqual(slow.map((x) => x.content));
  });
});

describe('isDuplicateInBatch — matches brute force verdict', () => {
  it('agrees with a linear scan', () => {
    const rng = mulberry32(99);
    const corpus = randomCorpus(rng, 40);
    for (let i = 0; i < corpus.length; i++) {
      const prior = corpus.slice(0, i).map((x) => ({ content: x.content }));
      const candidate = corpus[i].content;
      const naive = prior.some((p) => trigramSimilarity(candidate, p.content) >= 0.85);
      expect(isDuplicateInBatch(candidate, prior, 0.85)).toBe(naive);
    }
  });
});

describe('BloomFilter', () => {
  it('has no false negatives', () => {
    const bf = new BloomFilter(1000, 0.01);
    const added: string[] = [];
    for (let i = 0; i < 500; i++) {
      const key = `key-${i}`;
      bf.add(key);
      added.push(key);
    }
    for (const key of added) {
      expect(bf.has(key)).toBe(true);
    }
  });

  it('keeps the false-positive rate roughly within budget', () => {
    const bf = new BloomFilter(1000, 0.01);
    for (let i = 0; i < 1000; i++) bf.add(`in-${i}`);
    let fp = 0;
    const trials = 5000;
    for (let i = 0; i < trials; i++) {
      if (bf.has(`out-${i}`)) fp++;
    }
    // Allow generous slack over the nominal 1% to avoid flakiness.
    expect(fp / trials).toBeLessThan(0.05);
  });
});

describe('DedupIndex — streaming near-duplicate detection', () => {
  it('addIfNew rejects near-duplicates and accepts novel content', () => {
    const idx = new DedupIndex({ threshold: 0.85 });
    expect(idx.addIfNew('the gateway binds to port 8000 on startup')).toBe(true);
    // Exact repeat -> duplicate.
    expect(idx.addIfNew('the gateway binds to port 8000 on startup')).toBe(false);
    // Clearly different -> novel.
    expect(idx.addIfNew('mental models refresh after retention')).toBe(true);
    expect(idx.count).toBe(2);
  });

  it('verdicts match a brute-force streaming scan', () => {
    const rng = mulberry32(7);
    const corpus = randomCorpus(rng, 50);
    const idx = new DedupIndex({ threshold: 0.85 });
    const kept: string[] = [];
    for (const item of corpus) {
      const naive = !kept.some((k) => trigramSimilarity(item.content, k) >= 0.85);
      const got = idx.addIfNew(item.content);
      expect(got).toBe(naive);
      if (naive) kept.push(item.content);
    }
  });
});
