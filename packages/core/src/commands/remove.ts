/**
 * @module commands/remove
 * Fully uninstall OrionOmega from the current machine.
 *
 * Steps:
 * 1. Stop the gateway (if running)
 * 2. Remove the global CLI link (pnpm/npm)
 * 3. Remove config & data directory (~/.orionomega)
 * 4. Remove the source/install directory
 */

import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { findInstallDirectory, stopGateway } from './update.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const CONFIG_DIR = join(homedir(), '.orionomega');

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function unlinkGlobalCli(): boolean {
  const managers = ['pnpm', 'npm'];
  for (const mgr of managers) {
    try {
      execSync(`${mgr} unlink -g @orionomega/core 2>/dev/null`, {
        timeout: 15_000,
        stdio: 'pipe',
        shell: '/bin/sh' as any,
      });
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

export async function runRemove(): Promise<void> {
  process.stdout.write(`\n${BOLD}${RED}OrionOmega — Uninstall${RESET}\n\n`);

  const installDir = findInstallDirectory();
  const configExists = existsSync(CONFIG_DIR);

  process.stdout.write(`  This will remove OrionOmega from this machine:\n\n`);

  if (installDir) {
    process.stdout.write(`    ${DIM}Source directory:${RESET}  ${installDir}\n`);
  }
  if (configExists) {
    process.stdout.write(`    ${DIM}Config & data:${RESET}    ${CONFIG_DIR}\n`);
  }
  process.stdout.write(`    ${DIM}Global CLI link:${RESET}  orionomega command\n`);

  if (!installDir && !configExists) {
    process.stdout.write(`\n  ${YELLOW}Nothing to remove — OrionOmega does not appear to be installed.${RESET}\n\n`);
    return;
  }

  process.stdout.write('\n');
  const answer = await prompt(`  ${BOLD}Are you sure? This cannot be undone.${RESET} (yes/no): `);
  if (answer !== 'yes' && answer !== 'y') {
    process.stdout.write(`\n  ${DIM}Cancelled.${RESET}\n\n`);
    return;
  }

  process.stdout.write('\n');

  process.stdout.write(`  ${DIM}Stopping gateway...${RESET} `);
  const pid = stopGateway();
  if (pid) {
    process.stdout.write(`${GREEN}✓${RESET} (PID ${pid})\n`);
  } else {
    process.stdout.write(`${DIM}not running${RESET}\n`);
  }

  process.stdout.write(`  ${DIM}Removing global CLI link...${RESET} `);
  const unlinked = unlinkGlobalCli();
  process.stdout.write(unlinked ? `${GREEN}✓${RESET}\n` : `${DIM}not linked${RESET}\n`);

  if (configExists) {
    process.stdout.write(`  ${DIM}Removing config & data (${CONFIG_DIR})...${RESET} `);
    try {
      rmSync(CONFIG_DIR, { recursive: true, force: true });
      process.stdout.write(`${GREEN}✓${RESET}\n`);
    } catch (err) {
      process.stdout.write(`${RED}✗${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  if (installDir) {
    const isCwd = installDir === process.cwd();
    process.stdout.write(`  ${DIM}Removing source directory (${installDir})...${RESET} `);
    try {
      rmSync(installDir, { recursive: true, force: true });
      process.stdout.write(`${GREEN}✓${RESET}\n`);
    } catch (err) {
      process.stdout.write(`${RED}✗${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
    }
    if (isCwd) {
      process.stdout.write(`\n  ${YELLOW}Note: You were inside the source directory.${RESET}\n`);
      process.stdout.write(`  ${DIM}Run 'cd ~' to navigate out of the deleted directory.${RESET}\n`);
    }
  }

  process.stdout.write(`\n  ${GREEN}✓${RESET} ${BOLD}OrionOmega has been removed.${RESET}\n\n`);
}
