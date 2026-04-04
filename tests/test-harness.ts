/**
 * Shared test harness for memory system unit tests.
 *
 * Provides assertion utilities, mock factories, timing helpers,
 * and a lightweight test runner — no external dependencies.
 */

// ── Assertion Utilities ────────────────────────────────────────

let _passed = 0;
let _failed = 0;
let _skipped = 0;
const _failures: string[] = [];

export function assert(condition: boolean, message: string): void {
  if (!condition) {
    _failed++;
    _failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  } else {
    _passed++;
    console.log(`  ✓ PASS: ${message}`);
  }
}

export function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    _failed++;
    const detail = `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    _failures.push(detail);
    console.error(`  ✗ FAIL: ${detail}`);
  } else {
    _passed++;
    console.log(`  ✓ PASS: ${message}`);
  }
}

export function assertApprox(actual: number, min: number, max: number, message: string): void {
  if (actual < min || actual > max) {
    _failed++;
    const detail = `${message} — expected [${min}, ${max}], got ${actual.toFixed(6)}`;
    _failures.push(detail);
    console.error(`  ✗ FAIL: ${detail}`);
  } else {
    _passed++;
    console.log(`  ✓ PASS: ${message} (${actual.toFixed(4)})`);
  }
}

export function assertThrows(fn: () => void, message: string): void {
  try {
    fn();
    _failed++;
    _failures.push(`${message} — expected throw, but none occurred`);
    console.error(`  ✗ FAIL: ${message} — expected throw`);
  } catch {
    _passed++;
    console.log(`  ✓ PASS: ${message}`);
  }
}

export async function assertThrowsAsync(fn: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await fn();
    _failed++;
    _failures.push(`${message} — expected throw, but none occurred`);
    console.error(`  ✗ FAIL: ${message} — expected throw`);
  } catch {
    _passed++;
    console.log(`  ✓ PASS: ${message}`);
  }
}

export function assertDeepEq(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    _failed++;
    const detail = `${message}\n    expected: ${b}\n    actual:   ${a}`;
    _failures.push(detail);
    console.error(`  ✗ FAIL: ${detail}`);
  } else {
    _passed++;
    console.log(`  ✓ PASS: ${message}`);
  }
}

export function assertGt(actual: number, threshold: number, message: string): void {
  if (actual <= threshold) {
    _failed++;
    const detail = `${message} — expected > ${threshold}, got ${actual}`;
    _failures.push(detail);
    console.error(`  ✗ FAIL: ${detail}`);
  } else {
    _passed++;
    console.log(`  ✓ PASS: ${message} (${actual})`);
  }
}

export function assertLt(actual: number, threshold: number, message: string): void {
  if (actual >= threshold) {
    _failed++;
    const detail = `${message} — expected < ${threshold}, got ${actual}`;
    _failures.push(detail);
    console.error(`  ✗ FAIL: ${detail}`);
  } else {
    _passed++;
    console.log(`  ✓ PASS: ${message} (${actual})`);
  }
}

export function skip(message: string): void {
  _skipped++;
  console.log(`  ⊘ SKIP: ${message}`);
}

// ── Test Structure ─────────────────────────────────────────────

export function suite(name: string): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${'═'.repeat(60)}\n`);
}

export function section(name: string): void {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 54 - name.length))}\n`);
}

// ── Results ────────────────────────────────────────────────────

export function getResults(): { passed: number; failed: number; skipped: number; failures: string[] } {
  return { passed: _passed, failed: _failed, skipped: _skipped, failures: [..._failures] };
}

export function resetResults(): void {
  _passed = 0;
  _failed = 0;
  _skipped = 0;
  _failures.length = 0;
}

export function printSummary(suiteName: string): boolean {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${suiteName}: ${_passed} passed, ${_failed} failed, ${_skipped} skipped`);
  if (_failures.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of _failures) {
      console.log(`    - ${f}`);
    }
  }
  console.log(`${'═'.repeat(60)}\n`);
  return _failed === 0;
}

// ── Benchmark Utilities ────────────────────────────────────────

export interface BenchResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  opsPerSec: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export function bench(name: string, fn: () => void, iterations = 1000): BenchResult {
  // Warm up
  for (let i = 0; i < Math.min(10, iterations); i++) fn();

  const times: number[] = [];
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const totalMs = performance.now() - start;

  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const p99 = times[Math.floor(times.length * 0.99)];

  const result: BenchResult = {
    name,
    iterations,
    totalMs,
    avgMs: totalMs / iterations,
    opsPerSec: (iterations / totalMs) * 1000,
    p50Ms: p50,
    p95Ms: p95,
    p99Ms: p99,
  };

  console.log(
    `  ⏱ ${name}: ${result.opsPerSec.toFixed(0)} ops/s ` +
    `(avg: ${result.avgMs.toFixed(3)}ms, p50: ${p50.toFixed(3)}ms, p95: ${p95.toFixed(3)}ms, p99: ${p99.toFixed(3)}ms)`,
  );

  return result;
}

// ── Mock Factories ─────────────────────────────────────────────

/** Track calls to a mock function. */
export interface MockFn<TArgs extends unknown[] = unknown[], TReturn = unknown> {
  (...args: TArgs): TReturn;
  calls: TArgs[];
  lastCall: TArgs | undefined;
  callCount: number;
  reset(): void;
}

export function createMockFn<TArgs extends unknown[] = unknown[], TReturn = unknown>(
  impl?: (...args: TArgs) => TReturn,
): MockFn<TArgs, TReturn> {
  const calls: TArgs[] = [];
  const mock = ((...args: TArgs) => {
    calls.push(args);
    return impl?.(...args) as TReturn;
  }) as MockFn<TArgs, TReturn>;
  mock.calls = calls;
  Object.defineProperty(mock, 'lastCall', { get: () => calls[calls.length - 1] });
  Object.defineProperty(mock, 'callCount', { get: () => calls.length });
  mock.reset = () => { calls.length = 0; };
  return mock;
}

/** Creates a mock HindsightClient-like object for testing. */
export function createMockHindsightClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    health: createMockFn(() => Promise.resolve({ status: 'ok', version: '0.4.0' })),
    createBank: createMockFn(() => Promise.resolve()),
    getBank: createMockFn(() => Promise.resolve({ bank_id: 'test', name: 'Test', created_at: new Date().toISOString() })),
    listBanks: createMockFn(() => Promise.resolve({ banks: [] })),
    listBanksCached: createMockFn(() => Promise.resolve([])),
    invalidateBanksCache: createMockFn(),
    bankExists: createMockFn(() => Promise.resolve(true)),
    retain: createMockFn(() => Promise.resolve({ success: true, bank_id: 'test', items_count: 1 })),
    retainOne: createMockFn(() => Promise.resolve({ success: true, bank_id: 'test', items_count: 1 })),
    recall: createMockFn(() => Promise.resolve({ results: [], tokens_used: 0 })),
    recallWithTemporalDiversity: createMockFn(() => Promise.resolve({ results: [], tokens_used: 0, lowConfidence: false })),
    isDuplicateContent: createMockFn(() => Promise.resolve(false)),
    getMentalModel: createMockFn(() => Promise.resolve({ id: 'test', content: 'model content', last_refreshed: new Date().toISOString(), source_count: 5 })),
    refreshMentalModel: createMockFn(() => Promise.resolve()),
    onIO: undefined,
    onActivity: undefined,
    ...overrides,
  };
}

/** Creates a mock AnthropicClient-like object. */
export function createMockAnthropicClient(responseText = 'mock response'): Record<string, unknown> {
  return {
    createMessage: createMockFn(() => Promise.resolve({
      content: [{ type: 'text', text: responseText }],
    })),
  };
}

/** Creates a mock EventBus. */
export function createMockEventBus(): Record<string, unknown> {
  return {
    on: createMockFn(),
    off: createMockFn(),
    emit: createMockFn(),
  };
}

// ── File System Helpers ────────────────────────────────────────

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = '/tmp/orionomega-test-' + process.pid;

export function tmpDir(subpath = ''): string {
  const dir = join(TMP_BASE, subpath);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function tmpFile(name: string, content: string): string {
  const dir = tmpDir();
  const path = join(dir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

export function readTmp(path: string): string {
  return readFileSync(path, 'utf-8');
}

export function tmpExists(path: string): boolean {
  return existsSync(path);
}

export function cleanupTmp(): void {
  try {
    if (existsSync(TMP_BASE)) {
      rmSync(TMP_BASE, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}
