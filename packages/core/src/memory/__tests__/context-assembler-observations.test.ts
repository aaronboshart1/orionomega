/**
 * Unit tests verifying that ContextAssembler correctly includes observations
 * in recall calls, formats observation results with the [OBSERVATION] prefix,
 * and sorts observation items before other memory types.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAssembler } from '../context-assembler.js';
import type { HindsightClient } from '@orionomega/hindsight';
import type { RecalledMemory } from '@orionomega/hindsight';

type MockRecallResult = {
  results: RecalledMemory[];
  lowConfidence: boolean;
  tokens_used: number;
};

function makeMemory(overrides: Partial<RecalledMemory> = {}): RecalledMemory {
  return {
    content: 'test memory content',
    context: 'decision',
    timestamp: '2024-01-01T00:00:00.000Z',
    relevance: 0.7,
    ...overrides,
  };
}

function makeMockHs(recallResults: RecalledMemory[] = []): HindsightClient {
  const result: MockRecallResult = {
    results: recallResults,
    lowConfidence: false,
    tokens_used: 0,
  };
  return {
    recallWithTemporalDiversity: vi.fn().mockResolvedValue(result),
    listBanksCached: vi.fn().mockResolvedValue([]),
    retainOne: vi.fn().mockResolvedValue({ success: true, bank_id: 'test', items_count: 1 }),
    isDuplicateContent: vi.fn().mockResolvedValue(false),
  } as unknown as HindsightClient;
}

describe('ContextAssembler — observations in recall', () => {
  it('passes types including observation to recallWithTemporalDiversity', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'conv-test',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('What do we know about memory systems?');

    expect(hs.recallWithTemporalDiversity).toHaveBeenCalledTimes(1);
    const callOpts = (hs.recallWithTemporalDiversity as ReturnType<typeof vi.fn>).mock.calls[0][2] as Record<string, unknown>;
    expect(callOpts.types).toEqual(['world', 'experience', 'observation']);
  });

  it('includes types in recall for additional banks too', async () => {
    const hs = makeMockHs();
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'conv-test',
      additionalBanks: ['project-myrepo'],
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    await assembler.assemble('query');

    const calls = (hs.recallWithTemporalDiversity as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of calls) {
      const opts = call[2] as Record<string, unknown>;
      expect(opts.types).toEqual(['world', 'experience', 'observation']);
    }
  });
});

describe('ContextAssembler — observation formatting', () => {
  it('formats observation items with [OBSERVATION, confidence: X.XX] prefix', async () => {
    const hs = makeMockHs([
      makeMemory({
        content: 'The agent uses DAG-based orchestration',
        context: 'observation',
        relevance: 0.75,
      }),
    ]);
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'conv-test',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    const ctx = await assembler.assemble('query');

    expect(ctx.priorContext).not.toBeNull();
    expect(ctx.priorContext).toContain('[OBSERVATION, confidence: 0.75]');
    expect(ctx.priorContext).toContain('The agent uses DAG-based orchestration');
  });

  it('uses standard [confidence: X.XX][context] prefix for non-observation items', async () => {
    const hs = makeMockHs([
      makeMemory({
        content: 'Prefer TypeScript over JavaScript',
        context: 'preference',
        relevance: 0.8,
      }),
    ]);
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'conv-test',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    const ctx = await assembler.assemble('query');

    expect(ctx.priorContext).not.toBeNull();
    expect(ctx.priorContext).toContain('[confidence: 0.80] [preference]');
    expect(ctx.priorContext).not.toContain('[OBSERVATION');
  });

  it('formats multiple items with correct prefixes', async () => {
    const hs = makeMockHs([
      makeMemory({ content: 'Decision: use pnpm', context: 'decision', relevance: 0.8 }),
      makeMemory({ content: 'Pattern observed in codebase', context: 'observation', relevance: 0.6 }),
    ]);
    const assembler = new ContextAssembler(hs, {
      conversationBank: 'conv-test',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });

    const ctx = await assembler.assemble('query');

    expect(ctx.priorContext).toContain('[OBSERVATION, confidence: 0.60]');
    expect(ctx.priorContext).toContain('[confidence: 0.80] [decision]');
  });
});

describe('ContextAssembler — observation-first sort priority', () => {
  let assembler: ContextAssembler;
  let hs: HindsightClient;

  beforeEach(() => {
    // Return two items: a world item with a newer timestamp (would normally sort first)
    // and an observation item with an older timestamp — observation must win sort order.
    hs = makeMockHs([
      makeMemory({
        content: 'Recent world fact',
        context: 'world',
        timestamp: '2024-06-01T00:00:00.000Z',
        relevance: 0.9,  // higher relevance
      }),
      makeMemory({
        content: 'Older server-side observation',
        context: 'observation',
        timestamp: '2024-01-01T00:00:00.000Z',
        relevance: 0.6,  // lower relevance
      }),
    ]);
    assembler = new ContextAssembler(hs, {
      conversationBank: 'conv-test',
      federateBanks: false,
      adaptiveRecall: false,
      dynamicSummaryFallback: false,
    });
  });

  it('places observation items before non-observation items in output', async () => {
    const ctx = await assembler.assemble('query');

    expect(ctx.priorContext).not.toBeNull();
    const obsIdx = ctx.priorContext!.indexOf('[OBSERVATION, confidence: 0.60]');
    const worldIdx = ctx.priorContext!.indexOf('[confidence: 0.90] [world]');
    expect(obsIdx).toBeGreaterThanOrEqual(0);
    expect(worldIdx).toBeGreaterThanOrEqual(0);
    // Observation must appear before the world item in the formatted output
    expect(obsIdx).toBeLessThan(worldIdx);
  });

  it('observation sort wins over both higher relevance and newer timestamp', async () => {
    const ctx = await assembler.assemble('query');

    // The observation (lower relevance, older timestamp) must appear first
    const text = ctx.priorContext!;
    const obsPos = text.indexOf('Older server-side observation');
    const worldPos = text.indexOf('Recent world fact');
    expect(obsPos).toBeGreaterThanOrEqual(0);
    expect(worldPos).toBeGreaterThanOrEqual(0);
    expect(obsPos).toBeLessThan(worldPos);
  });
});
