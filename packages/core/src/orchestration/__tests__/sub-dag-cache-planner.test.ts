/**
 * @module orchestration/__tests__/sub-dag-cache-planner
 *
 * Task #239 — proves `Planner.subPlan` consults the sub-DAG cache:
 *   1. Two identical phase expansions make exactly ONE planner LLM call
 *      (the second is served from cache; `cacheHit === true`).
 *   2. A changed phase body misses the cache and makes a fresh call.
 *   3. A pre-populated cache short-circuits BEFORE the API-key gate
 *      (a cached phase needs no network credentials).
 *
 * We mock the Anthropic client, config loader, and model-discovery so no
 * network round-trips happen; the `createMessage` spy's call count is the
 * direct signal for "did the planner actually run?".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowNode } from '../types.js';

const createMessageSpy = vi.hoisted(() =>
  vi.fn(async () => ({
    id: 'msg_1',
    model: 'claude-sonnet-4-6',
    role: 'assistant' as const,
    stop_reason: 'tool_use' as const,
    content: [
      {
        type: 'tool_use',
        name: 'submit_plan',
        input: {
          nodes: [
            {
              id: 'sub-a',
              type: 'CODING_AGENT',
              label: 'A',
              dependsOn: [],
              codingAgent: { task: 'do A', cwd: '/repo' },
            },
          ],
          summary: 'one node',
        },
      },
    ],
    usage: { input_tokens: 1000, output_tokens: 200 },
  })),
);

vi.mock('../../anthropic/client.js', () => ({
  AnthropicClient: class {
    constructor(_apiKey: string) {}
    createMessage = createMessageSpy;
  },
}));

vi.mock('../../models/model-discovery.js', () => ({
  discoverModels: vi.fn(async () => []),
  pickModelByTier: vi.fn(() => undefined),
  buildModelGuide: vi.fn(() => ''),
}));

let mockApiKey: string | undefined = 'test-key';
vi.mock('../../config/loader.js', () => ({
  readConfig: () => ({
    models: {
      apiKey: mockApiKey,
      default: 'claude-sonnet-4-6',
      provider: 'anthropic',
    },
    agentSdk: {},
    skills: {},
    coding: {},
    orchestration: {},
  }),
}));

// Import AFTER the mocks are registered.
const { Planner } = await import('../planner.js');

function macro(phaseId = 'phase-1'): WorkflowNode {
  return {
    id: `macro-${phaseId}`,
    type: 'MACRO_NODE',
    label: `Phase ${phaseId}`,
    dependsOn: [],
    macro: { specRef: 'SPEC.md', phaseId, phaseTitle: `Title ${phaseId}` },
  };
}

describe('Planner.subPlan sub-DAG cache (Task #239)', () => {
  beforeEach(() => {
    createMessageSpy.mockClear();
    mockApiKey = 'test-key';
  });

  it('serves an identical phase from cache without a second planner call', async () => {
    const planner = new Planner({ model: 'claude-sonnet-4-6' });

    const r1 = await planner.subPlan(macro(), '<repo>', 'body text', undefined);
    expect(r1.cacheHit).toBe(false);
    expect(createMessageSpy).toHaveBeenCalledTimes(1);
    expect(r1.nodes.map((n) => n.id)).toEqual(['phase-1__sub-a']);

    const r2 = await planner.subPlan(macro(), '<repo>', 'body text', undefined);
    expect(r2.cacheHit).toBe(true);
    // No new planner round-trip.
    expect(createMessageSpy).toHaveBeenCalledTimes(1);
    expect(r2.nodes.map((n) => n.id)).toEqual(['phase-1__sub-a']);
    // Cache hit reports zero spend for the pass.
    expect(r2.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

    // Deep-clone isolation: mutating the hit result must not corrupt the
    // cached copy used by the next hit.
    r2.nodes[0].dependsOn.push('analyze');
    const r3 = await planner.subPlan(macro(), '<repo>', 'body text', undefined);
    expect(r3.nodes[0].dependsOn).toEqual([]);
    expect(createMessageSpy).toHaveBeenCalledTimes(1);

    const stats = planner.getSubDagCache().stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
  });

  it('misses the cache when the phase body changes', async () => {
    const planner = new Planner({ model: 'claude-sonnet-4-6' });

    const r1 = await planner.subPlan(macro(), '<repo>', 'original body', undefined);
    expect(r1.cacheHit).toBe(false);
    expect(createMessageSpy).toHaveBeenCalledTimes(1);

    const r2 = await planner.subPlan(macro(), '<repo>', 'DIFFERENT body', undefined);
    expect(r2.cacheHit).toBe(false);
    // The body change forced a fresh planner round-trip.
    expect(createMessageSpy).toHaveBeenCalledTimes(2);
  });

  it('a pre-populated cache short-circuits before the API-key gate', async () => {
    const planner = new Planner({ model: 'claude-sonnet-4-6' });
    const node = macro();
    const cache = planner.getSubDagCache();
    const key = cache.keyFor({
      phaseBody: 'cached body',
      phaseId: 'phase-1',
      model: 'claude-sonnet-4-6',
      repoPreamble: '<repo>',
      upstreamPhaseSummary: undefined,
    });
    cache.set(key, [
      {
        id: 'phase-1__pre',
        type: 'CODING_AGENT',
        label: 'pre',
        dependsOn: [],
        codingAgent: { task: 'precached', cwd: '/repo' },
      },
    ]);

    // Remove credentials: without the cache, subPlan throws "no API key".
    mockApiKey = undefined;

    const r = await planner.subPlan(node, '<repo>', 'cached body', undefined);
    expect(r.cacheHit).toBe(true);
    expect(r.nodes.map((n) => n.id)).toEqual(['phase-1__pre']);
    expect(createMessageSpy).not.toHaveBeenCalled();
  });
});
