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

  // Only capture input when there's no active plan (PlanPrompt handles its own input)
  useInput((ch, key) => {
    if (activePlan) return;

    if (key.return) {
      const trimmed = input.trim();
      if (!trimmed) return;

      if (trimmed.startsWith('/')) {
        onCommand(trimmed.slice(1));
      } else {
        onSend(trimmed);
      }
      setInput('');
      return;
    }

    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1));
      return;
    }

    // Ignore control sequences
    if (key.ctrl || key.meta) return;

    if (ch) {
      setInput(prev => prev + ch);
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

      {/* Input line */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="cyan" bold>{'> '}</Text>
        <Text>{input}</Text>
        <Text dimColor>▋</Text>
      </Box>
    </Box>
  );
}
