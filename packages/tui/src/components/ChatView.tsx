/**
 * @module components/ChatView
 * Chat display with messages flowing into terminal scrollback and
 * input/status pinned at the bottom.
 *
 * Uses Ink's <Static> component so completed messages render once into the
 * terminal's native scrollback buffer — scrollable via mouse/trackpad.
 * The currently streaming message renders in the dynamic section below.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, Static, useInput } from 'ink';
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

/** Props for the ChatView component. */
interface ChatViewProps {
  /** Completed messages (rendered once into scrollback). */
  messages: DisplayMessage[];
  /** Currently streaming message (rendered dynamically). */
  streamingMessage: DisplayMessage | null;
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
 * Completed messages go into <Static> (terminal scrollback).
 * Streaming message + input stay in dynamic section at bottom.
 */
export function ChatView({
  messages,
  streamingMessage,
  thinking,
  activePlan,
  onSend,
  onCommand,
  onExit,
  onPlanRespond,
}: ChatViewProps): React.ReactElement {
  const [input, setInput] = useState('');
  const [selectedCmd, setSelectedCmd] = useState(0);

  // Paste detection state
  const pasteBufferRef = useRef('');
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPastingRef = useRef(false);
  const [pastedContent, setPastedContent] = useState<string | null>(null);

  // Detect paste via stdin data chunk size
  useEffect(() => {
    const handler = (data: Buffer) => {
      const str = data.toString('utf8');
      const isPaste = str.length > 15 || (str.includes('\n') && str.length > 5);
      if (isPaste) {
        isPastingRef.current = true;
        pasteBufferRef.current += str;

        if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current);
        pasteTimerRef.current = setTimeout(() => {
          const text = pasteBufferRef.current;
          pasteBufferRef.current = '';
          isPastingRef.current = false;
          pasteTimerRef.current = null;

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

    process.stdin.prependListener('data', handler);
    return () => {
      process.stdin.removeListener('data', handler);
      if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current);
    };
  }, []);

  // Determine if we're in slash-command mode
  const isSlashMode = input.startsWith('/');
  const slashFilter = isSlashMode ? input.toLowerCase() : '';
  const filteredCommands = isSlashMode
    ? SLASH_COMMANDS.filter(c => c.cmd.startsWith(slashFilter))
    : [];

  useInput((ch, key) => {
    if (activePlan) return;
    if (isPastingRef.current) return;

    if (key.tab && isSlashMode && filteredCommands.length > 0) {
      const idx = selectedCmd < filteredCommands.length ? selectedCmd : 0;
      setInput(filteredCommands[idx].cmd);
      setSelectedCmd(0);
      return;
    }

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

    if (key.ctrl && ch === 'c') {
      onExit();
      return;
    }

    if (key.return) {
      if (pastedContent) {
        onSend(pastedContent);
        setPastedContent(null);
        setInput('');
        return;
      }

      const trimmed = input.trim();
      if (!trimmed) return;

      if (CLIENT_COMMANDS.has(trimmed.toLowerCase())) {
        onExit();
        return;
      }

      if (isSlashMode && filteredCommands.length > 0 && !SLASH_COMMANDS.some(c => c.cmd === trimmed)) {
        const idx = selectedCmd < filteredCommands.length ? selectedCmd : 0;
        const selected = filteredCommands[idx].cmd;
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

    if (key.escape) {
      setInput('');
      setSelectedCmd(0);
      setPastedContent(null);
      pasteBufferRef.current = '';
      return;
    }

    if (key.ctrl || key.meta) return;

    if (ch) {
      setInput(prev => prev + ch);
      setSelectedCmd(0);
    }
  });

  return (
    <>
      {/* Completed messages — rendered once into terminal scrollback */}
      <Static items={messages}>
        {(msg: DisplayMessage) => (
          <Box key={msg.id}>
            <MessageBubble message={msg} />
          </Box>
        )}
      </Static>

      {/* Dynamic bottom section — re-renders in place */}
      <Box flexDirection="column">
        {/* Currently streaming message */}
        {streamingMessage && (
          <Box>
            <MessageBubble message={streamingMessage} />
          </Box>
        )}

        {/* Thinking indicator */}
        {thinking && (
          <Box>
            <Text dimColor italic>🧠 {thinking.length > 100 ? thinking.slice(0, 100) + '…' : thinking}</Text>
          </Box>
        )}

        {/* Plan prompt */}
        {activePlan && (
          <PlanPrompt plan={activePlan} onRespond={onPlanRespond} />
        )}

        {/* Slash command suggestions */}
        {isSlashMode && filteredCommands.length > 0 && (
          <Box flexDirection="column" paddingX={1}>
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
    </>
  );
}
