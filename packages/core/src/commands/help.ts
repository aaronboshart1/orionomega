/**
 * @module commands/help
 * Display all available OrionOmega CLI commands.
 */

const BOLD = '\x1b[1m';
const BLUE = '\x1b[34m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const COMMANDS: [string, string][] = [
  ['tui', 'Open the terminal UI (default when no command given)'],
  ['setup', 'Run the interactive setup wizard'],
  ['status', 'Quick system health check'],
  ['doctor', 'Full diagnostic scan'],
  ['gateway <cmd>', 'Manage gateway: start | stop | restart | status'],
  ['config', 'Open config in $EDITOR'],
  ['config get <key>', 'Read a config value (dot-notation)'],
  ['config set <key> <val>', 'Set a config value'],
  ['setup skills [name]', 'Configure skill(s) interactively'],
  ['skill list', 'List installed skills'],
  ['skill setup [name]', 'Configure skill(s) (alias for setup skills)'],
  ['skill install <path>', 'Install a skill from a directory'],
  ['skill create <name>', 'Scaffold a new skill'],
  ['skill test <name>', "Run a skill's health check"],
  ['logs [--level <lvl>]', 'Tail log file, optionally filtered by level'],
  ['update', 'Pull latest code, rebuild, and restart'],
  ['ui <cmd>', 'Manage web UI: start | stop | restart | status'],
  ['remove', 'Fully uninstall OrionOmega from this machine'],
  ['help', 'Show this help message'],
];

/**
 * Print the help screen with all available commands.
 */
export async function runHelp(): Promise<void> {
  process.stdout.write(`\n${BOLD}OrionOmega${RESET} — AI Agent Orchestration System\n\n`);
  process.stdout.write(`${BOLD}Usage:${RESET} orionomega [command] [options]\n\n`);
  process.stdout.write(`${BOLD}Commands:${RESET}\n\n`);

  for (const [cmd, desc] of COMMANDS) {
    process.stdout.write(`  ${BLUE}${cmd}${RESET}${''.padEnd(Math.max(2, 30 - cmd.length))}${desc}\n`);
  }

  process.stdout.write(`\n${DIM}Run "orionomega setup" to get started.${RESET}\n\n`);
}
