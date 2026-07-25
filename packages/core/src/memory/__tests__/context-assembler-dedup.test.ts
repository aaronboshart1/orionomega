/**
 * Recalled content reaching `priorContext` alongside a populated hot window.
 *
 * This file was originally the H5 suite: it pinned a filter inside
 * `recallFromBanks` that dropped any recalled item whose `trigramSimilarity`
 * to a hot-window message exceeded 0.80. That filter went with bank federation
 * in the §12 rewrite, and deduplication is now the store's job — `RedisMemoryStore`
 * rejects near-duplicates at WRITE time (`isDuplicate`, `trigramSimilarity >=
 * threshold`), so the same content never reaches recall in the first place.
 *
 * What survives here is the half of the old suite that was never about the
 * filter: recalled records reach `priorContext`, and `assemble()` leaves the
 * hot window alone (retained property 1).
 */

import { describe, it, expect } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import { trigramSimilarity } from '@orionomega/shared/similarity';
import { makeMockStore, record } from './helpers/mock-store.js';
import type { MockStore } from './helpers/mock-store.js';
import type { ConversationMessage } from '../context-assembler.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Store whose recall returns a single record with the given content. */
function makeStoreWith(recallContent: string, relevance = 0.85): MockStore {
  return makeMockStore({
    records: [
      record({
        content: recallContent,
        context: 'decision',
        timestamp: new Date().toISOString(), // fresh timestamp — won't be expired
        relevance,
      }),
    ],
  });
}

function makeMsg(content: string, role: 'user' | 'assistant' = 'user'): ConversationMessage {
  return { role, content, timestamp: new Date().toISOString() };
}

/** Budget comfortably above MIN_RECALL_TOKENS so recall actually runs. */
const CONFIG = {
  conversationScope: 'test-scope',
  recallBudgetTokens: 16_384,
  maxTurnTokens: 60_000,
  systemPromptTokens: 15_000,
  outputReserveTokens: 4_096,
};

// Sentence pairs used across tests — keep them in one place for readability.
const HOT_CONTENT = 'The project uses pnpm workspaces for monorepo package management and TypeScript for type safety';
// Identical to HOT_CONTENT → trigramSimilarity = 1.0.
const IDENTICAL_CONTENT = HOT_CONTENT;
// Completely unrelated topic → trigramSimilarity ≈ 0.
const DISSIMILAR_CONTENT = 'REST API endpoints should return JSON with snake_case field names for consistency';

// ── Similarity assumptions (self-documenting assertions) ────────────────────

describe('trigramSimilarity — test content verification', () => {
  // Retired with the rewrite (§12): 'identical strings exceed the dedup
  // threshold' and 'dissimilar strings are below the dedup threshold' both
  // asserted against DEDUP_THRESHOLD = 0.80 — the assembler's hot-window
  // recall filter, which was deleted along with recallFromBanks/bank
  // federation. No such constant exists in the assembler any more; the
  // store's write-time threshold is its own concern and is covered by
  // redis-store's tests.

  it('identical strings have similarity 1.0', () => {
    expect(trigramSimilarity(IDENTICAL_CONTENT, HOT_CONTENT)).toBe(1.0);
  });
});

// ── Recalled content reaches priorContext ────────────────────────────────────

describe('ContextAssembler — recalled content reaches priorContext', () => {
  // Retired with the rewrite (§12): 'recalled memory identical to hot window
  // content is absent from priorContext' and 'only the duplicate is removed —
  // other memories remain in priorContext' both asserted the H5 hot-window
  // similarity filter (trigramSimilarity(item, hotMsg) > 0.80 → drop). That
  // filter lived inside recallFromBanks and was deleted with bank federation;
  // deduplication now happens at write time in the store.

  it('a recalled record appears in priorContext', async () => {
    const store = makeStoreWith(DISSIMILAR_CONTENT);
    const assembler = new ContextAssembler(store, CONFIG);

    await assembler.push(makeMsg(HOT_CONTENT));

    const ctx = await assembler.assemble('query about APIs');

    expect(ctx.priorContext).not.toBeNull();
    expect(ctx.priorContext).toContain(DISSIMILAR_CONTENT);
  });

  it('a populated hot window does not suppress recalled content', async () => {
    const store = makeStoreWith(DISSIMILAR_CONTENT);
    const assembler = new ContextAssembler(store, CONFIG);

    for (let i = 0; i < 3; i++) {
      await assembler.push(makeMsg(`Hot window message ${i}: ${HOT_CONTENT}`));
    }

    const ctx = await assembler.assemble('query');

    expect(ctx.priorContext).toContain(DISSIMILAR_CONTENT);
  });
});

// ── Empty hot window ──────────────────────────────────────────────────────────

describe('ContextAssembler — recall with an empty hot window', () => {
  it('recalled memories are included when the hot window is empty', async () => {
    const store = makeStoreWith(IDENTICAL_CONTENT);
    const assembler = new ContextAssembler(store, CONFIG);

    // No push() calls — hot window is empty.
    const ctx = await assembler.assemble('query');

    expect(ctx.priorContext).toContain(IDENTICAL_CONTENT);
  });
});

// ── assemble() does not touch the hot window ──────────────────────────────────

describe('ContextAssembler — assemble() leaves the hot window intact', () => {
  it('recall does not remove messages from the hot window', async () => {
    const store = makeStoreWith(IDENTICAL_CONTENT);
    const assembler = new ContextAssembler(store, CONFIG);

    await assembler.push(makeMsg(HOT_CONTENT));
    await assembler.assemble('query');

    // Hot window still contains the original message.
    expect(assembler.getHotWindow()).toHaveLength(1);
    expect(assembler.getHotWindow()[0].content).toBe(HOT_CONTENT);
  });
});

// Retired with the rewrite (§12): 'a recalled memory with similarity exactly
// at 0.80 is NOT filtered (> not >=)' pinned the inequality direction of the
// deleted hot-window filter's threshold. There is no assembler-side similarity
// threshold to have a direction any more.
