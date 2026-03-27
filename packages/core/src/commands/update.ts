/**
 * @module commands/update
 * Pull latest code, rebuild, and restart the gateway + web UI.
 *
 * Shared logic used by both `orionomega update` (CLI) and `/update` (slash command).
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

function findPidOnPort(port: number): number | null {
  try {
    const result = execSync(
      `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`,
      { timeout: 5000, shell: '/bin/sh' as any },
    ).toString().trim();
    if (!result) return null;
    const pids = result.split('\n').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    for (const pid of pids) {
      try {
        const cmdline = execSync(`ps -p ${pid} -o args= 2>/dev/null || true`, {
          timeout: 3000,
          shell: '/bin/sh' as any,
        }).toString().trim();
        if (cmdline.includes('server.js') || cmdline.includes('gateway')) {
          return pid;
        }
      } catch { /* skip */ }
    }
    return pids[0] ?? null;
  } catch {
    return null;
  }
}

export function findInstallDirectory(): string | null {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  const monorepoRoot = join(__dirname, '..', '..', '..', '..');
  const candidates = [
    monorepoRoot,
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

export interface UpdateStep {
  label: string;
  cmd: string;
  timeout: number;
}

export const UPDATE_STEPS: UpdateStep[] = [
  { label: 'Pulling latest changes', cmd: 'git pull', timeout: 30_000 },
  { label: 'Installing dependencies', cmd: 'pnpm install --frozen-lockfile || pnpm install', timeout: 120_000 },
  { label: 'Building all packages', cmd: 'pnpm build', timeout: 120_000 },
];

export interface UpdateCallbacks {
  onStep: (label: string) => void;
  onStepDone: (label: string) => void;
  onStepFailed: (label: string, error: string) => void;
}

export function runUpdateSteps(installDir: string, callbacks: UpdateCallbacks): boolean {
  for (const s of UPDATE_STEPS) {
    callbacks.onStep(s.label);
    try {
      execSync(s.cmd, { cwd: installDir, stdio: 'pipe', timeout: s.timeout, shell: '/bin/sh' as any });
      callbacks.onStepDone(s.label);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks.onStepFailed(s.label, msg.slice(0, 200));
      return false;
    }
  }
  return true;
}

export function stopGateway(port = 8000): number | null {
  let gatewayPid = readPid();
  if (!gatewayPid) {
    gatewayPid = findPidOnPort(port);
  }
  if (!gatewayPid) return null;
  try {
    process.kill(gatewayPid, 'SIGTERM');
    let waited = 0;
    while (waited < 5000) {
      try { process.kill(gatewayPid, 0); } catch { break; }
      execSync('sleep 0.5');
      waited += 500;
    }
    try { process.kill(gatewayPid, 0); process.kill(gatewayPid, 'SIGKILL'); } catch { /* done */ }
  } catch {
    // already stopped
  }
  return gatewayPid;
}

export function startGateway(installDir: string): number | null {
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
  return child.pid ?? null;
}

export async function runUpdate(): Promise<void> {
  process.stdout.write(`\n${BOLD}Updating OrionOmega${RESET}\n\n`);

  const installDir = findInstallDirectory();
  if (!installDir) {
    process.stdout.write(`${RED}✗${RESET} Cannot find OrionOmega git repository\n`);
    process.stdout.write(`  ${DIM}Expected at ~/.orionomega/src or current directory${RESET}\n`);
    return;
  }

  process.stdout.write(`  ${DIM}Install directory: ${installDir}${RESET}\n\n`);

  const gatewayPid = stopGateway();
  if (gatewayPid) {
    process.stdout.write(`  ${DIM}Stopped gateway (PID ${gatewayPid})${RESET} ${GREEN}✓${RESET}\n`);
  } else {
    process.stdout.write(`  ${DIM}Gateway not running${RESET}\n`);
  }

  const ok = runUpdateSteps(installDir, {
    onStep: (label) => process.stdout.write(`  ${DIM}${label}...${RESET} `),
    onStepDone: () => process.stdout.write(`${GREEN}✓${RESET}\n`),
    onStepFailed: (_label, error) => {
      process.stdout.write(`${RED}✗${RESET}\n`);
      process.stdout.write(`    ${DIM}${error}${RESET}\n`);
    },
  });

  if (!ok) return;

  process.stdout.write(`\n  ${DIM}Starting gateway...${RESET} `);
  const pid = startGateway(installDir);
  if (pid) {
    process.stdout.write(`${GREEN}✓${RESET} (PID ${pid})\n`);
  } else {
    process.stdout.write(`${RED}✗${RESET} failed to start\n`);
  }

  process.stdout.write(`\n${GREEN}✓${RESET} ${BOLD}Update complete!${RESET}\n`);
  process.stdout.write(`  ${DIM}Run 'orionomega ui' to start the web dashboard${RESET}\n\n`);
}
