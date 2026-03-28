'use client';

import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react';
import { Send, Command, X, Reply } from 'lucide-react';
import { useChatStore } from '@/stores/chat';

interface ChatInputProps {
  onSend: (text: string, replyToId?: string) => void;
  disabled?: boolean;
}

const BUILTIN_COMMANDS = [
  { command: '/stop', description: 'Stop current streaming' },
  { command: '/clear', description: 'Clear conversation' },
  { command: '/status', description: 'Show system status' },
  { command: '/update', description: 'Pull latest, rebuild, and restart' },
  { command: '/help', description: 'Show available commands' },
];

function useFileCommands() {
  const [fileCommands, setFileCommands] = useState<Array<{ command: string; description: string }>>([]);

  useEffect(() => {
    fetch('/api/gateway/api/commands')
      .then((res) => (res.ok ? res.json() : { commands: [] }))
      .then((data: { commands: Array<{ name: string; description: string }> }) => {
        setFileCommands(
          data.commands.map((c) => ({
            command: `/${c.name}`,
            description: c.description,
          })),
        );
      })
      .catch(() => {});
  }, []);

  return fileCommands;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [showPalette, setShowPalette] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messages = useChatStore((s) => s.messages);
  const replyTarget = useChatStore((s) => s.replyTarget);
  const setReplyTarget = useChatStore((s) => s.setReplyTarget);
  const fileCommands = useFileCommands();
  const SLASH_COMMANDS = [...BUILTIN_COMMANDS, ...fileCommands];

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed, replyTarget?.messageId);
    setInput('');
    setShowPalette(false);
    setReplyTarget(null);
  }, [input, disabled, onSend, replyTarget, setReplyTarget]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    if (e.key === 'ArrowUp' && input === '') {
      e.preventDefault();
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUserMsg) {
        setInput(lastUserMsg.content);
        setTimeout(() => {
          const ta = textareaRef.current;
          if (ta) ta.selectionStart = ta.selectionEnd = ta.value.length;
        }, 0);
      }
      return;
    }

  };

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setShowPalette((p) => !p);
        textareaRef.current?.focus();
      }
      if (e.key === 'Escape' && useChatStore.getState().isStreaming) {
        e.preventDefault();
        onSend('/stop');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onSend]);

  const selectCommand = (cmd: string) => {
    setInput(cmd);
    setShowPalette(false);
    textareaRef.current?.focus();
  };

  return (
    <div className="relative border-t border-zinc-800 px-6 py-4">
      {replyTarget && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-2">
          <Reply size={14} className="shrink-0 text-blue-400" />
          <div className="min-w-0 flex-1 text-xs text-zinc-300">
            <span className="font-medium text-zinc-400">
              Replying to {replyTarget.role === 'user' ? 'yourself' : 'Assistant'}
            </span>
            <p className="mt-0.5 truncate text-zinc-500">{replyTarget.content.replace(/\n/g, ' ').slice(0, 120)}</p>
          </div>
          <button
            onClick={() => setReplyTarget(null)}
            className="shrink-0 text-zinc-500 hover:text-zinc-300"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {showPalette && (
        <div className="absolute bottom-full left-6 right-6 mb-2 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
            <span className="text-xs font-medium text-zinc-400">Commands</span>
            <button
              onClick={() => setShowPalette(false)}
              className="text-zinc-500 hover:text-zinc-300"
            >
              <X size={14} />
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto py-1">
            {SLASH_COMMANDS.map((cmd) => (
              <button
                key={cmd.command}
                onClick={() => selectCommand(cmd.command)}
                className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-zinc-800"
              >
                <code className="text-xs text-blue-400">{cmd.command}</code>
                <span className="text-xs text-zinc-500">{cmd.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-end gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 focus-within:border-blue-600">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message OmegaClaw..."
          disabled={disabled}
          rows={1}
          className="max-h-32 flex-1 resize-none bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !input.trim()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:opacity-30 disabled:hover:bg-blue-600"
        >
          <Send size={16} />
        </button>
      </div>
      <p className="mt-2 text-center text-xs text-zinc-600">
        Enter to send · Shift+Enter for new line · Esc to stop ·{' '}
        <span className="inline-flex items-center gap-0.5">
          <Command size={10} className="inline" />/
        </span>{' '}
        commands
      </p>
    </div>
  );
}
