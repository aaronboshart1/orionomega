/**
 * Tests for the agent-facing memory tools (docs/memory-architecture-v2.md §11).
 *
 * The guards are the point of this file. The conversation loop has NO round cap
 * and its circuit breaker only counts results starting with "Error:", so a
 * zero-result search — a SUCCESS string, which actually *decrements* the
 * breaker — can be retried forever. Every assertion about NO_RESULTS, per-turn
 * budgets and byte ceilings is load-bearing, not cosmetic.
 *
 * REDIS SAFETY: db 15 only, one pid-scoped prefix, cleanup deletes only keys
 * matching that prefix.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { RedisMemoryStore } from '../redis-store.js';
import { buildMemoryTools, type MemoryTool } from '../memory-tools.js';

// Honour REDIS_URL so CI can point at its service container, and so the
// skip-guard can be exercised against an unreachable server.
const URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DB = 15;
const BASE = `omtest-tools-${process.pid}-`;
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
function store(prefix: string): RedisMemoryStore {
  const s = mk(prefix);
  stores.push(s);
  return s;
}

afterAll(async () => {
  if (!REDIS_UP) return;
  const mod = (await import('ioredis')) as unknown as { default?: new (u: string, o?: object) => any };
  const Ctor = (mod.default ?? mod) as new (u: string, o?: object) => any;
  const raw = new Ctor(URL, { db: DB });
  try {
    let cursor = '0';
    const keys: string[] = [];
    do {
      const [next, batch] = await raw.scan(cursor, 'MATCH', `${BASE}*`, 'COUNT', 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    for (let i = 0; i < keys.length; i += 200) {
      const slice = keys.slice(i, i + 200);
      if (slice.length > 0) await raw.del(...slice);
    }
  } finally {
    await raw.quit().catch(() => {});
  }
  await Promise.all(stores.map((s) => s.close().catch(() => {})));
}, 30_000);

function byName(tools: MemoryTool[], name: string): MemoryTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const TOPIC = 'the deployment pipeline uses blue green rollouts for the api gateway';

d('memory_search', () => {
  it('returns ranked snippets with relevance and context', async () => {
    const s = store(px());
    await s.retain('conv', [
      { content: TOPIC, context: 'decision' },
      { content: 'quarterly revenue reconciliation in the billing ledger', context: 'lesson' },
    ]);
    const search = byName(buildMemoryTools(s, { defaultScope: 'conv' }), 'memory_search');

    const out = await search.execute({ query: 'deployment pipeline rollouts' });
    expect(out).toContain('result(s) for');
    expect(out).toContain('relevance');
    expect(out).toContain('blue green rollouts');
    expect(out).not.toContain('billing ledger');
  });

  it('returns an explicit NO_RESULTS marker with corpus stats', async () => {
    // Without a machine-readable negative the model cannot tell "nothing is
    // there" from "my query was bad", and retries forever.
    const s = store(px());
    await s.retain('conv', [{ content: TOPIC, context: 'decision' }]);
    const search = byName(buildMemoryTools(s, { defaultScope: 'conv' }), 'memory_search');

    const out = await search.execute({ query: 'xylophone marsupial quantum' });
    expect(out).toContain('NO_RESULTS');
    expect(out).toMatch(/searched \d+ indexed records/);
    expect(out).toContain("scope 'conv'");
    expect(out).toContain('Do not retry the same query');
  });

  it('refuses past the per-turn budget instead of allowing an unbounded loop', async () => {
    const s = store(px());
    await s.retain('conv', [{ content: TOPIC, context: 'decision' }]);
    const search = byName(
      buildMemoryTools(s, { defaultScope: 'conv', maxSearchesPerTurn: 2 }),
      'memory_search',
    );

    expect(await search.execute({ query: 'deployment' })).not.toContain('REFUSED');
    expect(await search.execute({ query: 'pipeline' })).not.toContain('REFUSED');
    const third = await search.execute({ query: 'gateway' });
    expect(third).toContain('REFUSED');
    expect(third).toContain('limit reached for this turn');
  });

  it('gives each turn a fresh budget', async () => {
    const s = store(px());
    await s.retain('conv', [{ content: TOPIC, context: 'decision' }]);
    const opts = { defaultScope: 'conv', maxSearchesPerTurn: 1 };

    const turn1 = byName(buildMemoryTools(s, opts), 'memory_search');
    await turn1.execute({ query: 'deployment' });
    expect(await turn1.execute({ query: 'deployment' })).toContain('REFUSED');

    const turn2 = byName(buildMemoryTools(s, opts), 'memory_search');
    expect(await turn2.execute({ query: 'deployment' })).not.toContain('REFUSED');
  });

  it('caps the result body and says what was dropped', async () => {
    const s = store(px());
    const big = 'gateway deployment rollout '.repeat(400);
    await s.retain(
      'conv',
      Array.from({ length: 10 }, (_, i) => ({ content: `${big} variant ${i}`, context: 'lesson' })),
    );
    const search = byName(
      buildMemoryTools(s, { defaultScope: 'conv', maxChars: 2_000 }),
      'memory_search',
    );

    const out = await search.execute({ query: 'gateway deployment rollout' });
    expect(out.length).toBeLessThan(2_400);
    expect(out).toContain('[truncated at 2000 chars');
  });

  it('rejects an empty query without consuming reasoning', async () => {
    const s = store(px());
    const search = byName(buildMemoryTools(s, { defaultScope: 'conv' }), 'memory_search');
    expect(await search.execute({ query: '   ' })).toContain('Error:');
  });
});

d('memory_read', () => {
  it('reads a contiguous span around a centre point, in order', async () => {
    const s = store(px());
    for (let i = 0; i < 12; i++) {
      await s.retain('conv', [{ content: `record number ${i} discussing the gateway`, context: 'lesson' }]);
    }
    const b = (await s.bounds('conv'))!;
    const read = byName(buildMemoryTools(s, { defaultScope: 'conv' }), 'memory_read');

    const out = await read.execute({ around: b.min + 5, radius: 2 });
    expect(out).toMatch(/record\(s\) from seq/);
    const seqs = [...out.matchAll(/\[seq (\d+)/g)].map((m) => Number(m[1]));
    expect(seqs).toHaveLength(5);
    expect(seqs).toEqual([...seqs].sort((a, z) => a - z));
  });

  it('reads a segment by its MEMORY MAP id', async () => {
    const s = store(px());
    for (let i = 0; i < 55; i++) {
      await s.retain('conv', [{ content: `segment content item ${i} about caching`, context: 'lesson' }]);
    }
    const segs = await s.listSegments('conv');
    expect(segs.length).toBeGreaterThan(0);

    const read = byName(buildMemoryTools(s, { defaultScope: 'conv' }), 'memory_read');
    const out = await read.execute({ segment: segs[0]!.id });
    expect(out).toContain(segs[0]!.id);
    expect(out).toContain('segment content item');
  });

  it('names the known segments when given an unknown id', async () => {
    const s = store(px());
    await s.retain('conv', [{ content: 'a single record here', context: 'lesson' }]);
    const read = byName(buildMemoryTools(s, { defaultScope: 'conv' }), 'memory_read');

    const out = await read.execute({ segment: 'seg:conv:999' });
    expect(out).toContain('Error:');
    expect(out).toContain('Known segments');
  });

  it('caps the span and emits a usable continuation marker', async () => {
    // An uncapped span read would let the agent pull an arbitrary fraction of
    // the session back into context, defeating the dynamic window.
    const s = store(px());
    for (let i = 0; i < 40; i++) {
      await s.retain('conv', [{ content: `verbose record ${i}: ${'padding text '.repeat(60)}`, context: 'lesson' }]);
    }
    const b = (await s.bounds('conv'))!;
    const read = byName(buildMemoryTools(s, { defaultScope: 'conv', maxChars: 3_000 }), 'memory_read');

    const out = await read.execute({ around: b.min + 20, radius: 100 });
    expect(out.length).toBeLessThan(3_400);
    expect(out).toMatch(/\[truncated at 3000 chars — continue with \{around: \d+, radius: 10\}\]/);
  });

  it('requires an addressing argument', async () => {
    const s = store(px());
    const read = byName(buildMemoryTools(s, { defaultScope: 'conv' }), 'memory_read');
    expect(await read.execute({})).toContain('requires either `segment` or `around`');
  });

  it('enforces its own per-turn budget separately from search', async () => {
    const s = store(px());
    await s.retain('conv', [{ content: 'one record about the gateway', context: 'lesson' }]);
    const tools = buildMemoryTools(s, { defaultScope: 'conv', maxReadsPerTurn: 1, maxSearchesPerTurn: 3 });
    const read = byName(tools, 'memory_read');
    const search = byName(tools, 'memory_search');

    expect(await read.execute({ around: 1, radius: 5 })).not.toContain('REFUSED');
    expect(await read.execute({ around: 1, radius: 5 })).toContain('REFUSED');
    // A spent read budget must not disable search.
    expect(await search.execute({ query: 'gateway' })).not.toContain('REFUSED');
  });
});

d('memory_pin', () => {
  it('pins, revises by key, and reports the total', async () => {
    const s = store(px());
    const pin = byName(buildMemoryTools(s, { defaultScope: 'conv' }), 'memory_pin');

    expect(await pin.execute({ key: 'style', content: 'terse answers' })).toContain("Pinned 'style'");
    await pin.execute({ key: 'stack', content: 'redis and typescript' });

    const revised = await pin.execute({ key: 'style', content: 'VERY terse answers' });
    expect(revised).toContain('2 pin(s) total');

    const pins = await s.listPins('conv');
    expect(pins).toHaveLength(2);
    expect(pins.find((p) => p.key === 'style')!.content).toBe('VERY terse answers');
  });

  it('removes a pin when content is omitted', async () => {
    const s = store(px());
    const pin = byName(buildMemoryTools(s, { defaultScope: 'conv' }), 'memory_pin');
    await pin.execute({ key: 'temp', content: 'to be removed' });

    expect(await pin.execute({ key: 'temp' })).toContain("Removed pin 'temp'");
    expect(await s.listPins('conv')).toHaveLength(0);
  });

  it('requires a key', async () => {
    const s = store(px());
    const pin = byName(buildMemoryTools(s, { defaultScope: 'conv' }), 'memory_pin');
    expect(await pin.execute({ key: '  ' })).toContain('Error:');
  });

  it('is not subject to the read/search budgets', async () => {
    const s = store(px());
    const pin = byName(
      buildMemoryTools(s, { defaultScope: 'conv', maxSearchesPerTurn: 0, maxReadsPerTurn: 0 }),
      'memory_pin',
    );
    for (let i = 0; i < 5; i++) {
      expect(await pin.execute({ key: `k${i}`, content: `fact ${i}` })).toContain('Pinned');
    }
  });
});

d('tool surface', () => {
  it('exposes exactly three tools with required fields declared', async () => {
    const s = store(px());
    const tools = buildMemoryTools(s, { defaultScope: 'conv' });
    expect(tools.map((t) => t.name)).toEqual(['memory_search', 'memory_read', 'memory_pin']);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema).toHaveProperty('type', 'object');
      expect(t.inputSchema).toHaveProperty('properties');
    }
  });

  it("tells the model that tool results are stored but not searchable", async () => {
    // §4.4 excludes tool_result from the search corpus; if the description does
    // not say so, the agent will conclude the memory is simply missing.
    const s = store(px());
    const search = byName(buildMemoryTools(s, { defaultScope: 'conv' }), 'memory_search');
    expect(search.description).toMatch(/NOT searchable/i);
    expect(search.description).toMatch(/memory_read/);
  });
});
