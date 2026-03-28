/**
 * @module commands/ui
 * Manage the OrionOmega web UI service (start/stop/restart/status).
 */

import { execSync, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../config/loader.js';
import { normalizeBindAddresses } from '../config/loader.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const ORIONOMEGA_DIR = join(homedir(), '.orionomega');
const PID_FILE = join(ORIONOMEGA_DIR, 'ui.pid');
const LOG_FILE = join(ORIONOMEGA_DIR, 'ui.log');
const SYSTEMD_UNIT = 'orionomega-ui';

function ensureDir(): void {
  mkdirSync(ORIONOMEGA_DIR, { recursive: true });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForExit(pid: number, timeoutMs = 2000): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    sleepSync(50);
  }
  return !isAlive(pid);
}

function hasSystemd(): boolean {
  try {
    execSync('systemctl --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasSystemdUnit(): boolean {
  try {
    execSync(`systemctl cat ${SYSTEMD_UNIT} 2>/dev/null`, { stdio: 'ignore' });
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

function isPortInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
  });
}

function killPortHolder(port: number): boolean {
  try {
    const out = execSync(`lsof -ti tcp:${port} 2>/dev/null || fuser ${port}/tcp 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (!out) return false;
    const pids = out.split(/\s+/).map((p) => parseInt(p, 10)).filter((p) => !isNaN(p) && p > 0);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    if (pids.length > 0) {
      sleepSync(1000);
      for (const pid of pids) {
        if (isAlive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      }
    }
    return pids.length > 0;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) return null;
  if (isAlive(pid)) return pid;
  try { unlinkSync(PID_FILE); } catch {}
  return null;
}

function findWebDir(): string | null {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const monorepoRoot = join(__dirname, '..', '..', '..', '..');

  const candidates = [
    join(monorepoRoot, 'packages', 'web'),
    join(homedir(), '.orionomega', 'src', 'packages', 'web'),
    join(homedir(), '.orionomega', 'packages', 'web'),
    `${process.cwd()}/packages/web`,
  ];

  for (const c of candidates) {
    if (existsSync(`${c}/package.json`)) return c;
  }
  return null;
}

function findServerPath(): string | null {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const monorepoRoot = join(__dirname, '..', '..', '..', '..');

  const candidates = [
    join(monorepoRoot, 'packages', 'web', 'server.mjs'),
    join(homedir(), '.orionomega', 'src', 'packages', 'web', 'server.mjs'),
    join(homedir(), '.orionomega', 'packages', 'web', 'server.mjs'),
    join(process.cwd(), 'packages', 'web', 'server.mjs'),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function parseUIArgs(args: string[]): { host: string | null; port: string | null } {
  let host: string | null = null;
  let port: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-H' || args[i] === '--hostname') && args[i + 1]) {
      host = args[i + 1];
      i++;
    } else if ((args[i] === '-p' || args[i] === '--port') && args[i + 1]) {
      port = args[i + 1];
      i++;
    }
  }
  return { host, port };
}

async function startDev(args: string[], force = false): Promise<void> {
  const existing = readPid();
  if (existing) {
    if (force) {
      try {
        process.kill(existing, 'SIGTERM');
        if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
        if (!waitForExit(existing)) {
          process.stdout.write(`${RED}✗${RESET} Existing UI (PID ${existing}) did not stop in time\n`);
          return;
        }
        process.stdout.write(`${GREEN}✓${RESET} Stopped existing UI (PID ${existing})\n`);
      } catch {}
    } else {
      process.stdout.write(`${YELLOW}⚠${RESET} Web UI already running (PID ${existing})\n`);
      return;
    }
  }

  const serverPath = findServerPath();
  if (!serverPath) {
    process.stdout.write(`${RED}✗${RESET} Web UI server.mjs not found\n`);
    process.stdout.write(`  Ensure the web package is available.\n`);
    return;
  }

  const webDir = findWebDir();
  if (!webDir) {
    process.stdout.write(`${RED}✗${RESET} Web package directory not found\n`);
    return;
  }

  const cliArgs = parseUIArgs(args);
  const fullConfig = readConfig();
  const bindAddresses = normalizeBindAddresses(
    cliArgs.host || process.env.HOST || fullConfig.webui.bind,
  );
  const host = bindAddresses.join(',');
  const port = cliArgs.port || process.env.PORT || String(fullConfig.webui.port);
  const portNum = parseInt(port, 10);

  if (await isPortInUse(portNum)) {
    process.stdout.write(`${YELLOW}⚠${RESET} Port ${port} already in use — attempting to free it...\n`);
    const killed = killPortHolder(portNum);
    if (killed) {
      sleepSync(500);
    }
    if (await isPortInUse(portNum)) {
      process.stdout.write(`${RED}✗${RESET} Port ${port} is still in use. Stop the other process or use --port <N>\n`);
      return;
    }
    process.stdout.write(`${GREEN}✓${RESET} Port ${port} freed\n`);
  }

  ensureDir();
  const logFd = openSync(LOG_FILE, 'a');

  const child = spawn('node', [serverPath], {
    cwd: webDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, HOST: host, PORT: port },
  });

  child.unref();

  if (child.pid) {
    writeFileSync(PID_FILE, String(child.pid), 'utf-8');
    process.stdout.write(`${GREEN}✓${RESET} Web UI started (PID ${child.pid}, http://${host}:${port})\n`);
    process.stdout.write(`  ${DIM}Log: ${LOG_FILE}${RESET}\n`);
  } else {
    process.stdout.write(`${RED}✗${RESET} Failed to start Web UI\n`);
  }
}

function stopDev(): void {
  const pid = readPid();
  if (!pid) {
    process.stdout.write(`${YELLOW}⚠${RESET} Web UI is not running\n`);
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    if (waitForExit(pid)) {
      process.stdout.write(`${GREEN}✓${RESET} Web UI stopped (PID ${pid})\n`);
    } else {
      process.stdout.write(`${YELLOW}⚠${RESET} Web UI sent SIGTERM (PID ${pid}) but process still running\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${RED}✗${RESET} Failed to stop Web UI: ${msg}\n`);
  }
}

function statusDev(): void {
  const pid = readPid();
  const fullConfig = readConfig();
  const bindAddresses = normalizeBindAddresses(fullConfig.webui.bind);
  const host = bindAddresses.join(',');
  const port = fullConfig.webui.port;
  if (pid) {
    process.stdout.write(`${GREEN}✓${RESET} Web UI is running (PID ${pid}, http://${host}:${port})\n`);
  } else {
    process.stdout.write(`${RED}✗${RESET} Web UI is not running\n`);
  }
}

async function runDevMode(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case 'start': await startDev(args); break;
    case 'stop': stopDev(); break;
    case 'restart': await startDev(args, true); break;
    case 'status': statusDev(); break;
  }
}

export async function restartWebUI(): Promise<{ stopped: number | null; started: number | null }> {
  const stopped = readPid();
  if (stopped) {
    try {
      process.kill(stopped, 'SIGTERM');
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
      if (!waitForExit(stopped)) {
        try { process.kill(stopped, 'SIGKILL'); } catch {}
        waitForExit(stopped, 2000);
      }
    } catch {}
  }

  const serverPath = findServerPath();
  const webDir = findWebDir();
  if (!serverPath || !webDir) {
    return { stopped, started: null };
  }

  const fullConfig = readConfig();
  const bindAddresses = normalizeBindAddresses(
    process.env.HOST || fullConfig.webui.bind,
  );
  const host = bindAddresses.join(',');
  const port = process.env.PORT || String(fullConfig.webui.port);
  const portNum = parseInt(port, 10);

  if (await isPortInUse(portNum)) {
    killPortHolder(portNum);
    sleepSync(500);
  }

  ensureDir();
  const logFd = openSync(LOG_FILE, 'a');

  const child = spawn('node', [serverPath], {
    cwd: webDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, HOST: host, PORT: port },
  });
  child.unref();

  if (child.pid) {
    writeFileSync(PID_FILE, String(child.pid), 'utf-8');
    sleepSync(500);
    if (!isAlive(child.pid)) {
      try { unlinkSync(PID_FILE); } catch {}
      return { stopped, started: null };
    }
  }

  return { stopped, started: child.pid ?? null };
}

export async function runUI(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || !['start', 'stop', 'restart', 'status'].includes(sub)) {
    process.stdout.write(`\n${BOLD}Usage:${RESET} orionomega ui <start|stop|restart|status>\n\n`);
    return;
  }

  const subArgs = args.slice(1);

  if (hasSystemd() && hasSystemdUnit()) {
    try {
      if (sub === 'status') {
        try {
          const active = execSync(`systemctl is-active ${SYSTEMD_UNIT} 2>&1`, { encoding: 'utf-8' }).trim();
          if (active === 'active') {
            const fullConfig = readConfig();
            const pid = execSync(`systemctl show ${SYSTEMD_UNIT} --property=MainPID --value 2>/dev/null`, { encoding: 'utf-8' }).trim();
            process.stdout.write(`${GREEN}✓${RESET} Web UI is running (PID ${pid}, port ${fullConfig.webui.port}, systemd)\n`);
          } else {
            process.stdout.write(`${RED}✗${RESET} Web UI is ${active} (systemd)\n`);
          }
        } catch {
          process.stdout.write(`${RED}✗${RESET} Web UI is not running (systemd)\n`);
        }
        return;
      } else {
        execSync(`sudo systemctl ${sub} ${SYSTEMD_UNIT}`, { stdio: 'inherit' });
        const pastTense: Record<string, string> = { start: 'started', stop: 'stopped', restart: 'restarted' };
        process.stdout.write(`${GREEN}✓${RESET} Web UI ${pastTense[sub] ?? sub} via systemd\n`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (sub === 'status') {
        process.stdout.write(`${DIM}systemd unit not active, checking dev mode...${RESET}\n`);
        statusDev();
      } else {
        process.stdout.write(`${RED}✗${RESET} systemctl ${sub} failed: ${msg.slice(0, 200)}\n`);
      }
    }
  } else {
    await runDevMode(sub, subArgs);
  }
}
