/**
 * @module orchestration/__tests__/agent-sdk-bridge-opus-48
 *
 * Opus 4.8 compatibility tests for the agent-sdk-bridge module.
 *
 * Covers:
 * - EFFORT_TO_BUDGET_TOKENS maps effort levels (medium/high/xhigh) to token budgets
 * - ROLE_THINKING_CONFIG has correct enabled/effort settings per coding role
 * - ROLE_EFFORT_MAP has correct effort levels per coding role
 * - classifyError() correctly handles permanent, transient, budget, and tool-denied errors
 * - computeBackoff() produces valid exponential delays
 *
 * Note: executeAgent/executeCodingAgent are integration-heavy and not tested here.
 * These tests cover the pure-logic exports that gate Opus 4.8 request construction.
 */

import { describe, it, expect } from 'vitest';
import {
  EFFORT_TO_BUDGET_TOKENS,
  ROLE_THINKING_CONFIG,
  ROLE_EFFORT_MAP,
  classifyError,
  computeBackoff,
  RETRY_CONFIG,
} from '../agent-sdk-bridge.js';

// ── EFFORT_TO_BUDGET_TOKENS ───────────────────────────────────────────────────

describe('EFFORT_TO_BUDGET_TOKENS', () => {
  it('maps medium to 8000 tokens', () => {
    expect(EFFORT_TO_BUDGET_TOKENS.medium).toBe(8_000);
  });

  it('maps high to 16000 tokens', () => {
    expect(EFFORT_TO_BUDGET_TOKENS.high).toBe(16_000);
  });

  it('maps xhigh to 32000 tokens', () => {
    expect(EFFORT_TO_BUDGET_TOKENS.xhigh).toBe(32_000);
  });

  it('has strictly increasing values: medium < high < xhigh', () => {
    expect(EFFORT_TO_BUDGET_TOKENS.medium).toBeLessThan(EFFORT_TO_BUDGET_TOKENS.high);
    expect(EFFORT_TO_BUDGET_TOKENS.high).toBeLessThan(EFFORT_TO_BUDGET_TOKENS.xhigh);
  });

  it('covers all three effort levels (no missing keys)', () => {
    expect(Object.keys(EFFORT_TO_BUDGET_TOKENS)).toEqual(
      expect.arrayContaining(['medium', 'high', 'xhigh']),
    );
  });
});

// ── ROLE_THINKING_CONFIG ──────────────────────────────────────────────────────

describe('ROLE_THINKING_CONFIG — thinking disabled roles', () => {
  it('disables thinking for codebase-scanner (read-only speed role)', () => {
    expect(ROLE_THINKING_CONFIG['codebase-scanner'].enabled).toBe(false);
  });

  it('disables thinking for reporter (summary speed role)', () => {
    expect(ROLE_THINKING_CONFIG['reporter'].enabled).toBe(false);
  });

  it('disables thinking for validator (TOOL node)', () => {
    expect(ROLE_THINKING_CONFIG['validator'].enabled).toBe(false);
  });

  it('disables thinking for review-gate (ROUTER node)', () => {
    expect(ROLE_THINKING_CONFIG['review-gate'].enabled).toBe(false);
  });
});

describe('ROLE_THINKING_CONFIG — thinking enabled roles', () => {
  it('enables thinking for architect', () => {
    expect(ROLE_THINKING_CONFIG['architect'].enabled).toBe(true);
  });

  it('enables thinking for implementer', () => {
    expect(ROLE_THINKING_CONFIG['implementer'].enabled).toBe(true);
  });

  it('enables thinking for stitcher', () => {
    expect(ROLE_THINKING_CONFIG['stitcher'].enabled).toBe(true);
  });

  it('enables thinking for test-writer', () => {
    expect(ROLE_THINKING_CONFIG['test-writer'].enabled).toBe(true);
  });

  it('enables thinking for reviewer', () => {
    expect(ROLE_THINKING_CONFIG['reviewer'].enabled).toBe(true);
  });

  it('enables thinking for debugger', () => {
    expect(ROLE_THINKING_CONFIG['debugger'].enabled).toBe(true);
  });
});

describe('ROLE_THINKING_CONFIG — effort levels', () => {
  it("debugger uses 'xhigh' effort (deepest reasoning for root-cause analysis)", () => {
    const cfg = ROLE_THINKING_CONFIG['debugger'];
    expect(cfg.enabled).toBe(true);
    expect(cfg.effort).toBe('xhigh');
  });

  it("reviewer uses 'high' effort", () => {
    expect(ROLE_THINKING_CONFIG['reviewer'].effort).toBe('high');
  });

  it("architect uses 'high' effort", () => {
    expect(ROLE_THINKING_CONFIG['architect'].effort).toBe('high');
  });

  it("stitcher uses 'high' effort", () => {
    expect(ROLE_THINKING_CONFIG['stitcher'].effort).toBe('high');
  });

  it("implementer uses 'medium' effort", () => {
    expect(ROLE_THINKING_CONFIG['implementer'].effort).toBe('medium');
  });

  it("test-writer uses 'medium' effort", () => {
    expect(ROLE_THINKING_CONFIG['test-writer'].effort).toBe('medium');
  });
});

// ── ROLE_EFFORT_MAP ───────────────────────────────────────────────────────────

describe('ROLE_EFFORT_MAP', () => {
  it("assigns 'low' effort to codebase-scanner", () => {
    expect(ROLE_EFFORT_MAP['codebase-scanner']).toBe('low');
  });

  it("assigns 'low' effort to reporter", () => {
    expect(ROLE_EFFORT_MAP['reporter']).toBe('low');
  });

  it("assigns 'high' effort to architect", () => {
    expect(ROLE_EFFORT_MAP['architect']).toBe('high');
  });

  it("assigns 'high' effort to reviewer", () => {
    expect(ROLE_EFFORT_MAP['reviewer']).toBe('high');
  });

  it("assigns 'high' effort to debugger", () => {
    expect(ROLE_EFFORT_MAP['debugger']).toBe('high');
  });

  it("assigns 'medium' effort to implementer", () => {
    expect(ROLE_EFFORT_MAP['implementer']).toBe('medium');
  });

  it("assigns 'medium' effort to test-writer", () => {
    expect(ROLE_EFFORT_MAP['test-writer']).toBe('medium');
  });
});

// ── classifyError ─────────────────────────────────────────────────────────────

describe('classifyError — permanent errors', () => {
  it('classifies invalid API key as permanent', () => {
    expect(classifyError('invalid api key provided')).toBe('permanent');
  });

  it('classifies 401 unauthorized as permanent', () => {
    expect(classifyError('401 unauthorized access')).toBe('permanent');
  });

  it('classifies 403 forbidden as permanent', () => {
    expect(classifyError('403 forbidden')).toBe('permanent');
  });

  it('classifies "model not found" as permanent', () => {
    expect(classifyError('model not found: claude-opus-4-8')).toBe('permanent');
  });

  it('classifies schema validation failure as permanent', () => {
    expect(classifyError('schema validation error: unknown field')).toBe('permanent');
  });
});

describe('classifyError — transient errors', () => {
  it('classifies rate limit (429) as transient', () => {
    expect(classifyError('rate limit exceeded (429)')).toBe('transient');
  });

  it('classifies 503 service unavailable as transient', () => {
    expect(classifyError('503 service unavailable')).toBe('transient');
  });

  it('classifies request timeout as transient', () => {
    expect(classifyError('request timed out after 30s')).toBe('transient');
  });

  it('classifies overloaded message as transient', () => {
    expect(classifyError('model is overloaded, please try again')).toBe('transient');
  });

  it('classifies network connection reset as transient', () => {
    expect(classifyError('econnreset: connection reset by peer')).toBe('transient');
  });

  it('defaults to transient for unrecognised errors (safe to retry)', () => {
    expect(classifyError('something unexpected occurred')).toBe('transient');
  });
});

describe('classifyError — budget and turn-limit errors', () => {
  it('classifies max budget USD reached as budget_exceeded', () => {
    expect(classifyError('max budget (usd) reached: $5.00')).toBe('budget_exceeded');
  });

  it('classifies error_max_budget_usd subtype as budget_exceeded', () => {
    expect(classifyError('error_max_budget_usd')).toBe('budget_exceeded');
  });

  it('classifies max turns reached as turn_limit', () => {
    expect(classifyError('max turns reached after 50 turns')).toBe('turn_limit');
  });

  it('classifies error_max_turns subtype as turn_limit', () => {
    expect(classifyError('error_max_turns')).toBe('turn_limit');
  });
});

describe('classifyError — tool denied errors', () => {
  it('classifies write blocked by security policy as tool_denied', () => {
    expect(classifyError('write blocked: content appears to contain a secret or credential')).toBe('tool_denied');
  });

  it("classifies role 'X' cannot write as tool_denied", () => {
    expect(classifyError("role 'architect' cannot write — read-only role")).toBe('tool_denied');
  });

  it('classifies write outside workspace as tool_denied', () => {
    expect(classifyError("Write to '/etc/passwd' is outside workspace '/tmp/ws'")).toBe('tool_denied');
  });
});

// ── computeBackoff ────────────────────────────────────────────────────────────

describe('computeBackoff', () => {
  it('returns 1000ms (baseDelayMs × 1.0) for attempt 0', () => {
    expect(computeBackoff(0)).toBe(Math.round(RETRY_CONFIG.baseDelayMs * 1.0));
  });

  it('returns 1500ms (baseDelayMs × 1.5) for attempt 1', () => {
    expect(computeBackoff(1)).toBe(Math.round(RETRY_CONFIG.baseDelayMs * 1.5));
  });

  it('returns 2000ms (baseDelayMs × 2.0) for attempt 2', () => {
    expect(computeBackoff(2)).toBe(Math.round(RETRY_CONFIG.baseDelayMs * 2.0));
  });

  it('caps at 2.0x for attempts beyond the multiplier table', () => {
    const capped = computeBackoff(100);
    expect(capped).toBe(Math.round(RETRY_CONFIG.baseDelayMs * 2.0));
  });

  it('produces values >= baseDelayMs for all attempts', () => {
    for (let i = 0; i < 5; i++) {
      expect(computeBackoff(i)).toBeGreaterThanOrEqual(RETRY_CONFIG.baseDelayMs);
    }
  });
});
