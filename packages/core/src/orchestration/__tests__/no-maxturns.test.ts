/**
 * Regression test for Task #211: assert that the SDK `query()` options
 * passed by both `executeAgent` and `executeCodingAgent` do NOT contain
 * a `maxTurns` key.
 *
 * We intercept the underlying `@anthropic-ai/claude-agent-sdk` `query`
 * function via vi.mock, capture the options object, and short-circuit
 * the iteration with a single synthetic `result` message so the agent
 * call returns immediately.
 */

import { describe, it, expect, vi } from 'vitest';

const capturedOptionsList: Array<Record<string, unknown>> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  class MockAbortError extends Error {
    constructor(msg = 'aborted') { super(msg); this.name = 'AbortError'; }
  }
  return {
    AbortError: MockAbortError,
    createSdkMcpServer: vi.fn(() => ({})),
    tool: vi.fn(() => ({})),
    query: vi.fn((opts: Record<string, unknown>) => {
      capturedOptionsList.push(opts);
      // Async-iterable that yields one minimal `result` message
      // (subtype 'success', empty result string) so the bridge returns
      // without invoking real tool calls.
      const iter: AsyncIterable<unknown> & { interrupt?: () => void; close?: () => void } = {
        [Symbol.asyncIterator]() {
          let yielded = false;
          return {
            async next() {
              if (yielded) return { value: undefined, done: true };
              yielded = true;
              return {
                value: {
                  type: 'result',
                  subtype: 'success',
                  total_cost_usd: 0,
                  result: '',
                },
                done: false,
              };
            },
          };
        },
        interrupt: () => {},
        close: () => {},
      };
      return iter;
    }),
  };
});

vi.mock('../../config/loader.js', () => ({
  readConfig: () => ({
    models: { apiKey: 'test-key', default: 'claude-sonnet-4-6', provider: 'anthropic' },
    agentSdk: { enabled: true, permissionMode: 'acceptEdits', effort: 'high' },
    skills: { directory: '/tmp/skills-noop' },
    coding: {},
    orchestration: {},
  }),
}));

vi.mock('../../logging/audit.js', () => ({
  auditToolInvocation: () => {},
}));

vi.mock('../coding/safe-commit.js', () => ({
  buildCommitSafetyToolGuard: () => () => ({ behavior: 'allow' }),
}));

vi.mock('../../agent/skill-tools.js', () => ({
  buildSkillToolset: () => [],
}));

vi.mock('@orionomega/skills-sdk', () => ({
  SkillExecutor: class { constructor() {} },
}));

describe('Task #211: maxTurns is not passed to query() options', () => {
  it('executeAgent — query() options has no maxTurns key', async () => {
    capturedOptionsList.length = 0;
    const { executeAgent } = await import('../agent-sdk-bridge.js');
    await executeAgent({
      task: 'noop',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      cwd: '/tmp',
    });
    expect(capturedOptionsList.length).toBeGreaterThan(0);
    for (const opts of capturedOptionsList) {
      expect(opts).not.toHaveProperty('maxTurns');
      // The SDK options payload lives under `opts.options` — assert
      // explicitly so an accidental reintroduction of `options.maxTurns`
      // is caught even if the top-level key stays clean.
      expect(opts.options).toBeDefined();
      expect(opts.options).not.toHaveProperty('maxTurns');
    }
  });

  it('executeCodingAgent — query() options has no maxTurns key', async () => {
    capturedOptionsList.length = 0;
    const { executeCodingAgent } = await import('../agent-sdk-bridge.js');
    const node = {
      id: 'n1',
      type: 'CODING_AGENT' as const,
      label: 'noop',
      dependsOn: [] as string[],
      status: 'pending' as const,
      codingAgent: {
        task: 'noop',
        model: 'claude-sonnet-4-6',
        cwd: '/tmp',
      },
    };
    await executeCodingAgent(node as never, '/tmp');
    expect(capturedOptionsList.length).toBeGreaterThan(0);
    for (const opts of capturedOptionsList) {
      expect(opts).not.toHaveProperty('maxTurns');
      expect(opts.options).toBeDefined();
      expect(opts.options).not.toHaveProperty('maxTurns');
    }
  });
});
