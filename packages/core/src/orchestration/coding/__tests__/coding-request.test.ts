/**
 * @module orchestration/coding/__tests__/coding-request
 *
 * Task #237 — focused unit tests for the pure request-parsing helpers split
 * out of `coding-orchestrator.ts`: normalizeRepoHint, looksLikeRepoToken, and
 * parseCodingRequest.
 */
import { describe, it, expect } from 'vitest';
import { normalizeRepoHint, looksLikeRepoToken, parseCodingRequest } from '../coding-request.js';

describe('normalizeRepoHint', () => {
  it('expands a bare owner/repo slug into a GitHub HTTPS clone URL', () => {
    expect(normalizeRepoHint('owner/repo')).toBe('https://github.com/owner/repo.git');
  });

  it('appends .git to a github.com HTTPS URL that lacks it', () => {
    expect(normalizeRepoHint('https://github.com/owner/repo')).toBe('https://github.com/owner/repo.git');
  });

  it('leaves a complete .git URL and scp-style SSH form untouched', () => {
    expect(normalizeRepoHint('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git');
    expect(normalizeRepoHint('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git');
  });

  it('strips surrounding quotes and trailing punctuation', () => {
    expect(normalizeRepoHint('"owner/repo".')).toBe('https://github.com/owner/repo.git');
    expect(normalizeRepoHint('`https://example.com/x/y.git`')).toBe('https://example.com/x/y.git');
  });

  it('returns undefined for empty / undefined input', () => {
    expect(normalizeRepoHint(undefined)).toBeUndefined();
    expect(normalizeRepoHint('   ')).toBeUndefined();
    expect(normalizeRepoHint('""')).toBeUndefined();
  });
});

describe('looksLikeRepoToken', () => {
  it('accepts URLs, scp-like SSH, and owner/repo slugs', () => {
    expect(looksLikeRepoToken('https://github.com/a/b')).toBe(true);
    expect(looksLikeRepoToken('git@github.com:a/b.git')).toBe(true);
    expect(looksLikeRepoToken('owner/repo')).toBe(true);
  });

  it('rejects innocent English words', () => {
    expect(looksLikeRepoToken('the')).toBe(false);
    expect(looksLikeRepoToken('main')).toBe(false);
    expect(looksLikeRepoToken(undefined)).toBe(false);
    expect(looksLikeRepoToken('')).toBe(false);
  });
});

describe('parseCodingRequest', () => {
  it('extracts an explicit repo: hint and normalizes it', () => {
    const r = parseCodingRequest('Fix the bug. repo: owner/repo');
    expect(r.repoUrl).toBe('https://github.com/owner/repo.git');
    expect(r.branch).toBe('main');
    expect(r.taskDescription).toBe('Fix the bug. repo: owner/repo');
  });

  it('honours a conversational "use repo <url>" form when the token looks repo-like', () => {
    const r = parseCodingRequest('Please use repo https://github.com/o/p to do the work');
    expect(r.repoUrl).toBe('https://github.com/o/p.git');
  });

  it('does NOT capture innocent English like "clone the repo"', () => {
    const r = parseCodingRequest('clone the repo and run tests');
    expect(r.repoUrl).toBeUndefined();
  });

  it('extracts an explicit branch and defaults to main otherwise', () => {
    expect(parseCodingRequest('do x branch: develop').branch).toBe('develop');
    expect(parseCodingRequest('the default branch is main, switch branch upstream').branch).toBe('main');
    expect(parseCodingRequest('just do the work').branch).toBe('main');
  });
});
