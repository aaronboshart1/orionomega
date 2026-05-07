/**
 * @module orchestration/coding/__tests__/coding-orchestrator
 *
 * Unit tests for the Task #172 changes to the legacy CodingOrchestrator:
 *
 *   1. `resolveCodingRemote()` priority order:
 *        repoHint → sourceRepoDir's origin → defaultRemote → cwd-fallback
 *        → throws RemoteResolutionError.
 *   2. `parseCodingRequest()` returns `repoUrl: undefined` when no
 *      `repo:<url>` hint is present (the legacy `file://./` fallback is
 *      gone; resolution happens in the orchestrator).
 *   3. `repoNameFromRemoteUrl()` matches what `cloneRepo` would pick so
 *      the orchestrator can predict the per-run checkout path.
 *
 * The full `CodingOrchestrator.run()` end-to-end flow is intentionally
 * NOT exercised here — it pulls in the SQLite DB, the Anthropic SDK, and
 * the codebase analyzer, none of which add useful coverage for the
 * resolver/parser changes that are the heart of this task.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  parseCodingRequest,
  resolveCodingRemote,
  RemoteResolutionError,
} from '../coding-orchestrator.js';
import { repoNameFromRemoteUrl } from '../repo-manager.js';

function makeBareishRepo(remoteUrl: string): string {
  // Make a small on-disk git repo with a configured `origin` remote so
  // `git remote get-url origin` returns `remoteUrl`. We don't need to
  // actually be able to fetch from it — only the URL lookup matters.
  const dir = mkdtempSync(join(tmpdir(), 'orion-resolve-test-'));
  execSync('git init -q', { cwd: dir });
  execSync(`git remote add origin ${remoteUrl}`, { cwd: dir });
  return dir;
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) {
    const d = created.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
});

describe('parseCodingRequest', () => {
  it('returns the repo hint and branch when both are present', () => {
    const out = parseCodingRequest(
      'Add feature X repo:https://github.com/foo/bar.git branch:dev',
    );
    expect(out.repoUrl).toBe('https://github.com/foo/bar.git');
    expect(out.branch).toBe('dev');
    expect(out.taskDescription).toContain('Add feature X');
  });

  it('returns repoUrl: undefined when no `repo:` hint is present', () => {
    // The legacy `file://./` fallback is gone — the orchestrator now
    // resolves the remote via `resolveCodingRemote` instead.
    const out = parseCodingRequest('Just refactor the auth module please');
    expect(out.repoUrl).toBeUndefined();
    expect(out.branch).toBe('main');
  });
});

describe('resolveCodingRemote', () => {
  it('(1) uses the explicit `repo:<url>` hint when given', async () => {
    const url = await resolveCodingRemote({
      repoHint: 'https://github.com/owner/repo.git',
      sourceRepoDir: '/does/not/matter',
      defaultRemote: 'https://github.com/should/not-pick.git',
    });
    expect(url).toBe('https://github.com/owner/repo.git');
  });

  it('(2) falls back to sourceRepoDir\'s origin remote URL', async () => {
    const repoDir = makeBareishRepo('git@github.com:team/source-repo.git');
    created.push(repoDir);
    const url = await resolveCodingRemote({
      sourceRepoDir: repoDir,
      defaultRemote: 'https://github.com/should/not-pick.git',
    });
    expect(url).toBe('git@github.com:team/source-repo.git');
  });

  it('(3) falls back to defaultRemote when sourceRepoDir is missing/has no origin', async () => {
    const url = await resolveCodingRemote({
      sourceRepoDir: '/definitely/does/not/exist',
      defaultRemote: 'https://github.com/team/default.git',
      cwdForFallback: null,
    });
    expect(url).toBe('https://github.com/team/default.git');
  });

  it('(4) falls back to `git remote get-url origin` in cwdForFallback', async () => {
    const cwdRepo = makeBareishRepo('https://github.com/cwd/fallback.git');
    created.push(cwdRepo);
    const url = await resolveCodingRemote({
      cwdForFallback: cwdRepo,
    });
    expect(url).toBe('https://github.com/cwd/fallback.git');
  });

  it('throws RemoteResolutionError with a helpful message when nothing resolves', async () => {
    await expect(
      resolveCodingRemote({
        sourceRepoDir: '/definitely/does/not/exist',
        cwdForFallback: null,
      }),
    ).rejects.toMatchObject({
      name: 'RemoteResolutionError',
    });

    // The error message must name every remediation path so the operator
    // knows how to recover. We assert each of the four hints by substring
    // rather than the full text so future copy edits don't break the test.
    try {
      await resolveCodingRemote({
        sourceRepoDir: '/missing',
        cwdForFallback: null,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteResolutionError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/repo:</);
      expect(msg).toMatch(/coding\.defaultRemote/);
      expect(msg).toMatch(/coding\.repoDir|sourceRepoDir/);
      expect(msg).toMatch(/git remote get-url origin/);
    }
  });
});

describe('repoNameFromRemoteUrl', () => {
  it('strips trailing .git from HTTPS URLs', () => {
    expect(repoNameFromRemoteUrl('https://github.com/foo/bar.git')).toBe('bar');
  });

  it('strips trailing .git from SSH URLs', () => {
    expect(repoNameFromRemoteUrl('git@github.com:foo/baz.git')).toBe('baz');
  });

  it('handles URLs without a .git suffix', () => {
    expect(repoNameFromRemoteUrl('https://example.com/team/project')).toBe('project');
  });
});

describe('Task #172: commit message uses task description verbatim', () => {
  it('source contains the verbatim-task commit msg branch and no `feat:` prefix', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, '..', 'coding-orchestrator.ts'),
      'utf8',
    );
    // The new code path: trim the user's task and use it as the commit
    // message (with a non-empty fallback so `git commit` doesn't reject
    // an empty message).
    expect(src).toMatch(/const trimmedTask = taskDescription\.trim\(\)/);
    expect(src).toMatch(/trimmedTask\.length > 0\s*\?\s*trimmedTask/);
    // The legacy `feat: …truncated…\nGenerated by` shape must be gone.
    expect(src).not.toMatch(/feat: \$\{taskDescription\.slice/);
    expect(src).not.toMatch(/Generated by OrionOmega Coding Agent/);
  });
});
