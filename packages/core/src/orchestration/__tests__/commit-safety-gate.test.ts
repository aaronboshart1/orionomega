/**
 * @module orchestration/__tests__/commit-safety-gate
 *
 * Task #237 — focused unit tests for the CommitSafetyGate collaborator
 * extracted from `executor.ts`. The git-using `findUnsafeCommittedFiles`
 * dependency is injected so these tests stay pure (no real repos / forks).
 */
import { describe, it, expect, vi } from 'vitest';
import { CommitSafetyGate, runCommitSafetyPreflight } from '../commit-safety-gate.js';
import type { CommitSafetyReport, RefusedCommittedFile } from '../types.js';

function baseReport(overrides: Partial<CommitSafetyReport> = {}): CommitSafetyReport {
  return {
    checkoutPath: '/checkout',
    gitignoreAdded: [],
    gitignoreCreated: false,
    hooksInstalled: true,
    preCommitHookPath: '/checkout/.git/hooks/pre-commit',
    prePushHookPath: '/checkout/.git/hooks/pre-push',
    baseHeadCommit: 'abc123',
    preflightStatus: 'skipped',
    refusedFiles: [],
    ...overrides,
  };
}

const refused: RefusedCommittedFile = {
  path: '.env',
  reason: 'secret',
  bytes: 42,
  commit: 'deadbeefcafef00d',
  blobSha: 'b10b5ha1',
};

describe('runCommitSafetyPreflight', () => {
  it('marks the report clean and emits no error when nothing is refused', () => {
    const finder = vi.fn(() => ({ refused: [], skippedReason: null }));
    const { report, error } = runCommitSafetyPreflight(baseReport(), finder);
    expect(finder).toHaveBeenCalledWith('/checkout', 'abc123');
    expect(report.preflightStatus).toBe('clean');
    expect(report.refusedFiles).toEqual([]);
    expect(error).toBeUndefined();
  });

  it('marks skipped (no error) when the finder reports a skip reason', () => {
    const finder = vi.fn(() => ({ refused: [], skippedReason: 'no .git directory' }));
    const { report, error } = runCommitSafetyPreflight(baseReport(), finder);
    expect(report.preflightStatus).toBe('skipped');
    expect(report.preflightReason).toBe('no .git directory');
    expect(error).toBeUndefined();
  });

  it('marks refused and returns a structured error naming the offending file', () => {
    const finder = vi.fn(() => ({ refused: [refused], skippedReason: null }));
    const { report, error } = runCommitSafetyPreflight(baseReport(), finder);
    expect(report.preflightStatus).toBe('refused');
    expect(report.refusedFiles).toEqual([refused]);
    expect(error?.worker).toBe('commit-safety-preflight');
    expect(error?.message).toContain('.env');
    expect(error?.resolution).toBeTruthy();
  });

  it('degrades to skipped (never throws) when the finder itself crashes', () => {
    const finder = vi.fn(() => { throw new Error('git exploded'); });
    const { report, error } = runCommitSafetyPreflight(baseReport(), finder);
    expect(report.preflightStatus).toBe('skipped');
    expect(report.preflightReason).toContain('git exploded');
    expect(error).toBeUndefined();
  });

  it('does not mutate the original report object (returns a copy)', () => {
    const original = baseReport();
    const finder = vi.fn(() => ({ refused: [refused], skippedReason: null }));
    const { report } = runCommitSafetyPreflight(original, finder);
    expect(original.preflightStatus).toBe('skipped'); // unchanged
    expect(report).not.toBe(original);
  });
});

describe('CommitSafetyGate wrapper', () => {
  it('delegates to runCommitSafetyPreflight', () => {
    const gate = new CommitSafetyGate();
    const finder = vi.fn(() => ({ refused: [], skippedReason: null }));
    const { report } = gate.runPreflight(baseReport(), finder);
    expect(report.preflightStatus).toBe('clean');
    expect(finder).toHaveBeenCalledOnce();
  });
});
