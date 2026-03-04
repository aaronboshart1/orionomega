/**
 * @module commands/logs
 * Tail OrionOmega log files with optional level filtering.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readConfig } from '../config/index.js';

const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Tail the log file, optionally filtering by level.
 */
export async function runLogs(args: string[]): Promise<void> {
  const config = readConfig();
  const logFile = config.logging.file;

  if (!existsSync(logFile)) {
    process.stdout.write(`${RED}✗${RESET} Log file not found: ${logFile}\n`);
    process.stdout.write(`  ${DIM}The gateway may not have started yet.${RESET}\n`);
    return;
  }

  // Parse --level flag
  let level: string | null = null;
  const levelIdx = args.indexOf('--level');
  if (levelIdx !== -1 && args[levelIdx + 1]) {
    level = args[levelIdx + 1];
  }

  process.stdout.write(`${DIM}Tailing ${logFile}${level ? ` (filtering: ${level})` : ''}${RESET}\n`);
  process.stdout.write(`${DIM}Press Ctrl+C to stop${RESET}\n\n`);

  if (level) {
    // tail -f | grep
    const tail = spawn('tail', ['-f', logFile], { stdio: ['ignore', 'pipe', 'inherit'] });
    const grep = spawn('grep', ['--line-buffered', '-i', level], { stdio: ['pipe', 'inherit', 'inherit'] });
    tail.stdout.pipe(grep.stdin);

    process.on('SIGINT', () => {
      tail.kill();
      grep.kill();
      process.exit(0);
    });

    await new Promise<void>((resolve) => {
      grep.on('close', resolve);
    });
  } else {
    const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });

    process.on('SIGINT', () => {
      tail.kill();
      process.exit(0);
    });

    await new Promise<void>((resolve) => {
      tail.on('close', resolve);
    });
  }
}
