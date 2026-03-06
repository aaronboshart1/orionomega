/**
 * @module components/ChatView
 * Main chat display with scrollable message list, text input, and plan prompts.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DisplayMessage } from '../hooks/use-gateway.js';
import type { PlannerOutput } from '@orionomega/core';
import { MessageBubble } from './MessageBubble.js';
import { PlanPrompt } from './PlanPrompt.js';

/** Available slash commands with descriptions. */
const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: '/help', desc: 'Show available commands' },
  { cmd: '/status', desc: 'Session and system status' },
  { cmd: '/reset', desc: 'Clear history and detach workflow' },
  { cmd: '/stop', desc: 'Stop the active workflow' },
  { cmd: '/restart', desc: 'Restart the active workflow' },
  { cmd: '/plan', desc: 'Show the current execution plan' },
  { cmd: '/workers', desc: 'List active workers' },
];

/** Props for the ChatView component. */
interface ChatViewProps {
  /** Chat messages to display. */
  messages: DisplayMessage[];
  /** Current thinking text (shown as a dim indicator). */
  thinking: string;
  /** Active plan awaiting approval, or null. */
  activePlan: PlannerOutput | null;
  /** Callback to send a chat message. */
  onSend: (content: string) => void;
  /** Callback to send a slash command. */
  onCommand: (command: string) => void;
  /** Callback to respond to a plan prompt. */
  onPlanRespond: (action: 'approve' | 'reject' | 'modify', modification?: string) => void;
}

/**
 * Main chat view component.
 * Displays messages, thinking indicator, plan prompts, and a text input.
 */
export function ChatView({
  messages,
  thinking,
  activePlan,
  onSend,
  onCommand,
  onPlanRespond,
}: ChatViewProps): React.ReactElement {
  const [input, setInput] = useState('');
  const [selectedCmd, setSelectedCmd] = useState(0);

  // Determine if we're in slash-command mode and filter matches
  const isSlashMode = input.startsWith('/');
  const slashFilter = isSlashMode ? input.toLowerCase() : '';
  const filteredCommands = isSlashMode
    ? SLASH_COMMANDS.filter(c => c.cmd.startsWith(slashFilter))
    : [];

  // Only capture input when there's no active plan (PlanPrompt handles its own input)
  useInput((ch, key) => {
    if (activePlan) return;

    // Tab-complete in slash mode
    if (key.tab && isSlashMode && filteredCommands.length > 0) {
      const idx = selectedCmd < filteredCommands.length ? selectedCmd : 0;
      setInput(filteredCommands[idx].cmd);
      setSelectedCmd(0);
      return;
    }

    // Arrow keys to navigate command suggestions
    if (isSlashMode && filteredCommands.length > 0) {
      if (key.upArrow) {
        setSelectedCmd(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedCmd(prev => Math.min(filteredCommands.length - 1, prev + 1));
        return;
      }
    }

    if (key.return) {
      const trimmed = input.trim();
      if (!trimmed) return;

      // If in slash mode with a selected suggestion and input is partial, complete it
      if (isSlashMode && filteredCommands.length > 0 && !SLASH_COMMANDS.some(c => c.cmd === trimmed)) {
        const idx = selectedCmd < filteredCommands.length ? selectedCmd : 0;
        onCommand(filteredCommands[idx].cmd.slice(1));
        setInput('');
        setSelectedCmd(0);
        return;
      }

      if (trimmed.startsWith('/')) {
        onCommand(trimmed.slice(1));
      } else {
        onSend(trimmed);
      }
      setInput('');
      setSelectedCmd(0);
      return;
    }

    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1));
      setSelectedCmd(0);
      return;
    }

    // Escape to clear input
    if (key.escape) {
      setInput('');
      setSelectedCmd(0);
      return;
    }

    // Ignore control sequences
    if (key.ctrl || key.meta) return;

    if (ch) {
      setInput(prev => prev + ch);
      setSelectedCmd(0);
    }
  });

  // Show the last N messages to keep things manageable
  const visibleMessages = messages.slice(-50);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Message list */}
      <Box flexDirection="column" flexGrow={1}>
        {visibleMessages.length === 0 && (
          <Text dimColor>No messages yet. Type something to begin.</Text>
        )}
        {visibleMessages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Thinking indicator */}
        {thinking && (
          <Box marginTop={0}>
            <Text dimColor italic>🧠 Thinking... {thinking.length > 80 ? thinking.slice(0, 80) + '…' : thinking}</Text>
          </Box>
        )}
      </Box>

      {/* Plan prompt */}
      {activePlan && (
        <PlanPrompt plan={activePlan} onRespond={onPlanRespond} />
      )}

      {/* Slash command suggestions */}
      {isSlashMode && filteredCommands.length > 0 && (
        <Box flexDirection="column" paddingX={1} marginBottom={0}>
          {filteredCommands.map((c, i) => (
            <Box key={c.cmd}>
              <Text color={i === selectedCmd ? 'cyan' : 'gray'} bold={i === selectedCmd}>
                {i === selectedCmd ? '▸ ' : '  '}
              </Text>
              <Text color={i === selectedCmd ? 'yellow' : 'gray'} bold={i === selectedCmd}>
                {c.cmd}
              </Text>
              <Text dimColor>  {c.desc}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Input line */}
      <Box borderStyle="single" borderColor={isSlashMode ? 'yellow' : 'gray'} paddingX={1}>
        <Text color="cyan" bold>{'> '}</Text>
        {isSlashMode ? (
          <Text color="yellow" bold>{input}</Text>
        ) : (
          <Text>{input}</Text>
        )}
        <Text dimColor>▋</Text>
      </Box>
    </Box>
  );
}
