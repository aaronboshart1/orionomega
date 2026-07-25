/**
 * Tests for memory-tool event reporting.
 *
 * The three tools ARE the agent-facing memory system, and until this reporting
 * existed they left no trace: the memory feed showed the retain/recall the
 * framework performs on the agent's behalf, and nothing the agent asked for
 * itself. A turn could search memory three times and the panel stayed empty.
 *
 * The outcome is derived from the result's leading marker (`REFUSED`,
 * `NO_RESULTS`, `Error:`). Those are the tools' documented protocol with the
 * model — the conversation loop's circuit breaker already depends on them — so
 * they are load-bearing strings, but the coupling is real and pinned here.
 *
 * REDIS SAFETY: db 15 only, one pid-scoped prefix, cleanup deletes only keys
 * matching that prefix.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { RedisMemoryStore } from '../redis-store.js';
import { buildMemoryTools, outcomeOf, type MemoryTool } from '../memory-tools.js';

const URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DB = 15;
const BASE = `omtest-toolevents-${process.pid}-`;
let n = 0;
const px = (): string => `${BASE}${n++}:`;

const mk = (prefix: string): RedisMemoryStore =>
  new RedisMemoryStore({ redis: { url: URL, db: DB, keyPrefix: prefix } });

const REDIS_UP = await (async () => {
  try {
    const s = mk(px());
    const h = await s.health();
    await s.close();
    return h.healthy;
  } catch {
    return false;
  }
})();

const d = REDIS_UP ? describe : describe.skip;

const stores: RedisMemoryStore[] = [];
afterAll(async () => {
  for (const s of stores) {
    try { await s.close(); } catch { /* best effort */ }
  }
});

function track(s: RedisMemoryStore): RedisMemoryStore {
  stores.push(s);
  return s;
}

const byName = (tools: MemoryTool[], name: string): MemoryTool =>
  tools.find((t) => t.name === name)!;

type Event = {
  tool: string;
  detail: string;
  scope: string;
  outcome: string;
  meta?: Record<string, unknown>;
};

// ── outcomeOf: pure, no Redis ───────────────────────────────────────────────

describe('outcomeOf', () => {
  it('classifies each documented marker', () => {
    expect(outcomeOf('REFUSED — memory_search limit reached')).toBe('refused');
    expect(outcomeOf('NO_RESULTS — searched 12 indexed records')).toBe('no_results');
    expect(outcomeOf('Error: memory_read failed — boom')).toBe('error');
    expect(outcomeOf('3 of 8 result(s) for "auth" in scope \'conv\':')).toBe('ok');
  });

  it('does not mistake prose containing a marker for that outcome', () => {
    // Only a LEADING marker counts — a result quoting the word must stay ok.
    expect(outcomeOf('1 of 1 result(s): the agent said NO_RESULTS once')).toBe('ok');
  });
});

// ── reporting against a real store ──────────────────────────────────────────

d('memory tool event reporting', () => {
  it('reports a successful search with tool, scope and outcome', async () => {
    const s = track(mk(px()));
    await s.retain('conv', [
      { content: 'the deploy key lives in the vault', context: 'note', timestamp: new Date().toISOString() },
    ]);

    const events: Event[] = [];
    const search = byName(
      buildMemoryTools(s, { defaultScope: 'conv', onEvent: (e) => events.push(e as Event) }),
      'memory_search',
    );

    await search.execute({ query: 'deploy key vault' });

    expect(events).toHaveLength(1);
    expect(events[0]!.tool).toBe('memory_search');
    expect(events[0]!.scope).toBe('conv');
    expect(events[0]!.outcome).toBe('ok');
    expect(events[0]!.meta?.query).toBe('deploy key vault');
    expect(typeof events[0]!.meta?.durationMs).toBe('number');
  });

  it('reports no_results rather than success on an empty search', async () => {
    // The distinction the loop guard depends on, surfaced to the operator too.
    const s = track(mk(px()));
    await s.retain('conv', [
      { content: 'unrelated content about gardening', context: 'note', timestamp: new Date().toISOString() },
    ]);

    const events: Event[] = [];
    const search = byName(
      buildMemoryTools(s, { defaultScope: 'conv', onEvent: (e) => events.push(e as Event) }),
      'memory_search',
    );

    await search.execute({ query: 'zzzqqq nonexistent quantum telemetry' });

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe('no_results');
  });

  it('reports refused when the per-turn budget is spent', async () => {
    const s = track(mk(px()));
    const events: Event[] = [];
    const search = byName(
      buildMemoryTools(s, {
        defaultScope: 'conv',
        maxSearchesPerTurn: 1,
        onEvent: (e) => events.push(e as Event),
      }),
      'memory_search',
    );

    await search.execute({ query: 'first' });
    await search.execute({ query: 'second' });

    expect(events).toHaveLength(2);
    expect(events[1]!.outcome).toBe('refused');
    expect(events[1]!.detail).toContain('budget');
  });

  it('reports the scope a call actually targeted, not just the default', async () => {
    const s = track(mk(px()));
    const events: Event[] = [];
    const search = byName(
      buildMemoryTools(s, { defaultScope: 'conv', onEvent: (e) => events.push(e as Event) }),
      'memory_search',
    );

    await search.execute({ query: 'anything', scope: 'core' });

    expect(events[0]!.scope).toBe('core');
  });

  it('returns the tool result unchanged when reporting', async () => {
    const s = track(mk(px()));
    const withReporter = byName(
      buildMemoryTools(s, { defaultScope: 'conv', onEvent: () => {} }),
      'memory_search',
    );
    const without = byName(buildMemoryTools(s, { defaultScope: 'conv' }), 'memory_search');

    const a = await withReporter.execute({ query: 'same query' });
    const b = await without.execute({ query: 'same query' });

    expect(a).toBe(b);
  });

  it('survives a reporter that throws', async () => {
    // A broken panel must not break the agent's access to its own memory.
    const s = track(mk(px()));
    const boom = vi.fn(() => { throw new Error('reporter exploded'); });
    const search = byName(
      buildMemoryTools(s, { defaultScope: 'conv', onEvent: boom }),
      'memory_search',
    );

    await expect(search.execute({ query: 'still works' })).resolves.toBeTypeOf('string');
    expect(boom).toHaveBeenCalled();
  });

  it('does not report when no reporter is configured', async () => {
    // The un-instrumented path must stay exactly as it was.
    const s = track(mk(px()));
    const tools = buildMemoryTools(s, { defaultScope: 'conv' });

    await expect(byName(tools, 'memory_search').execute({ query: 'x' })).resolves.toBeTypeOf('string');
  });

  it('reports memory_pin with the key it wrote', async () => {
    const s = track(mk(px()));
    const events: Event[] = [];
    const pin = byName(
      buildMemoryTools(s, { defaultScope: 'conv', onEvent: (e) => events.push(e as Event) }),
      'memory_pin',
    );

    await pin.execute({ key: 'deploy-target', content: 'staging cluster b' });

    expect(events).toHaveLength(1);
    expect(events[0]!.tool).toBe('memory_pin');
    expect(events[0]!.meta?.key).toBe('deploy-target');
  });
});
