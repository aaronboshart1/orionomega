/**
 * @module commands/update
 * Pull latest code, rebuild, and restart the gateway.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function step(label: string, cmd: string, cwd: string): boolean {
  process.stdout.write(`  ${DIM}${label}...${RESET} `);
  try {
    execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' });
    process.stdout.write(`${GREEN}✓${RESET}\n`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${RED}✗${RESET}\n`);
    process.stdout.write(`    ${DIM}${msg.slice(0, 200)}${RESET}\n`);
    return false;
  }
}

/**
 * Update OrionOmega: git pull, pnpm install, pnpm build, restart gateway.
 */
export async function runUpdate(): Promise<void> {
  process.stdout.write(`\n${BOLD}Updating OrionOmega${RESET}\n\n`);

  // Find install directory
  const candidates = ['/opt/orionomega', process.cwd()];
  let installDir: string | null = null;
  for (const c of candidates) {
    if (existsSync(`${c}/package.json`) && existsSync(`${c}/.git`)) {
      installDir = c;
      break;
    }
  }

  if (!installDir) {
    process.stdout.write(`${RED}✗${RESET} Cannot find OrionOmega git repository\n`);
    process.stdout.write(`  ${DIM}Expected at /opt/orionomega or current directory${RESET}\n`);
    return;
  }

  process.stdout.write(`  ${DIM}Install directory: ${installDir}${RESET}\n\n`);

  if (!step('Pulling latest changes', 'git pull', installDir)) return;
  if (!step('Installing dependencies', 'pnpm install --frozen-lockfile', installDir)) {
    // Try without frozen lockfile
    if (!step('Installing dependencies (unfrozen)', 'pnpm install', installDir)) return;
  }
  if (!step('Building', 'pnpm build', installDir)) return;

  // Restart gateway
  process.stdout.write(`  ${DIM}Restarting gateway...${RESET} `);
  try {
    execSync('systemctl restart orionomega 2>/dev/null || true', { stdio: 'pipe' });
    process.stdout.write(`${GREEN}✓${RESET}\n`);
  } catch {
    process.stdout.write(`${DIM}skipped (no systemd unit)${RESET}\n`);
  }

  process.stdout.write(`\n${GREEN}✓${RESET} ${BOLD}Update complete!${RESET}\n\n`);
}
