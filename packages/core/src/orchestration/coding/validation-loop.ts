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
        maxTurns: Math.min(budget.maxTurns, 20),
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
        const exitCode = 0;

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
  const commands: string[] = [];

  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;

      if (scripts.test && !scripts.test.includes('no test specified')) {
        commands.push('npm test');
      }
      if (scripts.lint) {
        commands.push('npm run lint');
      }
      if (scripts.typecheck || scripts['type-check']) {
        commands.push('npm run ' + (scripts.typecheck ? 'typecheck' : 'type-check'));
      }
      if (scripts.build && commands.length === 0) {
        // Only add build if no test/lint detected (build acts as smoke test)
        commands.push('npm run build');
      }
    }

    const makefilePath = join(cwd, 'Makefile');
    if (existsSync(makefilePath) && commands.length === 0) {
      const makefile = readFileSync(makefilePath, 'utf-8');
      if (/^test:/m.test(makefile)) commands.push('make test');
      if (/^lint:/m.test(makefile)) commands.push('make lint');
    }
  } catch {
    // Non-fatal — return what we have
  }

  return commands;
}
