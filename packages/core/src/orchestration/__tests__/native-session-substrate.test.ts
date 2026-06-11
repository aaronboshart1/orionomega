/**
 * @module orchestration/__tests__/native-session-substrate
 *
 * Task #240 (R3) — native multi-agent-session substrate pilot.
 *
 * Covers:
 *   1. `resolveNativeSessionConfig` defaulting + cap clamping.
 *   2. `evaluateLayerEligibility` gating (flag off, single node, mixed types,
 *      oversize, happy path) — including the flag-off invariant that keeps the
 *      executor on its existing path.
 *   3. `agentNameForNode` sanitisation + `buildAgentRoster` (one agent per
 *      node, tools/model pass-through).
 *   4. `buildCoordinatorPrompt` instructs per-subagent fan-out + JSON report.
 *   5. `parseCoordinatorReport` happy path, fenced-block extraction, and
 *      fail-closed behaviour (missing node / unparseable report).
 *   6. `executeNativeSessionLayer` end-to-end with an injected fake `queryFn`:
 *      result mapping, token/cost splitting, session-id capture.
 *   7. `submitNativeSessionFollowUp` resumes the persisted session.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveNativeSessionConfig,
  evaluateLayerEligibility,
  agentNameForNode,
  buildAgentRoster,
  buildCoordinatorPrompt,
  parseCoordinatorReport,
  executeNativeSessionLayer,
  submitNativeSessionFollowUp,
  type NativeSessionNodeSpec,
  type NativeSessionQueryFn,
  type NativeSessionSdkMessage,
} from '../native-session-substrate.js';

/** Build a fake query stream from a list of SDK messages. */
function fakeStream(messages: NativeSessionSdkMessage[]): NativeSessionQueryFn {
  return () => {
    async function* gen(): AsyncGenerator<NativeSessionSdkMessage> {
      for (const m of messages) yield m;
    }
    return gen();
  };
}

/** Convenience: an assistant text block message. */
function assistantText(text: string): NativeSessionSdkMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  };
}

describe('resolveNativeSessionConfig', () => {
  it('defaults to disabled when no block is provided', () => {
    expect(resolveNativeSessionConfig(undefined)).toEqual({
      enabled: false,
      maxAgentsPerLayer: 8,
    });
  });

  it('honours enabled:true and a custom cap', () => {
    expect(resolveNativeSessionConfig({ enabled: true, maxAgentsPerLayer: 3 })).toEqual({
      enabled: true,
      maxAgentsPerLayer: 3,
    });
  });

  it('clamps a non-positive / invalid cap back to the default', () => {
    expect(resolveNativeSessionConfig({ enabled: true, maxAgentsPerLayer: 0 }).maxAgentsPerLayer).toBe(8);
    expect(resolveNativeSessionConfig({ enabled: true, maxAgentsPerLayer: -5 }).maxAgentsPerLayer).toBe(8);
    expect(resolveNativeSessionConfig({ enabled: true, maxAgentsPerLayer: NaN }).maxAgentsPerLayer).toBe(8);
  });

  it('floors a fractional cap', () => {
    expect(resolveNativeSessionConfig({ enabled: true, maxAgentsPerLayer: 4.9 }).maxAgentsPerLayer).toBe(4);
  });
});

describe('evaluateLayerEligibility', () => {
  const enabled = { enabled: true, maxAgentsPerLayer: 8 };

  it('is INELIGIBLE when the flag is off (executor stays on its existing path)', () => {
    const verdict = evaluateLayerEligibility(
      [
        { id: 'a', type: 'CODING_AGENT' },
        { id: 'b', type: 'CODING_AGENT' },
      ],
      { enabled: false, maxAgentsPerLayer: 8 },
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/disabled/i);
  });

  it('is ineligible for a single-node layer', () => {
    const verdict = evaluateLayerEligibility([{ id: 'a', type: 'CODING_AGENT' }], enabled);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/>= 2/);
  });

  it('is ineligible when any node is not a CODING_AGENT', () => {
    const verdict = evaluateLayerEligibility(
      [
        { id: 'a', type: 'CODING_AGENT' },
        { id: 'b', type: 'AGENT' },
      ],
      enabled,
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/non-CODING_AGENT/);
    expect(verdict.reason).toContain('b:AGENT');
  });

  it('is ineligible when the layer exceeds maxAgentsPerLayer', () => {
    const verdict = evaluateLayerEligibility(
      [
        { id: 'a', type: 'CODING_AGENT' },
        { id: 'b', type: 'CODING_AGENT' },
        { id: 'c', type: 'CODING_AGENT' },
      ],
      { enabled: true, maxAgentsPerLayer: 2 },
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/maxAgentsPerLayer/);
  });

  it('is ELIGIBLE for >=2 CODING_AGENT nodes within the cap', () => {
    const verdict = evaluateLayerEligibility(
      [
        { id: 'a', type: 'CODING_AGENT' },
        { id: 'b', type: 'CODING_AGENT' },
      ],
      enabled,
    );
    expect(verdict.eligible).toBe(true);
  });
});

describe('agentNameForNode + buildAgentRoster', () => {
  it('sanitises node ids into stable agent names', () => {
    expect(agentNameForNode('node/with spaces!!')).toBe('node-node-with-spaces');
    expect(agentNameForNode('---')).toBe('node-unnamed');
    expect(agentNameForNode('clean_id-1')).toBe('node-clean_id-1');
  });

  it('builds one agent per node and passes through tools/model', () => {
    const specs: NativeSessionNodeSpec[] = [
      { nodeId: 'n1', label: 'First', task: 'do A', tools: ['Read', 'Write'], model: 'opus' },
      { nodeId: 'n2', label: 'Second', task: 'do B' },
    ];
    const roster = buildAgentRoster(specs);
    expect(Object.keys(roster).sort()).toEqual(['node-n1', 'node-n2']);
    expect(roster['node-n1'].tools).toEqual(['Read', 'Write']);
    expect(roster['node-n1'].model).toBe('opus');
    expect(roster['node-n1'].description).toContain('n1');
    // No tools/model omitted cleanly.
    expect(roster['node-n2'].tools).toBeUndefined();
    expect(roster['node-n2'].model).toBeUndefined();
  });

  it('prepends an optional role system prompt', () => {
    const roster = buildAgentRoster([
      { nodeId: 'n1', label: 'First', task: 'do A', roleSystemPrompt: 'You are a security auditor.' },
    ]);
    expect(roster['node-n1'].prompt).toContain('You are a security auditor.');
  });
});

describe('buildCoordinatorPrompt', () => {
  it('names each subagent and demands a JSON results report', () => {
    const prompt = buildCoordinatorPrompt([
      { nodeId: 'n1', label: 'First', task: 'do A' },
      { nodeId: 'n2', label: 'Second', task: 'do B' },
    ]);
    expect(prompt).toContain('COORDINATOR');
    expect(prompt).toContain('subagent `node-n1`');
    expect(prompt).toContain('subagent `node-n2`');
    expect(prompt).toContain('do A');
    expect(prompt).toContain('do B');
    expect(prompt).toContain('"results"');
    expect(prompt).toContain('Task tool');
  });
});

describe('parseCoordinatorReport', () => {
  it('parses a fenced JSON report and maps per-node outcomes', () => {
    const text = [
      'Some narration.',
      '```json',
      JSON.stringify({
        results: [
          { nodeId: 'n1', status: 'done', summary: 'built A', outputPaths: ['a.ts'] },
          { nodeId: 'n2', status: 'error', summary: 'failed B', outputPaths: [] },
        ],
      }),
      '```',
    ].join('\n');
    const { results, parsed } = parseCoordinatorReport(text, ['n1', 'n2']);
    expect(parsed).toBe(true);
    expect(results.get('n1')).toEqual({ status: 'done', summary: 'built A', outputPaths: ['a.ts'] });
    expect(results.get('n2')!.status).toBe('error');
  });

  it('uses the LAST results-bearing block when several are present', () => {
    const text = [
      '```json',
      JSON.stringify({ results: [{ nodeId: 'n1', status: 'error', summary: 'stale' }] }),
      '```',
      'updated:',
      '```json',
      JSON.stringify({ results: [{ nodeId: 'n1', status: 'done', summary: 'fresh' }] }),
      '```',
    ].join('\n');
    const { results } = parseCoordinatorReport(text, ['n1']);
    expect(results.get('n1')).toEqual({ status: 'done', summary: 'fresh', outputPaths: [] });
  });

  it('fails CLOSED for a node missing from an otherwise-parsed report', () => {
    const text = '```json\n' + JSON.stringify({ results: [{ nodeId: 'n1', status: 'done', summary: 'ok' }] }) + '\n```';
    const { results, parsed } = parseCoordinatorReport(text, ['n1', 'n2']);
    expect(parsed).toBe(true);
    expect(results.get('n2')!.status).toBe('error');
    expect(results.get('n2')!.summary).toMatch(/omitted/i);
  });

  it('fails CLOSED for every node when the report is unparseable', () => {
    const { results, parsed } = parseCoordinatorReport('no json here at all', ['n1', 'n2']);
    expect(parsed).toBe(false);
    expect(results.get('n1')!.status).toBe('error');
    expect(results.get('n2')!.status).toBe('error');
    expect(results.get('n1')!.summary).toMatch(/no parseable/i);
  });
});

describe('executeNativeSessionLayer', () => {
  const specs: NativeSessionNodeSpec[] = [
    { nodeId: 'n1', label: 'First', task: 'do A' },
    { nodeId: 'n2', label: 'Second', task: 'do B' },
  ];

  it('maps the coordinator report onto nodes and splits usage/cost', async () => {
    const report = {
      results: [
        { nodeId: 'n1', status: 'done', summary: 'built A', outputPaths: ['a.ts'] },
        { nodeId: 'n2', status: 'done', summary: 'built B', outputPaths: [] },
      ],
    };
    const queryFn = fakeStream([
      { type: 'system', subtype: 'init', session_id: 'sess-123' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Task' },
            { type: 'tool_use', name: 'Task' },
            { type: 'text', text: '```json\n' + JSON.stringify(report) + '\n```' },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 4,
          },
        },
      },
      { type: 'result', subtype: 'success', result: 'all done', total_cost_usd: 0.42 },
    ]);

    const res = await executeNativeSessionLayer({
      specs,
      cwd: '/tmp/work',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
      queryFn,
    });

    expect(res.sessionId).toBe('sess-123');
    expect(res.reportParsed).toBe(true);
    expect(res.totalCostUsd).toBe(0.42);
    expect(res.totalToolCalls).toBe(2);

    const n1 = res.perNode.get('n1')!;
    const n2 = res.perNode.get('n2')!;
    expect(n1.success).toBe(true);
    expect(n1.output).toBe('built A');
    expect(n1.outputPaths).toEqual(['a.ts']);

    // Cost is attributed once (to the first node), not double-counted.
    expect(n1.costUsd).toBe(0.42);
    expect(n2.costUsd).toBe(0);

    // Tokens floor-split with remainder on the first node.
    expect(n1.inputTokens + n2.inputTokens).toBe(100);
    expect(n1.outputTokens + n2.outputTokens).toBe(50);
    expect(n1.toolCalls + n2.toolCalls).toBe(2);
  });

  it('marks a node failed (fail-closed) when the report omits it', async () => {
    const report = { results: [{ nodeId: 'n1', status: 'done', summary: 'ok', outputPaths: [] }] };
    const queryFn = fakeStream([
      { type: 'system', subtype: 'init', session_id: 'sess-9' },
      assistantText('```json\n' + JSON.stringify(report) + '\n```'),
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 },
    ]);
    const res = await executeNativeSessionLayer({
      specs,
      cwd: '/tmp/work',
      apiKey: 'k',
      model: 'm',
      queryFn,
    });
    expect(res.perNode.get('n1')!.success).toBe(true);
    expect(res.perNode.get('n2')!.success).toBe(false);
    expect(res.perNode.get('n2')!.error).toBeDefined();
  });
});

describe('submitNativeSessionFollowUp', () => {
  it('resumes the persisted session id and returns the follow-up result', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const queryFn: NativeSessionQueryFn = (args) => {
      capturedOptions = args.options;
      async function* gen(): AsyncGenerator<NativeSessionSdkMessage> {
        yield { type: 'system', subtype: 'init', session_id: 'sess-123' };
        yield assistantText('follow-up answer');
        yield { type: 'result', subtype: 'success', result: 'final answer', total_cost_usd: 0.05 };
      }
      return gen();
    };

    const res = await submitNativeSessionFollowUp({
      sessionId: 'sess-123',
      prompt: 'What did node n1 change?',
      cwd: '/tmp/work',
      apiKey: 'k',
      model: 'm',
      queryFn,
    });

    expect(capturedOptions?.resume).toBe('sess-123');
    expect(capturedOptions?.persistSession).toBe(true);
    expect(res.sessionId).toBe('sess-123');
    expect(res.finalResult).toBe('final answer');
    expect(res.costUsd).toBe(0.05);
  });
});
