/**
 * Tests for cross-project LessonsRollup.
 *
 * Uses a hand-rolled fake HindsightClient (only the four methods the rollup
 * touches) so we can assert: project banks are scanned, near-duplicates and
 * already-promoted lessons are skipped, promotions carry a stable idempotent
 * document_id + source tag, non-lesson contexts and too-short content are
 * ignored, and the core bank is the promotion destination (never a source).
 */

import { describe, it, expect, vi } from 'vitest';
import { LessonsRollup } from '../lessons-rollup.js';
import type { HindsightClient } from '../client.js';
import type { BankInfo, RecalledMemory, MemoryItem, RetainResult } from '../types.js';

interface FakeOpts {
  banks: BankInfo[];
  memories: Record<string, RecalledMemory[]>;
  coreSeed?: RecalledMemory[];
}

function mem(content: string, context = 'lesson'): RecalledMemory {
  return { content, context, timestamp: new Date().toISOString(), relevance: 0 };
}

function bank(id: string, memory_count = 5): BankInfo {
  return { bank_id: id, name: id, created_at: new Date().toISOString(), memory_count };
}

function makeFakeClient(opts: FakeOpts) {
  const retained: Array<{ bankId: string; items: MemoryItem[] }> = [];
  const client = {
    listBanksCached: vi.fn(async (): Promise<BankInfo[]> => opts.banks),
    listMemories: vi.fn(async (bankId: string): Promise<{ items: RecalledMemory[] }> => {
      if (bankId === 'core') return { items: opts.coreSeed ?? [] };
      return { items: opts.memories[bankId] ?? [] };
    }),
    retain: vi.fn(async (bankId: string, items: MemoryItem[]): Promise<RetainResult> => {
      retained.push({ bankId, items });
      return { success: true, bank_id: bankId, items_count: items.length };
    }),
  };
  return { client: client as unknown as HindsightClient, raw: client, retained };
}

describe('LessonsRollup.run', () => {
  it('promotes new lessons from project banks into core', async () => {
    const { client, retained } = makeFakeClient({
      banks: [bank('project-alpha'), bank('project-beta'), bank('core')],
      memories: {
        'project-alpha': [mem('always bump the cache key when the response shape changes')],
        'project-beta': [mem('probes must cache their failures to avoid alert floods')],
      },
    });

    const rollup = new LessonsRollup(client);
    const res = await rollup.run();

    expect(res.banksScanned).toBe(2);
    expect(res.lessonsPromoted).toBe(2);
    expect(res.duplicatesSkipped).toBe(0);
    expect(retained.length).toBe(2);
    for (const r of retained) {
      expect(r.bankId).toBe('core');
      expect(r.items[0].context).toBe('lesson');
      expect(r.items[0].document_id).toMatch(/^lesson-rollup-/);
      expect(r.items[0].tags).toContain('cross-project-rollup');
      expect(r.items[0].tags?.some((t) => t.startsWith('source:project-'))).toBe(true);
    }
  });

  it('skips lessons already present in the core bank', async () => {
    const existing = 'probes must cache their failures to avoid alert floods';
    const { client, retained } = makeFakeClient({
      banks: [bank('project-alpha'), bank('core')],
      memories: { 'project-alpha': [mem(existing)] },
      coreSeed: [mem(existing)],
    });

    const rollup = new LessonsRollup(client);
    const res = await rollup.run();

    expect(res.duplicatesSkipped).toBe(1);
    expect(res.lessonsPromoted).toBe(0);
    expect(retained.length).toBe(0);
  });

  it('deduplicates across project banks within a single pass', async () => {
    const shared = 'always bump the cache key when the response shape changes';
    const { client, retained } = makeFakeClient({
      banks: [bank('project-alpha'), bank('project-beta')],
      memories: {
        'project-alpha': [mem(shared)],
        'project-beta': [mem(shared)],
      },
    });

    const rollup = new LessonsRollup(client);
    const res = await rollup.run();

    expect(res.lessonsPromoted).toBe(1);
    expect(res.duplicatesSkipped).toBe(1);
    expect(retained.length).toBe(1);
  });

  it('produces stable document_ids (idempotent across runs)', async () => {
    const content = 'always bump the cache key when the response shape changes';
    const mk = () => makeFakeClient({
      banks: [bank('project-alpha')],
      memories: { 'project-alpha': [mem(content)] },
    });

    const a = mk();
    await new LessonsRollup(a.client).run();
    const b = mk();
    await new LessonsRollup(b.client).run();

    expect(a.retained[0].items[0].document_id).toBe(b.retained[0].items[0].document_id);
  });

  it('ignores non-lesson contexts and too-short content', async () => {
    const { client, retained } = makeFakeClient({
      banks: [bank('project-alpha')],
      memories: {
        'project-alpha': [
          mem('short', 'lesson'), // below minLessonLength
          mem('a perfectly fine length observation here', 'observation'), // wrong context
          mem('this lesson is long enough and should be promoted', 'lesson'),
        ],
      },
    });

    const rollup = new LessonsRollup(client);
    const res = await rollup.run();

    expect(res.lessonsPromoted).toBe(1);
    expect(retained[0].items[0].content).toContain('long enough');
  });

  it('respects the decision context as a lesson source', async () => {
    const { client } = makeFakeClient({
      banks: [bank('project-alpha')],
      memories: {
        'project-alpha': [mem('we chose drizzle for scheduled task storage', 'decision')],
      },
    });
    const res = await new LessonsRollup(client).run();
    expect(res.lessonsPromoted).toBe(1);
  });

  it('never treats the core bank as a source', async () => {
    const { client, raw } = makeFakeClient({
      banks: [bank('core'), bank('project-alpha')],
      memories: { 'project-alpha': [mem('a genuinely novel cross-project lesson here')] },
    });
    await new LessonsRollup(client).run();
    // listMemories called for core (seed) + project-alpha only.
    const scanned = raw.listMemories.mock.calls.map((c) => c[0]);
    expect(scanned).toContain('core');
    expect(scanned).toContain('project-alpha');
    // core must only be read for seeding, never scanned as a project bank.
    expect(scanned.filter((b) => b === 'core').length).toBe(1);
  });

  it('skips empty project banks', async () => {
    const { client } = makeFakeClient({
      banks: [bank('project-empty', 0), bank('project-alpha', 3)],
      memories: { 'project-alpha': [mem('a genuinely novel cross-project lesson here')] },
    });
    const res = await new LessonsRollup(client).run();
    expect(res.banksScanned).toBe(1);
  });

  it('continues past a bank that fails to list and records the error', async () => {
    const { client, raw } = makeFakeClient({
      banks: [bank('project-bad'), bank('project-good')],
      memories: { 'project-good': [mem('a genuinely novel cross-project lesson here')] },
    });
    raw.listMemories.mockImplementation(async (bankId: string) => {
      if (bankId === 'project-bad') throw new Error('boom');
      if (bankId === 'core') return { items: [] };
      return { items: [mem('a genuinely novel cross-project lesson here')] };
    });

    const res = await new LessonsRollup(client).run();
    expect(res.lessonsPromoted).toBe(1);
    expect(res.errors.some((e) => e.includes('project-bad'))).toBe(true);
  });
});

describe('LessonsRollup.start/stop', () => {
  it('start schedules and stop clears without throwing', () => {
    const { client } = makeFakeClient({ banks: [], memories: {} });
    const rollup = new LessonsRollup(client);
    rollup.start(60_000);
    rollup.start(60_000); // idempotent
    rollup.stop();
    rollup.stop(); // safe to call twice
  });
});
