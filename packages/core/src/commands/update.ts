/**
 * @module commands/update
 * Pull latest code, rebuild, and restart the gateway + web UI.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const PID_FILE = join(homedir(), '.orionomega', 'gateway.pid');

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function step(label: string, cmd: string, cwd: string): boolean {
  process.stdout.write(`  ${DIM}${label}...${RESET} `);
  try {
    execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8', timeout: 120_000 });
    process.stdout.write(`${GREEN}✓${RESET}\n`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${RED}✗${RESET}\n`);
    process.stdout.write(`    ${DIM}${msg.slice(0, 200)}${RESET}\n`);
    return false;
  }
}

function findInstallDir(): string | null {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const monorepoRoot = join(__dirname, '..', '..', '..', '..');
  const candidates = [
    monorepoRoot,
    '/opt/orionomega',
    join(homedir(), '.orionomega', 'src'),
    process.cwd(),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'package.json')) && existsSync(join(c, '.git'))) {
      return c;
    }
  }
  return null;
}

export async function runUpdate(): Promise<void> {
  process.stdout.write(`\n${BOLD}Updating OrionOmega${RESET}\n\n`);

  const installDir = findInstallDir();
  if (!installDir) {
    process.stdout.write(`${RED}✗${RESET} Cannot find OrionOmega git repository\n`);
    process.stdout.write(`  ${DIM}Expected at /opt/orionomega or current directory${RESET}\n`);
    return;
  }

  process.stdout.write(`  ${DIM}Install directory: ${installDir}${RESET}\n\n`);

  const gatewayPid = readPid();
  if (gatewayPid) {
    process.stdout.write(`  ${DIM}Stopping gateway (PID ${gatewayPid})...${RESET} `);
    try {
      process.kill(gatewayPid, 'SIGTERM');
      let waited = 0;
      while (waited < 5000) {
        try { process.kill(gatewayPid, 0); } catch { break; }
        execSync('sleep 0.5');
        waited += 500;
      }
      process.stdout.write(`${GREEN}✓${RESET}\n`);
    } catch {
      process.stdout.write(`${DIM}already stopped${RESET}\n`);
    }
  } else {
    process.stdout.write(`  ${DIM}Gateway not running${RESET}\n`);
  }

  if (!step('Pulling latest changes', 'git pull', installDir)) return;
  if (!step('Installing dependencies', 'pnpm install --frozen-lockfile', installDir)) {
    if (!step('Installing dependencies (unfrozen)', 'pnpm install', installDir)) return;
  }
  if (!step('Building all packages', 'pnpm build', installDir)) return;

  process.stdout.write(`\n  ${DIM}Starting gateway...${RESET} `);
  try {
    const gatewayEntry = join(installDir, 'packages', 'gateway', 'dist', 'server.js');
    const child = spawn(process.execPath, [gatewayEntry], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env },
    });
    child.unref();
    if (child.pid) {
      writeFileSync(PID_FILE, String(child.pid), 'utf-8');
    }
    process.stdout.write(`${GREEN}✓${RESET} (PID ${child.pid})\n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${RED}✗${RESET}\n`);
    process.stdout.write(`    ${DIM}${msg.slice(0, 200)}${RESET}\n`);
  }

  process.stdout.write(`\n${GREEN}✓${RESET} ${BOLD}Update complete!${RESET}\n`);
  process.stdout.write(`  ${DIM}Run 'orionomega ui' to start the web dashboard${RESET}\n\n`);
}

export function findInstallDirectory(): string | null {
  return findInstallDir();
}
