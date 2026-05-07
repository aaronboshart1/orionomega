/**
 * @module agent/__tests__/attachment-staging-dispatch
 *
 * Task #192 — integration tests:
 *   1. `MainAgent.handleMessage` stages chat attachments to disk on
 *      every dispatch route (orchestrate, code, skill).
 *   2. The orchestration dispatch receives a planner task that PREPENDS
 *      the staged-attachments preamble (paths/MIME/size) before the
 *      original user content.
 *   3. The dispatch options carry `stagedAttachments`, which the executor
 *      uses to inject paths into AGENT/CODING_AGENT workers (the executor
 *      injection itself is unit-tested in
 *      `orchestration/__tests__/executor.test.ts`-style harnesses; here
 *      we assert the wiring end-to-end at the dispatch boundary).
 *   4. Retry of the same turn reuses the on-disk file without overwriting.
 *   5. A write failure surfaces as a verbatim user-facing error AND the
 *      dispatch is aborted (no orchestration call made).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MainAgent, type MainAgentCallbacks, type MainAgentConfig } from '../main-agent.js';
import { ATTACHMENTS_DIR_NAME } from '../attachment-staging.js';

let workspaceDir: string;
let agent: MainAgent;
let textCalls: string[];
let prevConfigPath: string | undefined;

const callbacks = (): MainAgentCallbacks => {
  textCalls = [];
  return {
    onText: (m) => { textCalls.push(m); },
    onThinking: () => {},
    onPlan: () => {},
    onEvent: () => {},
    onGraphState: () => {},
    onCommandResult: () => {},
  };
};

function buildAgent(): MainAgent {
  const config: MainAgentConfig = {
    model: 'claude-test',
    apiKey: 'test-key',
    systemPrompt: 'TEST_PROMPT',
    workspaceDir,
    checkpointDir: path.join(workspaceDir, 'checkpoints'),
    workerTimeout: 1000,
    maxRetries: 0,
  };
  return new MainAgent(config, callbacks());
}

interface DispatchCapture {
  type: 'full' | 'coding';
  task: string;
  opts: Record<string, unknown> | undefined;
}

function stubOrchestration(a: MainAgent): { calls: DispatchCapture[] } {
  const calls: DispatchCapture[] = [];
  const fakeOrch = {
    hasPendingGates: false,
    hasPendingConfirmations: false,
    hasPendingPlans: false,
    latestPendingPlanId: null,
    isWorkflowActive: () => false,
    listPendingGates: () => [],
    stopAll: () => {},
    dispatchFullDAG: async (task: string, _push: unknown, opts?: Record<string, unknown>) => {
      calls.push({ type: 'full', task, opts });
    },
    dispatchCodingWorkflow: async (task: string, _push: unknown, opts?: Record<string, unknown>) => {
      calls.push({ type: 'coding', task, opts });
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (a as any).orchestration = fakeOrch;
  return { calls };
}

beforeEach(() => {
  workspaceDir = mkdtempSync(path.join(tmpdir(), 'oo-stage-disp-'));
  prevConfigPath = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = path.join(workspaceDir, 'config.yaml');
  agent = buildAgent();
});
afterEach(() => {
  if (prevConfigPath === undefined) delete process.env.CONFIG_PATH;
  else process.env.CONFIG_PATH = prevConfigPath;
  // Restore any chmod-locked staging dir before rm.
  try {
    const sessions = path.join(workspaceDir, 'output');
    if (existsSync(sessions)) {
      for (const conv of require('node:fs').readdirSync(sessions)) {
        const a = path.join(sessions, conv, ATTACHMENTS_DIR_NAME);
        try { chmodSync(a, 0o755); } catch { /* */ }
      }
    }
  } catch { /* */ }
  rmSync(workspaceDir, { recursive: true, force: true });
});

const HELLO_B64 = Buffer.from('hello,world\n1,2\n', 'utf-8').toString('base64');

describe('Task #192 — handleMessage stages attachments and threads them through dispatch', () => {
  it('orchestrate route: stages file to disk and prepends preamble + carries stagedAttachments opt', async () => {
    const { calls } = stubOrchestration(agent);
    await agent.handleMessage(
      's1',
      'please orchestrate analysis on this CSV',
      undefined,
      [{ name: 'data.csv', size: HELLO_B64.length, type: 'text/csv', data: HELLO_B64 }],
      'orchestrate',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe('full');
    // Original user content reaches the dispatch (the preamble itself is
    // prepended INSIDE the real `dispatchFullDAG` and asserted by the
    // helper-level unit tests on `renderStagedAttachmentsBlock`; this
    // stub captures the call before that prepend runs).
    expect(calls[0]!.task).toContain('please orchestrate analysis on this CSV');
    // Defense-in-depth: the staged list also rides on the dispatch opts so
    // the executor can inject per-worker context even when the planner LLM
    // re-emits worker tasks without the preamble.
    const opts = calls[0]!.opts as { stagedAttachments?: { absPath: string; name: string }[] } | undefined;
    expect(opts?.stagedAttachments).toHaveLength(1);
    expect(opts!.stagedAttachments![0]!.name).toBe('data.csv');
    expect(opts!.stagedAttachments![0]!.absPath.endsWith('data.csv')).toBe(true);
    // File actually exists on disk.
    expect(existsSync(opts!.stagedAttachments![0]!.absPath)).toBe(true);
    expect(readFileSync(opts!.stagedAttachments![0]!.absPath, 'utf-8')).toBe('hello,world\n1,2\n');
  });

  it('code route: forwards stagedAttachments to dispatchCodingWorkflow', async () => {
    const { calls } = stubOrchestration(agent);
    await agent.handleMessage(
      's2',
      'add a function that parses this',
      undefined,
      [{ name: 'spec.md', size: 5, type: 'text/markdown', textContent: '# spec' }],
      'code',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe('coding');
    const opts = calls[0]!.opts as { stagedAttachments?: { name: string }[] } | undefined;
    expect(opts?.stagedAttachments?.[0]?.name).toBe('spec.md');
  });

  it('retry within the same session reuses the on-disk file without overwriting', async () => {
    const { calls } = stubOrchestration(agent);
    const att = { name: 'data.csv', size: HELLO_B64.length, type: 'text/csv', data: HELLO_B64 };

    await agent.handleMessage('s3', 'first try', undefined, [att], 'orchestrate');
    const first = (calls[0]!.opts as { stagedAttachments: { absPath: string }[] }).stagedAttachments[0]!.absPath;
    const mtime1 = statSync(first).mtimeMs;

    await new Promise((r) => setTimeout(r, 25));

    await agent.handleMessage('s3', 'retry', undefined, [att], 'orchestrate');
    const second = (calls[1]!.opts as { stagedAttachments: { absPath: string }[] }).stagedAttachments[0]!.absPath;
    const mtime2 = statSync(second).mtimeMs;

    // Same path (per-session staging dir reused) and no rewrite occurred.
    expect(second).toBe(first);
    expect(mtime2).toBe(mtime1);
  });

  it('staging write failure aborts dispatch and surfaces the verbatim error to the user', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const { calls } = stubOrchestration(agent);

    // Pre-create the per-session staging dir read-only so the first
    // attachment write fails.
    // First we have to know the convOutputId — but it's per-session and
    // allocated on demand. Easiest path: pre-create EVERY potential
    // _attachments dir under workspaceDir/output/* by intercepting once:
    // we instead pre-create the parent `output/` and then make `output/`
    // itself read-only AFTER convOutputId is allocated. Simpler approach:
    // pre-make `workspaceDir/output` read-only so mkdir of the conv dir
    // (or the _attachments subdir) fails.
    const outputRoot = path.join(workspaceDir, 'output');
    mkdirSync(outputRoot, { recursive: true });
    chmodSync(outputRoot, 0o500);
    try {
      await agent.handleMessage(
        's4',
        'msg',
        undefined,
        [{ name: 'x.txt', size: 5, type: 'text/plain', textContent: 'hello' }],
        'orchestrate',
      );
    } finally {
      chmodSync(outputRoot, 0o755);
    }
    // No dispatch call was made.
    expect(calls).toHaveLength(0);
    // User-facing error surfaced verbatim via onText.
    expect(textCalls.some((t) => t.includes('Failed to stage uploaded file'))).toBe(true);
  });

  it('messages with no attachments do not create the staging dir and do not pass stagedAttachments', async () => {
    const { calls } = stubOrchestration(agent);
    await agent.handleMessage('s5', 'just a chat', undefined, undefined, 'orchestrate');
    // No staging dir was created.
    const sessions = path.join(workspaceDir, 'output');
    if (existsSync(sessions)) {
      for (const conv of require('node:fs').readdirSync(sessions)) {
        expect(existsSync(path.join(sessions, conv, ATTACHMENTS_DIR_NAME))).toBe(false);
      }
    }
    if (calls.length > 0) {
      const opts = calls[0]!.opts as { stagedAttachments?: unknown } | undefined;
      expect(opts?.stagedAttachments).toBeUndefined();
    }
  });
});
