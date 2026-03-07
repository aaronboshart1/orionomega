/**
 * @module commands/gateway
 * Manage the OrionOmega gateway service (start/stop/restart/status).
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readConfig } from '../config/index.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const PID_FILE = join(homedir(), '.orionomega', 'gateway.pid');

/** Check whether systemd is available. */
function hasSystemd(): boolean {
  try {
    execSync('systemctl --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Check whether a process with given PID is alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read PID from file, return null if missing or stale. */
function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) return null;
  return isAlive(pid) ? pid : null;
}

/** Find the gateway server entry point. */
function findServerPath(): string {
  // Try common locations
  const candidates = [
    join(process.cwd(), 'packages/gateway/dist/server.js'),
    '/opt/orionomega/packages/gateway/dist/server.js',
    join(homedir(), '.orionomega', 'packages/gateway/dist/server.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to relative from this module
  return join(process.cwd(), 'packages/gateway/dist/server.js');
}

function startDev(): void {
  const existing = readPid();
  if (existing) {
    process.stdout.write(`${YELLOW}⚠${RESET} Gateway already running (PID ${existing})\n`);
    return;
  }

  const serverPath = findServerPath();
  if (!existsSync(serverPath)) {
    process.stdout.write(`${RED}✗${RESET} Gateway server not found at ${serverPath}\n`);
    process.stdout.write(`  Run ${BOLD}pnpm build${RESET} first.\n`);
    return;
  }

  const config = readConfig();
  const child = spawn('node', [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(config.gateway.port) },
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

/**
 * Handle gateway subcommands: start, stop, restart, status.
 */
export async function runGateway(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || !['start', 'stop', 'restart', 'status'].includes(sub)) {
    process.stdout.write(`\n${BOLD}Usage:${RESET} orionomega gateway <start|stop|restart|status>\n\n`);
    return;
  }

  if (hasSystemd()) {
    // Use systemd
    try {
      if (sub === 'status') {
        const out = execSync('systemctl status orionomega 2>&1', { encoding: 'utf-8' });
        process.stdout.write(out + '\n');
      } else {
        // Use sudo for service management — avoids polkit auth prompts.
        // A passwordless sudoers rule should be in /etc/sudoers.d/orionomega.
        execSync(`sudo systemctl ${sub} orionomega`, { stdio: 'inherit' });
        process.stdout.write(`${GREEN}✓${RESET} Gateway ${sub}ed via systemd\n`);
      }
    } catch (err: unknown) {
      // systemd unit might not exist — fall through to dev mode
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('could not be found') || msg.includes('No such file')) {
        process.stdout.write(`${DIM}systemd unit not installed, using dev mode${RESET}\n`);
        runDevMode(sub);
      } else {
        // For status, non-zero exit is normal when service is stopped
        if (sub === 'status') {
          process.stdout.write(`${DIM}systemd unit not active, checking dev mode...${RESET}\n`);
          statusDev();
        } else {
          process.stdout.write(`${RED}✗${RESET} systemctl ${sub} failed: ${msg.slice(0, 200)}\n`);
        }
      }
    }
  } else {
    runDevMode(sub);
  }
}

function runDevMode(sub: string): void {
  switch (sub) {
    case 'start': startDev(); break;
    case 'stop': stopDev(); break;
    case 'restart':
      stopDev();
      setTimeout(() => startDev(), 500);
      break;
    case 'status': statusDev(); break;
  }
}
