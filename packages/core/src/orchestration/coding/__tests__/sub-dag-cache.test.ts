/**
 * @module orchestration/coding/__tests__/sub-dag-cache
 *
 * Task #239 — unit coverage for the sub-DAG cache primitive:
 *   1. Key derivation centres on the phase body and invalidates on any
 *      body / phase-id / model / context change.
 *   2. `set`/`get` deep-clone so the executor's in-place splice can't
 *      corrupt the stored copy.
 *   3. Hit/miss/eviction counters are accurate.
 */

import { describe, it, expect } from 'vitest';
import { SubDagCache, type SubDagCacheKeyInput } from '../sub-dag-cache.js';
import type { WorkflowNode } from '../../types.js';

function sampleNodes(): WorkflowNode[] {
  return [
    {
      id: 'phase-1__a',
      type: 'CODING_AGENT',
      label: 'A',
      dependsOn: [],
      codingAgent: { task: 'do A', cwd: '/repo' },
    },
    {
      id: 'phase-1__b',
      type: 'CODING_AGENT',
      label: 'B',
      dependsOn: ['phase-1__a'],
      codingAgent: { task: 'do B', cwd: '/repo' },
    },
  ];
}

const baseKeyInput: SubDagCacheKeyInput = {
  phaseBody: 'implement the widget',
  phaseId: 'phase-1',
  model: 'claude-sonnet-4-6',
  repoPreamble: '<repo block>',
  upstreamPhaseSummary: undefined,
};

describe('SubDagCache.keyFor', () => {
  it('produces a stable key for identical inputs', () => {
    const cache = new SubDagCache();
    expect(cache.keyFor(baseKeyInput)).toBe(cache.keyFor({ ...baseKeyInput }));
  });

  it('changes the key when the phase body changes (invalidation)', () => {
    const cache = new SubDagCache();
    const a = cache.keyFor(baseKeyInput);
    const b = cache.keyFor({ ...baseKeyInput, phaseBody: 'implement the gadget' });
    expect(a).not.toBe(b);
  });

  it('changes the key for different phase id / model / preamble / upstream', () => {
    const cache = new SubDagCache();
    const base = cache.keyFor(baseKeyInput);
    expect(cache.keyFor({ ...baseKeyInput, phaseId: 'phase-2' })).not.toBe(base);
    expect(cache.keyFor({ ...baseKeyInput, model: 'claude-opus-4-8' })).not.toBe(base);
    expect(cache.keyFor({ ...baseKeyInput, repoPreamble: 'other' })).not.toBe(base);
    expect(cache.keyFor({ ...baseKeyInput, upstreamPhaseSummary: '- `x`' })).not.toBe(base);
  });

  it('is not fooled by field-boundary concatenation', () => {
    const cache = new SubDagCache();
    // Without NUL separators these two would hash identically.
    const a = cache.keyFor({ ...baseKeyInput, phaseId: 'ab', phaseBody: 'cd' });
    const b = cache.keyFor({ ...baseKeyInput, phaseId: 'a', phaseBody: 'bcd' });
    expect(a).not.toBe(b);
  });
});

describe('SubDagCache get/set', () => {
  it('returns undefined and counts a miss when key is absent', () => {
    const cache = new SubDagCache();
    expect(cache.get('nope')).toBeUndefined();
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 1, size: 0 });
  });

  it('returns a deep clone on hit (caller cannot mutate the stored copy)', () => {
    const cache = new SubDagCache();
    const key = cache.keyFor(baseKeyInput);
    cache.set(key, sampleNodes(), { inputTokens: 100, outputTokens: 50 });

    const first = cache.get(key);
    expect(first).toBeDefined();
    // Mutate the returned copy the way the executor's splice does.
    first!.nodes[0].dependsOn.push('analyze');
    first!.nodes[0].label = 'MUTATED';

    const second = cache.get(key);
    expect(second!.nodes[0].dependsOn).toEqual([]);
    expect(second!.nodes[0].label).toBe('A');
    // Distinct object references between hits.
    expect(second!.nodes).not.toBe(first!.nodes);
    expect(second!.nodes[0]).not.toBe(first!.nodes[0]);
  });

  it('clones on set so later mutation of the source array does not leak in', () => {
    const cache = new SubDagCache();
    const key = cache.keyFor(baseKeyInput);
    const src = sampleNodes();
    cache.set(key, src, { inputTokens: 1, outputTokens: 1 });
    src[0].label = 'CHANGED AFTER SET';

    expect(cache.get(key)!.nodes[0].label).toBe('A');
  });

  it('preserves the recorded usage on a hit', () => {
    const cache = new SubDagCache();
    const key = cache.keyFor(baseKeyInput);
    cache.set(key, sampleNodes(), { inputTokens: 321, outputTokens: 123 });
    expect(cache.get(key)!.usage).toEqual({ inputTokens: 321, outputTokens: 123 });
  });

  it('tracks hits and misses', () => {
    const cache = new SubDagCache();
    const key = cache.keyFor(baseKeyInput);
    cache.get(key); // miss
    cache.set(key, sampleNodes());
    cache.get(key); // hit
    cache.get(key); // hit
    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });
});

describe('SubDagCache eviction', () => {
  it('evicts the oldest entries beyond maxEntries (LRU)', () => {
    const cache = new SubDagCache({ maxEntries: 2 });
    const k1 = 'k1';
    const k2 = 'k2';
    const k3 = 'k3';
    cache.set(k1, sampleNodes());
    cache.set(k2, sampleNodes());
    // Touch k1 so it becomes most-recently-used; k2 is now the oldest.
    expect(cache.get(k1)).toBeDefined();
    cache.set(k3, sampleNodes());

    expect(cache.get(k2)).toBeUndefined(); // evicted
    expect(cache.get(k1)).toBeDefined();
    expect(cache.get(k3)).toBeDefined();
    expect(cache.stats().size).toBe(2);
    expect(cache.stats().evictions).toBe(1);
  });
});
