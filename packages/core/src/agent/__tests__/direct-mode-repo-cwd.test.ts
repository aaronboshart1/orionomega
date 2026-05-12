/**
 * @module agent/__tests__/direct-mode-repo-cwd
 *
 * Task #216 — verify Direct mode uses the Git-tab selected repo as the
 * working directory for tool calls (and the system prompt names it),
 * and falls back gracefully to the per-conversation scratch dir when no
 * selection exists or `ensureSessionClone` fails.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MainAgent, type MainAgentCallbacks, type MainAgentConfig } from '../main-agent.js';
import { executeMainTool, detectExecProtectedWriteIntent } from '../conversation.js';
import {
  getOrionOmegaSourceRoots,
  _resetOrionOmegaSourceRootsCache,
} from '../../utils/install-dir.js';

let workspaceDir: string;
let fakeRepoDir: string;

const noopCallbacks: MainAgentCallbacks = {
  onText: () => {},
  onThinking: () => {},
  onPlan: () => {},
  onEvent: () => {},
  onGraphState: () => {},
  onCommandResult: () => {},
};

function buildAgentWithGetSessionRepo(
  getSessionRepo?: MainAgentConfig['getSessionRepo'],
): MainAgent {
  const config: MainAgentConfig = {
    model: 'claude-test',
    apiKey: 'test-key',
    systemPrompt: 'TEST_BASE_PROMPT',
    workspaceDir,
    checkpointDir: path.join(workspaceDir, 'checkpoints'),
    workerTimeout: 1000,
    maxRetries: 0,
    ...(getSessionRepo ? { getSessionRepo } : {}),
  };
  return new MainAgent(config, noopCallbacks);
}

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

beforeEach(() => {
  workspaceDir = mkdtempSync(path.join(tmpdir(), 'oo-direct-repo-'));
  fakeRepoDir = mkdtempSync(path.join(tmpdir(), 'oo-fake-repo-'));
  // Make it look like a git repo so ensureSessionClone treats it as
  // already-cloned (its remote check is bypassed because there's no
  // origin set; we only care about the localPath being returned).
  mkdirSync(path.join(fakeRepoDir, '.git'), { recursive: true });
});
afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(fakeRepoDir, { recursive: true, force: true });
});

describe('Direct mode runDir selection (Task #216)', () => {
  it('falls back to scratch output dir when no Git-tab selection exists', async () => {
    const agent = buildAgentWithGetSessionRepo();
    const { prompts } = stubAnthropicAndCapturePrompts(agent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = agent as any;
    a.currentSessionId = 's1';
    const convId = a.getOrAllocateConvOutputId('s1');
    await a.respondConversationally('hi', undefined, 'run-1', convId);
    expect(prompts).toHaveLength(1);
    // Legacy "Output Directory (STRICT)" wording — NOT the Working Directory variant.
    expect(prompts[0]).toContain('## Output Directory (STRICT)');
    expect(prompts[0]).not.toContain('## Working Directory (STRICT)');
    expect(prompts[0]).toContain(path.join(workspaceDir, 'output', convId));
  });

  it('does not throw when getSessionRepo returns undefined (treated as no selection)', async () => {
    const agent = buildAgentWithGetSessionRepo(() => undefined);
    const { prompts } = stubAnthropicAndCapturePrompts(agent);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = agent as any;
    a.currentSessionId = 's1';
    const convId = a.getOrAllocateConvOutputId('s1');
    await a.respondConversationally('hi', undefined, 'run-1', convId);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('## Output Directory (STRICT)');
    expect(prompts[0]).not.toContain('## Working Directory (STRICT)');
  });
});

describe('executeMainTool runDir resolution (Task #216)', () => {
  it('write_file with relative path resolves under runDir, not workspaceDir', async () => {
    const result = await executeMainTool(
      'write_file',
      { path: 'hello.md', content: 'hi' },
      workspaceDir,
      fakeRepoDir,
    );
    expect(result).toContain('File written');
    expect(existsSync(path.join(fakeRepoDir, 'hello.md'))).toBe(true);
    expect(readFileSync(path.join(fakeRepoDir, 'hello.md'), 'utf-8')).toBe('hi');
    // And NOT in workspaceDir
    expect(existsSync(path.join(workspaceDir, 'hello.md'))).toBe(false);
  });

  it('read_file with relative path resolves under runDir (Task #216 read_file fix)', async () => {
    const filePath = path.join(fakeRepoDir, 'data.txt');
    require('node:fs').writeFileSync(filePath, 'payload');
    const result = await executeMainTool(
      'read_file',
      { path: 'data.txt' },
      workspaceDir,
      fakeRepoDir,
    );
    expect(result).toBe('payload');
  });

  it('refuses write_file to packages/<pkg>/src in the running dev checkout', async () => {
    _resetOrionOmegaSourceRootsCache();
    const roots = getOrionOmegaSourceRoots();
    expect(roots.length).toBeGreaterThan(0);
    const target = path.join(roots[0]!, 'fake-direct-mode-poison.ts');
    const result = await executeMainTool(
      'write_file',
      { path: target, content: 'malicious' },
      workspaceDir,
      fakeRepoDir,
    );
    expect(result.startsWith('Error: refused to write')).toBe(true);
    expect(result).toContain("OrionOmega application's own source/install tree");
    expect(existsSync(target)).toBe(false);
  });
});

describe('detectExecProtectedWriteIntent (Task #216)', () => {
  beforeEach(() => _resetOrionOmegaSourceRootsCache());

  it('refuses `tee` into a packages/<pkg>/src path', () => {
    const roots = getOrionOmegaSourceRoots();
    const target = path.join(roots[0]!, 'main-agent.ts');
    const result = detectExecProtectedWriteIntent(`echo bad | tee ${target}`, fakeRepoDir);
    expect(result).not.toBeNull();
    expect(result!.offender).toBe(target);
  });

  it('refuses `>` redirection into ~/.orionomega', () => {
    const target = path.join(process.env.HOME ?? '/root', '.orionomega', 'config.yaml');
    const result = detectExecProtectedWriteIntent(`echo bad > ${target}`, fakeRepoDir);
    expect(result).not.toBeNull();
    expect(result!.offender).toBe(target);
  });

  it('refuses `rm -rf` of a packages/<pkg>/src path', () => {
    const roots = getOrionOmegaSourceRoots();
    const result = detectExecProtectedWriteIntent(`rm -rf ${roots[0]}`, fakeRepoDir);
    expect(result).not.toBeNull();
  });

  it('allows a benign read command with no protected paths', () => {
    expect(detectExecProtectedWriteIntent('ls -la', fakeRepoDir)).toBeNull();
    expect(detectExecProtectedWriteIntent('cat README.md', fakeRepoDir)).toBeNull();
    expect(detectExecProtectedWriteIntent('git status', fakeRepoDir)).toBeNull();
  });

  it('allows a write to a non-protected path (the user repo)', () => {
    const safe = path.join(fakeRepoDir, 'README.md');
    expect(detectExecProtectedWriteIntent(`echo hi > ${safe}`, fakeRepoDir)).toBeNull();
    expect(detectExecProtectedWriteIntent(`tee ${safe}`, fakeRepoDir)).toBeNull();
  });

  it('allows reading a protected path (read-only intent, no write verb)', () => {
    const target = path.join(process.env.HOME ?? '/root', '.orionomega', 'config.yaml');
    expect(detectExecProtectedWriteIntent(`cat ${target}`, fakeRepoDir)).toBeNull();
  });
});
