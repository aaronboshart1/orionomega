#!/usr/bin/env tsx
/**
 * Master Test Runner — executes all memory system unit test suites.
 *
 * Usage:
 *   npx tsx tests/run-all-tests.ts
 *   npx tsx tests/run-all-tests.ts --suite=01  # run only suite 01
 *
 * Exit code: 0 if all pass, 1 if any fail.
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SuiteResult {
  name: string;
  file: string;
  passed: boolean;
  durationMs: number;
  output: string;
}

const SUITES = [
  { name: '01 — Storage Layer: Similarity Scoring', file: '01-similarity-storage.test.ts' },
  { name: '02 — Retrieval Layer: Client Recall', file: '02-client-retrieval.test.ts' },
  { name: '03 — Indexing: Query Classification & Context Assembly', file: '03-indexing.test.ts' },
  { name: '04 — Integration: End-to-End Memory Operations', file: '04-integration.test.ts' },
  { name: '05 — Error Scenarios: Corruption Recovery', file: '05-error-scenarios.test.ts' },
  { name: '06 — Performance Benchmarks', file: '06-performance-benchmarks.test.ts' },
];

// Parse --suite=XX filter
const filterArg = process.argv.find(a => a.startsWith('--suite='));
const suiteFilter = filterArg ? filterArg.split('=')[1] : null;

const results: SuiteResult[] = [];
let totalPassed = 0;
let totalFailed = 0;

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║        Memory System Unit Tests — Master Runner            ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

for (const suite of SUITES) {
  if (suiteFilter && !suite.file.startsWith(suiteFilter)) {
    continue;
  }

  const filePath = resolve(__dirname, suite.file);
  const start = performance.now();
  let output = '';
  let passed = false;

  try {
    output = execSync(`npx tsx "${filePath}"`, {
      cwd: __dirname,
      encoding: 'utf-8',
      timeout: 120_000, // 2 minutes per suite
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    passed = true;
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; status?: number };
    output = (execErr.stdout ?? '') + '\n' + (execErr.stderr ?? '');
    passed = false;
  }

  const durationMs = performance.now() - start;
  results.push({ name: suite.name, file: suite.file, passed, durationMs, output });

  // Count from output
  const passMatch = output.match(/(\d+) passed/);
  const failMatch = output.match(/(\d+) failed/);
  const suitePassCount = passMatch ? parseInt(passMatch[1], 10) : 0;
  const suiteFailCount = failMatch ? parseInt(failMatch[1], 10) : 0;
  totalPassed += suitePassCount;
  totalFailed += suiteFailCount;

  const icon = passed ? '✓' : '✗';
  const status = passed ? 'PASS' : 'FAIL';
  console.log(`${icon} ${status}: ${suite.name} (${durationMs.toFixed(0)}ms, ${suitePassCount}p/${suiteFailCount}f)`);

  // Show failures inline
  if (!passed) {
    const failLines = output.split('\n').filter(l => l.includes('FAIL'));
    for (const line of failLines.slice(0, 10)) {
      console.log(`    ${line.trim()}`);
    }
    if (failLines.length > 10) {
      console.log(`    ... and ${failLines.length - 10} more failures`);
    }
  }
}

// ── Final Summary ──────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║                     FINAL SUMMARY                          ║');
console.log('╠══════════════════════════════════════════════════════════════╣');

const suitesRun = results.length;
const suitesPassed = results.filter(r => r.passed).length;
const suitesFailed = results.filter(r => !r.passed).length;
const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

console.log(`║  Suites:      ${suitesPassed}/${suitesRun} passed${suitesFailed > 0 ? ` (${suitesFailed} FAILED)` : ''}`);
console.log(`║  Assertions:  ${totalPassed} passed, ${totalFailed} failed`);
console.log(`║  Duration:    ${(totalDuration / 1000).toFixed(1)}s`);
console.log('╚══════════════════════════════════════════════════════════════╝\n');

if (suitesFailed > 0) {
  console.log('FAILED SUITES:');
  for (const r of results.filter(r => !r.passed)) {
    console.log(`  ✗ ${r.name}`);
  }
  console.log('');
}

// Write detailed output to file
const reportPath = resolve(__dirname, '..', 'test-results.txt');
const report = results.map(r => {
  return `${'═'.repeat(60)}\n${r.passed ? '✓' : '✗'} ${r.name} (${r.durationMs.toFixed(0)}ms)\n${'═'.repeat(60)}\n${r.output}\n`;
}).join('\n');

try {
  const fs = require('node:fs');
  fs.writeFileSync(reportPath, report, 'utf-8');
  console.log(`Detailed results written to: ${reportPath}`);
} catch {
  // Non-critical
}

process.exit(suitesFailed > 0 ? 1 : 0);
