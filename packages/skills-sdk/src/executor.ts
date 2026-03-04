/**
 * @module executor
 * Executes skill tool handler scripts in a child process.
 * Sends JSON parameters on stdin, collects JSON from stdout.
 */

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

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

        if (killed) {
          reject(
            new Error(
              `Handler "${resolvedPath}" timed out after ${options.timeout}ms.`,
            ),
          );
          return;
        }

        if (code !== 0) {
          reject(
            new Error(
              `Handler "${resolvedPath}" exited with code ${code ?? 'null'}. stderr: ${stderr.trim()}`,
            ),
          );
          return;
        }

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
