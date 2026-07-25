/**
 * THE GATE for the assembler rewrite (docs/memory-architecture-v2.md §12).
 *
 * The rewrite deleted ~380 lines of pre-v2 accretion. What it must NOT
 * have changed is the property the file exists for:
 *
 *   Context is rebuilt from memory each turn within an explicit token budget.
 *   No compaction, no naive sliding window.
 *
 * Every assertion here pins one of the four retained behaviours, the new
 * Memory Map injection, or the budget-overflow fix. If this file is green the
 * rewrite preserved the property; the tests that died with the deleted features
 * were testing the accretion, not the requirement.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import type { MemoryStore, RecalledRecord } from '../store.js';

function rec(content: string, relevance = 0.9): RecalledRecord {
  return { content, context: 'lesson', timestamp: '2026-07-20T10:00:00.000Z', relevance };
}

interface FakeOpts {
  records?: RecalledRecord[];
  map?: string | null;
}

function makeStore(opts: FakeOpts = {}) {
  const recall = vi.fn().mockResolvedValue({
    records: opts.records ?? [],
    lowConfidence: false,
    tokensUsed: 0,
  });
  const buildMemoryMap = vi.fn().mockResolvedValue(opts.map ?? null);
  const store = {
    recall,
    buildMemoryMap,
    retain: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
    retainOne: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
    isDuplicate: vi.fn().mockResolvedValue(false),
    listScopes: vi.fn().mockResolvedValue([]),
    deleteScope: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ healthy: true }),
  } as unknown as MemoryStore;
  return { store, recall, buildMemoryMap };
}

const PROD = {
  recallBudgetTokens: 30_000,
  maxTurnTokens: 60_000,
  systemPromptTokens: 15_000,
  outputReserveTokens: 4_096,
  conversationScope: 'conv',
};

describe('PROPERTY 1 — assemble() never drops hot-window messages', () => {
  it('returns every hot message even when the recall budget is exhausted', async () => {
    const { store } = makeStore();
    // System prompt alone exceeds the turn budget, so there is nothing left.
    const a = new ContextAssembler(store, {
      ...PROD,
      maxTurnTokens: 1_000,
      systemPromptTokens: 100_000,
      hotWindowSize: 50,
    });
    for (let i = 0; i < 12; i++) await a.push({ role: 'user', content: `message ${i}` });

    const out = await a.assemble('anything');
    expect(out.hotMessages).toHaveLength(12);
    expect(out.priorContext).toBeNull();
  });

  it('assemble() is read-only — repeated calls do not shrink the window', async () => {
    const { store } = makeStore({ records: [rec('some prior context here')] });
    const a = new ContextAssembler(store, { ...PROD, hotWindowSize: 50 });
    for (let i = 0; i < 8; i++) await a.push({ role: 'user', content: `message ${i}` });

    const first = await a.assemble('query one');
    const second = await a.assemble('query two');
    const third = await a.assemble('query three');

    expect(first.hotMessages).toHaveLength(8);
    expect(second.hotMessages).toHaveLength(8);
    expect(third.hotMessages).toHaveLength(8);
    expect(a.getHotWindow()).toHaveLength(8);
  });

  it('only push() trims, and it respects hotWindowSize', async () => {
    const { store } = makeStore();
    const a = new ContextAssembler(store, { ...PROD, hotWindowSize: 5 });
    for (let i = 0; i < 20; i++) await a.push({ role: 'user', content: `message ${i}` });

    const out = await a.assemble('q');
    expect(out.hotMessages).toHaveLength(5);
    // The newest survive.
    expect(out.hotMessages[4]!.content).toBe('message 19');
    // But the running count reflects everything seen.
    expect(a.messageCount).toBe(20);
  });
});

describe('PROPERTY 2 — recall is skipped below the minimum budget', () => {
  it('does not call the store when the computed budget is <= 500', async () => {
    const { store, recall } = makeStore({ records: [rec('should never be fetched')] });
    // 60 000 − 59 600 − 400 = 0 available.
    const a = new ContextAssembler(store, {
      ...PROD,
      maxTurnTokens: 60_000,
      systemPromptTokens: 59_600,
      outputReserveTokens: 400,
    });
    await a.push({ role: 'user', content: 'hello' });

    const out = await a.assemble('query');
    expect(recall).not.toHaveBeenCalled();
    expect(out.priorContext).toBeNull();
  });

  it('does call the store when the budget is comfortably above the floor', async () => {
    const { store, recall } = makeStore({ records: [rec('prior context that is long enough to matter')] });
    const a = new ContextAssembler(store, PROD);
    await a.push({ role: 'user', content: 'hello' });

    const out = await a.assemble('query');
    expect(recall).toHaveBeenCalled();
    expect(out.priorContext).toContain('PRIOR CONTEXT');
  });
});

describe('PROPERTY 3 — estimatedTokens formula', () => {
  it('is system + recalled + map + hot, and excludes outputReserve', async () => {
    const { store } = makeStore();
    const a = new ContextAssembler(store, {
      ...PROD,
      systemPromptTokens: 1_000,
      outputReserveTokens: 4_096,
    });
    await a.push({ role: 'user', content: 'x'.repeat(400) });

    const out = await a.assemble('query');
    const hotTokens = Math.ceil(400 / 4);

    // No recall content and no map, so the total is system + hot exactly.
    expect(out.priorContext).toBeNull();
    expect(out.memoryMap).toBeNull();
    expect(out.estimatedTokens).toBe(1_000 + hotTokens);
    // outputReserve is headroom, not input — it must not appear.
    expect(out.estimatedTokens).not.toBe(1_000 + hotTokens + 4_096);
  });

  it('includes the Memory Map in the estimate when one is present', async () => {
    const map = '[MEMORY MAP] scope conv · 40 records';
    const { store } = makeStore({ map });
    const a = new ContextAssembler(store, { ...PROD, systemPromptTokens: 1_000 });
    await a.push({ role: 'user', content: 'y'.repeat(400) });

    const out = await a.assemble('query');
    expect(out.memoryMap).toBe(map);
    expect(out.estimatedTokens).toBe(1_000 + Math.ceil(400 / 4) + Math.ceil(map.length / 4));
  });
});

describe('PROPERTY 4 — isExternalAction short-circuits recall', () => {
  it('skips recall entirely for an external-action query', async () => {
    const { store, recall } = makeStore({ records: [rec('should not be fetched')] });
    const a = new ContextAssembler(store, PROD);
    await a.push({ role: 'user', content: 'hi' });

    // Phrasing the classifier actually recognises. Its EXTERNAL_ACTION_STRONG
    // patterns are deliberately narrow — web search, curl/wget, package
    // installs, explicit shell — not any imperative verb.
    const out = await a.assemble('search the web for redis clustering guides');
    expect(recall).not.toHaveBeenCalled();
    expect(out.priorContext).toBeNull();
  });

  it('emits an observable event when it skips', async () => {
    const { store } = makeStore();
    const a = new ContextAssembler(store, PROD);
    const events: string[] = [];
    a.onMemoryEvent = (_op, detail) => events.push(detail);
    await a.push({ role: 'user', content: 'hi' });

    await a.assemble('npm install ioredis');
    expect(events.some((e) => /external action/i.test(e))).toBe(true);
  });
});

describe('Memory Map injection (§9)', () => {
  it('injects the map even when recall returns nothing', async () => {
    // The map's job is announcing that context EXISTS — it must not depend on
    // this turn's query happening to match something.
    const map = '[MEMORY MAP] scope conv · 900 records';
    const { store } = makeStore({ records: [], map });
    const a = new ContextAssembler(store, PROD);
    await a.push({ role: 'user', content: 'hello' });

    const out = await a.assemble('nothing will match this');
    expect(out.priorContext).toBeNull();
    expect(out.memoryMap).toBe(map);
  });

  it('survives a store with no map support', async () => {
    const { store } = makeStore();
    delete (store as unknown as Record<string, unknown>).buildMemoryMap;
    const a = new ContextAssembler(store, PROD);
    await a.push({ role: 'user', content: 'hello' });

    const out = await a.assemble('query');
    expect(out.memoryMap).toBeNull();
  });

  it('does not fail the turn when map building throws', async () => {
    const { store, buildMemoryMap } = makeStore();
    (buildMemoryMap as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('redis gone'));
    const a = new ContextAssembler(store, PROD);
    await a.push({ role: 'user', content: 'hello' });

    const out = await a.assemble('query');
    expect(out.memoryMap).toBeNull();
    expect(out.hotMessages).toHaveLength(1);
  });
});

describe('§6.2 — recall output is fitted to the budget', () => {
  it('never returns prior context exceeding the recall budget', async () => {
    // The old transport clamped to a tier cap, hiding this. A store that
    // honours maxTokens literally exposes it.
    const huge = Array.from({ length: 200 }, (_, i) =>
      rec(`record ${i}: ${'function foo() { return 1; } '.repeat(40)}`, 0.9 - i * 0.001),
    );
    const { store } = makeStore({ records: huge });
    const a = new ContextAssembler(store, {
      ...PROD,
      recallBudgetTokens: 2_000,
      systemPromptTokens: 1_000,
    });
    await a.push({ role: 'user', content: 'hello' });

    const out = await a.assemble('function foo return');
    expect(out.priorContext).toBeTruthy();
    // Code-like text is estimated at 3.2 chars/token while smartTruncate cuts
    // at 3.5, so a single truncation can still measure over. Fitting re-measures.
    expect(Math.ceil(out.priorContext!.length / 3.2)).toBeLessThanOrEqual(2_000 * 1.05);
  });

  it('passes the production budget through to the store rather than a tier cap', async () => {
    const { store, recall } = makeStore({ records: [rec('anything')] });
    const a = new ContextAssembler(store, PROD);
    await a.push({ role: 'user', content: 'hello' });

    await a.assemble('query');
    const opts = recall.mock.calls[0]![2] as { maxTokens: number };
    // 60 000 − 15 000 − 4 096 − hot, capped at 30 000 — NOT the old 4 096 cap.
    expect(opts.maxTokens).toBeGreaterThan(20_000);
  });
});

describe('recall across explicit scopes', () => {
  it('queries the conversation scope and each configured extra', async () => {
    const { store, recall } = makeStore({ records: [rec('shared context')] });
    const a = new ContextAssembler(store, { ...PROD, additionalScopes: ['core', 'infra'] });
    await a.push({ role: 'user', content: 'hello' });

    await a.assemble('query');
    const scopes = recall.mock.calls.map((c) => c[0]);
    expect(scopes).toEqual(['conv', 'core', 'infra']);
  });

  it('merges results by descending relevance across scopes', async () => {
    const recall = vi.fn(async (scope: string) => ({
      records: scope === 'conv' ? [rec('low relevance conv record', 0.2)] : [rec('high relevance core record', 0.95)],
      lowConfidence: false,
      tokensUsed: 0,
    }));
    const store = {
      recall,
      retain: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
      retainOne: vi.fn(),
      isDuplicate: vi.fn(),
      listScopes: vi.fn(),
      deleteScope: vi.fn(),
      health: vi.fn(),
    } as unknown as MemoryStore;

    const a = new ContextAssembler(store, { ...PROD, additionalScopes: ['core'] });
    await a.push({ role: 'user', content: 'hello' });

    const out = await a.assemble('query');
    const hi = out.priorContext!.indexOf('high relevance core record');
    const lo = out.priorContext!.indexOf('low relevance conv record');
    expect(hi).toBeGreaterThanOrEqual(0);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThan(lo);
  });

  it('a failing scope does not fail the turn', async () => {
    const recall = vi.fn(async (scope: string) => {
      if (scope === 'core') throw new Error('scope unavailable');
      return { records: [rec('conv record survives')], lowConfidence: false, tokensUsed: 0 };
    });
    const store = {
      recall,
      retain: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
      retainOne: vi.fn(), isDuplicate: vi.fn(), listScopes: vi.fn(), deleteScope: vi.fn(), health: vi.fn(),
    } as unknown as MemoryStore;

    const a = new ContextAssembler(store, { ...PROD, additionalScopes: ['core'] });
    await a.push({ role: 'user', content: 'hello' });

    const out = await a.assemble('query');
    expect(out.priorContext).toContain('conv record survives');
  });
});

describe('resilience', () => {
  it('a store with no memory at all still yields a usable turn', async () => {
    const a = new ContextAssembler(null, PROD);
    await a.push({ role: 'user', content: 'hello there' });

    const out = await a.assemble('query');
    expect(out.priorContext).toBeNull();
    expect(out.memoryMap).toBeNull();
    expect(out.hotMessages).toHaveLength(1);
    expect(out.estimatedTokens).toBeGreaterThan(0);
  });

  it('a throwing recall degrades to hot window only', async () => {
    const { store, recall } = makeStore();
    (recall as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('redis down'));
    const a = new ContextAssembler(store, PROD);
    await a.push({ role: 'user', content: 'hello' });

    const out = await a.assemble('query');
    expect(out.priorContext).toBeNull();
    expect(out.hotMessages).toHaveLength(1);
  });
});
