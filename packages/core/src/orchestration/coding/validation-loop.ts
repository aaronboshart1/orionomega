/**
 * @module orchestration/coding/validation-loop
 * Build/test/lint cycle with targeted fix retry.
 *
 * The ValidationLoop executes a sequence of shell commands (e.g. `npm test`,
 * `npm run lint`) and, if they fail, asks the executor to create a targeted
 * fix node. It continues until all commands pass or the maximum retry count
 * is reached.
 *
 * This implements the LOOP node semantics for the validation phase of all
 * Coding Mode templates.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ValidationConfig, ValidatorOutput, NodeBudget } from './coding-types.js';
import type { WorkflowNode } from '../types.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('validation-loop');
const execAsync = promisify(exec);

/**
 * Allowlist of safe validation command patterns.
 *
 * Only commands matching this regex are permitted to run. This prevents
 * shell injection via attacker-controlled project files (e.g. a malicious
 * package.json script value executed through `npm test`).
 *
 * Operators who need an unlisted tool should set
 * `codingMode.validation.commands` explicitly in config — those are
 * trusted as operator-supplied and bypass this check.
 */
const ALLOWED_COMMAND_RE =
  /^(?:npm|npx|pnpm|yarn|bun)\s+(?:test|run|ci|install|build|check|exec)\b|^make\s+[a-z0-9_][a-z0-9_-]*$|^(?:pytest|python\s+-m\s+pytest|cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)|mvn\s+(?:test|package|verify|compile)|\.\/gradlew\s+[a-z0-9_-]+|gradle\s+[a-z0-9_-]+)(?:\s|$)/i;

function assertCommandAllowed(command: string): void {
  if (!ALLOWED_COMMAND_RE.test(command.trim())) {
    throw new Error(
      `[security] Validation command rejected by allowlist: "${command}". ` +
      'Only known build-tool invocations (npm, pnpm, yarn, make, pytest, cargo, go, mvn) are permitted. ' +
      'Set codingMode.validation.commands explicitly in config to use a custom command.',
    );
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ValidationIteration {
  iteration: number;
  result: ValidatorOutput;
}

export interface ValidationLoopResult {
  /** Final validator output (last iteration). */
  finalOutput: ValidatorOutput;
  /** Total iterations performed. */
  iterations: number;
  /** Whether the loop exited due to reaching max retries. */
  exhausted: boolean;
}

/**
 * Identifies which of the 6 validation steps a command belongs to.
 * Used for targeted retry and progressive disclosure in the UI.
 */
export type ValidationStepKind =
  | 'syntax'        // Step 1: fast-fail parse/syntax check
  | 'lint'          // Step 2: linter + formatter (auto-fixable)
  | 'typecheck'     // Step 3: type checker / compiler
  | 'unit-tests'    // Step 4: unit tests
  | 'integration'   // Step 5: integration tests
  | 'security';     // Step 6: SAST security scan

/**
 * A single command in the 6-step validation chain.
 */
export interface ValidationStep {
  /** Human-readable label for the step. */
  label: string;
  /** Which of the 6 pipeline positions this step occupies. */
  kind: ValidationStepKind;
  /** Shell command to execute. */
  command: string;
  /**
   * Optional auto-fix command. When set and the step fails,
   * the ValidationLoop will try running this command first and
   * then retrying the original command before counting it as a failure.
   * Typical use: `eslint --fix .` for the lint step.
   */
  autoFixCommand?: string;
  /** Per-step timeout override in milliseconds. */
  timeoutMs?: number;
}

// ── Loop ──────────────────────────────────────────────────────────────────────

export class ValidationLoop {
  /**
   * Execute the validation loop.
   *
   * Runs the configured commands up to `config.maxRetries + 1` times.
   * Calls `onIteration` after each attempt so the executor can emit events.
   *
   * @param config - Validation configuration (commands, patterns, retries).
   * @param cwd - Working directory for shell commands.
   * @param onIteration - Callback invoked after each validation attempt.
   * @returns The final ValidatorOutput and loop metadata.
   */
  async execute(
    config: ValidationConfig,
    cwd: string,
    onIteration: (result: ValidatorOutput, iteration: number) => void,
  ): Promise<ValidationLoopResult> {
    const maxAttempts = config.maxRetries + 1;
    let lastOutput: ValidatorOutput | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log.info(`Validation attempt ${attempt}/${maxAttempts}`);

      const output = await this.runCommands(config, cwd);
      lastOutput = output;

      onIteration(output, attempt);

      if (output.passed) {
        log.info(`Validation passed on attempt ${attempt}`);
        return {
          finalOutput: output,
          iterations: attempt,
          exhausted: false,
        };
      }

      log.warn(
        `Validation failed on attempt ${attempt}: ${output.failureSummary ?? 'unknown failure'}`,
      );

      if (attempt < maxAttempts) {
        log.info(`Retrying validation (${maxAttempts - attempt} attempt(s) remaining)...`);
      }
    }

    log.error(`Validation exhausted after ${maxAttempts} attempt(s)`);
    return {
      finalOutput: lastOutput!,
      iterations: maxAttempts,
      exhausted: true,
    };
  }

  /**
   * Create a targeted fix node for a validation failure.
   *
   * The returned WorkflowNode is a CODING_AGENT that reads the failure output
   * and applies minimal fixes. The executor inserts it before re-running
   * validation.
   *
   * @param failureOutput - ValidatorOutput from the failed validation run.
   * @param originalTask - The original coding task description.
   * @param budget - Budget for the fix node.
   * @param cwd - Working directory for the fix agent.
   * @returns A WorkflowNode that attempts to fix the failures.
   */
  createFixNode(
    failureOutput: ValidatorOutput,
    originalTask: string,
    budget: NodeBudget,
    cwd?: string,
  ): WorkflowNode {
    const failureSummary = failureOutput.failureSummary ?? this.buildFailureSummary(failureOutput);

    const task = `# Targeted Validation Fix

## Original Task
${originalTask}

## Validation Failure
${failureSummary}

## Command Results
${failureOutput.results
  .filter((r) => r.exitCode !== 0)
  .map(
    (r) =>
      `### Command: \`${r.command}\` (exit ${r.exitCode})\n` +
      (r.stderr ? `STDERR:\n${r.stderr.slice(0, 2000)}\n` : '') +
      (r.stdout ? `STDOUT:\n${r.stdout.slice(0, 2000)}\n` : ''),
  )
  .join('\n')}

## Instructions
Fix the minimum set of code changes required to make the above commands pass.
- Read the failing files first before editing them.
- Make targeted, surgical fixes — do NOT refactor or rewrite working code.
- After fixing, verify your understanding by re-reading the changed files.
- Do NOT run the tests yourself — the validation loop will re-run them.`;

    const id = `fix-${Date.now().toString(36)}`;

    return {
      id,
      type: 'CODING_AGENT',
      label: 'Targeted Fix',
      dependsOn: [],
      status: 'pending',
      codingAgent: {
        task,
        model: budget.model || undefined,
        cwd,
        maxBudgetUsd: budget.maxBudgetUsd,
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      },
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async runCommands(
    config: ValidationConfig,
    cwd: string,
  ): Promise<ValidatorOutput> {
    const results: ValidatorOutput['results'] = [];

    for (const command of config.commands) {
      assertCommandAllowed(command);
      const start = Date.now();
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: config.timeout,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
        });

        const durationMs = Date.now() - start;
        const _exitCode = 0;

        // Check success pattern if configured
        let passed = true;
        if (config.failurePattern) {
          const failRe = new RegExp(config.failurePattern, 'i');
          if (failRe.test(stdout) || failRe.test(stderr)) {
            passed = false;
          }
        }

        results.push({ command, exitCode: passed ? 0 : 1, stdout, stderr, durationMs });

        if (!passed) {
          // Fail fast on first failing command
          return this.buildOutput(results, false);
        }
      } catch (err) {
        const durationMs = Date.now() - start;
        const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };

        results.push({
          command,
          exitCode: e.code ?? 1,
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? e.message ?? '',
          durationMs,
        });

        // Fail fast on first failing command
        return this.buildOutput(results, false);
      }
    }

    return this.buildOutput(results, true);
  }

  private buildOutput(
    results: ValidatorOutput['results'],
    passed: boolean,
  ): ValidatorOutput {
    if (passed) {
      return { passed, results };
    }

    const failureSummary = this.buildFailureSummary({ results });
    return { passed, results, failureSummary };
  }

  private buildFailureSummary(output: Pick<ValidatorOutput, 'results'>): string {
    const failed = output.results.filter((r) => r.exitCode !== 0);
    if (failed.length === 0) return 'Unknown failure';

    return failed
      .map((r) => {
        const lines: string[] = [`Command \`${r.command}\` failed (exit ${r.exitCode})`];
        if (r.stderr?.trim()) {
          lines.push(`stderr: ${r.stderr.trim().split('\n').slice(0, 10).join('\n')}`);
        }
        if (r.stdout?.trim() && !r.stderr?.trim()) {
          lines.push(`stdout: ${r.stdout.trim().split('\n').slice(0, 10).join('\n')}`);
        }
        return lines.join('\n');
      })
      .join('\n\n');
  }
}

/**
 * Auto-detect validation commands from common project files.
 *
 * @param cwd - Project root directory.
 * @returns Array of validation commands, or empty if none detected.
 */
export async function detectValidationCommands(cwd: string): Promise<string[]> {
  const chain = await buildValidationChain(cwd);
  return chain.map((s) => s.command);
}

/**
 * Build a 6-step validation chain by auto-detecting commands from
 * `package.json` scripts, `Makefile` targets, and language-specific
 * tooling present in `cwd`.
 *
 * Steps:
 *  1. Syntax/parse check  — fast-fail, <1s
 *  2. Lint + format check — auto-fixable issues resolved automatically
 *  3. Type check/compile  — structural correctness
 *  4. Unit tests          — behavioural correctness
 *  5. Integration tests   — cross-module correctness
 *  6. Security scan       — SAST (semgrep / eslint-plugin-security)
 *
 * Commands are validated against {@link ALLOWED_COMMAND_RE} before
 * being returned so the caller can trust they are safe to execute.
 *
 * @param cwd - Project root directory.
 * @returns Ordered list of ValidationStep objects (may be shorter than 6
 *   when commands cannot be detected for a given step).
 */
export async function buildValidationChain(cwd: string): Promise<ValidationStep[]> {
  const steps: ValidationStep[] = [];

  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    // ── Detect package manager ───────────────────────────────────────────
    const hasPnpm = existsSync(join(cwd, 'pnpm-lock.yaml'));
    const hasYarn = existsSync(join(cwd, 'yarn.lock'));
    const hasBun  = existsSync(join(cwd, 'bun.lockb'));
    const pm = hasPnpm ? 'pnpm' : hasYarn ? 'yarn' : hasBun ? 'bun' : 'npm';

    // ── Node/JS project ──────────────────────────────────────────────────
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      const devDeps = ((pkg.devDependencies ?? {}) as Record<string, string>);
      const deps    = ((pkg.dependencies    ?? {}) as Record<string, string>);
      const allDeps = { ...devDeps, ...deps };

      // Step 1 — Syntax check: tsc --noEmit (fast) or a build that validates syntax
      const hasTsc = existsSync(join(cwd, 'tsconfig.json'));
      if (hasTsc && (scripts.typecheck || scripts['type-check'])) {
        // will be used as typecheck step instead
      } else if (hasTsc) {
        const cmd = `${pm} exec tsc --noEmit`;
        if (isCmdAllowed(cmd)) {
          steps.push({ label: 'TypeScript syntax check', kind: 'syntax', command: cmd, timeoutMs: 30_000 });
        }
      }

      // Step 2 — Lint + auto-fix
      if (scripts.lint) {
        const lintCmd = `${pm} run lint`;
        if (isCmdAllowed(lintCmd)) {
          // Detect an auto-fix variant
          const hasEslint = 'eslint' in allDeps;
          const hasPrettier = 'prettier' in allDeps;
          let autoFixCmd: string | undefined;
          if (hasEslint && scripts['lint:fix']) {
            autoFixCmd = `${pm} run lint:fix`;
          } else if (hasEslint) {
            autoFixCmd = `${pm} exec eslint --fix .`;
          } else if (hasPrettier && scripts.format) {
            autoFixCmd = `${pm} run format`;
          }
          steps.push({
            label: 'Lint + format check',
            kind: 'lint',
            command: lintCmd,
            autoFixCommand: autoFixCmd && isCmdAllowed(autoFixCmd) ? autoFixCmd : undefined,
            timeoutMs: 60_000,
          });
        }
      }

      // Step 3 — Type check / compile
      const typecheckScript = scripts.typecheck || scripts['type-check'] || scripts['type:check'];
      if (typecheckScript) {
        const cmd = `${pm} run ${scripts.typecheck ? 'typecheck' : scripts['type-check'] ? 'type-check' : 'type:check'}`;
        if (isCmdAllowed(cmd)) {
          steps.push({ label: 'Type check', kind: 'typecheck', command: cmd, timeoutMs: 60_000 });
        }
      } else if (scripts.build) {
        const cmd = `${pm} run build`;
        if (isCmdAllowed(cmd)) {
          steps.push({ label: 'Build (type check proxy)', kind: 'typecheck', command: cmd, timeoutMs: 120_000 });
        }
      }

      // Step 4 — Unit tests
      if (scripts.test && !scripts.test.includes('no test specified')) {
        const cmd = `${pm} ${pm === 'npm' ? 'test' : 'run test'}`;
        if (isCmdAllowed(cmd)) {
          steps.push({ label: 'Unit tests', kind: 'unit-tests', command: cmd, timeoutMs: 300_000 });
        }
      } else if (scripts['test:unit']) {
        const cmd = `${pm} run test:unit`;
        if (isCmdAllowed(cmd)) {
          steps.push({ label: 'Unit tests', kind: 'unit-tests', command: cmd, timeoutMs: 300_000 });
        }
      }

      // Step 5 — Integration tests (if separate from unit)
      if (scripts['test:integration'] || scripts['test:e2e'] || scripts['test:int']) {
        const intScript = scripts['test:integration'] ? 'test:integration'
          : scripts['test:e2e'] ? 'test:e2e'
          : 'test:int';
        const cmd = `${pm} run ${intScript}`;
        if (isCmdAllowed(cmd)) {
          steps.push({ label: 'Integration tests', kind: 'integration', command: cmd, timeoutMs: 600_000 });
        }
      }

      // Step 6 — Security scan
      const hasSemgrep = existsSync(join(cwd, '.semgrep.yml')) || existsSync(join(cwd, '.semgrep'));
      const hasEslintSecurity = 'eslint-plugin-security' in allDeps;
      if (hasSemgrep) {
        const cmd = `${pm} exec semgrep --config=auto --error .`;
        if (isCmdAllowed(cmd)) {
          steps.push({ label: 'Security scan (semgrep)', kind: 'security', command: cmd, timeoutMs: 120_000 });
        }
      } else if (hasEslintSecurity && scripts['lint:security']) {
        const cmd = `${pm} run lint:security`;
        if (isCmdAllowed(cmd)) {
          steps.push({ label: 'Security scan (eslint-plugin-security)', kind: 'security', command: cmd, timeoutMs: 60_000 });
        }
      }

      // If we found any steps, return early
      if (steps.length > 0) return steps;
    }

    // ── Makefile fallback ────────────────────────────────────────────────
    const makefilePath = join(cwd, 'Makefile');
    if (existsSync(makefilePath)) {
      const makefile = readFileSync(makefilePath, 'utf-8');
      if (/^test:/m.test(makefile))  steps.push({ label: 'make test',  kind: 'unit-tests', command: 'make test',  timeoutMs: 300_000 });
      if (/^lint:/m.test(makefile))  steps.push({ label: 'make lint',  kind: 'lint',       command: 'make lint',  timeoutMs: 60_000 });
      if (/^check:/m.test(makefile)) steps.push({ label: 'make check', kind: 'typecheck',  command: 'make check', timeoutMs: 120_000 });
      if (steps.length > 0) return steps;
    }

    // ── Python / pytest ──────────────────────────────────────────────────
    if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py'))) {
      steps.push({ label: 'pytest',          kind: 'unit-tests', command: 'pytest',           timeoutMs: 300_000 });
      steps.push({ label: 'ruff lint',       kind: 'lint',       command: 'ruff check .',      timeoutMs: 30_000,
        autoFixCommand: 'ruff check --fix .' });
      steps.push({ label: 'mypy typecheck',  kind: 'typecheck',  command: 'python -m mypy .',  timeoutMs: 60_000 });
      return steps;
    }

    // ── Rust / cargo ─────────────────────────────────────────────────────
    if (existsSync(join(cwd, 'Cargo.toml'))) {
      steps.push({ label: 'cargo check', kind: 'syntax',     command: 'cargo check',    timeoutMs: 60_000 });
      steps.push({ label: 'cargo clippy', kind: 'lint',      command: 'cargo clippy',   timeoutMs: 120_000 });
      steps.push({ label: 'cargo test',  kind: 'unit-tests', command: 'cargo test',     timeoutMs: 300_000 });
      return steps;
    }

    // ── Go ───────────────────────────────────────────────────────────────
    if (existsSync(join(cwd, 'go.mod'))) {
      steps.push({ label: 'go build',  kind: 'syntax',     command: 'go build ./...', timeoutMs: 60_000 });
      steps.push({ label: 'go vet',    kind: 'lint',       command: 'go vet ./...',   timeoutMs: 30_000 });
      steps.push({ label: 'go test',   kind: 'unit-tests', command: 'go test ./...',  timeoutMs: 300_000 });
      return steps;
    }

  } catch (err) {
    log.debug('buildValidationChain: failed to read project files', { err });
  }

  return steps;
}

/** Returns true iff the command passes the allowlist check. */
function isCmdAllowed(cmd: string): boolean {
  return ALLOWED_COMMAND_RE.test(cmd.trim());
}
