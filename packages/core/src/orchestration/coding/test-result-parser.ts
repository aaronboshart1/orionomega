/**
 * @module orchestration/coding/test-result-parser
 * Structured test result parsing for 5 frameworks — spec §4.6.
 *
 * Parsers:
 *   parseJestJson()      – Jest --json flag → JSON stdout
 *   parsePytestJunit()   – pytest --junitxml=results.xml → XML content
 *   parseGoTestJson()    – go test -json → newline-delimited JSON
 *   parseCargoTestJson() – cargo test --format json → newline-delimited JSON
 *   parseMochaJson()     – Mocha --reporter json → JSON stdout
 *
 * Detection:
 *   detectTestFramework() – Infers framework + output flags from ProjectProfile
 *
 * Classification:
 *   classifyFailures()    – Maps a TestResults set to a recovery strategy
 *   buildDebuggerContext() – Formats structured failures for the debugger agent
 *                            (with previous-attempt diff injection for retry #2+)
 */

// ── Types (spec §4.6) ─────────────────────────────────────────────────────────

export type TestFramework = 'jest' | 'pytest' | 'go-test' | 'cargo-test' | 'mocha';

/**
 * Category of a single test failure.
 * - assertion: Expected/actual value mismatch (AssertionError, assert_eq!, etc.)
 * - runtime:   Unhandled exception during test execution
 * - timeout:   Test exceeded its time limit
 * - setup:     Failure during beforeAll/beforeEach/module import phase
 */
export type FailureCategory = 'assertion' | 'runtime' | 'timeout' | 'setup';

/**
 * Higher-level failure classification for the self-healing loop (spec §4.6).
 * - auto-fixable:   Lint/format error; run auto-fixer, no LLM agent needed
 * - code-error:     Type/compile/assertion failure; debug agent required
 * - test-error:     Test infrastructure failure; debug agent (test-focused)
 * - architectural:  Cascading failures; escalate to architect for replanning
 */
export type FailureClassification = 'auto-fixable' | 'code-error' | 'test-error' | 'architectural';

/** A single test failure with structured fields — spec §4.6. */
export interface TestFailure {
  testName: string;
  file: string;
  line: number;
  expected: string;
  actual: string;
  errorMessage: string;
  stackTrace: string;
  category: FailureCategory;
}

/** Structured result of a full test run — spec §4.6. */
export interface TestResults {
  framework: TestFramework;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: TestFailure[];
  duration_ms: number;
}

/** Configuration returned by detectTestFramework(). */
export interface TestFrameworkConfig {
  framework: TestFramework;
  /** Command-line flags that produce structured output. */
  flags: string[];
  /** How structured output is delivered. */
  outputType: 'stdout-json' | 'file-xml' | 'stdout-jsonlines';
  /** When outputType is 'file-xml', the file path written by the test runner. */
  outputFileArg?: string;
}

/**
 * Minimal project profile for framework detection.
 * Structurally compatible with CodebaseScanOutput.
 */
export interface ProjectProfile {
  testFramework: string | null;
  dependencies?: Record<string, string>;
}

// ── Jest JSON Parser ──────────────────────────────────────────────────────────

/** Internal shape of Jest's --json output. */
interface JestJsonOutput {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  testResults?: Array<{
    testFilePath?: string;
    testResults?: Array<{
      ancestorTitles?: string[];
      title?: string;
      fullName?: string;
      status?: string;
      duration?: number | null;
      failureMessages?: string[];
    }>;
  }>;
}

/**
 * Parse Jest --json output into TestResults.
 *
 * @param rawJson - The full stdout from `jest --json`.
 * @throws If rawJson is not valid JSON or does not have an object root.
 */
export function parseJestJson(rawJson: string): TestResults {
  let data: JestJsonOutput;
  try {
    data = JSON.parse(rawJson) as JestJsonOutput;
  } catch (e) {
    throw new Error(`parseJestJson: invalid JSON – ${(e as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('parseJestJson: expected a JSON object at root');
  }

  const failures: TestFailure[] = [];
  let durationMs = 0;
  let countedTotal = 0;
  let countedPassed = 0;
  let countedFailed = 0;
  let countedSkipped = 0;

  for (const fileSuite of data.testResults ?? []) {
    const filePath = fileSuite.testFilePath ?? '';
    for (const tc of fileSuite.testResults ?? []) {
      countedTotal++;
      if (typeof tc.duration === 'number') durationMs += tc.duration;

      const status = tc.status ?? '';
      if (status === 'passed') {
        countedPassed++;
      } else if (status === 'failed') {
        countedFailed++;
        const rawMsg = tc.failureMessages?.[0] ?? '';
        const { errorMessage, stackTrace, expected, actual, line } = parseJestFailureMessage(
          rawMsg,
          filePath,
        );
        failures.push({
          testName:
            tc.fullName ??
            [...(tc.ancestorTitles ?? []), tc.title ?? ''].filter(Boolean).join(' > '),
          file: filePath,
          line,
          expected,
          actual,
          errorMessage,
          stackTrace,
          category: categorizeFailure(errorMessage, stackTrace),
        });
      } else {
        // pending / skipped / todo
        countedSkipped++;
      }
    }
  }

  return {
    framework: 'jest',
    total: data.numTotalTests ?? countedTotal,
    passed: data.numPassedTests ?? countedPassed,
    failed: data.numFailedTests ?? countedFailed,
    skipped: data.numPendingTests ?? countedSkipped,
    failures,
    duration_ms: durationMs,
  };
}

function parseJestFailureMessage(
  msg: string,
  file: string,
): { errorMessage: string; stackTrace: string; expected: string; actual: string; line: number } {
  const lines = msg.split('\n');

  // Extract expected / actual from Jest's standard diff lines
  let expected = '';
  let actual = '';
  for (const l of lines) {
    const expMatch = /^\s*Expected(?:\s+value)?[: ]+(.+)$/.exec(l);
    if (expMatch && !expected) expected = expMatch[1].trim();
    const recMatch = /^\s*Received(?:\s+value)?[: ]+(.+)$/.exec(l);
    if (recMatch && !actual) actual = recMatch[1].trim();
  }

  // Split error message from stack trace at the first "    at " line
  const stackStartIdx = lines.findIndex((l) => /^\s{4}at\s/.test(l));
  const errorMessage =
    stackStartIdx > 0
      ? lines.slice(0, stackStartIdx).join('\n').trim()
      : (lines[0]?.trim() ?? msg.trim());
  const stackTrace = stackStartIdx > 0 ? lines.slice(stackStartIdx).join('\n') : '';

  // Extract line number from the first stack frame that matches this file
  let line = 0;
  const fileBase = escapeRegex(file.replace(/.*[\\/]/, ''));
  if (fileBase) {
    for (const stackLine of stackTrace.split('\n')) {
      const m = new RegExp(`${fileBase}:(\\d+):`).exec(stackLine);
      if (m) {
        line = parseInt(m[1], 10);
        break;
      }
    }
  }

  return { errorMessage, stackTrace, expected, actual, line };
}

// ── pytest JUnit XML Parser ───────────────────────────────────────────────────

/**
 * Parse pytest --junitxml output into TestResults.
 *
 * Supports both `<testsuites>/<testsuite>` and bare `<testsuite>` root elements.
 * Uses a lightweight regex-based parser — no external XML library required.
 *
 * @param xmlContent - The full content of the JUnit XML file.
 * @throws If xmlContent is empty or contains no `<testsuite>` element.
 */
export function parsePytestJunit(xmlContent: string): TestResults {
  if (!xmlContent.trim()) {
    throw new Error('parsePytestJunit: empty XML content');
  }

  // Find the first <testsuite> tag (handles both root and nested).
  // Use \b to avoid matching <testsuites> (the plural wrapper element).
  const suiteMatch = /<testsuite\b([^>]*)>/i.exec(xmlContent);
  if (!suiteMatch) {
    throw new Error('parsePytestJunit: no <testsuite> element found');
  }

  const suiteAttrs = suiteMatch[1];
  const xmlTotal = parseInt(extractAttr(suiteAttrs, 'tests') ?? '0', 10);
  const xmlFailures = parseInt(extractAttr(suiteAttrs, 'failures') ?? '0', 10);
  const xmlErrors = parseInt(extractAttr(suiteAttrs, 'errors') ?? '0', 10);
  const xmlSkipped = parseInt(extractAttr(suiteAttrs, 'skipped') ?? '0', 10);
  const xmlFailed = xmlFailures + xmlErrors;
  const xmlPassed = xmlTotal - xmlFailed - xmlSkipped;
  const durationMs = Math.round(parseFloat(extractAttr(suiteAttrs, 'time') ?? '0') * 1000);

  const failures: TestFailure[] = [];

  // Normalize self-closing <testcase ... /> to <testcase ...></testcase> so the
  // body regex always sees balanced open/close pairs.
  const normalized = xmlContent.replace(/<testcase([^>]*)\/>/gi, '<testcase$1></testcase>');

  // Parse each <testcase> element.
  const testcaseRe = /<testcase([^>]*)>([\s\S]*?)<\/testcase>/gi;
  let tcMatch: RegExpExecArray | null;
  while ((tcMatch = testcaseRe.exec(normalized)) !== null) {
    const tcAttrs = tcMatch[1];
    const tcBody = tcMatch[2];

    // Only process testcases with <failure> or <error> children
    const faultMatch = /<(?:failure|error)([^>]*)>([\s\S]*?)<\/(?:failure|error)>/i.exec(tcBody);
    if (!faultMatch) continue;

    const classname = extractAttr(tcAttrs, 'classname') ?? '';
    const name = extractAttr(tcAttrs, 'name') ?? '';
    // Derive file path: use `file` attr if present, otherwise convert classname
    const fileAttr =
      extractAttr(tcAttrs, 'file') ??
      (classname ? classname.replace(/\./g, '/') + '.py' : '');
    const lineAttr = parseInt(extractAttr(tcAttrs, 'line') ?? '0', 10);

    const faultAttrs = faultMatch[1];
    const faultBody = stripCdata(faultMatch[2].trim());
    const message = unescapeXml(extractAttr(faultAttrs, 'message') ?? faultBody.split('\n')[0] ?? '');
    const stackTrace = unescapeXml(faultBody);

    failures.push({
      testName: classname ? `${classname}::${name}` : name,
      file: fileAttr,
      line: lineAttr,
      expected: '',
      actual: '',
      errorMessage: message,
      stackTrace,
      category: categorizeFailure(message, stackTrace),
    });
  }

  return {
    framework: 'pytest',
    total: xmlTotal,
    passed: xmlPassed,
    failed: xmlFailed,
    skipped: xmlSkipped,
    failures,
    duration_ms: durationMs,
  };
}

// ── Go Test JSON Parser ───────────────────────────────────────────────────────

/** Internal shape of a single `go test -json` line. */
interface GoTestEvent {
  Action: 'run' | 'pass' | 'fail' | 'skip' | 'output' | 'pause' | 'cont' | 'start';
  Package?: string;
  Test?: string;
  Output?: string;
  Elapsed?: number;
}

/**
 * Parse `go test -json` newline-delimited JSON into TestResults.
 *
 * @param jsonLines - The full stdout from `go test -json`.
 */
export function parseGoTestJson(jsonLines: string): TestResults {
  const lines = jsonLines.split('\n').filter((l) => l.trim());
  const failures: TestFailure[] = [];
  // Buffer output lines per test key until result is known
  const outputBuffers = new Map<string, string[]>();
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let durationMs = 0;

  for (const raw of lines) {
    let event: GoTestEvent;
    try {
      event = JSON.parse(raw) as GoTestEvent;
    } catch {
      // Skip build output / non-JSON lines
      continue;
    }

    if (!event.Test) {
      // Package-level event — accumulate elapsed time
      if ((event.Action === 'pass' || event.Action === 'fail') && event.Elapsed !== undefined) {
        durationMs += Math.round(event.Elapsed * 1000);
      }
      continue;
    }

    const key = `${event.Package ?? ''}::${event.Test}`;

    switch (event.Action) {
      case 'run':
        outputBuffers.set(key, []);
        break;
      case 'output':
        outputBuffers.get(key)?.push(event.Output ?? '');
        break;
      case 'pass':
        passed++;
        outputBuffers.delete(key);
        break;
      case 'fail': {
        failed++;
        const output = (outputBuffers.get(key) ?? []).join('');
        outputBuffers.delete(key);
        const { file, line, errorMessage, stackTrace } = parseGoFailureOutput(output);
        failures.push({
          testName: event.Test,
          file,
          line,
          expected: '',
          actual: '',
          errorMessage,
          stackTrace,
          category: categorizeFailure(errorMessage, stackTrace),
        });
        break;
      }
      case 'skip':
        skipped++;
        outputBuffers.delete(key);
        break;
    }
  }

  const total = passed + failed + skipped;
  return {
    framework: 'go-test',
    total,
    passed,
    failed,
    skipped,
    failures,
    duration_ms: durationMs,
  };
}

function parseGoFailureOutput(output: string): {
  file: string;
  line: number;
  errorMessage: string;
  stackTrace: string;
} {
  const lines = output.split('\n');
  let file = '';
  let line = 0;
  const msgParts: string[] = [];
  const stackParts: string[] = [];

  for (const l of lines) {
    // Go assertion output: "    file_test.go:10: message"
    const locMatch = /^\s+(\S+\.go):(\d+):\s*(.*)$/.exec(l);
    if (locMatch) {
      if (!file) {
        file = locMatch[1];
        line = parseInt(locMatch[2], 10);
      }
      if (locMatch[3].trim()) msgParts.push(locMatch[3].trim());
    } else if (/^goroutine\s+\d+|^panic:|^\s+\S+\.go:\d+/.test(l)) {
      stackParts.push(l);
    }
  }

  return {
    file,
    line,
    errorMessage: msgParts.join(' ') || (output.trim().split('\n')[0] ?? ''),
    stackTrace: stackParts.join('\n'),
  };
}

// ── Cargo Test JSON Parser ────────────────────────────────────────────────────

/** Internal shape of a single `cargo test --format json` line. */
interface CargoTestEvent {
  type: 'test' | 'suite' | 'bench';
  event: 'started' | 'ok' | 'failed' | 'ignored' | 'finished';
  name?: string;
  stdout?: string;
  message?: string;
  exec_time?: number;
  passed?: number;
  failed?: number;
  ignored?: number;
}

/**
 * Parse `cargo test --format json` output into TestResults.
 *
 * @param jsonLines - The full stdout from `cargo test --format json -- -Z unstable-options`.
 */
export function parseCargoTestJson(jsonLines: string): TestResults {
  const lines = jsonLines.split('\n').filter((l) => l.trim());
  const failures: TestFailure[] = [];
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let durationMs = 0;

  for (const raw of lines) {
    let event: CargoTestEvent;
    try {
      event = JSON.parse(raw) as CargoTestEvent;
    } catch {
      continue;
    }

    if (event.type === 'suite' && event.event === 'finished') {
      // Suite summary — use authoritative counts
      passed = event.passed ?? passed;
      failed = event.failed ?? failed;
      skipped = event.ignored ?? skipped;
      total = passed + failed + skipped;
      if (event.exec_time !== undefined) durationMs = Math.round(event.exec_time * 1000);
    } else if (event.type === 'test' && event.event === 'failed') {
      const rawOutput = event.stdout ?? event.message ?? '';
      const { file, line, errorMessage, stackTrace } = parseCargoFailureOutput(
        event.name ?? '',
        rawOutput,
      );
      failures.push({
        testName: event.name ?? '',
        file,
        line,
        expected: '',
        actual: '',
        errorMessage,
        stackTrace,
        category: categorizeFailure(errorMessage, rawOutput),
      });
    }
  }

  return {
    framework: 'cargo-test',
    total,
    passed,
    failed,
    skipped,
    failures,
    duration_ms: durationMs,
  };
}

function parseCargoFailureOutput(
  testName: string,
  output: string,
): { file: string; line: number; errorMessage: string; stackTrace: string } {
  let file = '';
  let line = 0;
  let errorMessage = '';
  let stackTrace = '';

  // Old Rust format: panicked at 'message', src/lib.rs:10:5
  const oldPanic = /panicked at '([^']+)',\s*(\S+):(\d+):\d+/.exec(output);
  if (oldPanic) {
    errorMessage = oldPanic[1];
    file = oldPanic[2];
    line = parseInt(oldPanic[3], 10);
  } else {
    // New Rust format (1.73+): panicked at src/lib.rs:10:5:\nmessage
    const newPanic = /panicked at (\S+):(\d+):\d+:\n([\s\S]*?)(?:\n\n|$)/.exec(output);
    if (newPanic) {
      file = newPanic[1];
      line = parseInt(newPanic[2], 10);
      errorMessage = newPanic[3].trim();
    } else {
      errorMessage = output.trim().split('\n')[0] ?? testName;
    }
  }

  // Extract stack backtrace if present
  const stackIdx = output.indexOf('stack backtrace:');
  if (stackIdx !== -1) stackTrace = output.slice(stackIdx);

  return { file, line, errorMessage, stackTrace };
}

// ── Mocha JSON Parser ─────────────────────────────────────────────────────────

/** Internal shape of Mocha's --reporter json output. */
interface MochaJsonOutput {
  stats?: {
    tests?: number;
    passes?: number;
    pending?: number;
    failures?: number;
    duration?: number;
  };
  failures?: Array<{
    title?: string;
    fullTitle?: string;
    file?: string;
    err?: {
      message?: string;
      stack?: string;
      actual?: unknown;
      expected?: unknown;
    };
  }>;
}

/**
 * Parse Mocha --reporter json output into TestResults.
 *
 * @param rawJson - The full stdout from `mocha --reporter json`.
 * @throws If rawJson is not valid JSON or is missing the required `stats` key.
 */
export function parseMochaJson(rawJson: string): TestResults {
  let data: MochaJsonOutput;
  try {
    data = JSON.parse(rawJson) as MochaJsonOutput;
  } catch (e) {
    throw new Error(`parseMochaJson: invalid JSON – ${(e as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || typeof data.stats !== 'object') {
    throw new Error('parseMochaJson: expected { stats: {...}, failures: [...] } at root');
  }

  const stats = data.stats ?? {};
  const failures: TestFailure[] = [];

  for (const f of data.failures ?? []) {
    const err = f.err ?? {};
    const rawStack = err.stack ?? '';
    const { file: stackFile, line } = extractFileLineFromStack(rawStack);

    failures.push({
      testName: f.fullTitle ?? f.title ?? '',
      file: f.file ?? stackFile,
      line,
      expected: err.expected !== undefined ? String(err.expected) : '',
      actual: err.actual !== undefined ? String(err.actual) : '',
      errorMessage: err.message ?? rawStack.split('\n')[0] ?? '',
      stackTrace: rawStack,
      category: categorizeFailure(err.message ?? '', rawStack),
    });
  }

  return {
    framework: 'mocha',
    total: stats.tests ?? 0,
    passed: stats.passes ?? 0,
    failed: stats.failures ?? 0,
    skipped: stats.pending ?? 0,
    failures,
    duration_ms: stats.duration ?? 0,
  };
}

// ── Framework Detection ───────────────────────────────────────────────────────

/**
 * Infer the test framework and structured-output flags from a project profile.
 *
 * Detection priority:
 *   1. Explicit `testFramework` field from the codebase scanner
 *   2. Presence in `dependencies` / `devDependencies`
 *   3. Returns null if no framework can be determined
 *
 * @param profile - Minimal project metadata (compatible with CodebaseScanOutput).
 * @returns TestFrameworkConfig or null if framework is undetectable.
 */
export function detectTestFramework(profile: ProjectProfile): TestFrameworkConfig | null {
  const tf = (profile.testFramework ?? '').toLowerCase();
  const deps = profile.dependencies ?? {};

  const has = (...names: string[]) => names.some((n) => n in deps);

  if (tf.includes('jest') || has('jest', '@jest/core', 'jest-circus')) {
    return {
      framework: 'jest',
      flags: ['--json'],
      outputType: 'stdout-json',
    };
  }
  if (tf.includes('vitest') || has('vitest')) {
    // vitest supports jest-compatible JSON via --reporter=json
    return {
      framework: 'jest',
      flags: ['--reporter=json', '--outputFile=/dev/stdout'],
      outputType: 'stdout-json',
    };
  }
  if (tf.includes('mocha') || has('mocha')) {
    return {
      framework: 'mocha',
      flags: ['--reporter', 'json'],
      outputType: 'stdout-json',
    };
  }
  if (tf.includes('pytest') || has('pytest')) {
    return {
      framework: 'pytest',
      flags: ['--junitxml=results.xml'],
      outputType: 'file-xml',
      outputFileArg: 'results.xml',
    };
  }
  // Check cargo/rust before go: 'cargo' contains the substring 'go'.
  if (tf.includes('cargo') || tf.includes('rust')) {
    return {
      framework: 'cargo-test',
      flags: ['--format', 'json', '--', '-Z', 'unstable-options'],
      outputType: 'stdout-jsonlines',
    };
  }
  if (tf === 'go' || tf.includes('go-test')) {
    return {
      framework: 'go-test',
      flags: ['-json'],
      outputType: 'stdout-jsonlines',
    };
  }

  return null;
}

// ── Failure Classification ────────────────────────────────────────────────────

/**
 * Classify a set of test results into a recovery strategy for the self-healing loop.
 *
 * Rules (in priority order):
 *   - ≥ 5 distinct failing files OR ≥ 10 total failures → architectural
 *   - Any setup-category failure → test-error
 *   - Default → code-error
 *
 * @param results - Parsed TestResults from any framework.
 * @returns The appropriate FailureClassification.
 */
export function classifyFailures(results: TestResults): FailureClassification {
  if (results.failures.length === 0) {
    // No structured failures — treat conservatively
    return 'code-error';
  }

  const distinctFiles = new Set(results.failures.map((f) => f.file)).size;
  if (distinctFiles >= 5 || results.failures.length >= 10) {
    return 'architectural';
  }

  if (results.failures.some((f) => f.category === 'setup')) {
    return 'test-error';
  }

  return 'code-error';
}

/**
 * Build a structured context string for the debugger agent.
 *
 * On retry #2+, pass `previousAttemptDiff` to inject the previous fix's
 * unified diff — this prevents the "same fix repeated" anti-pattern (spec §4.6).
 *
 * @param results           - Parsed TestResults to summarise.
 * @param previousAttemptDiff - Unified diff from the last failed fix attempt.
 * @returns Markdown string suitable for the debugger agent's task prompt.
 */
export function buildDebuggerContext(results: TestResults, previousAttemptDiff?: string): string {
  const sections: string[] = [];

  sections.push(
    `## Test Results (${results.framework}): ${results.failed}/${results.total} failed`,
  );

  for (const failure of results.failures) {
    const lines: string[] = [
      `### FAIL: ${failure.testName}`,
      `- File: ${failure.file}${failure.line ? `:${failure.line}` : ''}`,
      `- Category: ${failure.category}`,
      `- Error: ${failure.errorMessage}`,
    ];
    if (failure.expected) lines.push(`- Expected: ${failure.expected}`);
    if (failure.actual) lines.push(`- Actual:   ${failure.actual}`);
    if (failure.stackTrace) {
      lines.push(`\`\`\`\n${failure.stackTrace.slice(0, 1000)}\n\`\`\``);
    }
    sections.push(lines.join('\n'));
  }

  if (previousAttemptDiff) {
    sections.push(
      `## Previous Fix Attempt (do NOT repeat these changes)\n\`\`\`diff\n${previousAttemptDiff}\n\`\`\``,
    );
  }

  return sections.join('\n\n');
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

/**
 * Heuristically categorize a single failure from its message and stack text.
 */
function categorizeFailure(message: string, stack: string): FailureCategory {
  const text = `${message}\n${stack}`;

  if (/timeout|timed?\s*out|etimedout|test exceeded|exceeded.*time limit/i.test(text)) {
    return 'timeout';
  }
  if (
    /beforeAll|beforeEach|setup\s+fail|cannot\s+import|module\s+not\s+found|cannot\s+find\s+module|No\s+module\s+named|failed\s+to\s+setup|ImportError|ModuleNotFoundError/i.test(
      text,
    )
  ) {
    return 'setup';
  }
  if (
    /AssertionError|assert\s+fail|expect\s*\(.*\)\s*\.to|Expected.*Received|Received.*Expected|assertion\s+failed|assert_eq!|assert_ne!|assert!\s*\(/i.test(
      text,
    )
  ) {
    return 'assertion';
  }
  return 'runtime';
}

/**
 * Extract the value of an XML attribute from a tag string.
 * Handles both single-quoted and double-quoted values.
 */
function extractAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}=["']([^"']*?)["']`, 'i');
  return re.exec(tag)?.[1];
}

/** Decode the five predefined XML entity references. */
function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Strip CDATA wrappers from XML text content. */
function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/**
 * Extract file path and line number from a JS/TS stack trace.
 * Handles both `at func (file:line:col)` and `at file:line:col` forms.
 */
function extractFileLineFromStack(stack: string): { file: string; line: number } {
  // Named frame: "at Object.<anonymous> (/path/to/file.js:10:5)"
  const named = /at\s+\S+\s+\(([^)]+):(\d+):\d+\)/.exec(stack);
  if (named) return { file: named[1], line: parseInt(named[2], 10) };

  // Anonymous frame: "at /path/to/file.js:10:5"
  const bare = /at\s+(\/\S+):(\d+):\d+/.exec(stack);
  if (bare) return { file: bare[1], line: parseInt(bare[2], 10) };

  return { file: '', line: 0 };
}

/** Escape special regex metacharacters in a literal string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
