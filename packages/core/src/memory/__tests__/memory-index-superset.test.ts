/**
 * MERGE GATE for the candidate/rank split (docs/memory-architecture-v2.md §6.1).
 *
 * Proves, differentially against the real scorer:
 *
 *   candidates(q, θ) ⊇ { d : computeClientRelevance(q, d) ≥ θ }
 *
 * The design review killed an earlier claim that the split gave "identical
 * final ordering". It does not — not automatically. THIS is the property that
 * actually holds, and it only holds because the index maintains a trigram path
 * and a short-form path alongside word postings. Delete either and this file
 * goes red.
 *
 * Modelled on packages/shared/src/__tests__/dedup-prefilter.test.ts, which
 * asserts the dedup pre-filter is byte-identical to naive O(n²) on a seeded
 * corpus. Same idea: the brute-force answer is the oracle.
 *
 * Determinism: the corpus is generated from a seeded PRNG so failures are
 * reproducible. No Math.random().
 */

import { describe, it, expect } from 'vitest';
import { computeClientRelevance } from '@orionomega/shared/similarity';
import { MemoryIndex } from '../memory-index.js';

// ── Seeded PRNG (mulberry32) ────────────────────────────────────────────────

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/**
 * Vocabulary chosen to stress the scorer's edges rather than read naturally:
 * near-miss morphology (deploy/deployed/deploying) drives trigram-only
 * matches, short tokens (<=2 chars) are invisible to the keyword channel, and
 * the structural labels are stripped by normalize().
 */
const WORDS = [
  'deploy', 'deployed', 'deploying', 'deployment',
  'redis', 'rediss', 'redix',
  'gateway', 'gatewayed', 'getaway',
  'memory', 'memoir', 'memorial',
  'index', 'indexed', 'indexing',
  'token', 'tokens', 'tokenise',
  'a', 'to', 'of', 'is',
  'Task:', 'Node:', 'Decisions:', '[user]', '[assistant]',
  'sql', 'api', 'git', 'npm', 'cli',
] as const;

function randomText(rng: () => number, minWords: number, maxWords: number): string {
  const n = minWords + Math.floor(rng() * (maxWords - minWords + 1));
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(pick(rng, WORDS));
  return parts.join(' ');
}

/** Brute force: every document the real scorer would accept. */
function bruteForce(query: string, corpus: string[], theta: number): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < corpus.length; i++) {
    if (computeClientRelevance(query, corpus[i]!) >= theta) out.add(i);
  }
  return out;
}

function buildIndex(corpus: string[]): MemoryIndex {
  const idx = new MemoryIndex();
  corpus.forEach((c, i) => idx.add(i, c));
  return idx;
}

/**
 * Assert the index agrees with the scorer.
 *
 * The design contract (§6.1) is a SUPERSET property. This implementation
 * achieves EQUALITY — it computes the scorer's arithmetic exactly — so we
 * assert both: no missed document (the contract), no spurious document, and
 * bit-identical scores (what makes downstream rescoring unnecessary).
 */
function assertAgreesWithScorer(
  idx: MemoryIndex,
  corpus: string[],
  query: string,
  theta: number,
): void {
  const expected = bruteForce(query, corpus, theta);
  const hits = idx.search(query, theta);
  const got = new Map(hits.map((h) => [h.id, h.relevance]));

  // (a) Superset — the contract. A missed document is silently lost memory.
  for (const id of expected) {
    if (!got.has(id)) {
      throw new Error(
        `SUPERSET VIOLATION at θ=${theta}\n` +
          `  query:   ${JSON.stringify(query)}\n` +
          `  missing: id=${id} ${JSON.stringify(corpus[id])}\n` +
          `  score:   ${computeClientRelevance(query, corpus[id]!)}\n` +
          `  returned: ${got.size} hits`,
      );
    }
  }

  // (b) No spurious hits, and (c) scores identical to the scorer.
  for (const [id, relevance] of got) {
    const truth = computeClientRelevance(query, corpus[id]!);
    if (!expected.has(id)) {
      throw new Error(
        `SPURIOUS HIT at θ=${theta}\n` +
          `  query: ${JSON.stringify(query)}\n` +
          `  id=${id} ${JSON.stringify(corpus[id])} scored ${truth} (< θ)`,
      );
    }
    if (Math.abs(relevance - truth) > 1e-12) {
      throw new Error(
        `SCORE MISMATCH at θ=${theta}\n` +
          `  query: ${JSON.stringify(query)}\n` +
          `  id=${id} ${JSON.stringify(corpus[id])}\n` +
          `  index=${relevance} scorer=${truth}`,
      );
    }
  }
}

/** Back-compat alias so existing call sites read naturally. */
const assertSuperset = assertAgreesWithScorer;

// The full range of thresholds the system actually uses. 0.05 is the floor —
// temporal-diversity sub-queries lower minRelevance to max(min − 0.05, 0.05).
const THRESHOLDS = [0.05, 0.15, 0.2, 0.3, 0.5];

describe('MemoryIndex — superset guarantee (randomised differential)', () => {
  for (const theta of THRESHOLDS) {
    it(`holds across a 400-document seeded corpus at θ=${theta}`, () => {
      const rng = makeRng(0xc0ffee + Math.round(theta * 1000));
      const corpus = Array.from({ length: 400 }, () => randomText(rng, 1, 25));
      const idx = buildIndex(corpus);

      for (let q = 0; q < 200; q++) {
        assertSuperset(idx, corpus, randomText(rng, 1, 8), theta);
      }
    });
  }

  it('holds when queries are drawn from the corpus itself (exact-match stress)', () => {
    const rng = makeRng(0xbeef);
    const corpus = Array.from({ length: 200 }, () => randomText(rng, 1, 15));
    const idx = buildIndex(corpus);

    for (const theta of THRESHOLDS) {
      for (const doc of corpus) assertSuperset(idx, corpus, doc, theta);
    }
  });

  it('holds for degenerate and adversarial inputs', () => {
    const corpus = [
      '',
      ' ',
      'a',
      'ab',
      'abc',
      'ab',
      'A B',
      '[user] ab',
      'Task: ab',
      'x'.repeat(500),
      'deploy',
      'deployed',
      'deploying the gateway',
      'deployed gateway config',
      '日本語テキスト',
      '😀😀😀',
      'redis redis redis redis',
      '{}();=<>',
      'Decisions: [assistant] redis',
    ];
    const idx = buildIndex(corpus);

    const queries = [
      '', ' ', 'a', 'ab', 'abc', 'A B', 'deploy', 'deploying the gateway',
      'x'.repeat(500), '日本語テキスト', '😀😀😀', '{}();=<>', 'Task: ab',
      'redis', 'nonexistent term entirely',
    ];

    for (const theta of [0.01, 0.05, 0.15, 0.3, 0.5, 0.9]) {
      for (const q of queries) assertSuperset(idx, corpus, q, theta);
    }
  });

  it('catches trigram-only matches that share no whole word with the query', () => {
    // The concrete case from the design review: 'deploying' vs 'deployed'
    // share no word (keyword channel = 0) but overlap heavily on trigrams.
    const corpus = ['deployed gateway config'];
    const idx = buildIndex(corpus);
    const query = 'deploying the gateway';

    const score = computeClientRelevance(query, corpus[0]!);
    expect(score).toBeGreaterThan(0);

    // Sanity: this document is genuinely reachable, i.e. the test would fail
    // if the index dropped it.
    assertSuperset(idx, corpus, query, 0.05);
    expect(idx.candidates(query, 0.05)).toContain(0);
  });

  it('catches short-form documents with no trigrams', () => {
    // Normalised 'ab' has an EMPTY trigram set but scores 0.32 against 'ab'
    // (trigram 1.0 × 0.4 × 0.8 length penalty) — above a 0.15 threshold.
    const corpus = ['ab'];
    const idx = buildIndex(corpus);

    expect(computeClientRelevance('ab', 'ab')).toBeGreaterThanOrEqual(0.15);
    expect(idx.candidates('ab', 0.15)).toContain(0);
  });
});

describe('MemoryIndex — mutation and lifecycle', () => {
  it('remove() drops a document from every retrieval path', () => {
    const idx = new MemoryIndex();
    idx.add(1, 'deploying the redis gateway');
    idx.add(2, 'ab');

    expect(idx.candidates('deploying', 0.05)).toContain(1);
    expect(idx.candidates('ab', 0.15)).toContain(2);

    idx.remove(1);
    idx.remove(2);

    expect(idx.size).toBe(0);
    expect(idx.candidates('deploying', 0.05)).not.toContain(1);
    expect(idx.candidates('ab', 0.15)).not.toContain(2);
  });

  it('re-adding an id replaces its postings rather than accumulating them', () => {
    const idx = new MemoryIndex();
    idx.add(1, 'redis gateway deployment');
    idx.add(1, 'completely different subject matter');

    expect(idx.size).toBe(1);
    // The old content must no longer be reachable by its distinctive word.
    expect(idx.candidates('redis', 0.05)).not.toContain(1);
    expect(idx.candidates('completely', 0.05)).toContain(1);
  });

  it('preserves the superset property after interleaved add/remove churn', () => {
    const rng = makeRng(0x5eed);
    const live = new Map<number, string>();
    const idx = new MemoryIndex();

    for (let step = 0; step < 600; step++) {
      const id = Math.floor(rng() * 120);
      if (rng() < 0.35 && live.has(id)) {
        idx.remove(id);
        live.delete(id);
      } else {
        const text = randomText(rng, 1, 12);
        idx.add(id, text);
        live.set(id, text);
      }
    }

    expect(idx.size).toBe(live.size);

    const ids = [...live.keys()];
    const corpusById = (i: number) => live.get(i)!;

    for (let q = 0; q < 120; q++) {
      const query = randomText(rng, 1, 6);
      for (const theta of [0.05, 0.15, 0.3]) {
        const got = new Map(idx.search(query, theta).map((h) => [h.id, h.relevance]));
        for (const id of ids) {
          const truth = computeClientRelevance(query, corpusById(id));
          if (truth >= theta && !got.has(id)) {
            throw new Error(
              `SUPERSET VIOLATION after churn at θ=${theta}\n` +
                `  query:   ${JSON.stringify(query)}\n` +
                `  missing: id=${id} ${JSON.stringify(corpusById(id))}`,
            );
          }
          if (truth < theta && got.has(id)) {
            throw new Error(
              `STALE HIT after churn at θ=${theta}\n` +
                `  query:     ${JSON.stringify(query)}\n` +
                `  spurious:  id=${id} ${JSON.stringify(corpusById(id))} scored ${truth}`,
            );
          }
        }
      }
    }
  });

  it('empty index and empty query are safe', () => {
    const idx = new MemoryIndex();
    expect(idx.candidates('anything', 0.15)).toEqual([]);
    idx.add(1, 'some content');
    expect(idx.candidates('', 0.15)).toEqual([]);
    expect(idx.candidates('   ', 0.15)).toEqual([]);
  });
});
