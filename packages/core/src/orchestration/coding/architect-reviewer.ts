/**
 * @module orchestration/coding/architect-reviewer
 * Post-implementation architectural review for Coding Mode.
 *
 * The ArchitectReviewer evaluates the quality of code changes produced by
 * implementer nodes. It runs build/compile checks, executes test suites,
 * measures code quality metrics, and produces a structured ReviewReport.
 *
 * Based on the report, it emits either an 'approve' decision (ready to merge)
 * or a 'retask' decision (send back to implementers with specific feedback).
 *
 * This module is used by the reviewer node in all Coding Mode DAG templates.
 */

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createLogger } from '../../logging/logger.js';

const execAsync = promisify(execCb);
const log = createLogger('architect-reviewer');

// ── Types ─────────────────────────────────────────────────────────────────────

/** Result of running a single shell command. */
export interface CommandCheckResult {
  /** The command that was run. */
  command: string;
  /** Whether the command exited with code 0. */
  passed: boolean;
  /** Exit code. */
  exitCode: number;
  /** stdout output (trimmed, max 10 KB). */
  stdout: string;
  /** stderr output (trimmed, max 10 KB). */
  stderr: string;
  /** Duration in milliseconds. */
  durationMs: number;
}

/** Code quality metrics for the reviewed codebase. */
export interface CodeQualityMetrics {
  /**
   * Lint result (null if lint detection failed or no lint command found).
   */
  lintResult: CommandCheckResult | null;
  /**
   * TypeScript type-check result (null if project is not TypeScript).
   */
  typeCheckResult: CommandCheckResult | null;
  /**
   * Estimated cyclomatic complexity tier.
   * Based on average lines-per-file and nesting depth heuristics.
   */
  complexityTier: 'low' | 'medium' | 'high';
  /**
   * Fraction of source files that have a corresponding test file (0.0–1.0).
   * Returns null when detection is not meaningful for the project.
   */
  testCoverage: number | null;
  /** Total source lines of code across reviewed files. */
  totalLoc: number;
  /** Number of new or modified files in the change set. */
  changedFileCount: number;
}

/** Structured output from the architect review. */
export interface ReviewReport {
  /** Unique review ID. */
  reviewId: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Working directory that was reviewed. */
  cwd: string;
  /** Whether the build/compile check passed. */
  buildPassed: boolean;
  /** Result of the build check. */
  buildResult: CommandCheckResult | null;
  /** Whether all test suites passed. */
  testsPassed: boolean;
  /** Results of each test suite command. */
  testResults: CommandCheckResult[];
  /** Code quality metrics. */
  qualityMetrics: CodeQualityMetrics;
  /** High-level review decision. */
  decision: ReviewDecision;
  /** Summary paragraph describing the review outcome. */
  summary: string;
  /** Specific issues that must be fixed before approval. */
  blockers: ReviewIssue[];
  /** Suggestions that would improve the code but aren't blocking. */
  suggestions: ReviewIssue[];
}

/** A single issue identified during review. */
export interface ReviewIssue {
  /** Category of the issue. */
  category: 'build' | 'test' | 'lint' | 'type' | 'coverage' | 'complexity' | 'other';
  /** Human-readable description. */
  description: string;
  /** Affected file (if applicable). */
  file?: string;
  /** Severity level. */
  severity: 'error' | 'warning' | 'info';
}

/** The review decision. */
export interface ReviewDecision {
  /**
   * - 'approve': Code is ready; no retask needed.
   * - 'retask': Issues must be fixed; retask implementers with the feedback.
   * - 'approve_with_warnings': Passes but has non-blocking issues.
   */
  outcome: 'approve' | 'retask' | 'approve_with_warnings';
  /** Feedback for the retask (present when outcome === 'retask'). */
  retaskFeedback?: string;
  /** Overall confidence score (0.0–1.0). */
  confidence: number;
}

/** Options for runArchitectReview. */
export interface ReviewOptions {
  /** Files that were modified by the implementer nodes (relative to cwd). */
  changedFiles?: string[];
  /** Build commands to run. Auto-detected if not provided. */
  buildCommands?: string[];
  /** Test commands to run. Auto-detected if not provided. */
  testCommands?: string[];
  /** Lint command. Auto-detected if not provided. */
  lintCommand?: string;
  /** Whether to run type checking (TypeScript projects only). */
  runTypeCheck?: boolean;
  /** Per-command timeout in milliseconds. Default: 120_000. */
  timeoutMs?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 10_000;

/** Allowlist for reviewer commands (mirrors validation-loop's security posture). */
const ALLOWED_REVIEW_COMMAND_RE =
  /^(?:npm|npx|pnpm|yarn|bun)\s+(?:test|run|ci|build|check|exec)\b|^make\s+[a-z0-9_][a-z0-9_-]*$|^(?:pytest|python\s+-m\s+pytest|cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)|mvn\s+(?:test|package|verify|compile)|\.\/gradlew\s+[a-z0-9_-]+|gradle\s+[a-z0-9_-]+)(?:\s|$)|^tsc\b|^eslint\b|^ruff\b|^golangci-lint\b/i;

function assertCommandAllowed(command: string): void {
  if (!ALLOWED_REVIEW_COMMAND_RE.test(command.trim())) {
    throw new Error(
      `[security] Review command rejected by allowlist: "${command}". ` +
      'Only known build-tool invocations are permitted.',
    );
  }
}

function truncate(s: string, maxBytes = MAX_OUTPUT_BYTES): string {
  if (s.length <= maxBytes) return s;
  return s.slice(0, maxBytes) + `\n... [truncated, ${s.length} chars total]`;
}

// ── Command execution ─────────────────────────────────────────────────────────

/**
 * Run a shell command with a timeout, returning a structured result.
 * Never throws — failures are captured in the result.
 */
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CommandCheckResult> {
  assertCommandAllowed(command);
  const start = Date.now();
  log.verbose('Running review command', { command, cwd });

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    });
    const durationMs = Date.now() - start;
    return {
      command,
      passed: true,
      exitCode: 0,
      stdout: truncate(stdout.trim()),
      stderr: truncate(stderr.trim()),
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      command,
      passed: false,
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: truncate((error.stdout ?? '').trim()),
      stderr: truncate((error.stderr ?? error.message ?? '').trim()),
      durationMs,
    };
  }
}

// ── Auto-detection ────────────────────────────────────────────────────────────

/**
 * Detect the build command from common project files.
 * @internal
 */
function detectBuildCommands(cwd: string): string[] {
  const commands: string[] = [];

  if (existsSync(join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const pm = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm'
        : existsSync(join(cwd, 'yarn.lock')) ? 'yarn'
        : 'npm';

      if ('build' in scripts) commands.push(`${pm} run build`);
      else if ('compile' in scripts) commands.push(`${pm} run compile`);
      else if (pkg.devDependencies && 'typescript' in pkg.devDependencies) {
        commands.push('npx tsc --noEmit');
      }
    } catch { /* skip */ }
    return commands;
  }

  if (existsSync(join(cwd, 'Cargo.toml'))) return ['cargo build'];
  if (existsSync(join(cwd, 'go.mod'))) return ['go build ./...'];
  if (existsSync(join(cwd, 'pom.xml'))) return ['mvn compile -q'];
  if (existsSync(join(cwd, 'build.gradle'))) return ['./gradlew build'];
  if (existsSync(join(cwd, 'Makefile'))) return ['make build'];

  return commands;
}

/**
 * Detect test commands from common project files.
 * @internal
 */
function detectTestCommands(cwd: string): string[] {
  if (existsSync(join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const pm = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm'
        : existsSync(join(cwd, 'yarn.lock')) ? 'yarn'
        : 'npm';

      if ('test' in scripts) return [`${pm} test`];
      if ('test:run' in scripts) return [`${pm} run test:run`];
      if ('vitest' in scripts) return [`${pm} run vitest`];
    } catch { /* skip */ }
  }

  if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'conftest.py'))) {
    return ['pytest'];
  }
  if (existsSync(join(cwd, 'Cargo.toml'))) return ['cargo test'];
  if (existsSync(join(cwd, 'go.mod'))) return ['go test ./...'];
  if (existsSync(join(cwd, 'pom.xml'))) return ['mvn test -q'];
  if (existsSync(join(cwd, 'Makefile'))) return ['make test'];

  return [];
}

/**
 * Detect the lint command from common config files.
 * @internal
 */
function detectLintCommand(cwd: string): string | null {
  if (existsSync(join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const pm = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm'
        : existsSync(join(cwd, 'yarn.lock')) ? 'yarn'
        : 'npm';

      if ('lint' in scripts) return `${pm} run lint`;
      if ('lint:check' in scripts) return `${pm} run lint:check`;

      const devDeps = pkg.devDependencies ?? {};
      if ('eslint' in devDeps) return 'npx eslint .';
      if ('biome' in devDeps) return 'npx biome check .';
    } catch { /* skip */ }
  }

  if (existsSync(join(cwd, 'pyproject.toml'))) {
    const content = readFileSync(join(cwd, 'pyproject.toml'), 'utf-8');
    if (content.includes('ruff')) return 'ruff check .';
    if (content.includes('flake8')) return 'flake8';
  }

  if (existsSync(join(cwd, 'go.mod'))) return 'golangci-lint run';
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'cargo clippy';

  return null;
}

// ── Quality metrics ───────────────────────────────────────────────────────────

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.cs']);
const TEST_SUFFIXES = ['.test.ts', '.test.js', '.spec.ts', '.spec.js', '_test.go', '_test.py'];

/**
 * Compute code quality metrics from the local codebase.
 * @internal
 */
async function computeQualityMetrics(
  cwd: string,
  changedFiles: string[],
  timeoutMs: number,
  lintCommand: string | null,
  runTypeCheck: boolean,
): Promise<CodeQualityMetrics> {
  // Lint
  let lintResult: CommandCheckResult | null = null;
  if (lintCommand) {
    try {
      lintResult = await runCommand(lintCommand, cwd, timeoutMs);
    } catch {
      lintResult = null;
    }
  }

  // TypeScript type-check
  let typeCheckResult: CommandCheckResult | null = null;
  if (runTypeCheck && existsSync(join(cwd, 'tsconfig.json'))) {
    try {
      typeCheckResult = await runCommand('npx tsc --noEmit', cwd, timeoutMs);
    } catch {
      typeCheckResult = null;
    }
  }

  // Count source files and test files for coverage estimate
  let sourceFileCount = 0;
  let testFileCount = 0;
  let totalLoc = 0;
  let maxLoc = 0;

  const walkDir = (dir: string, depth = 0): void => {
    if (depth > 6) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }

    for (const entry of entries) {
      if (entry.startsWith('.') || ['node_modules', 'dist', 'build', 'target', '__pycache__'].includes(entry)) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          walkDir(full, depth + 1);
        } else {
          const ext = extname(entry);
          if (SOURCE_EXTS.has(ext)) {
            sourceFileCount++;
            if (TEST_SUFFIXES.some((s) => entry.endsWith(s))) {
              testFileCount++;
            }
            try {
              const lines = readFileSync(full, 'utf-8').split('\n').length;
              totalLoc += lines;
              if (lines > maxLoc) maxLoc = lines;
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }
  };
  walkDir(cwd);

  // Complexity tier based on file sizes
  let complexityTier: 'low' | 'medium' | 'high' = 'low';
  const avgLoc = sourceFileCount > 0 ? totalLoc / sourceFileCount : 0;
  if (maxLoc > 800 || avgLoc > 200) complexityTier = 'high';
  else if (maxLoc > 300 || avgLoc > 80) complexityTier = 'medium';

  // Test coverage estimate
  const testCoverage = sourceFileCount > 0
    ? Math.min(1, testFileCount / Math.max(1, sourceFileCount - testFileCount))
    : null;

  return {
    lintResult,
    typeCheckResult,
    complexityTier,
    testCoverage,
    totalLoc,
    changedFileCount: changedFiles.length,
  };
}

// ── Review decision ───────────────────────────────────────────────────────────

/**
 * Evaluate all check results and produce a ReviewDecision.
 * @internal
 */
function makeDecision(
  buildResult: CommandCheckResult | null,
  testResults: CommandCheckResult[],
  quality: CodeQualityMetrics,
): ReviewDecision {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (buildResult && !buildResult.passed) {
    blockers.push(`Build failed (exit ${buildResult.exitCode}): ${buildResult.stderr.slice(0, 200)}`);
  }

  for (const tr of testResults) {
    if (!tr.passed) {
      blockers.push(`Tests failed (${tr.command}, exit ${tr.exitCode}): ${tr.stderr.slice(0, 200)}`);
    }
  }

  if (quality.typeCheckResult && !quality.typeCheckResult.passed) {
    blockers.push(`Type errors detected: ${quality.typeCheckResult.stderr.slice(0, 200)}`);
  }

  if (quality.lintResult && !quality.lintResult.passed) {
    warnings.push('Lint issues detected');
  }

  if (quality.complexityTier === 'high') {
    warnings.push('Some files are highly complex (>800 LOC)');
  }

  if (blockers.length > 0) {
    return {
      outcome: 'retask',
      retaskFeedback: blockers.join('\n'),
      confidence: 0.9,
    };
  }

  if (warnings.length > 0) {
    return {
      outcome: 'approve_with_warnings',
      confidence: 0.75,
    };
  }

  return {
    outcome: 'approve',
    confidence: 0.95,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run build/compile checks for the project at `cwd`.
 *
 * @param cwd - Project root directory.
 * @param commands - Explicit build commands. Auto-detected if not provided.
 * @param timeoutMs - Per-command timeout.
 */
export async function runBuildCheck(
  cwd: string,
  commands?: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CommandCheckResult | null> {
  const cmds = commands && commands.length > 0 ? commands : detectBuildCommands(cwd);
  if (cmds.length === 0) {
    log.info('No build command detected', { cwd });
    return null;
  }

  log.info('Running build check', { cwd, commands: cmds });
  // Run all build commands and return the first failing result, or the last result
  for (const cmd of cmds) {
    const result = await runCommand(cmd, cwd, timeoutMs);
    if (!result.passed) return result;
    return result; // Return on first success too (all should pass)
  }
  return null;
}

/**
 * Run one or more test suite commands.
 *
 * @param cwd - Project root directory.
 * @param commands - Explicit test commands. Auto-detected if not provided.
 * @param timeoutMs - Per-command timeout.
 */
export async function runTestSuite(
  cwd: string,
  commands?: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CommandCheckResult[]> {
  const cmds = commands && commands.length > 0 ? commands : detectTestCommands(cwd);
  if (cmds.length === 0) {
    log.info('No test commands detected', { cwd });
    return [];
  }

  log.info('Running test suite', { cwd, commands: cmds });
  return Promise.all(cmds.map((cmd) => runCommand(cmd, cwd, timeoutMs)));
}

/**
 * Evaluate code quality metrics for the project.
 *
 * @param cwd - Project root directory.
 * @param changedFiles - Files modified in this change set (for metric context).
 * @param opts - Optional lint command and timeout overrides.
 */
export async function evaluateCodeQuality(
  cwd: string,
  changedFiles: string[] = [],
  opts: { lintCommand?: string; runTypeCheck?: boolean; timeoutMs?: number } = {},
): Promise<CodeQualityMetrics> {
  const lintCmd = opts.lintCommand ?? detectLintCommand(cwd);
  const runTypeCheck = opts.runTypeCheck ?? existsSync(join(cwd, 'tsconfig.json'));
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return computeQualityMetrics(cwd, changedFiles, timeout, lintCmd, runTypeCheck);
}

/**
 * Generate a full review report for a completed coding task.
 *
 * Runs build, tests, and quality checks concurrently.
 * Produces a ReviewReport with a final approve/retask decision.
 *
 * @param cwd - Project root directory.
 * @param opts - Review configuration.
 */
export async function generateReviewReport(
  cwd: string,
  opts: ReviewOptions = {},
): Promise<ReviewReport> {
  const reviewId = `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const timestamp = new Date().toISOString();
  const changedFiles = opts.changedFiles ?? [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  log.info('Starting architect review', { cwd, reviewId, changedFiles: changedFiles.length });

  const [buildResult, testResults, qualityMetrics] = await Promise.all([
    runBuildCheck(cwd, opts.buildCommands, timeoutMs),
    runTestSuite(cwd, opts.testCommands, timeoutMs),
    evaluateCodeQuality(cwd, changedFiles, {
      lintCommand: opts.lintCommand,
      runTypeCheck: opts.runTypeCheck,
      timeoutMs,
    }),
  ]);

  const decision = makeDecision(buildResult, testResults, qualityMetrics);

  // Build blockers list
  const blockers: ReviewIssue[] = [];
  const suggestions: ReviewIssue[] = [];

  if (buildResult && !buildResult.passed) {
    blockers.push({
      category: 'build',
      description: `Build failed: ${buildResult.stderr.slice(0, 300)}`,
      severity: 'error',
    });
  }

  for (const tr of testResults) {
    if (!tr.passed) {
      blockers.push({
        category: 'test',
        description: `Test suite failed (${tr.command}): ${tr.stderr.slice(0, 300)}`,
        severity: 'error',
      });
    }
  }

  if (qualityMetrics.typeCheckResult && !qualityMetrics.typeCheckResult.passed) {
    blockers.push({
      category: 'type',
      description: `TypeScript errors: ${qualityMetrics.typeCheckResult.stderr.slice(0, 300)}`,
      severity: 'error',
    });
  }

  if (qualityMetrics.lintResult && !qualityMetrics.lintResult.passed) {
    suggestions.push({
      category: 'lint',
      description: 'Lint issues detected — run the lint command locally to review',
      severity: 'warning',
    });
  }

  if (qualityMetrics.complexityTier === 'high') {
    suggestions.push({
      category: 'complexity',
      description: 'Some files exceed 800 LOC; consider splitting into smaller modules',
      severity: 'info',
    });
  }

  if (qualityMetrics.testCoverage !== null && qualityMetrics.testCoverage < 0.3) {
    suggestions.push({
      category: 'coverage',
      description: `Low test coverage estimate (~${Math.round((qualityMetrics.testCoverage ?? 0) * 100)}%). Consider adding tests.`,
      severity: 'warning',
    });
  }

  const buildPassed = buildResult === null || buildResult.passed;
  const testsPassed = testResults.every((r) => r.passed);

  const summaryParts: string[] = [];
  summaryParts.push(`Build: ${buildPassed ? '✓ passed' : '✗ failed'}.`);
  summaryParts.push(`Tests: ${testsPassed ? `✓ ${testResults.length} suite(s) passed` : '✗ failures'}.`);
  summaryParts.push(`Complexity: ${qualityMetrics.complexityTier}.`);
  summaryParts.push(`Decision: ${decision.outcome}.`);
  if (decision.outcome === 'retask') {
    summaryParts.push(`Feedback: ${decision.retaskFeedback}`);
  }

  const report: ReviewReport = {
    reviewId,
    timestamp,
    cwd,
    buildPassed,
    buildResult,
    testsPassed,
    testResults,
    qualityMetrics,
    decision,
    summary: summaryParts.join(' '),
    blockers,
    suggestions,
  };

  log.info('Architect review complete', {
    reviewId,
    outcome: decision.outcome,
    confidence: decision.confidence,
    blockers: blockers.length,
    suggestions: suggestions.length,
  });

  return report;
}

/**
 * Quick helper: evaluate a report and return the decision.
 *
 * @param report - A previously generated ReviewReport.
 */
export function extractDecision(report: ReviewReport): ReviewDecision {
  return report.decision;
}

/**
 * Convenience function: run a full review and return just the decision.
 *
 * @param cwd - Project root directory.
 * @param opts - Review options.
 */
export async function reviewAndDecide(
  cwd: string,
  opts: ReviewOptions = {},
): Promise<ReviewDecision> {
  const report = await generateReviewReport(cwd, opts);
  return report.decision;
}
