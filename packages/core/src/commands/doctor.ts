/**
 * @module commands/doctor
 * Full diagnostic check for OrionOmega.
 */

import { existsSync, accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readConfig, getConfigPath } from '../config/index.js';

const require = createRequire(import.meta.url);

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let passed = 0;
let warnings = 0;
let errors = 0;

function ok(label: string, detail?: string): void {
  const d = detail ? ` ${DIM}${detail}${RESET}` : '';
  process.stdout.write(`  ${GREEN}✓${RESET} ${label}${d}\n`);
  passed++;
}

function bad(label: string, detail?: string): void {
  const d = detail ? ` ${DIM}${detail}${RESET}` : '';
  process.stdout.write(`  ${RED}✗${RESET} ${label}${d}\n`);
  errors++;
}

function warn(label: string, detail?: string): void {
  const d = detail ? ` ${DIM}${detail}${RESET}` : '';
  process.stdout.write(`  ${YELLOW}⚠${RESET} ${label}${d}\n`);
  warnings++;
}

/**
 * Run the doctor command — full system diagnostic.
 */
export async function runDoctor(): Promise<void> {
  passed = 0;
  warnings = 0;
  errors = 0;

  process.stdout.write(`\n${BOLD}OrionOmega Doctor${RESET}\n\n`);

  const config = readConfig();
  const configPath = getConfigPath();

  // 1. Node.js version
  const nodeVer = process.versions.node;
  const major = parseInt(nodeVer.split('.')[0], 10);
  if (major >= 22) {
    ok('Node.js', `v${nodeVer}`);
  } else {
    bad('Node.js', `v${nodeVer} — requires >= 22`);
  }

  // 2. Gateway service
  try {
    const res = await fetch(`http://localhost:${config.gateway.port}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      ok('Gateway service', `port ${config.gateway.port}`);
    } else {
      bad('Gateway service', `returned ${res.status}`);
    }
  } catch {
    bad('Gateway service', 'not running');
  }

  // 3. Hindsight connectivity
  try {
    const res = await fetch(`${config.hindsight.url}/v1/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      ok('Hindsight', config.hindsight.url);
    } else {
      warn('Hindsight', `returned ${res.status}`);
    }
  } catch {
    warn('Hindsight', 'not reachable');
  }

  // 4. Anthropic API key present
  if (config.models.apiKey) {
    ok('Anthropic API key', 'present in config');
  } else {
    bad('Anthropic API key', 'missing — run "orionomega setup"');
  }

  // 5. Anthropic API reachable
  if (config.models.apiKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.models.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-20250414',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        ok('Anthropic API', 'reachable and key valid');
      } else if (res.status === 401) {
        bad('Anthropic API', 'invalid API key');
      } else {
        warn('Anthropic API', `returned ${res.status}`);
      }
    } catch {
      warn('Anthropic API', 'network error');
    }
  } else {
    warn('Anthropic API', 'skipped — no key');
  }

  // 6. Workspace exists and writable
  if (existsSync(config.workspace.path)) {
    try {
      accessSync(config.workspace.path, constants.W_OK);
      ok('Workspace', config.workspace.path);
    } catch {
      bad('Workspace', 'exists but not writable');
    }
  } else {
    bad('Workspace', `not found at ${config.workspace.path}`);
  }

  // 7. Config file valid
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const yaml = require('js-yaml') as typeof import('js-yaml');
      yaml.load(raw);
      ok('Config file', configPath);
    } catch {
      bad('Config file', 'exists but not valid YAML');
    }
  } else {
    warn('Config file', 'not found — using defaults');
  }

  // 8. Skills directory
  if (existsSync(config.skills.directory)) {
    let count = 0;
    try {
      count = readdirSync(config.skills.directory).filter((d) => {
        try { return existsSync(`${config.skills.directory}/${d}/manifest.yaml`) || existsSync(`${config.skills.directory}/${d}/manifest.json`); }
        catch { return false; }
      }).length;
    } catch { /* ignore */ }
    ok('Skills directory', `${count} skill(s) installed`);
  } else {
    warn('Skills directory', `not found at ${config.skills.directory}`);
  }

  // 9. Log directory exists and writable
  const logDir = config.logging.file.substring(0, config.logging.file.lastIndexOf('/'));
  if (existsSync(logDir)) {
    try {
      accessSync(logDir, constants.W_OK);
      ok('Log directory', logDir);
    } catch {
      bad('Log directory', 'exists but not writable');
    }
  } else {
    warn('Log directory', `not found at ${logDir}`);
  }

  // 10. Disk space
  try {
    const df = execSync('df -h / | tail -1', { encoding: 'utf-8' }).trim();
    const parts = df.split(/\s+/);
    const usePct = parts[4] ?? 'unknown';
    const avail = parts[3] ?? 'unknown';
    const pct = parseInt(usePct, 10);
    if (pct > 90) {
      warn('Disk space', `${usePct} used, ${avail} available`);
    } else {
      ok('Disk space', `${usePct} used, ${avail} available`);
    }
  } catch {
    warn('Disk space', 'could not check');
  }

  // 11. Memory usage
  try {
    const mem = process.memoryUsage();
    const rss = Math.round(mem.rss / 1024 / 1024);
    ok('Memory (CLI process)', `${rss} MB RSS`);
  } catch {
    warn('Memory', 'could not check');
  }

  // Summary
  process.stdout.write(`\n${BOLD}Summary:${RESET} `);
  process.stdout.write(`${GREEN}${passed} passed${RESET}`);
  if (warnings > 0) process.stdout.write(`, ${YELLOW}${warnings} warnings${RESET}`);
  if (errors > 0) process.stdout.write(`, ${RED}${errors} errors${RESET}`);
  process.stdout.write('\n\n');

  if (errors > 0) {
    process.exitCode = 1;
  }
}
