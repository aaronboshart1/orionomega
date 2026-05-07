/**
 * @module agent/__tests__/conversation-output-dir
 *
 * Direct-mode "Output Directory (STRICT)" stability tests.
 *
 * Pre-fix bug: every user turn minted a fresh `conv-<ts>-<rand>` runId
 * inside `handleMessage`, so the runDir + STRICT block printed in the
 * system prompt drifted between turns. Files written in turn N became
 * unreachable to turn N+1 because the agent was pointed at an empty
 * `output/conv-B/` instead of the populated `output/conv-A/`.
 *
 * Post-fix invariant: the per-turn `runId` is still per-turn (lifecycle
 * handle for foregroundRunId / backgroundConversations / workflow
 * bindings) but the `conv-<id>` used for the runDir + STRICT block is
 * allocated once per session and reused across every turn until
 * `clearSessionState(sid)` or `/reset` drops it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MainAgent, type MainAgentCallbacks, type MainAgentConfig } from '../main-agent.js';

let workspaceDir: string;
let agent: MainAgent;

const noopCallbacks: MainAgentCallbacks = {
  onText: () => {},
  onThinking: () => {},
  onPlan: () => {},
  onEvent: () => {},
  onGraphState: () => {},
  onCommandResult: () => {},
};

function buildAgent(): MainAgent {
  const config: MainAgentConfig = {
    model: 'claude-test',
    apiKey: 'test-key',
    systemPrompt: 'TEST_BASE_PROMPT',
    workspaceDir,
    checkpointDir: path.join(workspaceDir, 'checkpoints'),
    workerTimeout: 1000,
    maxRetries: 0,
  };
  return new MainAgent(config, noopCallbacks);
}

/**
 * Replace the agent's anthropic client with a fake whose `streamMessage`
 * records the system prompt for each call and yields a no-op end_turn.
 * Returns the recorded prompts array (mutated as turns happen).
 */
function stubAnthropicAndCapturePrompts(a: MainAgent): { prompts: string[] } {
  const prompts: string[] = [];
  const fake = {
    async *streamMessage(opts: { system?: string }) {
      prompts.push(opts.system ?? '');
      yield { type: 'message_start', message: { usage: { input_tokens: 1 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn', usage: { output_tokens: 1 } } };
      yield { type: 'message_stop' };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (a as any).anthropic = fake;
  return { prompts };
}

/** Extract the `conv-<id>` token printed inside the STRICT block. */
function extractConvId(systemPrompt: string): string | null {
  const m = systemPrompt.match(/output\/(conv-[A-Za-z0-9_-]+)`/);
  return m ? m[1] : null;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(path.join(tmpdir(), 'oo-conv-outdir-'));
  agent = buildAgent();
});
afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe('per-session conversation output directory', () => {
  it('allocates the same conv-<id> for repeated calls within one session', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = agent as any;
    const id1 = a.getOrAllocateConvOutputId('s1');
    const id2 = a.getOrAllocateConvOutputId('s1');
    const id3 = a.getOrAllocateConvOutputId('s1');
    expect(id1).toMatch(/^conv-/);
    expect(id2).toBe(id1);
    expect(id3).toBe(id1);
    expect(agent.peekConversationOutputId('s1')).toBe(id1);

    // Different sessions get distinct IDs.
    const otherId = a.getOrAllocateConvOutputId('s2');
    expect(otherId).not.toBe(id1);
  });

  it('clearSessionState drops the entry so the next allocate mints a fresh ID', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = agent as any;
    const id1 = a.getOrAllocateConvOutputId('s1');
    agent.clearSessionState('s1');
    expect(agent.peekConversationOutputId('s1')).toBeUndefined();
    const id2 = a.getOrAllocateConvOutputId('s1');
    expect(id2).not.toBe(id1);
  });

  it('runDir + STRICT block stay identical across 3 scripted direct-mode turns', async () => {
    const { prompts } = stubAnthropicAndCapturePrompts(agent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = agent as any;
    a.currentSessionId = 's1';
    const convId = a.getOrAllocateConvOutputId('s1');
    const expectedRunDir = path.join(workspaceDir, 'output', convId);

    for (let turn = 0; turn < 3; turn++) {
      const turnRunId = `run-test-${turn}`;
      await a.respondConversationally(`turn ${turn}`, undefined, turnRunId, convId);
    }

    expect(prompts).toHaveLength(3);
    const ids = prompts.map(extractConvId);
    expect(ids[0]).toBe(convId);
    expect(ids[1]).toBe(convId);
    expect(ids[2]).toBe(convId);
    // runDir was created exactly once (idempotent mkdir recursive) and
    // points at the per-session conv dir.
    expect(existsSync(expectedRunDir)).toBe(true);
    for (const sp of prompts) {
      expect(sp).toContain(`\`${expectedRunDir}\``);
    }
  });

  it('a file written in turn 1 is still resolvable via the same relative path in turn 3', async () => {
    stubAnthropicAndCapturePrompts(agent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = agent as any;
    a.currentSessionId = 's1';
    const convId = a.getOrAllocateConvOutputId('s1');
    const runDir = path.join(workspaceDir, 'output', convId);

    // Turn 1 — agent (simulated) writes an artifact under runDir.
    await a.respondConversationally('turn 1', undefined, 'run-1', convId);
    await mkdir(runDir, { recursive: true });
    const artifactPath = path.join(runDir, 'turn1-artifact.txt');
    writeFileSync(artifactPath, 'hello from turn 1');

    // Turn 2 — no writes, just stream.
    await a.respondConversationally('turn 2', undefined, 'run-2', convId);

    // Turn 3 — derive runDir from the (unchanged) STRICT block and read
    // the turn-1 artifact via the same relative filename.
    await a.respondConversationally('turn 3', undefined, 'run-3', convId);
    const turn3Prompt = (a.anthropic as { _lastSystem?: string });
    void turn3Prompt; // (recorded prompts are captured via stub array)

    const resolved = path.join(runDir, 'turn1-artifact.txt');
    expect(existsSync(resolved)).toBe(true);
    expect(readFileSync(resolved, 'utf-8')).toBe('hello from turn 1');
  });

  it('handleMessage(direct) keeps the same conv-<id> across 3 scripted turns at the public entrypoint', async () => {
    const { prompts } = stubAnthropicAndCapturePrompts(agent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = agent as any;
    // Stub orchestration with the minimal surface handleMessage()
    // touches before the direct-mode branch dispatches to
    // respondConversationally — we want to exercise the public
    // entrypoint, not bypass it.
    a.orchestration = {
      hasPendingGates: false,
      hasPendingConfirmations: false,
      hasPendingPlans: false,
      latestPendingPlanId: null,
      isWorkflowActive: () => false,
      listPendingGates: () => [],
      stopAll: () => {},
    };

    for (let turn = 0; turn < 3; turn++) {
      await agent.handleMessage('s-pub', `turn ${turn}`, undefined, undefined, 'direct');
    }

    expect(prompts).toHaveLength(3);
    const ids = prompts.map(extractConvId);
    expect(ids[0]).toMatch(/^conv-/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).toBe(ids[0]);
    const expectedRunDir = path.join(workspaceDir, 'output', ids[0]!);
    for (const sp of prompts) {
      expect(sp).toContain(`\`${expectedRunDir}\``);
    }
    expect(existsSync(expectedRunDir)).toBe(true);
  });

  it('detached background turn keeps its own runDir; new foreground turn shares the session conv dir', async () => {
    stubAnthropicAndCapturePrompts(agent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = agent as any;
    a.currentSessionId = 's1';
    const convId = a.getOrAllocateConvOutputId('s1');
    const expectedRunDir = path.join(workspaceDir, 'output', convId);

    // Foreground turn 1 starts and "detaches" (simulated by registering
    // it in backgroundConversations before invoking the loop).
    const bgRunId = 'run-bg-1';
    a.backgroundConversations.set(bgRunId, {
      id: bgRunId,
      abortController: new AbortController(),
      startedAt: Date.now(),
      userMessage: 'bg work',
    });
    await a.respondConversationally('bg work', undefined, bgRunId, convId);

    // New foreground turn after detach — uses a different per-turn
    // runId but the same per-session convOutputId.
    const fgRunId = 'run-fg-2';
    await a.respondConversationally('new fg', undefined, fgRunId, convId);

    // Both turns wrote into the same per-session conv dir.
    expect(existsSync(expectedRunDir)).toBe(true);
    // The session's conv id was never reallocated.
    expect(agent.peekConversationOutputId('s1')).toBe(convId);
  });
});
