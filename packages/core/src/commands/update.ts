/**
 * @module commands/update
 * Pull latest code, rebuild, and restart the gateway + web UI.
 *
 * Shared logic used by both `orionomega update` (CLI) and `/update` (slash command).
 *
 * Implements a full update lifecycle:
 *   1. Pre-update checks (git, clean state, network, permissions)
 *   2. Pull latest code with conflict handling
 *   3. Install dependencies + build with rollback on failure
 *   4. Restart services with health checks
 *   5. Automatic rollback on any failure
 */

import { execSync, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findPidOnPort, safeChildEnv, sleepSync } from './process-utils.js';

/* ── ANSI color codes ─────────────────────────────────────────────── */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/* ── Constants ────────────────────────────────────────────────────── */

const PID_FILE = join(homedir(), '.orionomega', 'gateway.pid');
const GATEWAY_PORT = 8000;
const WEBUI_PORT = 5000;

/* ── Helpers ──────────────────────────────────────────────────────── */

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

function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function execCmd(cmd: string, cwd: string, timeout: number): string {
  return execSync(cmd, {
    cwd,
    stdio: 'pipe',
    timeout,
    shell: '/bin/sh',
    encoding: 'utf-8',
  });
}

function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
  });
}

/* ── Public exports ───────────────────────────────────────────────── */

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

/* ── Update callbacks ─────────────────────────────────────────────── */

export interface UpdateCallbacks {
  onStep: (label: string) => void;
  onStepDone: (label: string, detail?: string) => void;
  onStepFailed: (label: string, error: string) => void;
  onInfo: (message: string) => void;
  onRollback: (message: string) => void;
}

/* ── Pre-update checks ────────────────────────────────────────────── */

export interface PreCheckResult {
  ok: boolean;
  installDir: string | null;
  currentCommit: string | null;
  branch: string | null;
  errors: string[];
}

export function runPreChecks(installDir: string | null): PreCheckResult {
  const errors: string[] = [];
  let currentCommit: string | null = null;
  let branch: string | null = null;

  // 1. Verify install directory
  if (!installDir) {
    return { ok: false, installDir: null, currentCommit: null, branch: null, errors: ['Cannot find OrionOmega git repository (expected at ~/.orionomega/src or monorepo root)'] };
  }

  // 2. Verify git is available
  try {
    execSync('git --version', { stdio: 'pipe', timeout: 5000 });
  } catch {
    errors.push('git is not installed or not in PATH');
    return { ok: false, installDir, currentCommit: null, branch: null, errors };
  }

  // 3. Save current commit hash for rollback
  try {
    currentCommit = execCmd('git rev-parse HEAD', installDir, 5000).trim();
  } catch {
    errors.push('Failed to read current git commit — is this a valid git repository?');
  }

  // 4. Get current branch
  try {
    branch = execCmd('git rev-parse --abbrev-ref HEAD', installDir, 5000).trim();
  } catch {
    errors.push('Failed to determine current git branch');
  }

  // 5. Check for clean working tree (uncommitted changes block git pull)
  try {
    const status = execCmd('git status --porcelain', installDir, 10000).trim();
    if (status) {
      const changedFiles = status.split('\n').length;
      errors.push(`Working tree is dirty (${changedFiles} modified file${changedFiles !== 1 ? 's' : ''}). Commit or stash changes first.`);
    }
  } catch {
    errors.push('Failed to check git working tree status');
  }

  // 6. Check network connectivity (can we reach the remote?)
  try {
    execCmd('git ls-remote --exit-code --heads origin HEAD', installDir, 15000);
  } catch {
    errors.push('Cannot reach git remote "origin" — check network connectivity');
  }

  // 7. Verify pnpm is available
  try {
    execSync('pnpm --version', { stdio: 'pipe', timeout: 5000 });
  } catch {
    errors.push('pnpm is not installed or not in PATH');
  }

  return { ok: errors.length === 0, installDir, currentCommit, branch, errors };
}

/* ── Git pull ─────────────────────────────────────────────────────── */

export interface PullResult {
  ok: boolean;
  newCommit: string | null;
  commitCount: number;
  summary: string;
  alreadyUpToDate: boolean;
}

export function pullLatest(installDir: string, branch: string | null): PullResult {
  const remoteBranch = branch || 'main';

  // Fetch first to see what's available
  try {
    execCmd('git fetch origin', installDir, 30000);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, newCommit: null, commitCount: 0, summary: `git fetch failed: ${msg.slice(0, 200)}`, alreadyUpToDate: false };
  }

  // Check if there are new commits
  let commitCount = 0;
  try {
    const countStr = execCmd(`git rev-list HEAD..origin/${remoteBranch} --count`, installDir, 5000).trim();
    commitCount = parseInt(countStr, 10) || 0;
  } catch {
    // Non-fatal: we just won't know how many commits ahead
  }

  if (commitCount === 0) {
    const currentCommit = execCmd('git rev-parse --short HEAD', installDir, 5000).trim();
    return { ok: true, newCommit: currentCommit, commitCount: 0, summary: 'Already up to date.', alreadyUpToDate: true };
  }

  // Get a summary of incoming changes before pulling
  let changesSummary = '';
  try {
    changesSummary = execCmd(
      `git log --oneline HEAD..origin/${remoteBranch} | head -10`,
      installDir,
      5000,
    ).trim();
  } catch { /* non-fatal */ }

  // Try fast-forward pull first
  try {
    execCmd('git pull --ff-only', installDir, 30000);
  } catch {
    // Fast-forward failed — try a clean reset to origin
    try {
      execCmd(`git reset --hard origin/${remoteBranch}`, installDir, 15000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Abort any merge in progress
      try { execCmd('git merge --abort', installDir, 5000); } catch { /* ok */ }
      return { ok: false, newCommit: null, commitCount, summary: `Pull failed: ${msg.slice(0, 200)}`, alreadyUpToDate: false };
    }
  }

  let newCommit: string | null = null;
  try {
    newCommit = execCmd('git rev-parse --short HEAD', installDir, 5000).trim();
  } catch { /* non-fatal */ }

  const summary = changesSummary
    ? `${commitCount} new commit${commitCount !== 1 ? 's' : ''}:\n${changesSummary}`
    : `${commitCount} new commit${commitCount !== 1 ? 's' : ''}`;

  return { ok: true, newCommit, commitCount, summary, alreadyUpToDate: false };
}

/* ── Build steps ──────────────────────────────────────────────────── */

export function installDependencies(installDir: string): { ok: boolean; error?: string } {
  try {
    // 5 min: matches UPDATE_STEPS install timeout. Older 180_000 was tight on
    // slow hardware where pnpm has to fetch and link a fresh node_modules.
    execCmd('pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1', installDir, 300_000);
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 300) };
  }
}

export function buildProject(installDir: string): { ok: boolean; error?: string } {
  try {
    // 10 min: matches UPDATE_STEPS build timeout. Full monorepo (core +
    // gateway + web + tui + skills-sdk + hindsight) build can exceed 5 min on
    // a Kali VM; if this trips, dist/ ends up partially populated and the
    // gateway loads stale code from the previous successful build.
    execCmd('pnpm build 2>&1', installDir, 600_000);
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 300) };
  }
}

/**
 * Wipe every package's `dist/` directory. Used by `orionomega update --clean`
 * (and by callers recovering from a half-finished build) so the next build
 * starts from a clean slate and cannot inherit stale compiled JavaScript from
 * a previous failed run.
 */
export function cleanDistDirectories(installDir: string): { ok: boolean; error?: string } {
  try {
    // `rm -rf` per glob is portable across macOS BSD `rm` and GNU `rm`. The
    // 2>/dev/null swallows "no match" when running on a tree that has never
    // been built, which is fine — there is nothing to clean.
    execCmd('rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo 2>/dev/null || true', installDir, 30_000);
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 300) };
  }
}

/* ── Rollback ─────────────────────────────────────────────────────── */

export function rollback(installDir: string, targetCommit: string): { ok: boolean; error?: string } {
  try {
    execCmd(`git reset --hard ${targetCommit}`, installDir, 15000);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `git reset failed: ${msg.slice(0, 200)}` };
  }

  // Rebuild from rolled-back state
  const depResult = installDependencies(installDir);
  if (!depResult.ok) {
    return { ok: false, error: `Rollback dependency install failed: ${depResult.error}` };
  }

  const buildResult = buildProject(installDir);
  if (!buildResult.ok) {
    return { ok: false, error: `Rollback build failed: ${buildResult.error}` };
  }

  return { ok: true };
}

/* ── Service management ───────────────────────────────────────────── */

export function stopGateway(port = GATEWAY_PORT): number | null {
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
      sleepSync(500);
      waited += 500;
    }
    try { process.kill(gatewayPid, 0); process.kill(gatewayPid, 'SIGKILL'); } catch { /* done */ }
  } catch {
    // already stopped
  }
  return gatewayPid;
}

export function relinkCli(installDir: string): void {
  const binDir = join(homedir(), '.orionomega', 'bin');
  const binTarget = join(binDir, 'orionomega');
  const binScript = join(installDir, 'packages', 'core', 'bin', 'orionomega');
  const cliJs = join(installDir, 'packages', 'core', 'dist', 'cli.js');

  mkdirSync(binDir, { recursive: true });

  try { unlinkSync(binTarget); } catch { /* doesn't exist yet */ }

  if (existsSync(binScript)) {
    symlinkSync(binScript, binTarget);
    try { chmodSync(binScript, 0o755); } catch { /* ok */ }
  } else if (existsSync(cliJs)) {
    writeFileSync(binTarget, `#!/usr/bin/env bash\nexec node "${cliJs}" "$@"\n`, 'utf-8');
    chmodSync(binTarget, 0o755);
  }
}

export function startGateway(installDir: string): number | null {
  const gatewayEntry = join(installDir, 'packages', 'gateway', 'dist', 'server.js');
  if (!existsSync(gatewayEntry)) return null;
  const child = spawn(process.execPath, [gatewayEntry], {
    stdio: 'ignore',
    detached: true,
    env: safeChildEnv(),
  });
  child.unref();
  if (child.pid) {
    writeFileSync(PID_FILE, String(child.pid), 'utf-8');
  }
  return child.pid ?? null;
}

export async function healthCheckGateway(port = GATEWAY_PORT, retries = 10, intervalMs = 1000): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    if (await isPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export async function healthCheckWebUI(port = WEBUI_PORT, retries = 10, intervalMs = 1000): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    if (await isPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/* ── Orchestrated update (used by /update slash command) ──────────── */

export interface UpdateResult {
  success: boolean;
  oldCommit: string | null;
  newCommit: string | null;
  alreadyUpToDate: boolean;
  rolledBack: boolean;
  error?: string;
  durationMs: number;
}

export async function runOrchestatedUpdate(callbacks: UpdateCallbacks): Promise<UpdateResult> {
  const totalStart = Date.now();
  let oldCommit: string | null = null;
  let newCommit: string | null = null;

  /* ── Step 1: Pre-flight checks ─────────────────────────────────── */
  callbacks.onStep('Running pre-update checks…');
  const stepStart1 = Date.now();

  const installDir = findInstallDirectory();
  const preCheck = runPreChecks(installDir);

  if (!preCheck.ok || !preCheck.installDir) {
    const errMsg = preCheck.errors.join('; ');
    callbacks.onStepFailed('Pre-update checks', errMsg);
    return { success: false, oldCommit: null, newCommit: null, alreadyUpToDate: false, rolledBack: false, error: errMsg, durationMs: Date.now() - totalStart };
  }

  oldCommit = preCheck.currentCommit;
  const dir = preCheck.installDir;
  const shortOld = oldCommit ? oldCommit.slice(0, 7) : 'unknown';

  callbacks.onStepDone('Pre-update checks', `branch: ${preCheck.branch}, commit: ${shortOld} (${elapsed(stepStart1)})`);

  /* ── Step 2: Pull latest code ──────────────────────────────────── */
  callbacks.onStep('Pulling latest changes…');
  const stepStart2 = Date.now();

  const pullResult = pullLatest(dir, preCheck.branch);

  if (!pullResult.ok) {
    callbacks.onStepFailed('Pull latest changes', pullResult.summary);
    return { success: false, oldCommit, newCommit: null, alreadyUpToDate: false, rolledBack: false, error: pullResult.summary, durationMs: Date.now() - totalStart };
  }

  if (pullResult.alreadyUpToDate) {
    callbacks.onStepDone('Pull latest changes', `Already up to date at ${pullResult.newCommit} (${elapsed(stepStart2)})`);
    callbacks.onInfo('No updates available. Services remain running.');
    return { success: true, oldCommit, newCommit: pullResult.newCommit, alreadyUpToDate: true, rolledBack: false, durationMs: Date.now() - totalStart };
  }

  newCommit = pullResult.newCommit;
  callbacks.onStepDone('Pull latest changes', `${pullResult.summary} (${elapsed(stepStart2)})`);

  /* ── Step 3: Install dependencies ──────────────────────────────── */
  callbacks.onStep('Installing dependencies…');
  const stepStart3 = Date.now();

  const depResult = installDependencies(dir);
  if (!depResult.ok) {
    callbacks.onStepFailed('Install dependencies', depResult.error || 'Unknown error');

    // Rollback
    if (oldCommit) {
      callbacks.onRollback(`Dependency install failed — rolling back to ${shortOld}…`);
      const rb = rollback(dir, oldCommit);
      if (rb.ok) {
        callbacks.onRollback(`Rollback to ${shortOld} successful.`);
      } else {
        callbacks.onRollback(`Rollback failed: ${rb.error}`);
      }
    }

    return { success: false, oldCommit, newCommit, alreadyUpToDate: false, rolledBack: !!oldCommit, error: `Dependency install failed: ${depResult.error}`, durationMs: Date.now() - totalStart };
  }

  callbacks.onStepDone('Install dependencies', elapsed(stepStart3));

  /* ── Step 4: Build ─────────────────────────────────────────────── */
  callbacks.onStep('Building all packages…');
  const stepStart4 = Date.now();

  const buildResult = buildProject(dir);
  if (!buildResult.ok) {
    callbacks.onStepFailed('Build', buildResult.error || 'Unknown error');

    // Rollback
    if (oldCommit) {
      callbacks.onRollback(`Build failed — rolling back to ${shortOld}…`);
      const rb = rollback(dir, oldCommit);
      if (rb.ok) {
        callbacks.onRollback(`Rollback to ${shortOld} successful.`);
      } else {
        callbacks.onRollback(`Rollback failed: ${rb.error}`);
      }
    }

    return { success: false, oldCommit, newCommit, alreadyUpToDate: false, rolledBack: !!oldCommit, error: `Build failed: ${buildResult.error}`, durationMs: Date.now() - totalStart };
  }

  callbacks.onStepDone('Build', elapsed(stepStart4));

  /* ── Step 5: Relink CLI binary ─────────────────────────────────── */
  try {
    relinkCli(dir);
  } catch { /* non-fatal */ }

  /* ── Step 6: Restart Web UI ────────────────────────────────────── */
  callbacks.onStep('Restarting Web UI…');
  const stepStart6 = Date.now();
  let webUiHealthy = false;

  try {
    const { restartWebUI } = await import('./ui.js');
    const uiResult = await restartWebUI();
    if (uiResult.started) {
      // Health check: wait for port to be listening
      webUiHealthy = await healthCheckWebUI(WEBUI_PORT, 10, 1000);
      if (webUiHealthy) {
        callbacks.onStepDone('Restart Web UI', `PID ${uiResult.started}, healthy (${elapsed(stepStart6)})`);
      } else {
        callbacks.onStepDone('Restart Web UI', `PID ${uiResult.started}, started but health check timed out (${elapsed(stepStart6)})`);
      }
    } else {
      callbacks.onStepFailed('Restart Web UI', `server.mjs not found (${elapsed(stepStart6)})`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    callbacks.onStepFailed('Restart Web UI', `${msg} (${elapsed(stepStart6)})`);
  }

  /* ── Step 7: Restart Gateway ───────────────────────────────────── */
  // The gateway restart is last because in the slash command path the current
  // process IS the gateway — so we report success and then exit to let the
  // supervisor (systemd or the restart wrapper) bring us back up.
  callbacks.onStepDone('Update', `${shortOld} → ${newCommit || 'unknown'} in ${elapsed(totalStart)}`);

  return {
    success: true,
    oldCommit,
    newCommit,
    alreadyUpToDate: false,
    rolledBack: false,
    durationMs: Date.now() - totalStart,
  };
}

/* ── Legacy compatibility: UpdateStep / runUpdateSteps ─────────────
 * Retained so that any code that imports the old interface still works.
 */

export interface UpdateStep {
  label: string;
  cmd: string;
  timeout: number;
}

// IMPORTANT: these timeouts must accommodate the full monorepo build on slow
// hardware (Kali VMs, low-spec laptops). The previous values (120 s for both
// install and build) were set when only @orionomega/core existed and routinely
// time out today, which silently abandons the build mid-way and leaves a
// half-fresh dist/ — the gateway then loads stale compiled code that still
// has the old 120 s worker timeout, causing the very "Worker timed out after
// 120s" / "Claude Code process aborted by user" errors users report.
//
// Keep these in sync with the modern path's `installDependencies` /
// `buildProject` helpers above.
export const UPDATE_STEPS: UpdateStep[] = [
  { label: 'Pulling latest changes', cmd: 'git pull --ff-only || { echo "Fast-forward failed. You may have local changes." >&2; exit 1; }', timeout: 60_000 },
  { label: 'Installing dependencies', cmd: 'pnpm install --frozen-lockfile || pnpm install', timeout: 300_000 },
  { label: 'Building all packages', cmd: 'pnpm build', timeout: 600_000 },
];

export function runUpdateSteps(installDir: string, callbacks: { onStep: (l: string) => void; onStepDone: (l: string) => void; onStepFailed: (l: string, e: string) => void }): boolean {
  for (const s of UPDATE_STEPS) {
    callbacks.onStep(s.label);
    try {
      execSync(s.cmd, { cwd: installDir, stdio: 'pipe', timeout: s.timeout, shell: '/bin/sh' });
      callbacks.onStepDone(s.label);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks.onStepFailed(s.label, msg.slice(0, 200));
      return false;
    }
  }
  return true;
}

/* ── CLI entry point: `orionomega update` ─────────────────────────── */

export interface RunUpdateOptions {
  /**
   * When true, wipe every packages/<pkg>/dist directory before building so the
   * build cannot inherit stale compiled JavaScript from a previous half-
   * finished run. This is the recovery flag for users hitting "Worker timed
   * out after 120s" / "Claude Code process aborted by user" because their
   * gateway is running compiled code older than their source tree.
   */
  clean?: boolean;
}

export async function runUpdate(options: RunUpdateOptions = {}): Promise<void> {
  const totalStart = Date.now();
  const cleanRebuild = options.clean === true;
  process.stdout.write(`\n${BOLD}Updating OrionOmega${RESET}${cleanRebuild ? ` ${DIM}(clean rebuild)${RESET}` : ''}\n\n`);

  /* ── Pre-flight checks ─────────────────────────────────────────── */
  process.stdout.write(`  ${DIM}Running pre-update checks...${RESET} `);
  const installDir = findInstallDirectory();
  const preCheck = runPreChecks(installDir);

  if (!preCheck.ok || !preCheck.installDir) {
    process.stdout.write(`${RED}✗${RESET}\n`);
    for (const e of preCheck.errors) {
      process.stdout.write(`    ${RED}•${RESET} ${e}\n`);
    }
    return;
  }

  const dir = preCheck.installDir;
  const oldCommit = preCheck.currentCommit;
  const shortOld = oldCommit ? oldCommit.slice(0, 7) : 'unknown';
  process.stdout.write(`${GREEN}✓${RESET} ${DIM}(${preCheck.branch}@${shortOld})${RESET}\n`);
  process.stdout.write(`  ${DIM}Install directory: ${dir}${RESET}\n\n`);

  /* ── Stop gateway ──────────────────────────────────────────────── */
  process.stdout.write(`  ${DIM}Stopping gateway...${RESET} `);
  const gatewayPid = stopGateway();
  if (gatewayPid) {
    process.stdout.write(`${GREEN}✓${RESET} ${DIM}(PID ${gatewayPid})${RESET}\n`);
  } else {
    process.stdout.write(`${YELLOW}—${RESET} ${DIM}not running${RESET}\n`);
  }

  /* ── Pull ───────────────────────────────────────────────────────── */
  process.stdout.write(`  ${DIM}Pulling latest changes...${RESET} `);
  const pullStart = Date.now();
  const pullResult = pullLatest(dir, preCheck.branch);

  if (!pullResult.ok) {
    process.stdout.write(`${RED}✗${RESET}\n`);
    process.stdout.write(`    ${DIM}${pullResult.summary}${RESET}\n`);
    return;
  }

  if (pullResult.alreadyUpToDate) {
    process.stdout.write(`${GREEN}✓${RESET} ${DIM}already up to date (${elapsed(pullStart)})${RESET}\n`);
    // The whole point of `--clean` is to recover from a stale dist/ even
    // when the source tree already matches the remote — that is the most
    // common stale-build scenario (user pulled the fix days ago, but a
    // 120s-killed `pnpm build` left half-stale compiled JS behind). So we
    // ONLY short-circuit here in the non-clean path; with --clean we fall
    // through to clean + install + build below.
    if (!cleanRebuild) {
      process.stdout.write(`\n${GREEN}✓${RESET} ${BOLD}No updates available.${RESET}\n\n`);
      // Still restart the services that were stopped
      startServicesForCli(dir);
      return;
    }
    process.stdout.write(`  ${DIM}Continuing with clean rebuild despite no new commits...${RESET}\n`);
  } else {
    process.stdout.write(`${GREEN}✓${RESET} ${DIM}${pullResult.commitCount} commit${pullResult.commitCount !== 1 ? 's' : ''} (${elapsed(pullStart)})${RESET}\n`);
  }

  /* ── Optional: clean dist/ directories ──────────────────────────── */
  if (cleanRebuild) {
    process.stdout.write(`  ${DIM}Cleaning dist/ directories...${RESET} `);
    const cleanStart = Date.now();
    const cleanResult = cleanDistDirectories(dir);
    if (cleanResult.ok) {
      process.stdout.write(`${GREEN}✓${RESET} ${DIM}(${elapsed(cleanStart)})${RESET}\n`);
    } else {
      // Non-fatal: a failed clean still lets the build proceed (it'll just
      // overwrite stale files), but warn so the user can investigate.
      process.stdout.write(`${YELLOW}⚠${RESET} ${DIM}${cleanResult.error}${RESET}\n`);
    }
  }

  /* ── Install dependencies ───────────────────────────────────────── */
  process.stdout.write(`  ${DIM}Installing dependencies...${RESET} `);
  const depStart = Date.now();
  const depResult = installDependencies(dir);

  if (!depResult.ok) {
    process.stdout.write(`${RED}✗${RESET}\n`);
    process.stdout.write(`    ${DIM}${depResult.error}${RESET}\n`);
    cliRollback(dir, oldCommit, shortOld);
    return;
  }

  process.stdout.write(`${GREEN}✓${RESET} ${DIM}(${elapsed(depStart)})${RESET}\n`);

  /* ── Build ──────────────────────────────────────────────────────── */
  process.stdout.write(`  ${DIM}Building all packages...${RESET} `);
  const buildStart = Date.now();
  const buildResult = buildProject(dir);

  if (!buildResult.ok) {
    process.stdout.write(`${RED}✗${RESET}\n`);
    process.stdout.write(`    ${DIM}${buildResult.error}${RESET}\n`);
    cliRollback(dir, oldCommit, shortOld);
    return;
  }

  process.stdout.write(`${GREEN}✓${RESET} ${DIM}(${elapsed(buildStart)})${RESET}\n`);

  /* ── Relink CLI + restart services ──────────────────────────────── */
  relinkCli(dir);
  await startServicesForCli(dir);

  const shortNew = pullResult.newCommit || 'unknown';
  process.stdout.write(`\n${GREEN}✓${RESET} ${BOLD}Update complete!${RESET} ${DIM}${shortOld} → ${shortNew} (${elapsed(totalStart)})${RESET}\n\n`);
}

/* ── CLI helpers ──────────────────────────────────────────────────── */

function cliRollback(dir: string, oldCommit: string | null, shortOld: string): void {
  if (!oldCommit) {
    process.stdout.write(`\n  ${RED}✗${RESET} Cannot rollback — no previous commit hash available\n`);
    return;
  }

  process.stdout.write(`\n  ${YELLOW}⟳${RESET} ${DIM}Rolling back to ${shortOld}...${RESET} `);
  const rb = rollback(dir, oldCommit);
  if (rb.ok) {
    process.stdout.write(`${GREEN}✓${RESET}\n`);
    relinkCli(dir);
  } else {
    process.stdout.write(`${RED}✗${RESET}\n`);
    process.stdout.write(`    ${DIM}${rb.error}${RESET}\n`);
  }
}

async function startServicesForCli(dir: string): Promise<void> {
  process.stdout.write(`\n  ${DIM}Starting gateway...${RESET} `);
  const pid = startGateway(dir);
  if (pid) {
    const healthy = await healthCheckGateway(GATEWAY_PORT, 10, 1000);
    if (healthy) {
      process.stdout.write(`${GREEN}✓${RESET} ${DIM}(PID ${pid}, healthy)${RESET}\n`);
    } else {
      process.stdout.write(`${YELLOW}⚠${RESET} ${DIM}(PID ${pid}, started but health check timed out)${RESET}\n`);
    }
  } else {
    process.stdout.write(`${RED}✗${RESET} failed to start\n`);
  }

  process.stdout.write(`  ${DIM}Restarting Web UI...${RESET} `);
  try {
    const { restartWebUI } = await import('./ui.js');
    const uiResult = await restartWebUI();
    if (uiResult.started) {
      const healthy = await healthCheckWebUI(WEBUI_PORT, 10, 1000);
      if (healthy) {
        process.stdout.write(`${GREEN}✓${RESET} ${DIM}(PID ${uiResult.started}, healthy)${RESET}\n`);
      } else {
        process.stdout.write(`${YELLOW}⚠${RESET} ${DIM}(PID ${uiResult.started}, started but health check timed out)${RESET}\n`);
      }
    } else {
      process.stdout.write(`${RED}✗${RESET} server.mjs not found\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${RED}✗${RESET} ${msg}\n`);
  }
}
