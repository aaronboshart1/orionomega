/**
 * @module commands/ui
 * Launch the OrionOmega web dashboard.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Start the Next.js web dashboard.
 */
export async function runUI(): Promise<void> {
  // Find the web package
  const candidates = [
    `${process.cwd()}/packages/web`,
    '/opt/orionomega/packages/web',
  ];

  let webDir: string | null = null;
  for (const c of candidates) {
    if (existsSync(`${c}/package.json`)) {
      webDir = c;
      break;
    }
  }

  if (!webDir) {
    process.stdout.write(`${RED}✗${RESET} Web package not found\n`);
    process.stdout.write(`  ${DIM}Expected at packages/web/ or /opt/orionomega/packages/web/${RESET}\n`);
    return;
  }

  // Determine dev vs production mode
  const isDev = process.env.NODE_ENV === 'development' || !existsSync(`${webDir}/.next`);
  const cmd = isDev ? 'dev' : 'start';

  process.stdout.write(`\n${BOLD}Starting OrionOmega Web UI${RESET} ${DIM}(${isDev ? 'development' : 'production'} mode)${RESET}\n`);
  process.stdout.write(`${DIM}Press Ctrl+C to stop${RESET}\n\n`);

  const child = spawn('pnpm', [cmd, '-H', '0.0.0.0'], {
    cwd: webDir,
    stdio: 'inherit',
    env: { ...process.env },
  });

  process.on('SIGINT', () => {
    child.kill();
    process.exit(0);
  });

  await new Promise<void>((resolve) => {
    child.on('close', resolve);
  });
}
