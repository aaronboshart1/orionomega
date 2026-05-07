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
  normalizeRepoHint,
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

  it('accepts conversational "the repo is <slug>" form and expands GitHub bare slugs', () => {
    const out = parseCodingRequest('the repo is aaronboshart1/orionomega');
    expect(out.repoUrl).toBe('https://github.com/aaronboshart1/orionomega.git');
  });

  it('accepts "repo is <slug>" without leading article', () => {
    const out = parseCodingRequest('repo is foo/bar');
    expect(out.repoUrl).toBe('https://github.com/foo/bar.git');
  });

  it('accepts "use repo <url>" / "clone <url>" forms', () => {
    expect(parseCodingRequest('please use repo foo/bar to start').repoUrl)
      .toBe('https://github.com/foo/bar.git');
    expect(parseCodingRequest('clone https://github.com/x/y.git and refactor').repoUrl)
      .toBe('https://github.com/x/y.git');
  });

  it('accepts repo=<value> equals form', () => {
    expect(parseCodingRequest('go ahead repo=foo/bar').repoUrl)
      .toBe('https://github.com/foo/bar.git');
  });

  it('strips trailing punctuation from conversational hints', () => {
    expect(parseCodingRequest('the repo is foo/bar.').repoUrl)
      .toBe('https://github.com/foo/bar.git');
    expect(parseCodingRequest('the repo is foo/bar, please proceed').repoUrl)
      .toBe('https://github.com/foo/bar.git');
  });

  it('preserves explicit https URLs and SSH forms verbatim', () => {
    expect(parseCodingRequest('repo:git@github.com:foo/bar.git').repoUrl)
      .toBe('git@github.com:foo/bar.git');
    expect(parseCodingRequest('repo:https://gitlab.com/foo/bar.git').repoUrl)
      .toBe('https://gitlab.com/foo/bar.git');
  });

  it('appends .git to GitHub HTTPS URLs missing the suffix', () => {
    expect(parseCodingRequest('repo:https://github.com/foo/bar').repoUrl)
      .toBe('https://github.com/foo/bar.git');
  });

  it('strips quotes / backticks around the repo value', () => {
    expect(parseCodingRequest('the repo is `foo/bar`').repoUrl)
      .toBe('https://github.com/foo/bar.git');
    expect(parseCodingRequest('the repo is "foo/bar"').repoUrl)
      .toBe('https://github.com/foo/bar.git');
  });

  it('does NOT capture filler words from loose conversational phrasing', () => {
    // "clone the repo" must not capture "the" as a repo. The legacy
    // resolver would then propagate that nonsense through to git clone.
    expect(parseCodingRequest('please clone the repo and refactor').repoUrl)
      .toBeUndefined();
    expect(parseCodingRequest('use repo and report back').repoUrl)
      .toBeUndefined();
    expect(parseCodingRequest('the repo is great, lets fix it').repoUrl)
      .toBeUndefined(); // "great," is not a slug
  });

  it('does NOT match incidental words containing "repo" as a substring', () => {
    // `\brepo` word-boundary guard prevents matching "monorepo:" etc.
    expect(parseCodingRequest('this is a monorepo: please refactor').repoUrl)
      .toBeUndefined();
  });

  it('does NOT capture branch from "default branch is main" English prose', () => {
    // Loose `branch\s+(\S+)` would have grabbed "is" or "main" here.
    // Only "branch is <name>" with explicit "branch is" prefix matches.
    const out = parseCodingRequest('the default branch is main');
    // Conservative: this DOES match "branch is main" by design — that's
    // the conversational branch form. The regression we're guarding
    // against is matching a plain `branch <word>` (no "is", no delimiter).
    expect(out.branch).toBe('main');
    // But "switch branch upstream please" must NOT capture "upstream".
    expect(parseCodingRequest('switch branch upstream please').branch)
      .toBe('main');
  });

  it('strict `repo:` form trusts the user even with weird-looking values', () => {
    // Backwards-compat: legacy callers may pass internal hostnames or
    // file:// URLs that don't match the slug heuristic. The strict
    // tagged form must not be filtered by looksLikeRepoToken.
    expect(parseCodingRequest('repo:file:///srv/repos/internal.git').repoUrl)
      .toBe('file:///srv/repos/internal.git');
  });
});

describe('normalizeRepoHint', () => {
  it('returns undefined for empty / whitespace input', () => {
    expect(normalizeRepoHint(undefined)).toBeUndefined();
    expect(normalizeRepoHint('')).toBeUndefined();
    expect(normalizeRepoHint('   ')).toBeUndefined();
  });

  it('expands bare GitHub slugs to clone URLs', () => {
    expect(normalizeRepoHint('owner/repo')).toBe('https://github.com/owner/repo.git');
    expect(normalizeRepoHint('aaronboshart1/orionomega'))
      .toBe('https://github.com/aaronboshart1/orionomega.git');
  });

  it('passes through full URLs and SSH refs unchanged', () => {
    expect(normalizeRepoHint('https://gitlab.com/foo/bar.git'))
      .toBe('https://gitlab.com/foo/bar.git');
    expect(normalizeRepoHint('git@github.com:foo/bar.git'))
      .toBe('git@github.com:foo/bar.git');
    expect(normalizeRepoHint('ssh://git@host/foo/bar.git'))
      .toBe('ssh://git@host/foo/bar.git');
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
