/**
 * @module agent/__tests__/coding-dispatch
 *
 * Unit tests for the active-path coding dispatch helper used by
 * {@link OrchestrationBridge.dispatchCodingWorkflow}.
 *
 * These cover the end-to-end behaviours required by Task #172:
 *
 *   - Per-run output folder layout (`<workspaceDir>/output/<runId>/<repoName>`).
 *   - Two consecutive runs land in two distinct folders.
 *   - The Repository block + checkout-path / branch / HEAD wiring in the
 *     planner preamble.
 *   - Commit message guidance: use the user's task description verbatim.
 *   - Push-failure-fails-the-run guidance in the planner preamble.
 *   - Resolver failures bubble out as `RemoteResolutionError` (the bridge
 *     surfaces the verbatim message to the user).
 */

import { describe, it, expect, vi } from 'vitest';
import { resolve as resolvePath } from 'node:path';
import {
  prepareCodingDispatch,
  buildCodingTaskPreamble,
} from '../coding-dispatch.js';
import { RemoteResolutionError } from '../../orchestration/coding/coding-orchestrator.js';

function fakeClone(_url: string, runDir: string, _opts: { branch?: string; shallow?: boolean }): Promise<string> {
  // Mirrors `cloneRepo`'s convention: `<runDir>/<repoName>`.
  return Promise.resolve(`${runDir}/repo`);
}

describe('prepareCodingDispatch', () => {
  it('clones into <workspaceDir>/output/<runId>/<repoName> and returns full provenance', async () => {
    const cloneRepo = vi.fn(fakeClone);
    const getHeadCommit = vi.fn(async () => 'deadbeefcafefood0000000000000000');
    const resolveRemote = vi.fn(async () => 'https://github.com/foo/bar.git');
    const mkdir = vi.fn();

    const out = await prepareCodingDispatch({
      userTask: 'Add a /healthz endpoint',
      workspaceDir: '/tmp/ws',
      runId: 'run-A',
      remote: { repoHint: 'https://github.com/foo/bar.git' },
      cloneRepo,
      getHeadCommit,
      resolveRemote,
      mkdir,
    });

    expect(out.runDir).toBe(resolvePath('/tmp/ws', 'output', 'run-A'));
    expect(out.checkoutPath).toBe(`${out.runDir}/repo`);
    expect(out.remoteUrl).toBe('https://github.com/foo/bar.git');
    expect(out.branch).toBe('main');
    expect(out.headCommit).toBe('deadbeefcafefood0000000000000000');

    // Verifies the clone was actually invoked with the expected args
    // (remote URL, run dir, branch + shallow flag).
    expect(cloneRepo).toHaveBeenCalledTimes(1);
    expect(cloneRepo).toHaveBeenCalledWith(
      'https://github.com/foo/bar.git',
      out.runDir,
      { branch: 'main', shallow: true },
    );

    // `mkdirSync` must be called for the run dir before cloning so the
    // `git clone` target is a writable directory.
    expect(mkdir).toHaveBeenCalledWith(out.runDir);
    // Resolver was given the per-call hint — the bridge always forwards
    // the user's `repo:<url>` hint verbatim.
    expect(resolveRemote).toHaveBeenCalledWith({ repoHint: 'https://github.com/foo/bar.git' });
  });

  it('two consecutive runs land in two distinct per-run folders', async () => {
    const cloneRepo = vi.fn(fakeClone);

    const a = await prepareCodingDispatch({
      userTask: 'first task',
      workspaceDir: '/tmp/ws',
      remote: {},
      runId: 'A',
      cloneRepo,
      getHeadCommit: async () => 'a'.repeat(40),
      resolveRemote: async () => 'https://github.com/foo/bar.git',
      mkdir: () => {},
    });
    const b = await prepareCodingDispatch({
      userTask: 'follow-up task',
      workspaceDir: '/tmp/ws',
      remote: {},
      runId: 'B',
      cloneRepo,
      getHeadCommit: async () => 'b'.repeat(40),
      resolveRemote: async () => 'https://github.com/foo/bar.git',
      mkdir: () => {},
    });

    // Different runIds → different runDirs → different checkout paths.
    expect(a.runDir).not.toBe(b.runDir);
    expect(a.checkoutPath).not.toBe(b.checkoutPath);
    // Two clones happen — follow-ups are fresh runs by spec, never reuse.
    expect(cloneRepo).toHaveBeenCalledTimes(2);
  });

  it('passes the parsed branch through to clone and the preamble', async () => {
    const cloneRepo = vi.fn(fakeClone);
    const out = await prepareCodingDispatch({
      userTask: 'do the thing',
      workspaceDir: '/tmp/ws',
      runId: 'r',
      branch: 'release-2.0',
      remote: {},
      cloneRepo,
      getHeadCommit: async () => 'c'.repeat(40),
      resolveRemote: async () => 'https://github.com/foo/bar.git',
      mkdir: () => {},
    });
    expect(out.branch).toBe('release-2.0');
    expect(cloneRepo).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      branch: 'release-2.0',
      shallow: true,
    });
    expect(out.codingTaskPreamble).toMatch(/Branch: release-2\.0/);
  });

  it('bubbles up RemoteResolutionError without cloning', async () => {
    const cloneRepo = vi.fn(fakeClone);
    const resolveRemote = vi.fn(async () => {
      throw new RemoteResolutionError('nothing matched');
    });

    await expect(
      prepareCodingDispatch({
        userTask: 'whatever',
        workspaceDir: '/tmp/ws',
        remote: {},
        cloneRepo,
        getHeadCommit: async () => null,
        resolveRemote,
        mkdir: () => {},
      }),
    ).rejects.toBeInstanceOf(RemoteResolutionError);

    // No clone attempted — the bridge would surface the verbatim error
    // to the user before any disk I/O happens.
    expect(cloneRepo).not.toHaveBeenCalled();
  });
});

describe('buildCodingTaskPreamble', () => {
  const base = {
    userTask: 'Add a /healthz endpoint that returns {ok: true}',
    remoteUrl: 'https://github.com/foo/bar.git',
    branch: 'main',
    checkoutPath: '/tmp/ws/output/run-A/bar',
    headCommit: 'deadbeefcafefood',
  };

  it('embeds remote URL, branch, checkout path, and HEAD commit', () => {
    const text = buildCodingTaskPreamble(base);
    expect(text).toMatch(/Remote URL: https:\/\/github\.com\/foo\/bar\.git/);
    expect(text).toMatch(/Branch: main/);
    expect(text).toMatch(/Checkout path[^\n]*\/tmp\/ws\/output\/run-A\/bar/);
    expect(text).toMatch(/HEAD commit: deadbeefcafefood/);
  });

  it('pins every CODING_AGENT cwd to the checkout path', () => {
    const text = buildCodingTaskPreamble(base);
    expect(text).toMatch(/ALL CODING_AGENT nodes MUST set `cwd` to `\/tmp\/ws\/output\/run-A\/bar`/);
  });

  it('forbids re-cloning and forbids cd-ing elsewhere', () => {
    const text = buildCodingTaskPreamble(base);
    expect(text).toMatch(/Do NOT clone the repo again/);
    expect(text).toMatch(/Do NOT `cd`/);
  });

  it('instructs the agent to use the user task description verbatim as the commit message', () => {
    const text = buildCodingTaskPreamble(base);
    expect(text).toMatch(/use the user's task description.*verbatim/);
    expect(text).toMatch(/do NOT prefix with `feat:`/);
    expect(text).toMatch(/do NOT truncate/);
  });

  it('requires push failure to fail the run with the verbatim git error', () => {
    const text = buildCodingTaskPreamble(base);
    expect(text).toMatch(/If `git push` fails for ANY reason/);
    expect(text).toMatch(/non-zero status/);
    expect(text).toMatch(/verbatim/);
    expect(text).toMatch(/orchestrator will fail the entire run/);
  });

  it('appends the user task verbatim under "User\'s Task"', () => {
    const text = buildCodingTaskPreamble(base);
    expect(text).toContain("### User's Task");
    expect(text).toContain(base.userTask);
  });

  it("falls back to 'unknown' when HEAD couldn't be captured", () => {
    const text = buildCodingTaskPreamble({ ...base, headCommit: null });
    expect(text).toMatch(/HEAD commit: unknown/);
  });
});
