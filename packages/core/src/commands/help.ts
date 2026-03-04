/**
 * @module commands/help
 * Display all available OrionOmega CLI commands.
 */

const BOLD = '\x1b[1m';
const BLUE = '\x1b[34m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const COMMANDS: [string, string][] = [
  ['', 'Launch the terminal UI (default)'],
  ['setup', 'Run the interactive setup wizard'],
  ['status', 'Quick system health check'],
  ['doctor', 'Full diagnostic scan'],
  ['gateway <cmd>', 'Manage gateway: start | stop | restart | status'],
  ['config', 'Open config in $EDITOR'],
  ['config get <key>', 'Read a config value (dot-notation)'],
  ['config set <key> <val>', 'Set a config value'],
  ['skill list', 'List installed skills'],
  ['skill install <path>', 'Install a skill from a directory'],
  ['skill create <name>', 'Scaffold a new skill'],
  ['skill test <name>', "Run a skill's health check"],
  ['logs [--level <lvl>]', 'Tail log file, optionally filtered by level'],
  ['update', 'Pull latest code, rebuild, and restart'],
  ['ui', 'Start the web dashboard'],
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
    const label = cmd === '' ? `${DIM}(no command)${RESET}` : `${BLUE}${cmd}${RESET}`;
    process.stdout.write(`  ${label.padEnd(cmd === '' ? 42 : 38)}${desc}\n`);
  }

  process.stdout.write(`\n${DIM}Run "orionomega setup" to get started.${RESET}\n\n`);
}
