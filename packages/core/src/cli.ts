#!/usr/bin/env node
/**
 * @module cli
 * Main CLI entry point for OrionOmega.
 * Routes subcommands to handler functions in `src/commands/`.
 */

import { createLogger } from './logging/index.js';

const log = createLogger('cli');

const COMMANDS: Record<string, () => Promise<void>> = {
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
 * Main entry — parse argv and route to the appropriate command handler.
 */
async function main(): Promise<void> {
  const subcommand = process.argv[2];

  // No args → launch TUI
  if (!subcommand) {
    try {
      // Dynamic import — @orionomega/tui is optional
      const tui = await (Function('return import("@orionomega/tui")')() as Promise<Record<string, unknown>>);
      if (typeof tui.start === 'function') {
        await (tui.start as () => Promise<void>)();
      } else {
        log.info('TUI package loaded but no start() export found. Use "orionomega help" for commands.');
      }
    } catch {
      log.warn('TUI package not available. Use "orionomega help" for available commands.');
      await COMMANDS.help();
    }
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
