/**
 * @module memory/__tests__/helpers/mock-store
 * Shared {@link MemoryStore} test double.
 *
 * Mocks the backend-neutral {@link MemoryStore} interface, not any particular
 * backend, so a change to `RedisMemoryStore` touches the mock surface in
 * exactly one place.
 *
 * `ContextAssembler` is the only caller of `store.recall`, and it issues
 * exactly one `recall(scope, query, opts)` per configured scope — so tests
 * read `store.recall.mock.calls` directly; no filtering helper is needed.
 */

import { vi } from 'vitest';
import type { MemoryStore, RecalledRecord, ScopeInfo } from '../../store.js';

/** A MemoryStore whose methods are all vitest mocks. */
export type MockStore = MemoryStore & {
  recall: ReturnType<typeof vi.fn>;
  listScopes: ReturnType<typeof vi.fn>;
  retain: ReturnType<typeof vi.fn>;
  retainOne: ReturnType<typeof vi.fn>;
  isDuplicate: ReturnType<typeof vi.fn>;
  deleteScope: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
};

export interface MockStoreOptions {
  /** Records returned from every `recall` call. Default: none. */
  records?: RecalledRecord[];
  /** `lowConfidence` flag on recall outcomes. Default: false. */
  lowConfidence?: boolean;
  /** Scopes returned from `listScopes`. Default: none. */
  scopes?: ScopeInfo[];
  /** Override the `retain` mock (e.g. to assert on batched writes). */
  retain?: ReturnType<typeof vi.fn>;
  /** Override the `recall` mock entirely (e.g. per-scope results). */
  recall?: ReturnType<typeof vi.fn>;
}

/** Build a fully-mocked MemoryStore. */
export function makeMockStore(opts: MockStoreOptions = {}): MockStore {
  const records = opts.records ?? [];
  const outcome = {
    records,
    lowConfidence: opts.lowConfidence ?? false,
    tokensUsed: 0,
  };

  return {
    recall: opts.recall ?? vi.fn().mockResolvedValue(outcome),
    listScopes: vi.fn().mockResolvedValue(opts.scopes ?? []),
    retain: opts.retain ?? vi.fn().mockResolvedValue({ ok: true, count: 1 }),
    retainOne: vi.fn().mockResolvedValue({ ok: true, count: 1 }),
    isDuplicate: vi.fn().mockResolvedValue(false),
    deleteScope: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue({ healthy: true }),
  } as unknown as MockStore;
}

/** Build a single recalled record with sensible defaults. */
export function record(partial: Partial<RecalledRecord> & { content: string }): RecalledRecord {
  return {
    context: 'lesson',
    timestamp: new Date().toISOString(),
    relevance: 0.9,
    ...partial,
  };
}
