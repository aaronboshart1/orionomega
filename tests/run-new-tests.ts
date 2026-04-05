#!/usr/bin/env tsx
/**
 * Test runner for new unit test suites (graph, event-bus, validator,
 * config-loader, model-discovery, checkpoint).
 *
 * Run with: npx tsx tests/run-new-tests.ts
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const TEST_FILES = [
  'tests/graph.test.ts',
  'tests/event-bus.test.ts',
  'tests/validator.test.ts',
  'tests/config-loader.test.ts',
  'tests/model-discovery.test.ts',
  'tests/checkpoint.test.ts',
];

const results: Array<{ file: string; passed: boolean; output: string }> = [];

console.log('\n' + '═'.repeat(70));
console.log('  New Module Test Suite');
console.log('═'.repeat(70) + '\n');

for (const testFile of TEST_FILES) {
  const label = testFile.replace('tests/', '');
  process.stdout.write(`Running ${label}... `);

  try {
    const output = execSync(
      `npx tsx ${join(REPO_ROOT, testFile)}`,
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );
    process.stdout.write('OK\n');
    results.push({ file: label, passed: true, output });
  } catch (err: unknown) {
    process.stdout.write('FAIL\n');
    const output =
      (err instanceof Error && 'stdout' in err ? String((err as NodeJS.ErrnoException & { stdout?: string }).stdout) : '') +
      (err instanceof Error && 'stderr' in err ? String((err as NodeJS.ErrnoException & { stderr?: string }).stderr) : '');
    results.push({ file: label, passed: false, output });
  }
}

console.log('\n' + '═'.repeat(70));
console.log('  Results Summary');
console.log('═'.repeat(70));

let allPassed = true;
for (const r of results) {
  const icon = r.passed ? '✓' : '✗';
  console.log(`  ${icon} ${r.file}`);
  if (!r.passed) {
    allPassed = false;
    // Show failure details
    const failLines = r.output.split('\n').filter(l => l.includes('FAIL'));
    for (const line of failLines.slice(0, 5)) {
      console.log(`      ${line.trim()}`);
    }
  }
}

console.log('\n' + '═'.repeat(70));
if (allPassed) {
  console.log('  ALL SUITES PASSED');
} else {
  console.log('  SOME SUITES FAILED — see output above');
}
console.log('═'.repeat(70) + '\n');

process.exit(allPassed ? 0 : 1);
