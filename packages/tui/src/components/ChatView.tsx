/**
 * @module components/ChatView
 * Main chat display with scrollable message list, text input, and plan prompts.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { DisplayMessage } from '../hooks/use-gateway.js';
import type { PlannerOutput } from '@orionomega/core';
import { MessageBubble } from './MessageBubble.js';
import { PlanPrompt } from './PlanPrompt.js';

/** Client-side commands handled by the TUI itself (not sent to gateway). */
const CLIENT_COMMANDS = new Set(['/exit', '/quit', '/q']);

/** Available slash commands with descriptions. */
const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: '/help', desc: 'Show available commands' },
  { cmd: '/status', desc: 'Session and system status' },
  { cmd: '/reset', desc: 'Clear history and detach workflow' },
  { cmd: '/stop', desc: 'Stop the active workflow' },
  { cmd: '/restart', desc: 'Restart the active workflow' },
  { cmd: '/plan', desc: 'Show the current execution plan' },
  { cmd: '/workers', desc: 'List active workers' },
  { cmd: '/exit', desc: 'Exit the TUI' },
];

/** Rough estimate of lines a message takes (content lines + 1 for the prefix line). */
function estimateLines(msg: DisplayMessage, cols: number): number {
  const prefix = msg.role === 'user' ? 'You: ' : msg.role === 'assistant' ? 'Jarvis: ' : '⚙️ ';
  const totalChars = prefix.length + msg.content.length;
  const wrappedLines = Math.ceil(totalChars / Math.max(cols - 4, 40));
  const newlines = (msg.content.match(/\n/g) ?? []).length;
  return Math.max(1, wrappedLines + newlines);
}

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
  /** Callback to exit the TUI. */
  onExit: () => void;
  /** Callback to respond to a plan prompt. */
  onPlanRespond: (action: 'approve' | 'reject' | 'modify', modification?: string) => void;
}

/**
 * Main chat view component.
 * Displays messages, thinking indicator, plan prompts, and a text input.
 * Supports scrolling with Page Up/Down and auto-follows new messages.
 */
export function ChatView({
  messages,
  thinking,
  activePlan,
  onSend,
  onCommand,
  onExit,
  onPlanRespond,
}: ChatViewProps): React.ReactElement {
  const [input, setInput] = useState('');
  const [selectedCmd, setSelectedCmd] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0); // 0 = bottom (latest)

  // Paste detection state
  const pasteBufferRef = useRef('');
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPastingRef = useRef(false);
  const [pastedContent, setPastedContent] = useState<string | null>(null);

  // Detect paste via stdin data chunk size — fires BEFORE Ink's useInput
  useEffect(() => {
    const handler = (data: Buffer) => {
      const str = data.toString('utf8');
      // Normal keystrokes: 1-6 bytes. Paste: much larger, often with newlines.
      const isPaste = str.length > 15 || (str.includes('\n') && str.length > 5);
      if (isPaste) {
        isPastingRef.current = true;
        pasteBufferRef.current += str;

        // Debounce: finalize after 100ms of no new data
        if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current);
        pasteTimerRef.current = setTimeout(() => {
          const text = pasteBufferRef.current;
          pasteBufferRef.current = '';
          isPastingRef.current = false;
          pasteTimerRef.current = null;

          // Clean up: remove bracketed paste markers if present
          const cleaned = text
            .replace(/\x1b\[200~/g, '')
            .replace(/\x1b\[201~/g, '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n');

          const lineCount = cleaned.split('\n').filter(l => l.length > 0).length;
          setPastedContent(cleaned);
          setInput(`[paste ${lineCount} line${lineCount !== 1 ? 's' : ''}]`);
        }, 100);
      }
    };

    // prepend ensures we detect paste BEFORE Ink processes the chars
    process.stdin.prependListener('data', handler);
    return () => {
      process.stdin.removeListener('data', handler);
      if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current);
    };
  }, []);
  const { stdout } = useStdout();

  const termRows = stdout?.rows ?? 24;
  const termCols = stdout?.columns ?? 80;
  // Reserve rows for: input box (3), status bar (3), slash suggestions (variable), thinking (1)
  const reservedRows = 7 + (activePlan ? 6 : 0);
  const chatRows = Math.max(5, termRows - reservedRows);

  // Determine if we're in slash-command mode and filter matches
  const isSlashMode = input.startsWith('/');
  const slashFilter = isSlashMode ? input.toLowerCase() : '';
  const filteredCommands = isSlashMode
    ? SLASH_COMMANDS.filter(c => c.cmd.startsWith(slashFilter))
    : [];

  // Auto-scroll to bottom when new messages arrive (if already at bottom)
  const prevMsgCount = React.useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevMsgCount.current && scrollOffset === 0) {
      // Already at bottom, stay there
    }
    prevMsgCount.current = messages.length;
  }, [messages.length, scrollOffset]);

  // Compute visible window of messages
  // We walk backwards from the end, accounting for scroll offset
  const allMessages = messages;
  let visibleMessages: DisplayMessage[];
  let canScrollUp = false;
  let canScrollDown = false;

  if (allMessages.length === 0) {
    visibleMessages = [];
  } else {
    // Start from the end minus scrollOffset, fill up chatRows
    const endIdx = allMessages.length - scrollOffset;
    let linesUsed = 0;
    let startIdx = endIdx;

    for (let i = endIdx - 1; i >= 0; i--) {
      const lines = estimateLines(allMessages[i], termCols);
      if (linesUsed + lines > chatRows) break;
      linesUsed += lines;
      startIdx = i;
    }

    visibleMessages = allMessages.slice(Math.max(0, startIdx), endIdx);
    canScrollUp = startIdx > 0;
    canScrollDown = scrollOffset > 0;
  }

  useInput((ch, key) => {
    if (activePlan) return;

    // Skip character processing during paste — stdin handler captures it
    if (isPastingRef.current) return;

    // Scroll: PgUp, PgDn, Shift+Arrow, Ctrl+U/D, or [ / ] when input is empty
    if (key.pageUp) {
      setScrollOffset(prev => Math.min(prev + 5, Math.max(0, allMessages.length - 1)));
      return;
    }
    if (key.pageDown) {
      setScrollOffset(prev => Math.max(0, prev - 5));
      return;
    }
    if (key.shift && key.upArrow) {
      setScrollOffset(prev => Math.min(prev + 3, Math.max(0, allMessages.length - 1)));
      return;
    }
    if (key.shift && key.downArrow) {
      setScrollOffset(prev => Math.max(0, prev - 3));
      return;
    }

    // Ctrl+U = scroll to top, Ctrl+D = scroll to bottom
    if (key.ctrl && ch === 'u') {
      setScrollOffset(Math.max(0, allMessages.length - 1));
      return;
    }
    if (key.ctrl && ch === 'd') {
      setScrollOffset(0);
      return;
    }

    // [ and ] to scroll when input is empty (most reliable in all terminals)
    if (!input && ch === '[') {
      setScrollOffset(prev => Math.min(prev + 3, Math.max(0, allMessages.length - 1)));
      return;
    }
    if (!input && ch === ']') {
      setScrollOffset(prev => Math.max(0, prev - 3));
      return;
    }

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

    // Ctrl+C to exit
    if (key.ctrl && ch === 'c') {
      onExit();
      return;
    }

    if (key.return) {
      // If we have pasted content, send the full paste
      if (pastedContent) {
        setScrollOffset(0);
        onSend(pastedContent);
        setPastedContent(null);
        setInput('');
        return;
      }

      const trimmed = input.trim();
      if (!trimmed) return;

      // Auto-scroll to bottom on send
      setScrollOffset(0);

      // Client-side commands — handle without sending to gateway
      if (CLIENT_COMMANDS.has(trimmed.toLowerCase())) {
        onExit();
        return;
      }

      // If in slash mode with a selected suggestion and input is partial, complete it
      if (isSlashMode && filteredCommands.length > 0 && !SLASH_COMMANDS.some(c => c.cmd === trimmed)) {
        const idx = selectedCmd < filteredCommands.length ? selectedCmd : 0;
        const selected = filteredCommands[idx].cmd;
        // Check if the selected suggestion is a client-side command
        if (CLIENT_COMMANDS.has(selected)) {
          onExit();
          return;
        }
        onCommand(selected.slice(1));
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

    // Escape to clear input (and any buffered paste)
    if (key.escape) {
      setInput('');
      setSelectedCmd(0);
      setPastedContent(null);
      pasteBufferRef.current = '';
      return;
    }

    // Ignore other control sequences
    if (key.ctrl || key.meta) return;

    if (ch) {
      setInput(prev => prev + ch);
      setSelectedCmd(0);
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Scroll indicator — top */}
      {canScrollUp && (
        <Box justifyContent="center">
          <Text dimColor>▲ Shift+↑ or PgUp to scroll up ({allMessages.length - visibleMessages.length - scrollOffset} more above)</Text>
        </Box>
      )}

      {/* Message list */}
      <Box flexDirection="column" flexGrow={1}>
        {allMessages.length === 0 && (
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

      {/* Scroll indicator — bottom */}
      {canScrollDown && (
        <Box justifyContent="center">
          <Text dimColor>▼ Shift+↓ or PgDn to scroll down ({scrollOffset} more below)</Text>
        </Box>
      )}

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
      <Box borderStyle="single" borderColor={pastedContent ? 'magenta' : isSlashMode ? 'yellow' : 'gray'} paddingX={1}>
        <Text color="cyan" bold>{'> '}</Text>
        {pastedContent ? (
          <Text color="magenta" bold>{input}</Text>
        ) : isSlashMode ? (
          <Text color="yellow" bold>{input}</Text>
        ) : (
          <Text>{input}</Text>
        )}
        <Text dimColor>▋</Text>
      </Box>
    </Box>
  );
}
