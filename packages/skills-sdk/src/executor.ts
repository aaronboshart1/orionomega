/**
 * @module executor
 * Skill handler execution — spawns handler scripts and communicates via stdin/stdout JSON.
 *
 * Handler contract:
 * - stdin:  one JSON object containing the tool's input parameters
 * - stdout: one JSON object representing the tool's output
 * - stderr: human-readable diagnostic text (not parsed)
 * - exit 0: success; any other exit code is a failure
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

export interface ExecuteOptions {
  cwd: string;
  timeout?: number;
  env?: Record<string, string>;
}

export class SkillExecutor {
  executeHandler(
    handlerPath: string,
    params: Record<string, unknown>,
    options: ExecuteOptions,
  ): Promise<unknown> {
    const resolvedHandler = path.isAbsolute(handlerPath)
      ? handlerPath
      : path.resolve(options.cwd, handlerPath);

    const timeout = options.timeout ?? 30_000;

    return new Promise((resolve, reject) => {
      let timedOut = false;

      const child = spawn(resolvedHandler, [], {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        reject(
          new Error(`Handler "${handlerPath}" timed out after ${timeout}ms`),
        );
      }, timeout);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (timedOut) return;
        reject(
          new Error(
            `Failed to spawn handler "${handlerPath}": ${err.message}`,
          ),
        );
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return;

        if (code !== 0) {
          const hint = stderr.trim() ? ` Stderr: ${stderr.trim().slice(0, 300)}` : '';
          reject(
            new Error(
              `Handler "${handlerPath}" exited with code ${code}.${hint}`,
            ),
          );
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch {
          const preview = stdout.slice(0, 200);
          reject(
            new Error(
              `Handler "${handlerPath}" returned invalid JSON: ${preview}`,
            ),
          );
        }
      });

      child.stdin.write(JSON.stringify(params), 'utf-8');
      child.stdin.end();
    });
  }
}
