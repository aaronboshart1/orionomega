import { describe, it, expect } from 'vitest';
import {
  serverMessageSchema,
  sessionSnapshotSchema,
  codingEventPayloadSchema,
  scheduledTaskSchema,
  parseServerMessage,
  safeParseServerMessage,
  isServerMessage,
  isServerMessageType,
  parseSessionSnapshot,
  isCodingEventPayload,
  type ServerMessage,
} from '../ws-contract.js';

describe('ws-contract: serverMessageSchema', () => {
  it('accepts a minimal envelope', () => {
    const msg = { id: 'm1', type: 'text', content: 'hello' };
    const parsed = parseServerMessage(msg);
    expect(parsed.id).toBe('m1');
    expect(parsed.type).toBe('text');
    expect(parsed.content).toBe('hello');
  });

  it('accepts a full dag_complete envelope with modelUsage', () => {
    const msg = {
      id: 'm2',
      type: 'dag_complete',
      workflowId: 'wf-1',
      dagComplete: {
        workflowId: 'wf-1',
        status: 'complete',
        summary: 'done',
        durationSec: 12,
        workerCount: 3,
        totalCostUsd: 0.42,
        toolCallCount: 9,
        nodeOutputPaths: { 'node-a': ['out/a.md'] },
        modelUsage: [
          {
            model: 'claude',
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            workerCount: 1,
            costUsd: 0.1,
          },
        ],
      },
    };
    const parsed = parseServerMessage(msg);
    expect(parsed.dagComplete?.status).toBe('complete');
    expect(parsed.dagComplete?.modelUsage?.[0]?.model).toBe('claude');
  });

  it('preserves unknown extra fields via passthrough', () => {
    const parsed = serverMessageSchema.parse({ id: 'm3', type: 'event', somethingNew: 42 });
    expect((parsed as Record<string, unknown>).somethingNew).toBe(42);
  });

  it('accepts defensively-read frontend fields (metadata/toolName/count)', () => {
    const parsed = parseServerMessage({
      id: 'm4',
      type: 'text',
      metadata: { model: 'claude', inputTokens: 1, outputTokens: 2, costUsd: 0.01 },
      toolName: 'Bash',
      name: 'Bash',
      count: 3,
    });
    expect(parsed.metadata?.model).toBe('claude');
    expect(parsed.toolName).toBe('Bash');
    expect(parsed.count).toBe(3);
  });

  it('rejects an unknown message type', () => {
    const res = safeParseServerMessage({ id: 'm5', type: 'not_a_real_type' });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain('type');
  });

  it('rejects a message missing the required id', () => {
    const res = safeParseServerMessage({ type: 'text' });
    expect(res.success).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(safeParseServerMessage(null).success).toBe(false);
    expect(safeParseServerMessage('nope').success).toBe(false);
    expect(safeParseServerMessage(42).success).toBe(false);
  });
});

describe('ws-contract: type guards', () => {
  it('isServerMessage narrows valid input', () => {
    const raw: unknown = { id: 'm', type: 'ack' };
    expect(isServerMessage(raw)).toBe(true);
    if (isServerMessage(raw)) {
      const m: ServerMessage = raw;
      expect(m.type).toBe('ack');
    }
  });

  it('isServerMessage rejects invalid input', () => {
    expect(isServerMessage({ id: 1, type: 'text' })).toBe(false);
    expect(isServerMessage(undefined)).toBe(false);
  });

  it('isServerMessageType narrows on the discriminator', () => {
    const msg = parseServerMessage({ id: 'm', type: 'dag_progress', dagProgress: {
      workflowId: 'wf', nodeId: 'n', nodeLabel: 'L', status: 'started',
    } });
    expect(isServerMessageType(msg, 'dag_progress')).toBe(true);
    expect(isServerMessageType(msg, 'text')).toBe(false);
    if (isServerMessageType(msg, 'dag_progress')) {
      expect(msg.dagProgress?.nodeId).toBe('n');
    }
  });
});

describe('ws-contract: codingEventPayloadSchema', () => {
  it('accepts a valid discriminated coding event', () => {
    const ev = {
      type: 'coding:step:progress',
      payload: { nodeId: 'n1', message: 'working', percentage: 50 },
    };
    expect(isCodingEventPayload(ev)).toBe(true);
    const parsed = codingEventPayloadSchema.parse(ev);
    expect(parsed.type).toBe('coding:step:progress');
  });

  it('rejects a coding event with a mismatched payload', () => {
    const ev = { type: 'coding:commit:completed', payload: { nodeId: 'x' } };
    expect(isCodingEventPayload(ev)).toBe(false);
  });

  it('rejects an unknown coding event type', () => {
    expect(isCodingEventPayload({ type: 'coding:bogus', payload: {} })).toBe(false);
  });
});

describe('ws-contract: scheduledTaskSchema', () => {
  it('accepts a task row with nullable timestamps', () => {
    const task = {
      id: 't1', name: 'nightly', description: '', cronExpr: '0 0 * * *', prompt: 'go',
      agentMode: 'orchestrate', sessionId: 'default', status: 'active', timezone: 'UTC',
      overlapPolicy: 'skip', maxRetries: 0, timeoutSec: 0,
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
      lastRunAt: null, nextRunAt: null, lastStatus: null, runCount: 0, runAt: null,
    };
    const parsed = scheduledTaskSchema.parse(task);
    expect(parsed.runCount).toBe(0);
    expect(parsed.lastRunAt).toBeNull();
  });
});

describe('ws-contract: sessionSnapshotSchema', () => {
  it('accepts a rich snapshot and preserves typed fields', () => {
    const snap = {
      messages: [{ id: '1', role: 'user', content: 'hi', timestamp: '2026', extra: true }],
      memoryEvents: [{ id: 'e1', timestamp: '2026', op: 'add', detail: 'x' }],
      inlineDAGs: { 'dag-1': { dagId: 'dag-1', status: 'complete', totalCostUsd: 0.1 } },
      sessionTotals: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0.2, messageCount: 2 },
      lastSeq: 99,
      agentMode: 'direct',
      unknownTopLevel: 'tolerated',
    };
    const parsed = parseSessionSnapshot(snap);
    expect(parsed.messages?.[0]?.role).toBe('user');
    expect(parsed.inlineDAGs?.['dag-1']?.totalCostUsd).toBe(0.1);
    expect(parsed.lastSeq).toBe(99);
    expect((parsed as Record<string, unknown>).unknownTopLevel).toBe('tolerated');
  });

  it('accepts an empty snapshot (all fields optional)', () => {
    expect(() => parseSessionSnapshot({})).not.toThrow();
  });
});
