/**
 * @module commands/gateway
 * Manage the OrionOmega gateway service (start/stop/restart/status).
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../config/index.js';
import { safeChildEnv } from './process-utils.js';
import { restartWebUI } from './ui.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const PID_FILE = join(homedir(), '.orionomega', 'gateway.pid');

function hasSystemd(): boolean {
  try {
    execSync('systemctl cat orionomega 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) return null;
  return isAlive(pid) ? pid : null;
}

function findServerPath(): string {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const monorepoRoot = join(__dirname, '..', '..', '..', '..');

  const candidates = [
    join(monorepoRoot, 'packages', 'gateway', 'dist', 'server.js'),
    join(homedir(), '.orionomega', 'src', 'packages', 'gateway', 'dist', 'server.js'),
    join(process.cwd(), 'packages', 'gateway', 'dist', 'server.js'),
    join(homedir(), '.orionomega', 'packages', 'gateway', 'dist', 'server.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

function startDev(force = false): void {
  const existing = readPid();
  if (existing) {
    if (force) {
      try {
        process.kill(existing, 'SIGTERM');
        unlinkSync(PID_FILE);
        process.stdout.write(`${GREEN}✓${RESET} Stopped existing gateway (PID ${existing})\n`);
      } catch (err) {
        process.stderr.write(`${YELLOW}⚠${RESET} Failed to stop existing gateway (PID ${existing}): ${err instanceof Error ? err.message : String(err)}\n`);
      }
    } else {
      process.stdout.write(`${YELLOW}⚠${RESET} Gateway already running (PID ${existing})\n`);
      return;
    }
  }

  const serverPath = findServerPath();
  if (!existsSync(serverPath)) {
    process.stdout.write(`${RED}✗${RESET} Gateway server not found at ${serverPath}\n`);
    process.stdout.write(`  Run ${BOLD}pnpm build${RESET} first.\n`);
    return;
  }

  const config = readConfig();
  const childEnv = safeChildEnv();
  childEnv.PORT = String(config.gateway.port);

  const child = spawn('node', [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: childEnv,
  });

  child.unref();

  if (child.pid) {
    writeFileSync(PID_FILE, String(child.pid), 'utf-8');
    process.stdout.write(`${GREEN}✓${RESET} Gateway started (PID ${child.pid}, port ${config.gateway.port})\n`);
  } else {
    process.stdout.write(`${RED}✗${RESET} Failed to start gateway\n`);
  }
}

function stopDev(): void {
  const pid = readPid();
  if (!pid) {
    process.stdout.write(`${YELLOW}⚠${RESET} Gateway is not running\n`);
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    unlinkSync(PID_FILE);
    process.stdout.write(`${GREEN}✓${RESET} Gateway stopped (PID ${pid})\n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${RED}✗${RESET} Failed to stop gateway: ${msg}\n`);
  }
}

function statusDev(): void {
  const pid = readPid();
  const config = readConfig();
  if (pid) {
    process.stdout.write(`${GREEN}✓${RESET} Gateway is running (PID ${pid}, port ${config.gateway.port})\n`);
  } else {
    process.stdout.write(`${RED}✗${RESET} Gateway is not running\n`);
  }
}

export async function runGateway(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || !['start', 'stop', 'restart', 'status'].includes(sub)) {
    process.stdout.write(`\n${BOLD}Usage:${RESET} orionomega gateway <start|stop|restart|status>\n\n`);
    return;
  }

  if (hasSystemd()) {
    try {
      if (sub === 'status') {
        try {
          const out = execSync('systemctl is-active orionomega 2>&1', { encoding: 'utf-8' }).trim();
          if (out === 'active') {
            const config = readConfig();
            const pid = execSync('systemctl show orionomega --property=MainPID --value 2>/dev/null', { encoding: 'utf-8' }).trim();
            process.stdout.write(`${GREEN}✓${RESET} Gateway is running (PID ${pid}, port ${config.gateway.port}, systemd)\n`);
          } else {
            process.stdout.write(`${RED}✗${RESET} Gateway is ${out} (systemd)\n`);
          }
        } catch {
          process.stdout.write(`${RED}✗${RESET} Gateway is not running (systemd)\n`);
        }
        return;
      } else {
        execSync(`sudo systemctl ${sub} orionomega`, { stdio: 'inherit' });
        process.stdout.write(`${GREEN}✓${RESET} Gateway ${sub}ed via systemd\n`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('could not be found') || msg.includes('No such file')) {
        process.stdout.write(`${DIM}systemd unit not installed, using dev mode${RESET}\n`);
        await runDevMode(sub);
      } else {
        if (sub === 'status') {
          process.stdout.write(`${DIM}systemd unit not active, checking dev mode...${RESET}\n`);
          statusDev();
        } else {
          process.stdout.write(`${RED}✗${RESET} systemctl ${sub} failed: ${msg.slice(0, 200)}\n`);
        }
      }
    }
  } else {
    await runDevMode(sub);
  }
}

async function runDevMode(sub: string): Promise<void> {
  switch (sub) {
    case 'start': startDev(); break;
    case 'stop': stopDev(); break;
    case 'restart':
      startDev(true);
      process.stdout.write(`${DIM}Restarting web UI...${RESET}\n`);
      try {
        const result = await restartWebUI();
        if (result.started) {
          process.stdout.write(`${GREEN}✓${RESET} Web UI restarted (PID ${result.started})\n`);
        } else {
          process.stdout.write(`${YELLOW}⚠${RESET} Web UI is not running or failed to start\n`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`${YELLOW}⚠${RESET} Failed to restart web UI: ${msg}\n`);
      }
      break;
    case 'status': statusDev(); break;
  }
}
