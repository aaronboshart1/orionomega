/**
 * Test runner for all Coding Mode unit and integration tests.
 * Run with: npx tsx tests/run-coding-mode-tests.ts
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const TEST_FILES = [
  'tests/coding-file-lock.test.ts',
  'tests/coding-budget.test.ts',
  'tests/coding-output-aggregator.test.ts',
  'tests/coding-models.test.ts',
  'tests/coding-templates.test.ts',
  'tests/coding-planner.test.ts',
];

const results: Array<{ file: string; passed: boolean; output: string }> = [];

console.log('\n' + '═'.repeat(70));
console.log('  Coding Mode Test Suite');
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
  }
}

// Print full output for all suites
console.log('\n' + '═'.repeat(70));
console.log('  Full Output');
console.log('═'.repeat(70));
for (const r of results) {
  if (r.output.trim()) {
    console.log(r.output);
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
