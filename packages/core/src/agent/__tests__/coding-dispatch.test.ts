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
import { resolve as resolvePath, join } from 'node:path';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('installs the safe-commit pre-commit + pre-push hooks + .gitignore into the checkout (Task #209)', async () => {
    // Use a real temp dir so the safe-commit installers have something
    // to write into. The cloneRepo stub creates `<runDir>/repo/.git` so
    // installSafeCommitHooks recognises it as a real checkout.
    const root = mkdtempSync(join(tmpdir(), 'coding-dispatch-test-'));
    try {
      const realClone = vi.fn(async (_url: string, runDir: string) => {
        const target = join(runDir, 'repo');
        mkdirSync(join(target, '.git'), { recursive: true });
        return target;
      });
      const out = await prepareCodingDispatch({
        userTask: 'do the thing',
        workspaceDir: root,
        runId: 'safe-commit-run',
        remote: {},
        cloneRepo: realClone,
        getHeadCommit: async () => 'd'.repeat(40),
        resolveRemote: async () => 'https://github.com/foo/bar.git',
        mkdir: (dir: string) => mkdirSync(dir, { recursive: true }),
      });

      // BOTH hooks must be installed and executable — git silently
      // skips non-executable hooks, which would silently disable the
      // safety net.
      const preCommitHookPath = join(out.checkoutPath, '.git', 'hooks', 'pre-commit');
      const prePushHookPath = join(out.checkoutPath, '.git', 'hooks', 'pre-push');
      expect(existsSync(preCommitHookPath)).toBe(true);
      expect(existsSync(prePushHookPath)).toBe(true);
      expect(statSync(preCommitHookPath).mode & 0o100).toBeTruthy();
      expect(statSync(prePushHookPath).mode & 0o100).toBeTruthy();
      expect(readFileSync(preCommitHookPath, 'utf-8')).toMatch(/OrionOmega safe-commit hook/);
      expect(readFileSync(prePushHookPath, 'utf-8')).toMatch(/OrionOmega safe-commit hook/);

      // The .gitignore must be seeded so the agent's first `git add -A`
      // doesn't sweep up node_modules / .env / etc.
      const ignorePath = join(out.checkoutPath, '.gitignore');
      expect(existsSync(ignorePath)).toBe(true);
      const ignoreBody = readFileSync(ignorePath, 'utf-8');
      expect(ignoreBody).toContain('node_modules/');
      expect(ignoreBody).toContain('.env');

      // The structured CommitSafetyReport (round 4 review): all fields
      // populated and consistent so the executor can render it
      // verbatim into run-summary.md.
      expect(out.commitSafety).toBeDefined();
      expect(out.commitSafety.checkoutPath).toBe(out.checkoutPath);
      expect(out.commitSafety.hooksInstalled).toBe(true);
      expect(out.commitSafety.preCommitHookPath).toBe(preCommitHookPath);
      expect(out.commitSafety.prePushHookPath).toBe(prePushHookPath);
      expect(out.commitSafety.gitignoreCreated).toBe(true);
      expect(out.commitSafety.gitignoreAdded.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('FAILS the dispatch when .git exists but the safe-commit hooks cannot be installed (Task #209)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-dispatch-fail-test-'));
    try {
      const failingClone = vi.fn(async (_url: string, runDir: string) => {
        const target = join(runDir, 'repo');
        // .git/hooks as a regular FILE → mkdirSync(hooksDir) is a
        // no-op (entry exists) but writeFileSync(<...>/hooks/pre-commit)
        // fails ENOTDIR, which puts installSafeCommitHooks into the
        // installed=false branch. The dispatch must hard-fail rather
        // than silently downgrade.
        mkdirSync(target, { recursive: true });
        mkdirSync(join(target, '.git'), { recursive: true });
        require('node:fs').writeFileSync(join(target, '.git', 'hooks'), 'not a dir', 'utf-8');
        return target;
      });
      await expect(
        prepareCodingDispatch({
          userTask: 'do the thing',
          workspaceDir: root,
          runId: 'safe-commit-fail-run',
          remote: {},
          cloneRepo: failingClone,
          getHeadCommit: async () => 'd'.repeat(40),
          resolveRemote: async () => 'https://github.com/foo/bar.git',
          mkdir: (dir: string) => mkdirSync(dir, { recursive: true }),
        }),
      ).rejects.toThrow(/Safe-commit hooks install failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it('describes the safe-commit procedure (Task #209): gitignore, oversize check, secret deny-list', () => {
    const text = buildCodingTaskPreamble(base);
    // Step (a): the .gitignore template entries the agent must ensure.
    expect(text).toMatch(/Safe-commit procedure/);
    expect(text).toContain('node_modules/');
    expect(text).toContain('.env.local');
    expect(text).toContain('.next/');
    // Step (a) must explicitly preserve user-curated content.
    expect(text).toMatch(/preserved verbatim/);
    // Step (c): 95 MB ceiling, with the explicit GitHub rationale.
    expect(text).toMatch(/95 MB/);
    expect(text).toMatch(/100 MB/);
    // Step (d): secret deny-list including .pem / .key files.
    expect(text).toMatch(/\*\.pem/);
    expect(text).toMatch(/\*\.key/);
    // Step (d) must allow .env.example through (conventional placeholder).
    expect(text).toMatch(/\.env\.example/);
    // Step (f): the run-summary breadcrumb.
    expect(text).toMatch(/Commit safety:/);
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
