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
import { readConfig } from '../../config/loader.js';
import type { AnthropicClient } from '../../anthropic/client.js';
import type { Requirement, RequirementVerdict } from './coding-types.js';

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
  /**
   * The requirements list this review was checked against (echoed from
   * `ReviewOptions.requirements`). Null when no requirements were supplied
   * (e.g. legacy callers).
   */
  requirements?: Requirement[];
  /**
   * Per-requirement verdicts produced by the goal-verification step. Each
   * entry corresponds to one requirement in `requirements`. Null when no
   * requirements were supplied or no Anthropic client was available.
   */
  goalVerdicts?: RequirementVerdict[];
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
  /** Per-command timeout in milliseconds. Default: 300_000 (5 min). */
  timeoutMs?: number;
  /**
   * Concrete goals (extracted by the architect from the user's task) that the
   * implementation is supposed to achieve. When provided alongside `anthropic`,
   * the reviewer runs an LLM-driven semantic check that produces a
   * `RequirementVerdict` for each entry and forces a `retask` decision when
   * any required goal is `unmet` — even if build/tests pass mechanically.
   */
  requirements?: Requirement[];
  /**
   * Anthropic client used for the goal-verification LLM call. When omitted,
   * the reviewer falls back to a heuristic verdict (`unknown` for every
   * requirement) so the review still completes — but the decision logic
   * will treat `unknown` as non-blocking, since we can't responsibly fail
   * the run on a check we never actually performed.
   */
  anthropic?: AnthropicClient;
  /** Model identifier for the goal-verification LLM call. */
  model?: string;
  /** Original user task — provides context for the goal-verification prompt. */
  taskDescription?: string;
  /** Implementation agent output (may include diffs/summaries). */
  implementationOutput?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// 5-minute default — 2-minute timeout was insufficient for monorepo build/test
// commands and produced false-negative review results.
const DEFAULT_TIMEOUT_MS = 300_000;
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
 *
 * `goalVerdicts` is consulted in addition to the mechanical signals: any
 * verdict with status `unmet` is treated as a blocker, even when build and
 * tests pass. `partially-met` is downgraded to a warning. `unknown` is
 * intentionally ignored — see `verifyRequirements` for rationale.
 *
 * @internal
 */
function makeDecision(
  buildResult: CommandCheckResult | null,
  testResults: CommandCheckResult[],
  quality: CodeQualityMetrics,
  goalVerdicts: RequirementVerdict[] = [],
  goalVerificationFailureReason?: string,
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

  // Goal-verification: unmet requirements are blockers, partial are warnings.
  // A `goalVerificationFailureReason` signals that the verifier itself crashed
  // (vs cleanly returning `unknown` because no client was supplied) — we
  // refuse to approve in that case, since the user explicitly asked for goal
  // verification and we cannot honor that contract by silently skipping it.
  const unmet = goalVerdicts.filter((v) => v.status === 'unmet');
  const partial = goalVerdicts.filter((v) => v.status === 'partially-met');
  if (unmet.length > 0) {
    blockers.push(
      `Unmet requirement(s): ` +
      unmet.map((v) => `[${v.requirementId}] ${v.description} — ${v.evidence.slice(0, 200)}`).join('; '),
    );
  }
  if (partial.length > 0) {
    warnings.push(
      `Partially-met requirement(s): ` +
      partial.map((v) => `[${v.requirementId}] ${v.description}`).join('; '),
    );
  }
  if (goalVerificationFailureReason) {
    blockers.push(`Goal verification did not run: ${goalVerificationFailureReason.slice(0, 300)}`);
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

// ── Goal verification ────────────────────────────────────────────────────────

/**
 * Maximum size (chars) of any single context block injected into the
 * goal-verification prompt. Prevents an unbounded build log from blowing
 * past the model's context window.
 */
const GOAL_CHECK_CONTEXT_BUDGET_PER_BLOCK = 4_000;

/**
 * Build an `unknown` verdict for every requirement. Used when no Anthropic
 * client is available, when the LLM call fails, or when the requirements
 * list is empty. `unknown` is intentionally non-blocking: the reviewer
 * cannot responsibly fail the run on a check it never performed.
 */
function unknownVerdicts(requirements: Requirement[], reason: string): RequirementVerdict[] {
  return requirements.map((r) => ({
    requirementId: r.id,
    description: r.description,
    status: 'unknown',
    evidence: reason,
    confidence: 0,
  }));
}

/**
 * Result of a goal-verification pass.
 *
 * `executionStatus` distinguishes:
 *  - `ok`: the LLM ran and returned verdicts (which may still be `unknown`
 *    for individual requirements the model couldn't grade).
 *  - `no-client`: the caller did not supply an Anthropic client. Verdicts
 *    are all `unknown` — non-blocking by design (degraded mode).
 *  - `no-requirements`: nothing to verify; trivially ok.
 *  - `failed`: a client was supplied but the call or parse failed. Verdicts
 *    are all `unknown`, and the reviewer should treat this as a blocker
 *    rather than silently approving.
 */
export interface GoalVerificationResult {
  verdicts: RequirementVerdict[];
  executionStatus: 'ok' | 'no-client' | 'no-requirements' | 'failed';
  failureReason?: string;
}

/**
 * Run an LLM-driven semantic check that grades each requirement against the
 * implementation evidence (changed files, build log, test output, agent
 * output). Returns one verdict per requirement.
 *
 * Never throws — callers always get a verdict array even on failure
 * (they will all be `unknown` with a reason in `evidence`).
 *
 * @internal exported for advanced callers; most consumers should rely on
 * `generateReviewReport` to invoke this automatically.
 */
export async function verifyRequirements(
  requirements: Requirement[],
  evidence: {
    taskDescription?: string;
    changedFiles: string[];
    buildResult: CommandCheckResult | null;
    testResults: CommandCheckResult[];
    implementationOutput?: string;
  },
  client: AnthropicClient | undefined,
  model: string | undefined,
): Promise<GoalVerificationResult> {
  if (requirements.length === 0) {
    return { verdicts: [], executionStatus: 'no-requirements' };
  }
  if (!client || !model) {
    return {
      verdicts: unknownVerdicts(requirements, 'No LLM client available for goal verification'),
      executionStatus: 'no-client',
    };
  }

  // Build a compact, bounded evidence payload for the model.
  const truncBlock = (s: string | undefined): string => {
    if (!s) return '';
    return s.length > GOAL_CHECK_CONTEXT_BUDGET_PER_BLOCK
      ? s.slice(0, GOAL_CHECK_CONTEXT_BUDGET_PER_BLOCK) + `\n... [truncated, ${s.length} chars total]`
      : s;
  };

  const buildBlock = evidence.buildResult
    ? `Build command: ${evidence.buildResult.command}\n` +
      `Status: ${evidence.buildResult.passed ? 'PASS' : 'FAIL'} (exit ${evidence.buildResult.exitCode})\n` +
      `stdout:\n${truncBlock(evidence.buildResult.stdout)}\n` +
      `stderr:\n${truncBlock(evidence.buildResult.stderr)}`
    : '(no build command was run)';

  const testBlock = evidence.testResults.length === 0
    ? '(no test command was run)'
    : evidence.testResults.map((t) => (
        `Test command: ${t.command}\n` +
        `Status: ${t.passed ? 'PASS' : 'FAIL'} (exit ${t.exitCode})\n` +
        `stdout:\n${truncBlock(t.stdout)}\n` +
        `stderr:\n${truncBlock(t.stderr)}`
      )).join('\n---\n');

  const filesBlock = evidence.changedFiles.length === 0
    ? '(no files reported as changed)'
    : evidence.changedFiles.slice(0, 200).map((f) => `- ${f}`).join('\n') +
      (evidence.changedFiles.length > 200 ? `\n... (+${evidence.changedFiles.length - 200} more)` : '');

  const reqsBlock = requirements
    .map((r, i) => `${i + 1}. id=${r.id}\n   description: ${r.description}\n   acceptance: ${r.acceptance}`)
    .join('\n');

  const taskBlock = evidence.taskDescription
    ? truncBlock(evidence.taskDescription)
    : '(task description not provided)';

  const implBlock = evidence.implementationOutput
    ? truncBlock(evidence.implementationOutput)
    : '(no implementation output captured)';

  const system =
    'You are the architect-reviewer for a coding agent. Your job is to grade ' +
    'whether each numbered requirement was actually achieved by the implementation. ' +
    'Be strict: passing build/tests is NOT sufficient evidence on its own. You must ' +
    'see concrete signals in the changed files, the build/test output, or the ' +
    "implementation report that demonstrate the requirement's acceptance criteria " +
    'were satisfied. Respond with JSON only — no prose, no code fences.';

  const user =
    `# Original user task\n${taskBlock}\n\n` +
    `# Requirements to grade\n${reqsBlock}\n\n` +
    `# Changed files\n${filesBlock}\n\n` +
    `# Build output\n${buildBlock}\n\n` +
    `# Test output\n${testBlock}\n\n` +
    `# Implementation agent output\n${implBlock}\n\n` +
    '# Output schema\n' +
    'Return a JSON object: { "verdicts": [ { "requirementId": "...", "status": "met"|"partially-met"|"unmet"|"unknown", "evidence": "...", "confidence": 0.0-1.0 } ] }\n' +
    'Include exactly one verdict per requirement, using the same id values.';

  try {
    const response = await client.createMessage({
      model,
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 4096,
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
      .trim();

    // Extract JSON — be tolerant of stray fences or leading commentary.
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn('Goal verification: no JSON in model response', { textPreview: text.slice(0, 300) });
      const reason = 'Goal-verification model returned no parseable JSON';
      return {
        verdicts: unknownVerdicts(requirements, reason),
        executionStatus: 'failed',
        failureReason: reason,
      };
    }

    let parsed: { verdicts?: Array<Partial<RequirementVerdict>> };
    try {
      parsed = JSON.parse(jsonMatch[0]) as { verdicts?: Array<Partial<RequirementVerdict>> };
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      log.warn('Goal verification: JSON parse failed', { error: msg });
      const reason = `Goal-verification JSON parse failed: ${msg}`;
      return {
        verdicts: unknownVerdicts(requirements, reason),
        executionStatus: 'failed',
        failureReason: reason,
      };
    }

    // Schema validation: a response that parses but doesn't carry a
    // recognisable `verdicts` array is just as much a verifier failure as
    // a thrown exception. Treat it as `failed` so the reviewer blocks
    // instead of silently approving with all-unknown verdicts.
    if (!Array.isArray(parsed.verdicts)) {
      log.warn('Goal verification: response missing verdicts array');
      const reason = 'Goal-verification response missing required `verdicts` array';
      return {
        verdicts: unknownVerdicts(requirements, reason),
        executionStatus: 'failed',
        failureReason: reason,
      };
    }
    const rawVerdicts = parsed.verdicts;

    // Build a verdict for every requirement, falling back to `unknown` for
    // any the model omitted or returned malformed.
    const byId = new Map<string, Partial<RequirementVerdict>>();
    for (const v of rawVerdicts) {
      if (v && typeof v.requirementId === 'string') {
        byId.set(v.requirementId, v);
      }
    }

    const verdicts: RequirementVerdict[] = requirements.map((r) => {
      const v = byId.get(r.id);
      const status = v?.status;
      const validStatus: RequirementVerdict['status'] =
        status === 'met' || status === 'partially-met' || status === 'unmet' || status === 'unknown'
          ? status
          : 'unknown';
      const confidenceRaw = typeof v?.confidence === 'number' ? v.confidence : 0;
      const confidence = Math.max(0, Math.min(1, confidenceRaw));
      return {
        requirementId: r.id,
        description: r.description,
        status: validStatus,
        evidence: typeof v?.evidence === 'string' && v.evidence.length > 0
          ? v.evidence
          : 'Model did not provide evidence for this requirement',
        confidence,
      };
    });
    return { verdicts, executionStatus: 'ok' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Goal verification LLM call failed', { error: msg });
    const reason = `Goal-verification LLM call failed: ${msg}`;
    return {
      verdicts: unknownVerdicts(requirements, reason),
      executionStatus: 'failed',
      failureReason: reason,
    };
  }
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
  // When no explicit timeoutMs is supplied, fall back to
  // `orchestration.validationTimeout` from the user's config so standalone
  // callers (CLI, tests) inherit the same budget as the orchestrator.
  // readConfig() is sync + cached; on read failure we silently use the
  // module default rather than blocking the review.
  let timeoutMs = opts.timeoutMs;
  if (timeoutMs === undefined) {
    try {
      const cfg = readConfig();
      const cfgTimeoutSec = cfg?.orchestration?.validationTimeout;
      if (typeof cfgTimeoutSec === 'number' && cfgTimeoutSec > 0) {
        timeoutMs = cfgTimeoutSec * 1000;
      }
    } catch {
      // Config unreadable in this context (e.g. test harness) — fall through.
    }
    timeoutMs ??= DEFAULT_TIMEOUT_MS;
  }

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

  // Goal verification: the helper never throws; instead it returns an
  // `executionStatus` so we can distinguish a clean run with `unknown`
  // verdicts (no client available — degraded but acceptable) from a true
  // execution failure (client present but call/parse failed). The latter
  // is a blocker because we cannot responsibly approve work whose goal
  // verification crashed.
  const requirements = opts.requirements ?? [];
  const goalResult = await verifyRequirements(
    requirements,
    {
      taskDescription: opts.taskDescription,
      changedFiles,
      buildResult,
      testResults,
      implementationOutput: opts.implementationOutput,
    },
    opts.anthropic,
    opts.model,
  );
  const goalVerdicts: RequirementVerdict[] = goalResult.verdicts;
  const goalVerificationFailed = goalResult.executionStatus === 'failed';

  const decision = makeDecision(
    buildResult,
    testResults,
    qualityMetrics,
    goalVerdicts,
    goalVerificationFailed
      ? `Goal verification execution failed: ${goalResult.failureReason ?? 'unknown error'}`
      : undefined,
  );

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

  // Surface unmet/partial requirements as proper review issues so downstream
  // UIs and persistence layers see them in the same shape as build/test
  // failures.
  for (const v of goalVerdicts) {
    if (v.status === 'unmet') {
      blockers.push({
        category: 'other',
        description: `Unmet requirement [${v.requirementId}] ${v.description}: ${v.evidence.slice(0, 300)}`,
        severity: 'error',
      });
    } else if (v.status === 'partially-met') {
      suggestions.push({
        category: 'other',
        description: `Partially-met requirement [${v.requirementId}] ${v.description}: ${v.evidence.slice(0, 300)}`,
        severity: 'warning',
      });
    }
  }

  // If the verifier crashed (vs no-client), surface that as a top-level
  // blocker so downstream UIs see it the same way they see build failures.
  if (goalVerificationFailed) {
    blockers.push({
      category: 'other',
      description: `Goal verification did not run: ${(goalResult.failureReason ?? 'unknown error').slice(0, 300)}`,
      severity: 'error',
    });
  }

  const buildPassed = buildResult === null || buildResult.passed;
  const testsPassed = testResults.every((r) => r.passed);

  const summaryParts: string[] = [];
  summaryParts.push(`Build: ${buildPassed ? '✓ passed' : '✗ failed'}.`);
  summaryParts.push(`Tests: ${testsPassed ? `✓ ${testResults.length} suite(s) passed` : '✗ failures'}.`);
  summaryParts.push(`Complexity: ${qualityMetrics.complexityTier}.`);
  if (requirements.length > 0) {
    const met = goalVerdicts.filter((v) => v.status === 'met').length;
    const partial = goalVerdicts.filter((v) => v.status === 'partially-met').length;
    const unmet = goalVerdicts.filter((v) => v.status === 'unmet').length;
    const unknown = goalVerdicts.filter((v) => v.status === 'unknown').length;
    summaryParts.push(`Goals: ${met}/${requirements.length} met, ${partial} partial, ${unmet} unmet, ${unknown} unknown.`);
  }
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
    requirements: requirements.length > 0 ? requirements : undefined,
    goalVerdicts: goalVerdicts.length > 0 ? goalVerdicts : undefined,
  };

  log.info('Architect review complete', {
    reviewId,
    outcome: decision.outcome,
    confidence: decision.confidence,
    blockers: blockers.length,
    suggestions: suggestions.length,
    requirementsChecked: requirements.length,
    goalsMet: goalVerdicts.filter((v) => v.status === 'met').length,
    goalsUnmet: goalVerdicts.filter((v) => v.status === 'unmet').length,
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
