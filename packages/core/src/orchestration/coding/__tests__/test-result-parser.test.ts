/**
 * @module orchestration/coding/__tests__/test-result-parser
 *
 * Unit tests for the structured test-result parsers (spec §4.6).
 *
 * Each parser section:
 *   - Verifies counts (total/passed/failed/skipped) from realistic output
 *   - Verifies failure field extraction (testName, file, line, category, etc.)
 *   - Verifies error handling for malformed input
 *
 * No external processes are spawned — all inputs are inline strings.
 */

import { describe, it, expect } from 'vitest';
import {
  parseJestJson,
  parsePytestJunit,
  parseGoTestJson,
  parseCargoTestJson,
  parseMochaJson,
  detectTestFramework,
  classifyFailures,
  buildDebuggerContext,
} from '../test-result-parser.js';
import type { TestResults } from '../test-result-parser.js';

// ── parseJestJson ─────────────────────────────────────────────────────────────

describe('parseJestJson', () => {
  it('parses a fully-passing run', () => {
    const input = JSON.stringify({
      numTotalTests: 3,
      numPassedTests: 3,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [
        {
          testFilePath: '/project/src/__tests__/math.test.ts',
          testResults: [
            { ancestorTitles: ['Math'], title: 'adds', fullName: 'Math adds', status: 'passed', duration: 5 },
            { ancestorTitles: ['Math'], title: 'subs', fullName: 'Math subs', status: 'passed', duration: 3 },
            { ancestorTitles: ['Math'], title: 'muls', fullName: 'Math muls', status: 'passed', duration: 4 },
          ],
        },
      ],
    });

    const result = parseJestJson(input);
    expect(result.framework).toBe('jest');
    expect(result.total).toBe(3);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failures).toHaveLength(0);
    expect(result.duration_ms).toBe(12);
  });

  it('extracts failure fields from assertion error', () => {
    const input = JSON.stringify({
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 1,
      numPendingTests: 0,
      testResults: [
        {
          testFilePath: '/project/src/__tests__/math.test.ts',
          testResults: [
            { ancestorTitles: ['Math'], title: 'passes', status: 'passed', duration: 2 },
            {
              ancestorTitles: ['Math'],
              title: 'subtracts correctly',
              fullName: 'Math subtracts correctly',
              status: 'failed',
              duration: 3,
              failureMessages: [
                'Error: expect(received).toBe(expected)\n\n' +
                '  Expected: 2\n' +
                '  Received: 3\n\n' +
                '    at Object.<anonymous> (/project/src/__tests__/math.test.ts:12:5)\n' +
                '    at Object.asyncJestTest (/project/node_modules/jest-jasmine2/build/jasmine/Env.js:455:37)',
              ],
            },
          ],
        },
      ],
    });

    const result = parseJestJson(input);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);

    const f = result.failures[0];
    expect(f.testName).toBe('Math subtracts correctly');
    expect(f.file).toBe('/project/src/__tests__/math.test.ts');
    expect(f.line).toBe(12);
    expect(f.expected).toBe('2');
    expect(f.actual).toBe('3');
    expect(f.category).toBe('assertion');
    expect(f.errorMessage).toContain('expect(received).toBe(expected)');
    expect(f.stackTrace).toContain('at Object.<anonymous>');
  });

  it('classifies runtime errors correctly', () => {
    const input = JSON.stringify({
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 0,
      testResults: [
        {
          testFilePath: '/project/src/__tests__/service.test.ts',
          testResults: [
            {
              title: 'calls service',
              fullName: 'calls service',
              status: 'failed',
              duration: 1,
              failureMessages: [
                'TypeError: Cannot read properties of undefined (reading \'id\')\n' +
                '    at /project/src/__tests__/service.test.ts:20:10',
              ],
            },
          ],
        },
      ],
    });

    const result = parseJestJson(input);
    expect(result.failures[0].category).toBe('runtime');
  });

  it('classifies setup errors from beforeAll', () => {
    const input = JSON.stringify({
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 0,
      testResults: [
        {
          testFilePath: '/project/src/__tests__/db.test.ts',
          testResults: [
            {
              title: 'connects to DB',
              fullName: 'connects to DB',
              status: 'failed',
              duration: 5,
              failureMessages: [
                'beforeAll: Cannot connect to database\n' +
                '    at /project/src/__tests__/db.test.ts:5:10',
              ],
            },
          ],
        },
      ],
    });

    const result = parseJestJson(input);
    expect(result.failures[0].category).toBe('setup');
  });

  it('counts pending tests as skipped', () => {
    const input = JSON.stringify({
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 1,
      testResults: [
        {
          testFilePath: '/project/src/__tests__/foo.test.ts',
          testResults: [
            { title: 'a', status: 'passed', duration: 1 },
            { title: 'b', status: 'passed', duration: 1 },
            { title: 'c', status: 'pending', duration: 0 },
          ],
        },
      ],
    });

    const result = parseJestJson(input);
    expect(result.skipped).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  it('builds testName from ancestorTitles when fullName is absent', () => {
    const input = JSON.stringify({
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 0,
      testResults: [
        {
          testFilePath: '/project/src/__tests__/foo.test.ts',
          testResults: [
            {
              ancestorTitles: ['Suite', 'Nested'],
              title: 'test it',
              status: 'failed',
              failureMessages: ['AssertionError: expected true to be false'],
            },
          ],
        },
      ],
    });

    const result = parseJestJson(input);
    expect(result.failures[0].testName).toBe('Suite > Nested > test it');
  });

  it('handles missing optional fields gracefully', () => {
    const input = JSON.stringify({
      testResults: [],
    });

    const result = parseJestJson(input);
    expect(result.total).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.failures).toHaveLength(0);
    expect(result.duration_ms).toBe(0);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJestJson('not json{')).toThrow('parseJestJson: invalid JSON');
  });

  it('throws on non-object JSON root', () => {
    expect(() => parseJestJson('[1,2,3]')).toThrow('parseJestJson: expected a JSON object');
  });
});

// ── parsePytestJunit ──────────────────────────────────────────────────────────

describe('parsePytestJunit', () => {
  const PASSING_XML = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" tests="3" errors="0" failures="0" skipped="0" time="0.456">
    <testcase classname="tests.test_math" name="test_add" time="0.100"/>
    <testcase classname="tests.test_math" name="test_sub" time="0.100"/>
    <testcase classname="tests.test_math" name="test_mul" time="0.100"/>
  </testsuite>
</testsuites>`;

  it('parses a fully-passing run', () => {
    const result = parsePytestJunit(PASSING_XML);
    expect(result.framework).toBe('pytest');
    expect(result.total).toBe(3);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failures).toHaveLength(0);
    expect(result.duration_ms).toBe(456);
  });

  it('extracts failure fields', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuite name="pytest" tests="2" errors="0" failures="1" skipped="0" time="0.250"
           file="tests/test_math.py">
  <testcase classname="tests.test_math" name="test_add" time="0.100"/>
  <testcase classname="tests.test_math" name="test_sub" file="tests/test_math.py" line="15" time="0.150">
    <failure message="AssertionError: assert 1 == 2">
E   AssertionError: assert 1 == 2
E    +  where 1 = subtract(3, 2)
    </failure>
  </testcase>
</testsuite>`;

    const result = parsePytestJunit(xml);
    expect(result.total).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failures).toHaveLength(1);

    const f = result.failures[0];
    expect(f.testName).toBe('tests.test_math::test_sub');
    expect(f.file).toBe('tests/test_math.py');
    expect(f.line).toBe(15);
    expect(f.errorMessage).toBe('AssertionError: assert 1 == 2');
    expect(f.category).toBe('assertion');
    expect(f.stackTrace).toContain('assert 1 == 2');
  });

  it('counts errors as failures', () => {
    const xml = `<testsuite tests="2" errors="1" failures="0" skipped="0" time="0.1">
  <testcase classname="tests.test_setup" name="test_foo">
    <error message="ModuleNotFoundError: No module named &apos;mylib&apos;">
ImportError while importing test module 'tests/test_setup.py'.
    </error>
  </testcase>
</testsuite>`;

    const result = parsePytestJunit(xml);
    expect(result.failed).toBe(1);
    expect(result.failures[0].category).toBe('setup');
    expect(result.failures[0].errorMessage).toContain("No module named 'mylib'");
  });

  it('handles CDATA sections', () => {
    const xml = `<testsuite tests="1" errors="0" failures="1" skipped="0" time="0.05">
  <testcase classname="tests.test_foo" name="test_bar">
    <failure message="AssertionError"><![CDATA[FAILED tests/test_foo.py::test_bar
AssertionError]]></failure>
  </testcase>
</testsuite>`;

    const result = parsePytestJunit(xml);
    expect(result.failures[0].stackTrace).toContain('FAILED tests/test_foo.py::test_bar');
  });

  it('derives file from classname when file attr is absent', () => {
    const xml = `<testsuite tests="1" errors="0" failures="1" skipped="0" time="0.01">
  <testcase classname="tests.sub.test_module" name="test_thing">
    <failure message="AssertionError: oops">oops</failure>
  </testcase>
</testsuite>`;

    const result = parsePytestJunit(xml);
    expect(result.failures[0].file).toBe('tests/sub/test_module.py');
  });

  it('handles skipped tests', () => {
    const xml = `<testsuite tests="2" errors="0" failures="0" skipped="1" time="0.01">
  <testcase classname="tests.t" name="test_a" time="0.005"/>
  <testcase classname="tests.t" name="test_skip" time="0.001">
    <skipped message="not implemented yet"/>
  </testcase>
</testsuite>`;

    const result = parsePytestJunit(xml);
    expect(result.skipped).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  it('throws on empty content', () => {
    expect(() => parsePytestJunit('')).toThrow('parsePytestJunit: empty XML content');
    expect(() => parsePytestJunit('   ')).toThrow('parsePytestJunit: empty XML content');
  });

  it('throws when no testsuite element is found', () => {
    expect(() => parsePytestJunit('<xml><nothing/></xml>')).toThrow(
      'parsePytestJunit: no <testsuite> element found',
    );
  });
});

// ── parseGoTestJson ───────────────────────────────────────────────────────────

describe('parseGoTestJson', () => {
  it('parses a fully-passing run', () => {
    const lines = [
      JSON.stringify({ Action: 'run', Test: 'TestAdd', Package: 'mypackage' }),
      JSON.stringify({ Action: 'pass', Test: 'TestAdd', Package: 'mypackage', Elapsed: 0.001 }),
      JSON.stringify({ Action: 'run', Test: 'TestSub', Package: 'mypackage' }),
      JSON.stringify({ Action: 'pass', Test: 'TestSub', Package: 'mypackage', Elapsed: 0.002 }),
      JSON.stringify({ Action: 'pass', Package: 'mypackage', Elapsed: 0.005 }),
    ].join('\n');

    const result = parseGoTestJson(lines);
    expect(result.framework).toBe('go-test');
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.total).toBe(2);
    expect(result.failures).toHaveLength(0);
    // durationMs comes from the package-level pass event
    expect(result.duration_ms).toBe(5);
  });

  it('extracts failure with file and line', () => {
    const lines = [
      JSON.stringify({ Action: 'run', Test: 'TestCalc', Package: 'mypackage' }),
      JSON.stringify({ Action: 'output', Test: 'TestCalc', Package: 'mypackage', Output: '--- FAIL: TestCalc (0.00s)\n' }),
      JSON.stringify({ Action: 'output', Test: 'TestCalc', Package: 'mypackage', Output: '    calc_test.go:22: expected 4, got 5\n' }),
      JSON.stringify({ Action: 'fail', Test: 'TestCalc', Package: 'mypackage', Elapsed: 0.001 }),
      JSON.stringify({ Action: 'fail', Package: 'mypackage', Elapsed: 0.001 }),
    ].join('\n');

    const result = parseGoTestJson(lines);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);

    const f = result.failures[0];
    expect(f.testName).toBe('TestCalc');
    expect(f.file).toBe('calc_test.go');
    expect(f.line).toBe(22);
    expect(f.errorMessage).toBe('expected 4, got 5');
    expect(f.category).toBe('runtime');
  });

  it('handles skipped tests', () => {
    const lines = [
      JSON.stringify({ Action: 'run', Test: 'TestSkipped', Package: 'mypackage' }),
      JSON.stringify({ Action: 'skip', Test: 'TestSkipped', Package: 'mypackage', Elapsed: 0 }),
      JSON.stringify({ Action: 'run', Test: 'TestPass', Package: 'mypackage' }),
      JSON.stringify({ Action: 'pass', Test: 'TestPass', Package: 'mypackage', Elapsed: 0.001 }),
    ].join('\n');

    const result = parseGoTestJson(lines);
    expect(result.skipped).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.total).toBe(2);
  });

  it('skips non-JSON lines without throwing', () => {
    const lines = [
      '# building package...',
      JSON.stringify({ Action: 'run', Test: 'TestFoo', Package: 'mypackage' }),
      JSON.stringify({ Action: 'pass', Test: 'TestFoo', Package: 'mypackage', Elapsed: 0.001 }),
    ].join('\n');

    expect(() => parseGoTestJson(lines)).not.toThrow();
    const result = parseGoTestJson(lines);
    expect(result.passed).toBe(1);
  });

  it('returns zero counts for empty input', () => {
    const result = parseGoTestJson('');
    expect(result.total).toBe(0);
    expect(result.failures).toHaveLength(0);
  });
});

// ── parseCargoTestJson ────────────────────────────────────────────────────────

describe('parseCargoTestJson', () => {
  it('parses a passing run with suite summary', () => {
    const lines = [
      JSON.stringify({ type: 'suite', event: 'started', test_count: 3 }),
      JSON.stringify({ type: 'test', event: 'started', name: 'tests::test_add' }),
      JSON.stringify({ type: 'test', event: 'ok', name: 'tests::test_add', exec_time: 0.001 }),
      JSON.stringify({ type: 'test', event: 'started', name: 'tests::test_sub' }),
      JSON.stringify({ type: 'test', event: 'ok', name: 'tests::test_sub', exec_time: 0.001 }),
      JSON.stringify({ type: 'suite', event: 'finished', passed: 2, failed: 0, ignored: 0, exec_time: 0.010 }),
    ].join('\n');

    const result = parseCargoTestJson(lines);
    expect(result.framework).toBe('cargo-test');
    expect(result.total).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.failures).toHaveLength(0);
    expect(result.duration_ms).toBe(10);
  });

  it('extracts failure with old Rust panic format', () => {
    const stdout =
      "thread 'tests::test_sub' panicked at 'assertion failed: `(left == right)`\\n  left: `1`,\\n right: `2`', src/lib.rs:15:5";
    const lines = [
      JSON.stringify({ type: 'test', event: 'started', name: 'tests::test_sub' }),
      JSON.stringify({ type: 'test', event: 'failed', name: 'tests::test_sub', exec_time: 0.001, stdout }),
      JSON.stringify({ type: 'suite', event: 'finished', passed: 0, failed: 1, ignored: 0, exec_time: 0.001 }),
    ].join('\n');

    const result = parseCargoTestJson(lines);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);

    const f = result.failures[0];
    expect(f.testName).toBe('tests::test_sub');
    expect(f.file).toBe('src/lib.rs');
    expect(f.line).toBe(15);
    expect(f.errorMessage).toContain('assertion failed');
    expect(f.category).toBe('assertion');
  });

  it('extracts failure with new Rust panic format (1.73+)', () => {
    const stdout = "thread 'tests::test_div' panicked at src/lib.rs:30:5:\nattempt to divide by zero";
    const lines = [
      JSON.stringify({ type: 'test', event: 'failed', name: 'tests::test_div', exec_time: 0, stdout }),
      JSON.stringify({ type: 'suite', event: 'finished', passed: 0, failed: 1, ignored: 0, exec_time: 0 }),
    ].join('\n');

    const result = parseCargoTestJson(lines);
    const f = result.failures[0];
    expect(f.file).toBe('src/lib.rs');
    expect(f.line).toBe(30);
    expect(f.errorMessage).toBe('attempt to divide by zero');
  });

  it('counts ignored tests as skipped', () => {
    const lines = [
      JSON.stringify({ type: 'suite', event: 'finished', passed: 1, failed: 0, ignored: 2, exec_time: 0 }),
    ].join('\n');

    const result = parseCargoTestJson(lines);
    expect(result.skipped).toBe(2);
    expect(result.total).toBe(3);
  });

  it('skips non-JSON lines', () => {
    const lines = [
      'running 1 test',
      JSON.stringify({ type: 'suite', event: 'finished', passed: 1, failed: 0, ignored: 0, exec_time: 0 }),
    ].join('\n');

    expect(() => parseCargoTestJson(lines)).not.toThrow();
  });
});

// ── parseMochaJson ────────────────────────────────────────────────────────────

describe('parseMochaJson', () => {
  it('parses a fully-passing run', () => {
    const input = JSON.stringify({
      stats: { tests: 3, passes: 3, pending: 0, failures: 0, duration: 456 },
      failures: [],
    });

    const result = parseMochaJson(input);
    expect(result.framework).toBe('mocha');
    expect(result.total).toBe(3);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.duration_ms).toBe(456);
    expect(result.failures).toHaveLength(0);
  });

  it('extracts failure fields', () => {
    const input = JSON.stringify({
      stats: { tests: 2, passes: 1, pending: 0, failures: 1, duration: 200 },
      failures: [
        {
          title: 'adds numbers',
          fullTitle: 'Math adds numbers',
          file: '/project/test/math.spec.js',
          err: {
            message: 'expected 2 to equal 3',
            stack: 'AssertionError: expected 2 to equal 3\n    at Context.<anonymous> (/project/test/math.spec.js:8:14)',
            actual: '2',
            expected: '3',
          },
        },
      ],
    });

    const result = parseMochaJson(input);
    expect(result.failed).toBe(1);
    const f = result.failures[0];
    expect(f.testName).toBe('Math adds numbers');
    expect(f.file).toBe('/project/test/math.spec.js');
    expect(f.line).toBe(8);
    expect(f.expected).toBe('3');
    expect(f.actual).toBe('2');
    expect(f.errorMessage).toBe('expected 2 to equal 3');
    expect(f.category).toBe('assertion');
  });

  it('handles pending (skipped) tests', () => {
    const input = JSON.stringify({
      stats: { tests: 3, passes: 2, pending: 1, failures: 0, duration: 100 },
      failures: [],
    });

    const result = parseMochaJson(input);
    expect(result.skipped).toBe(1);
  });

  it('falls back to stack-extracted file when file is absent', () => {
    const input = JSON.stringify({
      stats: { tests: 1, passes: 0, pending: 0, failures: 1, duration: 10 },
      failures: [
        {
          title: 'test',
          err: {
            message: 'oops',
            stack: 'Error: oops\n    at Context.<anonymous> (/project/test/foo.spec.js:5:3)',
          },
        },
      ],
    });

    const result = parseMochaJson(input);
    expect(result.failures[0].file).toBe('/project/test/foo.spec.js');
    expect(result.failures[0].line).toBe(5);
  });

  it('classifies timeout errors', () => {
    const input = JSON.stringify({
      stats: { tests: 1, passes: 0, pending: 0, failures: 1, duration: 2000 },
      failures: [
        {
          title: 'slow test',
          err: {
            message: 'Error: Timeout of 2000ms exceeded.',
            stack: 'Error: Timeout of 2000ms exceeded.\n    at /project/test/slow.spec.js:10:5',
          },
        },
      ],
    });

    const result = parseMochaJson(input);
    expect(result.failures[0].category).toBe('timeout');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseMochaJson('{invalid')).toThrow('parseMochaJson: invalid JSON');
  });

  it('throws when stats key is missing', () => {
    expect(() => parseMochaJson('{"failures":[]}')).toThrow(
      'parseMochaJson: expected { stats: {...}, failures: [...] } at root',
    );
  });

  it('throws on array root', () => {
    expect(() => parseMochaJson('[1,2,3]')).toThrow(
      'parseMochaJson: expected { stats: {...}, failures: [...] } at root',
    );
  });
});

// ── detectTestFramework ───────────────────────────────────────────────────────

describe('detectTestFramework', () => {
  it('detects jest from explicit testFramework field', () => {
    const cfg = detectTestFramework({ testFramework: 'jest', dependencies: {} });
    expect(cfg?.framework).toBe('jest');
    expect(cfg?.outputType).toBe('stdout-json');
    expect(cfg?.flags).toContain('--json');
  });

  it('detects jest from dependencies', () => {
    const cfg = detectTestFramework({ testFramework: null, dependencies: { jest: '^29.0.0' } });
    expect(cfg?.framework).toBe('jest');
  });

  it('detects vitest and maps to jest framework', () => {
    const cfg = detectTestFramework({ testFramework: 'vitest', dependencies: {} });
    expect(cfg?.framework).toBe('jest');
    expect(cfg?.flags).toContain('--reporter=json');
  });

  it('detects mocha from testFramework field', () => {
    const cfg = detectTestFramework({ testFramework: 'mocha' });
    expect(cfg?.framework).toBe('mocha');
    expect(cfg?.outputType).toBe('stdout-json');
    expect(cfg?.flags).toContain('json');
  });

  it('detects mocha from dependencies', () => {
    const cfg = detectTestFramework({ testFramework: null, dependencies: { mocha: '^10.0.0' } });
    expect(cfg?.framework).toBe('mocha');
  });

  it('detects pytest from testFramework', () => {
    const cfg = detectTestFramework({ testFramework: 'pytest' });
    expect(cfg?.framework).toBe('pytest');
    expect(cfg?.outputType).toBe('file-xml');
    expect(cfg?.outputFileArg).toBe('results.xml');
    expect(cfg?.flags).toContain('--junitxml=results.xml');
  });

  it('detects pytest from dependencies', () => {
    const cfg = detectTestFramework({ testFramework: null, dependencies: { pytest: '^7.0.0' } });
    expect(cfg?.framework).toBe('pytest');
  });

  it('detects go-test', () => {
    const cfg = detectTestFramework({ testFramework: 'go', dependencies: {} });
    expect(cfg?.framework).toBe('go-test');
    expect(cfg?.outputType).toBe('stdout-jsonlines');
    expect(cfg?.flags).toContain('-json');
  });

  it('detects cargo/rust', () => {
    const cfg = detectTestFramework({ testFramework: 'cargo', dependencies: {} });
    expect(cfg?.framework).toBe('cargo-test');
    expect(cfg?.outputType).toBe('stdout-jsonlines');
  });

  it('returns null for unknown framework', () => {
    expect(detectTestFramework({ testFramework: null, dependencies: {} })).toBeNull();
    expect(detectTestFramework({ testFramework: 'unknown-testing-lib' })).toBeNull();
  });

  it('handles missing dependencies field', () => {
    const cfg = detectTestFramework({ testFramework: 'jest' });
    expect(cfg?.framework).toBe('jest');
  });
});

// ── classifyFailures ──────────────────────────────────────────────────────────

describe('classifyFailures', () => {
  function makeResults(overrides: Partial<TestResults>): TestResults {
    return {
      framework: 'jest',
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      duration_ms: 0,
      failures: [],
      ...overrides,
    };
  }

  it('classifies assertion failures as code-error', () => {
    const results = makeResults({
      failures: [
        { testName: 'test', file: 'a.ts', line: 1, expected: '1', actual: '2',
          errorMessage: 'AssertionError', stackTrace: '', category: 'assertion' },
      ],
    });
    expect(classifyFailures(results)).toBe('code-error');
  });

  it('classifies runtime failures as code-error', () => {
    const results = makeResults({
      failures: [
        { testName: 'test', file: 'a.ts', line: 1, expected: '', actual: '',
          errorMessage: 'TypeError: undefined', stackTrace: '', category: 'runtime' },
      ],
    });
    expect(classifyFailures(results)).toBe('code-error');
  });

  it('classifies setup failures as test-error', () => {
    const results = makeResults({
      failures: [
        { testName: 'test', file: 'a.ts', line: 1, expected: '', actual: '',
          errorMessage: 'beforeAll failed', stackTrace: '', category: 'setup' },
      ],
    });
    expect(classifyFailures(results)).toBe('test-error');
  });

  it('classifies 5+ distinct failing files as architectural', () => {
    const failures = ['a', 'b', 'c', 'd', 'e'].map((name) => ({
      testName: `test-${name}`,
      file: `${name}.ts`,
      line: 1,
      expected: '',
      actual: '',
      errorMessage: 'failed',
      stackTrace: '',
      category: 'assertion' as const,
    }));
    const results = makeResults({ failed: 5, failures });
    expect(classifyFailures(results)).toBe('architectural');
  });

  it('classifies 10+ failures as architectural regardless of file count', () => {
    const failures = Array.from({ length: 10 }, (_, i) => ({
      testName: `test-${i}`,
      file: 'same-file.ts',
      line: i + 1,
      expected: '',
      actual: '',
      errorMessage: 'failed',
      stackTrace: '',
      category: 'assertion' as const,
    }));
    const results = makeResults({ failed: 10, failures });
    expect(classifyFailures(results)).toBe('architectural');
  });

  it('returns code-error when failures array is empty', () => {
    const results = makeResults({ failures: [] });
    expect(classifyFailures(results)).toBe('code-error');
  });
});

// ── buildDebuggerContext ──────────────────────────────────────────────────────

describe('buildDebuggerContext', () => {
  const BASE_RESULTS: TestResults = {
    framework: 'jest',
    total: 5,
    passed: 3,
    failed: 2,
    skipped: 0,
    duration_ms: 1000,
    failures: [
      {
        testName: 'Math adds correctly',
        file: '/project/src/__tests__/math.test.ts',
        line: 12,
        expected: '4',
        actual: '5',
        errorMessage: 'Expected 4 but received 5',
        stackTrace: '    at Object.<anonymous> (/project/src/__tests__/math.test.ts:12:5)',
        category: 'assertion',
      },
    ],
  };

  it('includes framework, counts, and failure details', () => {
    const ctx = buildDebuggerContext(BASE_RESULTS);
    expect(ctx).toContain('jest');
    expect(ctx).toContain('2/5 failed');
    expect(ctx).toContain('Math adds correctly');
    expect(ctx).toContain('/project/src/__tests__/math.test.ts:12');
    expect(ctx).toContain('assertion');
    expect(ctx).toContain('Expected 4 but received 5');
    expect(ctx).toContain('Expected: 4');
    expect(ctx).toContain('Actual:   5');
  });

  it('includes stack trace (truncated to 1000 chars)', () => {
    const ctx = buildDebuggerContext(BASE_RESULTS);
    expect(ctx).toContain('at Object.<anonymous>');
  });

  it('injects previous attempt diff on retry', () => {
    const diff = '--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1 @@\n-return a - b;\n+return a + b;';
    const ctx = buildDebuggerContext(BASE_RESULTS, diff);
    expect(ctx).toContain('Previous Fix Attempt');
    expect(ctx).toContain('do NOT repeat');
    expect(ctx).toContain('return a - b');
  });

  it('omits previous diff section when not provided', () => {
    const ctx = buildDebuggerContext(BASE_RESULTS);
    expect(ctx).not.toContain('Previous Fix Attempt');
  });

  it('omits expected/actual lines when they are empty', () => {
    const results: TestResults = {
      ...BASE_RESULTS,
      failures: [
        { ...BASE_RESULTS.failures[0], expected: '', actual: '' },
      ],
    };
    const ctx = buildDebuggerContext(results);
    expect(ctx).not.toContain('Expected:');
    expect(ctx).not.toContain('Actual:');
  });
});
