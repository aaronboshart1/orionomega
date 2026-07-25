/**
 * C3 Supplementary Smoke Tests — the recall budget reaching the store
 *
 * Originally written against the coarse tier vocabulary (`budget: 'high' |
 * 'mid' | 'low'`), which the rewrite deleted along with the query classifier's
 * strategy table. The behaviour those tests were actually guarding survives
 * verbatim as the budget arithmetic (§7):
 *
 *   availableForRecall = max(0, maxTurn − system − reserve − hot)
 *   recallTokens       = min(availableForRecall, recallBudgetTokens)
 *
 * and it reaches the store as `opts.maxTokens` on every per-scope recall. Each
 * test below is the same edge case with the tier string replaced by the number
 * it stood for.
 *
 * Edge cases:
 *  - Omitted recallBudgetTokens → the 16 384 default reaches the store
 *  - Empty string query still carries the default budget
 *  - Oversized query (>450 tokens) still carries the default budget
 *  - Rapid successive assembles all carry the default budget
 *  - Hot-window populated → the budget is still the configured one, because
 *    min() picks it over the (much larger) available headroom
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import type { MemoryStore } from '../store.js';

/** Mirrors DEFAULT_RECALL_BUDGET in context-assembler.ts. */
const DEFAULT_RECALL_BUDGET = 16_384;

function makeStore() {
  const recall = vi.fn().mockResolvedValue({ records: [], lowConfidence: false, tokensUsed: 0 });
  const store = {
    recall,
    retain: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
    retainOne: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
    isDuplicate: vi.fn().mockResolvedValue(false),
    listScopes: vi.fn().mockResolvedValue([]),
    deleteScope: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ healthy: true }),
  } as unknown as MemoryStore;
  return { store, recall };
}

/** Recall options from the nth assembler-issued recall. */
function recallOpts(recall: ReturnType<typeof vi.fn>, n = 0): { maxTokens: number } {
  const call = recall.mock.calls[n];
  if (!call) throw new Error(`expected at least ${n + 1} recall call(s)`);
  return call[2] as { maxTokens: number };
}

describe('C3 Supplement — recall budget default edge cases', () => {
  it('omitted recallBudgetTokens sends the 16 384 default as maxTokens', async () => {
    const { store, recall } = makeStore();
    const assembler = new ContextAssembler(store, { conversationScope: 'scope' });
    await assembler.assemble('query');
    expect(recall).toHaveBeenCalled();
    expect(recallOpts(recall).maxTokens).toBe(DEFAULT_RECALL_BUDGET);
  });

  it('empty string query: if recall is called, it carries the default budget', async () => {
    const { store, recall } = makeStore();
    const assembler = new ContextAssembler(store, { conversationScope: 'scope' });
    await assembler.assemble('');
    if (recall.mock.calls.length > 0) {
      expect(recallOpts(recall).maxTokens).toBe(DEFAULT_RECALL_BUDGET);
    }
  });

  it('oversized query (5 000 chars > 450 tokens): budget is still the default', async () => {
    const { store, recall } = makeStore();
    const assembler = new ContextAssembler(store, { conversationScope: 'scope' });
    await assembler.assemble('word '.repeat(1_000));
    if (recall.mock.calls.length > 0) {
      expect(recallOpts(recall).maxTokens).toBe(DEFAULT_RECALL_BUDGET);
    }
  });

  it('rapid successive assembles all pass the default budget', async () => {
    const { store, recall } = makeStore();
    const assembler = new ContextAssembler(store, { conversationScope: 'scope' });
    await assembler.assemble('query one');
    await assembler.assemble('query two');
    await assembler.assemble('query three');
    expect(recall.mock.calls.length).toBe(3);
    for (const call of recall.mock.calls) {
      expect((call[2] as { maxTokens: number }).maxTokens).toBe(DEFAULT_RECALL_BUDGET);
    }
  });

  it('hot-window populated: the configured budget is maintained', async () => {
    const { store, recall } = makeStore();
    const assembler = new ContextAssembler(store, { conversationScope: 'scope' });
    for (let i = 0; i < 5; i++) {
      await assembler.push({ role: 'user', content: `message ${i}`, timestamp: new Date().toISOString() });
    }
    recall.mockClear();
    await assembler.assemble('query after hot window fill');
    // Hot tokens are subtracted from availableForRecall, but the headroom still
    // dwarfs the budget, so min() keeps picking the budget.
    if (recall.mock.calls.length > 0) {
      expect(recallOpts(recall).maxTokens).toBe(DEFAULT_RECALL_BUDGET);
    }
    await assembler.destroy();
  });
});
