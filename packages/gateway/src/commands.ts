/**
 * @module commands
 * Slash-command handler for gateway sessions.
 */

import type { Session } from './sessions.js';
import type { CommandResult } from './types.js';
import { SessionManager } from './sessions.js';
import { CommandFileLoader } from '@orionomega/core';

/**
 * Parses and executes slash commands issued by clients.
 */
export class CommandHandler {
  private commandFileLoader: CommandFileLoader | null = null;

  constructor(private sessionManager: SessionManager) {}

  setCommandFileLoader(loader: CommandFileLoader): void {
    this.commandFileLoader = loader;
  }

  getFileCommands(): Array<{ name: string; description: string }> {
    if (!this.commandFileLoader) return [];
    return this.commandFileLoader.list().map((c) => ({
      name: c.name,
      description: `Custom command (${c.filePath})`,
    }));
  }

  /**
   * Handle a slash command string within a session context.
   * @param command - The raw command string (e.g. "/status", "/reset").
   * @param session - The session issuing the command.
   * @returns The command execution result.
   */
  async handle(command: string, session: Session): Promise<CommandResult> {
    const trimmed = command.trim();
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    const notConnected = (c: string) => ({
      command: c,
      success: false,
      message: 'Orchestration engine not connected. Waiting for MainAgent...',
    });

    switch (cmd) {
      case '/help':
        return this.handleHelp();

      case '/status':
        return this.handleStatus(session);

      case '/reset':
        return this.handleReset(session);

      case '/skills':
        return this.handleSkills(session);

      case '/stop':
      case '/plan':
      case '/workers':
      case '/pause':
      case '/resume':
      case '/gates':
      case '/workflows':
        return notConnected(cmd);

      case '/restart':
        return notConnected(cmd);

      default: {
        if (this.commandFileLoader && cmd) {
          const fileCmd = this.commandFileLoader.lookup(cmd);
          if (fileCmd) {
            return notConnected(cmd);
          }
        }
        return {
          command: trimmed,
          success: false,
          message: `Unknown command: ${cmd ?? trimmed}. Type /help for available commands.`,
        };
      }
    }
  }

  /** Return session and system status. */
  private handleStatus(session: Session): CommandResult {
    const allSessions = this.sessionManager.listSessions();
    const lines = [
      `Session: ${session.id}`,
      `Messages: ${session.messages.length}`,
      `Connected clients: ${session.clients.size}`,
      `Active workflows: ${session.activeWorkflows.size > 0 ? [...session.activeWorkflows].join(', ') : 'none'}`,
      `---`,
      `Total sessions: ${allSessions.length}`,
    ];

    return {
      command: '/status',
      success: true,
      message: lines.join('\n'),
    };
  }

  /** List available commands. */
  private handleHelp(): CommandResult {
    const lines = [
      'Available commands:',
      '  /workflows \u2014 List all active workflows',
      '  /status    \u2014 Session and system status',
      '  /stop      \u2014 Stop the active workflow',
      '  /pause     \u2014 Pause before next layer',
      '  /resume    \u2014 Resume a paused workflow',
      '  /plan      \u2014 Show the current execution plan',
      '  /workers   \u2014 List active workers',
      '  /gates     \u2014 List pending human approval gates',
      '  /skills    \u2014 View, enable/disable, configure skills',
      '  /reset     \u2014 Clear history and detach workflow',
      '  /restart   \u2014 Restart the gateway service',
      '  /help      \u2014 This message',
    ];

    if (this.commandFileLoader) {
      const fileCmds = this.commandFileLoader.list();
      if (fileCmds.length > 0) {
        lines.push('', 'Custom commands:');
        for (const c of fileCmds) {
          lines.push(`  /${c.name}    \u2014 ${c.filePath}`);
        }
      }
    }

    return {
      command: '/help',
      success: true,
      message: lines.join('\n'),
    };
  }

  /** List skills (gateway-level stub — real logic in main-agent). */
  private handleSkills(_session: Session): CommandResult {
    return {
      command: "/skills",
      success: true,
      message: "Querying skill state...",
    };
  }

  private handleReset(session: Session): CommandResult {
    this.sessionManager.resetSession(session.id);

    return {
      command: '/reset',
      success: true,
      message: 'Session reset. Message history and memory events cleared, workflow detached.',
    };
  }
}

// Note: /skills is primarily handled by MainAgent for full skill state.
// This is the gateway-level fallback.
