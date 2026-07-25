/**
 * @module commands/status
 * Quick health check for OrionOmega services.
 */

import { existsSync } from 'node:fs';
import { RedisMemoryStore } from '../memory/redis-store.js';
import { redactUrl, resolveRedisUrl } from '../memory/redis-connection.js';
import { readConfig, getConfigPath } from '../config/index.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function ok(label: string, detail?: string): void {
  const d = detail ? ` ${DIM}${detail}${RESET}` : '';
  process.stdout.write(`  ${GREEN}✓${RESET} ${label}${d}\n`);
}

function bad(label: string, detail?: string): void {
  const d = detail ? ` ${DIM}${detail}${RESET}` : '';
  process.stdout.write(`  ${RED}✗${RESET} ${label}${d}\n`);
}

/**
 * Run the status command — quick health overview.
 */
export async function runStatus(): Promise<void> {
  const config = readConfig();
  const configPath = getConfigPath();

  process.stdout.write(`\n${BOLD}OrionOmega Status${RESET}\n\n`);

  // Gateway
  try {
    const res = await fetch(`http://localhost:${config.gateway.port}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      ok('Gateway', `port ${config.gateway.port}`);
    } else {
      bad('Gateway', `returned ${res.status}`);
    }
  } catch {
    bad('Gateway', 'not reachable');
  }

  // Memory (Redis) — a PING, not an HTTP probe. health() never throws.
  {
    const redisUrl = resolveRedisUrl(config.memory?.redis);
    const probe = new RedisMemoryStore({ redis: config.memory?.redis });
    try {
      const { healthy } = await probe.health();
      if (healthy) ok('Memory (Redis)', redactUrl(redisUrl));
      else bad('Memory (Redis)', `not reachable at ${redactUrl(redisUrl)}`);
    } finally {
      await probe.close().catch(() => {});
    }
  }

  // Config
  if (existsSync(configPath)) {
    ok('Config', configPath);
  } else {
    bad('Config', `not found at ${configPath}`);
  }

  // Workspace
  if (existsSync(config.workspace.path)) {
    ok('Workspace', config.workspace.path);
  } else {
    bad('Workspace', `not found at ${config.workspace.path}`);
  }

  // API Key
  if (config.models.apiKey) {
    ok('API Key', 'configured');
  } else {
    bad('API Key', 'not set — run "orionomega setup"');
  }

  process.stdout.write('\n');
}
