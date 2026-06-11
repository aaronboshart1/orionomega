/**
 * @module orchestration/__tests__/retry-policy
 *
 * Task #237 — focused unit tests for the RetryPolicy collaborator extracted
 * from `executor.ts`. Covers error classification, backoff bounds, per-type
 * timeout floors, per-attempt multipliers, and the `maxRetries: 0` sentinel.
 */
import { describe, it, expect } from 'vitest';
import {
  RetryPolicy,
  classifyError,
  computeBackoffDelay,
  resolveNodeTimeoutSec,
  timeoutMultiplierForAttempt,
  resolveMaxRetries,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  TIMEOUT_FLOOR_SEC,
  RETRY_TIMEOUT_MULTIPLIERS,
} from '../retry-policy.js';
import { TaggedRetryError } from '../retry-error.js';
import { ModelUnavailableError } from '../model-fallback.js';
import type { WorkflowNode } from '../types.js';

function node(partial: Partial<WorkflowNode>): WorkflowNode {
  return {
    id: 'n',
    type: 'AGENT',
    label: 'n',
    dependsOn: [],
    status: 'pending',
    ...partial,
  } as WorkflowNode;
}

describe('classifyError', () => {
  it('classifies network/5xx/rate-limit messages as transient', () => {
    for (const msg of ['ETIMEDOUT', 'connection ECONNRESET', '503 Service Unavailable', 'rate limit exceeded', 'overloaded', '429 Too Many Requests']) {
      expect(classifyError(new Error(msg))).toBe('transient');
    }
  });

  it('classifies auth/validation/not-found messages as permanent', () => {
    for (const msg of ['authentication failed', 'unauthorized', 'invalid api key', 'validation error', '404 not found', 'permission denied']) {
      expect(classifyError(new Error(msg))).toBe('permanent');
    }
  });

  it('treats a model-unavailable error as permanent (degrade, do not retry)', () => {
    expect(classifyError(new ModelUnavailableError('claude-x', 'gone'))).toBe('permanent');
  });

  it('honours an explicit TaggedRetryError decision over pattern matching', () => {
    // Message looks permanent ("not found"), but the tag forces transient.
    expect(classifyError(new TaggedRetryError('not found', { retryable: true }))).toBe('transient');
    // Message looks transient ("timeout"), but the tag forces permanent.
    expect(classifyError(new TaggedRetryError('timeout', { retryable: false }))).toBe('permanent');
  });

  it('defaults unknown errors to transient', () => {
    expect(classifyError(new Error('something weird happened'))).toBe('transient');
  });
});

describe('computeBackoffDelay', () => {
  it('grows with attempt and stays within the jittered exponential bounds', () => {
    for (const attempt of [1, 2, 3, 4, 5]) {
      const exp = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      for (let i = 0; i < 50; i++) {
        const d = computeBackoffDelay(attempt);
        expect(d).toBeGreaterThanOrEqual(Math.floor(exp * 0.5));
        expect(d).toBeLessThanOrEqual(exp);
      }
    }
  });

  it('never exceeds MAX_BACKOFF_MS even for large attempts', () => {
    for (let i = 0; i < 50; i++) {
      expect(computeBackoffDelay(20)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
  });
});

describe('resolveNodeTimeoutSec', () => {
  const defaults = { workerTimeout: 300, codingAgentTimeout: 600 };

  it('clamps below-floor planner values up to the per-type floor', () => {
    expect(resolveNodeTimeoutSec(node({ type: 'CODING_AGENT', timeout: 120 }), defaults)).toBe(TIMEOUT_FLOOR_SEC.CODING_AGENT);
    expect(resolveNodeTimeoutSec(node({ type: 'AGENT', timeout: 5 }), defaults)).toBe(TIMEOUT_FLOOR_SEC.AGENT);
    expect(resolveNodeTimeoutSec(node({ type: 'TOOL', timeout: 1 }), defaults)).toBe(TIMEOUT_FLOOR_SEC.TOOL);
  });

  it('keeps above-floor requested values unchanged', () => {
    expect(resolveNodeTimeoutSec(node({ type: 'CODING_AGENT', timeout: 5000 }), defaults)).toBe(5000);
    expect(resolveNodeTimeoutSec(node({ type: 'AGENT', timeout: 1200 }), defaults)).toBe(1200);
  });

  it('falls back to config defaults (still floored) when no node timeout is set', () => {
    // workerTimeout 300 < AGENT floor 900 → clamped.
    expect(resolveNodeTimeoutSec(node({ type: 'AGENT' }), defaults)).toBe(TIMEOUT_FLOOR_SEC.AGENT);
    // codingAgentTimeout 600 < CODING floor 1800 → clamped.
    expect(resolveNodeTimeoutSec(node({ type: 'CODING_AGENT' }), defaults)).toBe(TIMEOUT_FLOOR_SEC.CODING_AGENT);
  });
});

describe('timeoutMultiplierForAttempt', () => {
  it('returns the table value and saturates past the last entry', () => {
    RETRY_TIMEOUT_MULTIPLIERS.forEach((m, i) => expect(timeoutMultiplierForAttempt(i)).toBe(m));
    const last = RETRY_TIMEOUT_MULTIPLIERS[RETRY_TIMEOUT_MULTIPLIERS.length - 1];
    expect(timeoutMultiplierForAttempt(99)).toBe(last);
  });
});

describe('resolveMaxRetries', () => {
  it('treats config-level 0/negative as unlimited (Infinity sentinel)', () => {
    expect(resolveMaxRetries(undefined, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(resolveMaxRetries(undefined, -1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('uses the config cap when positive and no node override', () => {
    expect(resolveMaxRetries(undefined, 3)).toBe(3);
  });

  it('lets a per-node value (including 0) override the config cap', () => {
    expect(resolveMaxRetries(0, 0)).toBe(0); // per-node 0 means "no retries"
    expect(resolveMaxRetries(5, 0)).toBe(5);
    expect(resolveMaxRetries(2, 10)).toBe(2);
  });
});

describe('RetryPolicy class wrapper', () => {
  const p = new RetryPolicy();
  it('delegates to the module functions', () => {
    expect(p.classify(new Error('timeout'))).toBe('transient');
    expect(p.timeoutMultiplier(0)).toBe(1.0);
    expect(p.resolveMaxRetries(undefined, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(p.resolveTimeoutSec(node({ type: 'TOOL', timeout: 1 }), { workerTimeout: 300, codingAgentTimeout: 600 })).toBe(TIMEOUT_FLOOR_SEC.TOOL);
    const d = p.backoffDelay(1);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(BASE_BACKOFF_MS);
  });
});
