/**
 * Tests for the Memory Map renderer (docs/memory-architecture-v2.md §9).
 *
 * The map is injected on EVERY turn, so three properties are load-bearing and
 * each is pinned here:
 *
 *   BOUNDED   — O(1) in session length. A map that grows with history is an
 *               unbounded per-request tax, which is the one thing it must not be.
 *   STABLE    — segment ids never move. An id the agent saw last turn must mean
 *               the same span this turn, or `memory_read` silently misaddresses.
 *   DETERMINISTIC — identical input yields identical bytes. No clock, no LLM,
 *               no corpus re-derivation at render time.
 */

import { describe, it, expect } from 'vitest';
import { renderMemoryMap, rankTerms, type SegmentSummary } from '../memory-map.js';

const estimate = (s: string): number => Math.ceil(s.length / 4);

function seg(n: number, from: number, to: number, label = `topic${n}, alpha, beta`): SegmentSummary {
  return {
    id: `seg:conv:${n}`,
    n,
    from,
    to,
    count: to - from + 1,
    label,
    openedAt: `2026-07-${String((n % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
    closedAt: `2026-07-${String((n % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
  };
}

function segments(count: number): SegmentSummary[] {
  return Array.from({ length: count }, (_, i) => seg(i + 1, i * 50 + 1, (i + 1) * 50));
}

function baseInput(segCount: number) {
  const segs = segments(segCount);
  return {
    scope: 'conv',
    totalRecords: segCount * 50,
    bounds: { min: 1, max: segCount * 50 },
    segments: segs,
    verbatim: { from: segCount * 50 - 19, to: segCount * 50, count: 20 },
    frequentTerms: [{ term: 'redis', count: 84 }, { term: 'index', count: 41 }],
    pinnedCount: 3,
  };
}

describe('renderMemoryMap — bounded growth', () => {
  it('is O(1) in session length: 1000 segments renders no larger than 10', () => {
    const small = renderMemoryMap(baseInput(10))!;
    const huge = renderMemoryMap(baseInput(1000))!;

    expect(small).toBeTruthy();
    expect(huge).toBeTruthy();

    const rows = (s: string) => s.split('\n').filter((l) => l.startsWith('  ')).length;
    // Same row count regardless of history — the excess collapses.
    expect(rows(huge)).toBeLessThanOrEqual(rows(small) + 1);
    expect(estimate(huge)).toBeLessThanOrEqual(estimate(small) * 1.3);
  });

  it('never exceeds the token budget, even with absurd labels', () => {
    const input = baseInput(400);
    input.segments = input.segments.map((s) => ({ ...s, label: 'x'.repeat(300) }));

    for (const maxTokens of [120, 300, 600]) {
      const out = renderMemoryMap(input, { maxTokens })!;
      expect(estimate(out), `budget ${maxTokens}`).toBeLessThanOrEqual(maxTokens);
    }
  });

  it('keeps the header and verbatim line when trimming to fit', () => {
    const input = baseInput(200);
    const out = renderMemoryMap(input, { maxTokens: 60 })!;
    expect(out).toContain('[MEMORY MAP]');
    expect(out).toContain('Verbatim in context');
  });

  it('drops the frequent-terms line before dropping segment rows', () => {
    const input = baseInput(12);
    const roomy = renderMemoryMap(input, { maxTokens: 600 })!;
    expect(roomy).toContain('Frequent:');

    const tight = renderMemoryMap(input, { maxTokens: 70 })!;
    expect(tight).not.toContain('Frequent:');
  });

  it('collapses the OLDEST segments and keeps the newest addressable', () => {
    const out = renderMemoryMap(baseInput(30), { detailedSegments: 5 })!;
    expect(out).toContain('…earlier');
    // Newest five remain individually named.
    for (const n of [26, 27, 28, 29, 30]) expect(out).toContain(`seg:conv:${n}`);
    // Oldest are gone from the detail list.
    expect(out).not.toContain('seg:conv:1 ');
    // The collapsed row still names the span, so old history stays reachable.
    expect(out).toMatch(/…earlier\s+1–1250\s+25 segments, 1250 records/);
  });
});

describe('renderMemoryMap — stability and determinism', () => {
  it('produces byte-identical output for identical input', () => {
    const a = renderMemoryMap(baseInput(40));
    const b = renderMemoryMap(baseInput(40));
    expect(a).toBe(b);
  });

  it('appending a segment does not renumber or move existing ids', () => {
    const before = renderMemoryMap(baseInput(9), { detailedSegments: 20 })!;
    const after = renderMemoryMap(baseInput(10), { detailedSegments: 20 })!;

    // Every id and span visible before must still be present, unchanged.
    for (const line of before.split('\n').filter((l) => l.trim().startsWith('seg:'))) {
      const id = line.trim().split(/\s+/)[0]!;
      const span = line.trim().split(/\s+/)[1]!;
      expect(after, `${id} moved`).toContain(`${id}`);
      expect(after, `${id} span changed`).toContain(span);
    }
  });

  it('relabelling a segment (async titler) leaves its id and span intact', () => {
    const input = baseInput(6);
    const original = renderMemoryMap(input)!;
    const retitled = renderMemoryMap({
      ...input,
      segments: input.segments.map((s) => ({ ...s, label: 'a completely different label' })),
    })!;

    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(original).toContain(`seg:conv:${n}`);
      expect(retitled).toContain(`seg:conv:${n}`);
    }
    expect(retitled).toContain('a completely different label');
  });

  it('returns null for an empty scope rather than an empty block', () => {
    // Injecting a contentless map every turn would train the model to skip it.
    expect(renderMemoryMap({ scope: 'x', totalRecords: 0, bounds: null, segments: [] })).toBeNull();
    expect(
      renderMemoryMap({ scope: 'x', totalRecords: 5, bounds: null, segments: [] }),
    ).toBeNull();
  });

  it('renders without optional sections', () => {
    const out = renderMemoryMap({
      scope: 'bare',
      totalRecords: 3,
      bounds: { min: 1, max: 3 },
      segments: [],
    })!;
    expect(out).toContain('[MEMORY MAP] scope bare');
    expect(out).not.toContain('Segments —');
    expect(out).not.toContain('Pinned:');
  });
});

describe('rankTerms', () => {
  const counts = (o: Record<string, number>) => new Map(Object.entries(o));

  it('prefers distinctive terms over ubiquitous ones', () => {
    const df: Record<string, number> = { widget: 2, common: 100 };
    const out = rankTerms(
      counts({ widget: 5, common: 50 }),
      (t) => df[t] ?? 1,
      100,
      2,
    );
    expect(out[0]!.term).toBe('widget');
  });

  it('drops stopwords that IDF cannot suppress on a cold corpus', () => {
    // Every term appears in every document, so IDF is uniformly zero — the
    // exact cold-start case that produced labels like "and, for, keyspace".
    const out = rankTerms(
      counts({ and: 50, the: 50, for: 50, keyspace: 50, namespacing: 50 }),
      () => 50,
      50,
      3,
    );
    expect(out.map((t) => t.term)).not.toContain('and');
    expect(out.map((t) => t.term)).not.toContain('the');
    expect(out.map((t) => t.term)).not.toContain('for');
    expect(out.map((t) => t.term)).toContain('keyspace');
  });

  it('drops purely numeric tokens and very short terms', () => {
    const out = rankTerms(
      counts({ '2024': 90, '42': 90, ab: 90, redis: 5 }),
      () => 1,
      100,
      5,
    );
    expect(out.map((t) => t.term)).toEqual(['redis']);
  });

  it('still returns ubiquitous terms when nothing distinctive exists', () => {
    // Better a weak label than an empty one.
    const out = rankTerms(counts({ keyspace: 10, namespacing: 10 }), () => 10, 10, 2);
    expect(out).toHaveLength(2);
  });

  it('is deterministic, breaking ties alphabetically', () => {
    const input = counts({ zebra: 5, alpha: 5, mango: 5 });
    const a = rankTerms(input, () => 1, 100, 3);
    const b = rankTerms(input, () => 1, 100, 3);
    expect(a).toEqual(b);
    expect(a.map((t) => t.term)).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('respects the limit', () => {
    const out = rankTerms(
      counts({ alpha: 1, bravo: 2, charlie: 3, delta: 4, echo: 5 }),
      () => 1,
      100,
      2,
    );
    expect(out).toHaveLength(2);
  });

  it('filters terms of two characters or fewer', () => {
    const out = rankTerms(counts({ ab: 90, xy: 90, redis: 1 }), () => 1, 100, 5);
    expect(out.map((t) => t.term)).toEqual(['redis']);
  });
});
