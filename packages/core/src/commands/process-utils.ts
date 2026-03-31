/**
 * @module commands/process-utils
 * Shared utilities for process management, port detection, and environment filtering.
 */

import { execSync } from 'node:child_process';

const SENSITIVE_ENV_PREFIXES = [
  'AWS_SECRET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'STRIPE_SECRET',
  'DATABASE_URL',
  'DB_PASSWORD',
  'PRIVATE_KEY',
  'SECRET_KEY',
  'SESSION_SECRET',
];

const SENSITIVE_ENV_EXACT = new Set([
  'NPM_TOKEN',
  'DOCKER_AUTH',
]);

export function safeChildEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SENSITIVE_ENV_EXACT.has(key)) continue;
    if (SENSITIVE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return env;
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function findPidOnPort(port: number): number | null {
  const commands = [
    `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`,
    `ss -tlnp 2>/dev/null | grep ':${port} ' | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p'`,
    `fuser ${port}/tcp 2>/dev/null`,
  ];

  for (const cmd of commands) {
    try {
      const result = execSync(cmd, { timeout: 5000, shell: '/bin/sh' }).toString().trim();
      if (!result) continue;
      const pids = result.split(/\s+/).map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
      if (pids.length === 0) continue;
      for (const pid of pids) {
        try {
          const cmdline = execSync(`ps -p ${pid} -o args= 2>/dev/null || true`, {
            timeout: 3000,
            shell: '/bin/sh',
          }).toString().trim();
          if (cmdline.includes('server.js') || cmdline.includes('gateway') || cmdline.includes('server.mjs')) {
            return pid;
          }
        } catch { /* skip */ }
      }
      return pids[0] ?? null;
    } catch {
      continue;
    }
  }

  return null;
}

export function killPortHolder(port: number): boolean {
  const pid = findPidOnPort(port);
  if (!pid) return false;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }

  sleepSync(1000);

  try {
    process.kill(pid, 0);
    try { process.kill(pid, 'SIGKILL'); } catch { /* ok */ }
  } catch {
    /* already dead */
  }

  return true;
}
