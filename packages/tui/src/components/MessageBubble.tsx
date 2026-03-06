/**
 * @module components/MessageBubble
 * Renders a single chat message with role-appropriate styling.
 * Assistant messages get full markdown rendering (bold, italic, headers,
 * bullets, code blocks) via marked + marked-terminal.
 */

import React, { useMemo } from 'react';
import { Text, Box } from 'ink';
import type { DisplayMessage } from '../hooks/use-gateway.js';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// Configure marked with terminal renderer once
const marked = new Marked(
  markedTerminal({
    // Style overrides for terminal output
    width: 80,
    reflowText: true,
    showSectionPrefix: false,
    tab: 2,
  }) as Record<string, unknown>,
);

/**
 * Render markdown content to ANSI-styled terminal text.
 * Falls back to raw content on error.
 */
function renderMarkdown(content: string): string {
  try {
    const rendered = marked.parse(content);
    if (typeof rendered !== 'string') return content;
    // Trim trailing newlines that marked adds
    return rendered.replace(/\n+$/, '');
  } catch {
    return content;
  }
}

/** Props for the MessageBubble component. */
interface MessageBubbleProps {
  /** The message to render. */
  message: DisplayMessage;
}

/**
 * Renders a single message with formatting based on role.
 * - User messages: bold cyan with "You:" prefix
 * - Assistant messages: markdown-rendered with "Jarvis:" prefix
 * - System messages: dim with emoji prefix
 */
export function MessageBubble({ message }: MessageBubbleProps): React.ReactElement {
  const { role, content, emoji } = message;

  // Memoize markdown rendering (expensive for long messages)
  const renderedContent = useMemo(() => {
    if (role === 'assistant') return renderMarkdown(content);
    return content;
  }, [role, content]);

  if (role === 'user') {
    const lines = content.split('\n');
    const isLongPaste = lines.length > 5 || content.length > 400;

    if (isLongPaste) {
      const preview = lines[0].slice(0, 60) + (lines[0].length > 60 ? '…' : '');
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">You:</Text>
          <Box marginLeft={2}>
            <Text color="magenta">[paste {lines.length} lines] </Text>
            <Text dimColor>{preview}</Text>
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">You:</Text>
        <Box marginLeft={2}>
          <Text>{content}</Text>
        </Box>
      </Box>
    );
  }

  if (role === 'assistant') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="green">Jarvis:</Text>
        <Box marginLeft={2} flexDirection="column">
          <Text>{renderedContent}</Text>
        </Box>
      </Box>
    );
  }

  // System message
  return (
    <Box marginTop={0}>
      <Text dimColor>{emoji ? `${emoji} ` : '⚙️ '}{content}</Text>
    </Box>
  );
}
