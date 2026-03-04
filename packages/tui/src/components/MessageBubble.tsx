/**
 * @module components/MessageBubble
 * Renders a single chat message with role-appropriate styling.
 */

import React from 'react';
import { Text, Box } from 'ink';
import type { DisplayMessage } from '../hooks/use-gateway.js';

/** Props for the MessageBubble component. */
interface MessageBubbleProps {
  /** The message to render. */
  message: DisplayMessage;
}

/**
 * Renders a single message with formatting based on role.
 * - User messages: bold cyan with "You:" prefix
 * - Assistant messages: white with "Jarvis:" prefix
 * - System messages: dim with emoji prefix
 */
export function MessageBubble({ message }: MessageBubbleProps): React.ReactElement {
  const { role, content, emoji } = message;

  if (role === 'user') {
    return (
      <Box marginBottom={0}>
        <Text bold color="cyan">You: </Text>
        <Text>{content}</Text>
      </Box>
    );
  }

  if (role === 'assistant') {
    return (
      <Box marginBottom={0}>
        <Text bold color="green">Jarvis: </Text>
        <Text>{content}</Text>
      </Box>
    );
  }

  // System message
  return (
    <Box marginBottom={0}>
      <Text dimColor>{emoji ? `${emoji} ` : '⚙️ '}{content}</Text>
    </Box>
  );
}
