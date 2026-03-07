#!/usr/bin/env node
/**
 * @module cli
 * Main CLI entry point for OrionOmega.
 * Routes subcommands to handler functions in `src/commands/`.
 */

import { createLogger } from './logging/index.js';
import { createRequire } from 'node:module';

const log = createLogger('cli');

/**
 * Dynamically import @orionomega/tui, resolving from this package's context
 * rather than the global scope (which the Function() trick would use).
 */
async function launchTUI(): Promise<void> {
  const require = createRequire(import.meta.url);
  const tuiPath = require.resolve('@orionomega/tui');
  const tui = await import(tuiPath) as Record<string, unknown>;
  if (typeof tui.start === 'function') {
    await (tui.start as () => Promise<void>)();
  } else {
    throw new Error('TUI package loaded but no start() export found.');
  }
}

const COMMANDS: Record<string, () => Promise<void>> = {
  tui: async () => {
    try {
      await launchTUI();
    } catch {
      log.error('Failed to launch TUI. Is @orionomega/tui built? Try: cd /opt/orionomega && pnpm -r build');
      process.exitCode = 1;
    }
  },
  setup: async () => (await import('./commands/setup.js')).runSetup(),
  status: async () => (await import('./commands/status.js')).runStatus(),
  doctor: async () => (await import('./commands/doctor.js')).runDoctor(),
  gateway: async () => (await import('./commands/gateway.js')).runGateway(process.argv.slice(3)),
  config: async () => (await import('./commands/config.js')).runConfig(process.argv.slice(3)),
  skill: async () => (await import('./commands/skill.js')).runSkill(process.argv.slice(3)),
  logs: async () => (await import('./commands/logs.js')).runLogs(process.argv.slice(3)),
  update: async () => (await import('./commands/update.js')).runUpdate(),
  ui: async () => (await import('./commands/ui.js')).runUI(),
  help: async () => (await import('./commands/help.js')).runHelp(),
};

/**
 * Print version from package.json.
 */
async function printVersion(): Promise<void> {
  try {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const pkgPath = join(new URL('.', import.meta.url).pathname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    process.stdout.write(`OrionOmega v${pkg.version}\n`);
  } catch {
    process.stdout.write('OrionOmega v0.1.0\n');
  }
}

/**
 * Main entry — parse argv and route to the appropriate command handler.
 */
async function main(): Promise<void> {
  const subcommand = process.argv[2];

  // No args → show help
  if (!subcommand) {
    await COMMANDS.help();
    return;
  }

  // Flags
  if (subcommand === '--help' || subcommand === '-h') {
    await COMMANDS.help();
    return;
  }

  if (subcommand === '--version' || subcommand === '-v' || subcommand === 'version') {
    await printVersion();
    return;
  }

  // Known command
  const handler = COMMANDS[subcommand];
  if (handler) {
    await handler();
    return;
  }

  // Unknown command
  process.stdout.write(`\x1b[31mUnknown command: ${subcommand}\x1b[0m\n\n`);
  await COMMANDS.help();
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`\x1b[31m✗ Fatal error: ${message}\x1b[0m\n`);
  log.error('Unhandled error', { error: message });
  process.exitCode = 1;
});
