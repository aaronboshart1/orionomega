/**
 * Task #221: deliverable-write verification.
 *
 * Part 1 — the pure `impliesWrittenDeliverable` heuristic (positive and
 * negative cues).
 * Part 2 — the `WorkerProcess.runAgent` verification path: when a task clearly
 * asks for a written file but the agent produces ONLY prose (zero real files),
 * the node must fail (TaggedRetryError) instead of being reported as success.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { impliesWrittenDeliverable } from '../deliverable-intent.js';

// --- Mock the SDK bridge so runAgent doesn't spawn a real agent -------------
const executeAgentResult: { current: Record<string, unknown> } = { current: {} };
vi.mock('../agent-sdk-bridge.js', () => ({
  executeAgent: vi.fn(async () => executeAgentResult.current),
}));

// readConfig is only consulted for skill loading (not exercised here) — keep
// it cheap and side-effect-free.
vi.mock('../../config/loader.js', () => ({
  readConfig: () => ({
    models: { apiKey: 'test-key', default: 'claude-test', workers: {} },
    skills: { directory: '/tmp/skills-noop' },
    agentSdk: {},
    orchestration: {},
  }),
}));

describe('Task #221: impliesWrittenDeliverable heuristic', () => {
  it('fires on clear written-deliverable cues', () => {
    expect(impliesWrittenDeliverable('Synthesize a comprehensive spec')).toBe(true);
    expect(impliesWrittenDeliverable('Write the report for the data room')).toBe(true);
    expect(impliesWrittenDeliverable('Produce a detailed implementation plan as markdown')).toBe(true);
    expect(impliesWrittenDeliverable('Deliver the design brief')).toBe(true);
    expect(impliesWrittenDeliverable(undefined, 'Synthesize spec')).toBe(true);
  });

  it('does NOT fire on tasks with no written-file cue', () => {
    expect(impliesWrittenDeliverable('Investigate the failing test')).toBe(false);
    expect(impliesWrittenDeliverable('Run the build and report any crash')).toBe(false);
    expect(impliesWrittenDeliverable('')).toBe(false);
    expect(impliesWrittenDeliverable(undefined)).toBe(false);
  });

  it('does NOT fire on prose-only synthesis/summary tasks (false-positive guard)', () => {
    // Bare "synthesize"/"spec" and vague "summary"/"analysis" nouns must NOT
    // hard-fail an ordinary prose node — these denote in-chat output.
    expect(impliesWrittenDeliverable('Synthesize key findings for me')).toBe(false);
    expect(impliesWrittenDeliverable('Compare implementation to spec and report gaps')).toBe(false);
    expect(impliesWrittenDeliverable('Generate a summary in chat')).toBe(false);
    expect(impliesWrittenDeliverable('Summarize the findings')).toBe(false);
    expect(impliesWrittenDeliverable('Analyze the codebase for issues')).toBe(false);
  });
});

describe('Task #221: runAgent deliverable verification', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(path.join(tmpdir(), 'oo-deliverable-'));
  });
  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function runWorker() {
    const { WorkerProcess } = await import('../worker.js');
    const { EventBus } = await import('../event-bus.js');
    const node = {
      id: 'n1',
      type: 'AGENT' as const,
      label: 'Synthesize spec',
      agent: { task: 'Synthesize a comprehensive spec for the feature' },
    };
    const worker = new WorkerProcess(node as never, new EventBus(), {
      workspaceDir,
      timeout: 30,
    });
    return worker.run();
  }

  it('fails when a spec task produces only prose and zero files', async () => {
    executeAgentResult.current = {
      success: true,
      output: "I'll write the spec now. Here is the outline...",
      finalResult: "I'll write the spec now.",
      toolCalls: 1,
      durationSec: 0.1,
      outputPaths: [],
    };
    await expect(runWorker()).rejects.toThrow(/without writing its declared deliverable/i);
  });

  it('succeeds when the agent actually wrote a file', async () => {
    writeFileSync(path.join(workspaceDir, 'spec.md'), '# Spec\n\nReal content');
    executeAgentResult.current = {
      success: true,
      output: 'Wrote the spec.',
      finalResult: 'Done.',
      toolCalls: 2,
      durationSec: 0.1,
      outputPaths: [path.join(workspaceDir, 'spec.md')],
    };
    const res = await runWorker();
    expect(res.outputPaths.length).toBeGreaterThan(0);
  });
});
