/**
 * Unit tests for MemoryBridge methods used in the DAG coding path:
 * recallForPlanning (types, budgets, cross-project federation),
 * reflectForDecision (reflect API call + TTL cache),
 * ensureDirectives (create missing, skip existing).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryBridge } from '../memory-bridge.js';
import type { AnthropicClient } from '../../anthropic/client.js';
import type { EventBus } from '../../orchestration/event-bus.js';
import type { HindsightClient } from '@orionomega/hindsight';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRecallResult(contents: string[] = ['Memory content']) {
  return {
    results: contents.map((content) => ({
      content,
      context: 'decision',
      timestamp: '2024-01-01T00:00:00.000Z',
      relevance: 0.8,
    })),
    tokens_used: 100,
    totalEstimatedTokens: 100,
  };
}

function makeMockHs(): HindsightClient & {
  recall: ReturnType<typeof vi.fn>;
  listBanksCached: ReturnType<typeof vi.fn>;
  reflect: ReturnType<typeof vi.fn>;
  listDirectives: ReturnType<typeof vi.fn>;
  createDirective: ReturnType<typeof vi.fn>;
} {
  return {
    recall: vi.fn().mockResolvedValue(makeRecallResult()),
    listBanksCached: vi.fn().mockResolvedValue([]),
    reflect: vi.fn().mockResolvedValue({ answer: 'The system uses DAG orchestration', structured_output: null }),
    listDirectives: vi.fn().mockResolvedValue([]),
    createDirective: vi.fn().mockResolvedValue({
      id: 'dir-1', name: 'test', content: 'test rule', priority: 10,
      is_active: true, tags: [], created_at: '', updated_at: '',
    }),
  } as unknown as ReturnType<typeof makeMockHs>;
}

function makeBridge(hs: HindsightClient, projectBank: string | null = 'project-myrepo') {
  const bridge = new MemoryBridge(
    { model: 'claude-test' },
    {} as unknown as AnthropicClient,
    {} as unknown as EventBus,
  );
  // Inject mock dependencies via private field casts (same pattern as orchestration-bridge tests)
  (bridge as unknown as { hindsightClient: HindsightClient }).hindsightClient = hs;
  (bridge as unknown as { activeProjectBank: string | null }).activeProjectBank = projectBank;
  return bridge;
}

// ── recallForPlanning ────────────────────────────────────────────────────────

describe('MemoryBridge.recallForPlanning()', () => {
  it('passes types: [world, experience, observation] to core bank recall', async () => {
    const hs = makeMockHs();
    const bridge = makeBridge(hs);

    await bridge.recallForPlanning('Implement auth module');

    const coreBankCall = hs.recall.mock.calls.find(
      (c: unknown[]) => c[0] === 'core',
    );
    expect(coreBankCall).toBeDefined();
    const opts = coreBankCall![2] as Record<string, unknown>;
    expect(opts.types).toEqual(['world', 'experience', 'observation']);
  });

  it('passes types: [world, experience, observation] to project bank recall', async () => {
    const hs = makeMockHs();
    const bridge = makeBridge(hs, 'project-myrepo');

    await bridge.recallForPlanning('Add API endpoint');

    const projectBankCall = hs.recall.mock.calls.find(
      (c: unknown[]) => c[0] === 'project-myrepo',
    );
    expect(projectBankCall).toBeDefined();
    const opts = projectBankCall![2] as Record<string, unknown>;
    expect(opts.types).toEqual(['world', 'experience', 'observation']);
  });

  it('uses budget: high for core bank', async () => {
    const hs = makeMockHs();
    const bridge = makeBridge(hs);

    await bridge.recallForPlanning('task');

    const coreCall = hs.recall.mock.calls.find((c: unknown[]) => c[0] === 'core');
    const opts = coreCall![2] as Record<string, unknown>;
    expect(opts.budget).toBe('high');
  });

  it('uses maxTokens: 2048 for core bank', async () => {
    const hs = makeMockHs();
    const bridge = makeBridge(hs);

    await bridge.recallForPlanning('task');

    const coreCall = hs.recall.mock.calls.find((c: unknown[]) => c[0] === 'core');
    const opts = coreCall![2] as Record<string, unknown>;
    expect(opts.maxTokens).toBe(2048);
  });

  it('uses maxTokens: 3072 for project bank', async () => {
    const hs = makeMockHs();
    const bridge = makeBridge(hs, 'project-repo');

    await bridge.recallForPlanning('task');

    const projectCall = hs.recall.mock.calls.find((c: unknown[]) => c[0] === 'project-repo');
    expect(projectCall).toBeDefined();
    const opts = projectCall![2] as Record<string, unknown>;
    expect(opts.maxTokens).toBe(3072);
  });

  it('returns concatenated memory contents', async () => {
    const hs = makeMockHs();
    hs.recall.mockResolvedValue(makeRecallResult(['Core memory A', 'Core memory B']));
    const bridge = makeBridge(hs, null);

    const memories = await bridge.recallForPlanning('task');

    expect(memories.length).toBeGreaterThan(0);
    expect(memories.join('\n')).toContain('Core memory A');
  });

  it('returns empty array when hindsightClient is null', async () => {
    const bridge = new MemoryBridge(
      { model: 'test' },
      {} as unknown as AnthropicClient,
      {} as unknown as EventBus,
    );
    // Leave hindsightClient as null (default)

    const memories = await bridge.recallForPlanning('task');

    expect(memories).toEqual([]);
  });
});

describe('MemoryBridge.recallForPlanning() — cross-project federation', () => {
  it('queries other project banks and prefixes results with [Cross-project: bankId]', async () => {
    const hs = makeMockHs();
    hs.listBanksCached.mockResolvedValue([
      { bank_id: 'core', name: 'Core', created_at: '', memory_count: 5 },
      { bank_id: 'project-myrepo', name: 'My Repo', created_at: '', memory_count: 10 },
      { bank_id: 'project-other', name: 'Other Project', created_at: '', memory_count: 3 },
    ]);
    // Return different results per bank
    hs.recall.mockImplementation((bankId: string) => {
      if (bankId === 'project-other') {
        return Promise.resolve(makeRecallResult(['Cross-project insight']));
      }
      return Promise.resolve(makeRecallResult(['Local memory']));
    });
    const bridge = makeBridge(hs, 'project-myrepo');

    const memories = await bridge.recallForPlanning('task');

    const fedResult = memories.find((m) => m.includes('[Cross-project: project-other]'));
    expect(fedResult).toBeDefined();
    expect(fedResult).toContain('Cross-project insight');
  });

  it('skips core and active project bank during federation', async () => {
    const hs = makeMockHs();
    hs.listBanksCached.mockResolvedValue([
      { bank_id: 'core', name: 'Core', created_at: '', memory_count: 5 },
      { bank_id: 'project-myrepo', name: 'My Repo', created_at: '', memory_count: 10 },
    ]);
    const bridge = makeBridge(hs, 'project-myrepo');

    await bridge.recallForPlanning('task');

    // Neither core nor project-myrepo should appear as cross-project
    const allMemories = await bridge.recallForPlanning('task');
    for (const m of allMemories) {
      expect(m).not.toContain('[Cross-project: core]');
      expect(m).not.toContain('[Cross-project: project-myrepo]');
    }
  });

  it('skips banks with zero memory_count during federation', async () => {
    const hs = makeMockHs();
    hs.listBanksCached.mockResolvedValue([
      { bank_id: 'project-empty', name: 'Empty', created_at: '', memory_count: 0 },
    ]);
    const bridge = makeBridge(hs, null);

    await bridge.recallForPlanning('task');

    const fedCalls = hs.recall.mock.calls.filter((c: unknown[]) => c[0] === 'project-empty');
    expect(fedCalls).toHaveLength(0);
  });
});

// ── reflectForDecision ───────────────────────────────────────────────────────

describe('MemoryBridge.reflectForDecision()', () => {
  it('calls hindsightClient.reflect on the active project bank', async () => {
    const hs = makeMockHs();
    const bridge = makeBridge(hs, 'project-myrepo');

    await bridge.reflectForDecision('What patterns do we use?');

    expect(hs.reflect).toHaveBeenCalledTimes(1);
    const [bankId, question] = hs.reflect.mock.calls[0] as [string, string];
    expect(bankId).toBe('project-myrepo');
    expect(question).toBe('What patterns do we use?');
  });

  it('falls back to core bank when no project bank is set', async () => {
    const hs = makeMockHs();
    const bridge = makeBridge(hs, null);

    await bridge.reflectForDecision('What patterns?');

    const [bankId] = hs.reflect.mock.calls[0] as [string, string];
    expect(bankId).toBe('core');
  });

  it('uses an explicit bankId when provided', async () => {
    const hs = makeMockHs();
    const bridge = makeBridge(hs, 'project-default');

    await bridge.reflectForDecision('Question?', 'project-custom');

    const [bankId] = hs.reflect.mock.calls[0] as [string, string];
    expect(bankId).toBe('project-custom');
  });

  it('returns the answer from the reflect response', async () => {
    const hs = makeMockHs();
    hs.reflect.mockResolvedValue({ answer: 'Use repository pattern', structured_output: null });
    const bridge = makeBridge(hs);

    const result = await bridge.reflectForDecision('What patterns?');

    expect(result).toBe('Use repository pattern');
  });

  it('returns null on reflect error', async () => {
    const hs = makeMockHs();
    hs.reflect.mockRejectedValue(new Error('Server unavailable'));
    const bridge = makeBridge(hs);

    const result = await bridge.reflectForDecision('What patterns?');

    expect(result).toBeNull();
  });

  it('returns null when hindsightClient is not initialised', async () => {
    const bridge = new MemoryBridge(
      { model: 'test' },
      {} as unknown as AnthropicClient,
      {} as unknown as EventBus,
    );

    const result = await bridge.reflectForDecision('Question?');

    expect(result).toBeNull();
  });

  it('caches results — second call with same question does not hit the API again', async () => {
    const hs = makeMockHs();
    hs.reflect.mockResolvedValue({ answer: 'Cached answer', structured_output: null });
    const bridge = makeBridge(hs);

    const first = await bridge.reflectForDecision('Same question');
    const second = await bridge.reflectForDecision('Same question');

    expect(first).toBe('Cached answer');
    expect(second).toBe('Cached answer');
    // reflect should only have been called once — the second call hit the cache
    expect(hs.reflect).toHaveBeenCalledTimes(1);
  });

  it('cache is keyed by bank+question — different questions bypass cache', async () => {
    const hs = makeMockHs();
    hs.reflect
      .mockResolvedValueOnce({ answer: 'Answer A', structured_output: null })
      .mockResolvedValueOnce({ answer: 'Answer B', structured_output: null });
    const bridge = makeBridge(hs);

    const a = await bridge.reflectForDecision('Question A');
    const b = await bridge.reflectForDecision('Question B');

    expect(a).toBe('Answer A');
    expect(b).toBe('Answer B');
    expect(hs.reflect).toHaveBeenCalledTimes(2);
  });
});

// ── ensureDirectives ─────────────────────────────────────────────────────────

describe('MemoryBridge.ensureDirectives()', () => {
  it('creates directive when none exist', async () => {
    const hs = makeMockHs();
    hs.listDirectives.mockResolvedValue([]);
    const bridge = makeBridge(hs);

    await bridge.ensureDirectives('project-myrepo', [
      { name: 'No force push', content: 'Never force-push to main', priority: 10 },
    ]);

    expect(hs.createDirective).toHaveBeenCalledTimes(1);
    const [bankId, directive] = hs.createDirective.mock.calls[0] as [string, Record<string, unknown>];
    expect(bankId).toBe('project-myrepo');
    expect(directive.name).toBe('No force push');
    expect(directive.content).toBe('Never force-push to main');
  });

  it('skips creating directive when one with same name already exists', async () => {
    const hs = makeMockHs();
    hs.listDirectives.mockResolvedValue([
      {
        id: 'dir-1', name: 'No force push', content: 'existing', priority: 10,
        is_active: true, tags: [], created_at: '', updated_at: '',
      },
    ]);
    const bridge = makeBridge(hs);

    await bridge.ensureDirectives('project-myrepo', [
      { name: 'No force push', content: 'Updated content' },
    ]);

    expect(hs.createDirective).not.toHaveBeenCalled();
  });

  it('creates only missing directives when some already exist', async () => {
    const hs = makeMockHs();
    hs.listDirectives.mockResolvedValue([
      {
        id: 'dir-1', name: 'Existing rule', content: 'existing', priority: 5,
        is_active: true, tags: [], created_at: '', updated_at: '',
      },
    ]);
    const bridge = makeBridge(hs);

    await bridge.ensureDirectives('bank', [
      { name: 'Existing rule', content: 'old' },
      { name: 'New rule', content: 'new rule content', priority: 8 },
    ]);

    expect(hs.createDirective).toHaveBeenCalledTimes(1);
    const [, directive] = hs.createDirective.mock.calls[0] as [string, Record<string, unknown>];
    expect(directive.name).toBe('New rule');
  });

  it('is a no-op when hindsightClient is not initialised', async () => {
    const bridge = new MemoryBridge(
      { model: 'test' },
      {} as unknown as AnthropicClient,
      {} as unknown as EventBus,
    );

    // Should not throw
    await expect(
      bridge.ensureDirectives('bank', [{ name: 'rule', content: 'content' }]),
    ).resolves.toBeUndefined();
  });

  it('does not throw on listDirectives failure', async () => {
    const hs = makeMockHs();
    hs.listDirectives.mockRejectedValue(new Error('Server error'));
    const bridge = makeBridge(hs);

    // Should swallow the error gracefully
    await expect(
      bridge.ensureDirectives('bank', [{ name: 'rule', content: 'content' }]),
    ).resolves.toBeUndefined();
  });
});
