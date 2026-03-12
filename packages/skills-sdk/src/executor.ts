/**
 * @module executor
 * Executes skill tool handler scripts in a child process.
 * Sends JSON parameters on stdin, collects JSON from stdout.
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

// Simple inline logger — skills-sdk doesn't depend on core's logger
const LOG_LEVEL = process.env.ORIONOMEGA_LOG_LEVEL ?? 'info';
const VERBOSE = ['verbose', 'debug'].includes(LOG_LEVEL);
function logVerbose(msg: string, data?: Record<string, unknown>): void {
  if (!VERBOSE) return;
  const tag = `\x1b[35m[${new Date().toISOString()}] [VERBOSE] [skill-executor]\x1b[0m`;
  if (data && Object.keys(data).length > 0) {
    console.log(`${tag} ${msg}`, JSON.stringify(data));
  } else {
    console.log(`${tag} ${msg}`);
  }
}
function logError(msg: string, data?: Record<string, unknown>): void {
  const tag = `\x1b[31m[${new Date().toISOString()}] [ERROR  ] [skill-executor]\x1b[0m`;
  if (data && Object.keys(data).length > 0) {
    console.log(`${tag} ${msg}`, JSON.stringify(data));
  } else {
    console.log(`${tag} ${msg}`);
  }
}

/**
 * Executes skill tool handler scripts as child processes.
 *
 * Handlers receive JSON on stdin and are expected to produce JSON on stdout.
 * Non-JSON output is wrapped in `{ result: string }`.
 */
export class SkillExecutor {
  /**
   * Execute a skill tool handler script.
   *
   * @param handlerPath - Absolute or relative path to the handler script.
   * @param params - Parameters to send as JSON on stdin.
   * @param options - Execution options (cwd, timeout, env).
   * @returns Parsed JSON output from the handler, or `{ result: string }` for non-JSON output.
   * @throws If the handler file is missing, not executable, times out, or exits non-zero.
   */
  async executeHandler(
    handlerPath: string,
    params: Record<string, unknown>,
    options: {
      cwd: string;
      timeout: number;
      env?: Record<string, string>;
    },
  ): Promise<unknown> {
    const resolvedPath = path.isAbsolute(handlerPath)
      ? handlerPath
      : path.resolve(options.cwd, handlerPath);

    // Check file exists
    try {
      await access(resolvedPath, constants.F_OK);
    } catch {
      throw new Error(`Handler file not found: ${resolvedPath}`);
    }

    // Check file is executable
    try {
      await access(resolvedPath, constants.X_OK);
    } catch {
      throw new Error(`Handler file is not executable: ${resolvedPath}`);
    }

    return new Promise<unknown>((resolve, reject) => {
      const env = { ...process.env, ...options.env };
      const start = Date.now();

      logVerbose(`Executing handler: ${resolvedPath}`, {
        cwd: options.cwd,
        timeout: options.timeout,
        paramKeys: Object.keys(params),
      });

      const child = spawn(resolvedPath, [], {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, options.timeout);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn handler "${resolvedPath}": ${err.message}`));
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;

        if (killed) {
          logError(`Handler timed out: ${resolvedPath}`, { durationMs, timeout: options.timeout });
          reject(
            new Error(
              `Handler "${resolvedPath}" timed out after ${options.timeout}ms.`,
            ),
          );
          return;
        }

        if (code !== 0) {
          logError(`Handler failed: ${resolvedPath}`, { code, durationMs, stderr: stderr.slice(0, 500) });
          reject(
            new Error(
              `Handler "${resolvedPath}" exited with code ${code ?? 'null'}. stderr: ${stderr.trim()}`,
            ),
          );
          return;
        }

        logVerbose(`Handler complete: ${resolvedPath}`, {
          durationMs,
          stdoutLength: stdout.length,
          stdoutPreview: stdout.slice(0, 300),
        });

        // Attempt JSON parse
        const trimmed = stdout.trim();
        try {
          resolve(JSON.parse(trimmed));
        } catch {
          resolve({ result: trimmed });
        }
      });

      // Write params to stdin and close
      child.stdin.write(JSON.stringify(params));
      child.stdin.end();
    });
  }
}
