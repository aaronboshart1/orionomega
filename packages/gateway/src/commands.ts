/**
 * @module commands
 * Slash-command handler for gateway sessions.
 */

import type { Session } from './sessions.js';
import type { CommandResult } from './types.js';
import { SessionManager } from './sessions.js';

/**
 * Parses and executes slash commands issued by clients.
 */
export class CommandHandler {
  constructor(private sessionManager: SessionManager) {}

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

    switch (cmd) {
      case '/help':
        return this.handleHelp();

      case '/status':
        return this.handleStatus(session);

      case '/reset':
        return this.handleReset(session);

      case '/stop':
        return {
          command: '/stop',
          success: true,
          message: 'Command registered, orchestration engine not yet connected.',
        };

      case '/restart':
        return {
          command: '/restart',
          success: true,
          message: 'Command registered, orchestration engine not yet connected.',
        };

      case '/plan':
        return {
          command: '/plan',
          success: true,
          message: 'Command registered, orchestration engine not yet connected.',
        };

      case '/workers':
        return {
          command: '/workers',
          success: true,
          message: 'Command registered, orchestration engine not yet connected.',
        };

      default:
        return {
          command: trimmed,
          success: false,
          message: `Unknown command: ${cmd ?? trimmed}. Type /help for available commands.`,
        };
    }
  }

  /** Return session and system status. */
  private handleStatus(session: Session): CommandResult {
    const allSessions = this.sessionManager.listSessions();
    const lines = [
      `Session: ${session.id}`,
      `Messages: ${session.messages.length}`,
      `Connected clients: ${session.clients.size}`,
      `Active workflow: ${session.activeWorkflow ?? 'none'}`,
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
      '  /help      \u2014 Show this help',
      '  /status    \u2014 Session and system status',
      '  /reset     \u2014 Clear message history and detach workflow',
      '  /stop      \u2014 Stop the active workflow',
      '  /restart   \u2014 Restart the active workflow',
      '  /plan      \u2014 Show the current execution plan',
      '  /workers   \u2014 List active workers',
    ];
    return {
      command: '/help',
      success: true,
      message: lines.join('\n'),
    };
  }

  /** Clear session message history and workflow state. */
  private handleReset(session: Session): CommandResult {
    session.messages.length = 0;
    session.activeWorkflow = undefined;
    session.updatedAt = new Date().toISOString();

    return {
      command: '/reset',
      success: true,
      message: 'Session reset. Message history cleared and workflow detached.',
    };
  }
}
