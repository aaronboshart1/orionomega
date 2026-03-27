'use client';

import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react';
import { Send, Command, X } from 'lucide-react';
import { useChatStore } from '@/stores/chat';

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

const MAX_CHARS = 4000;

const SLASH_COMMANDS = [
  { command: '/stop', description: 'Stop current streaming' },
  { command: '/clear', description: 'Clear conversation' },
  { command: '/status', description: 'Show system status' },
  { command: '/update', description: 'Pull latest, rebuild, and restart' },
  { command: '/help', description: 'Show available commands' },
];

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [showPalette, setShowPalette] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messages = useChatStore((s) => s.messages);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseInt(getComputedStyle(el).lineHeight || '20', 10);
    const maxHeight = lineHeight * 8;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [input]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput('');
    setShowPalette(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [input, disabled, onSend]);

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

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (e.target.value.length <= MAX_CHARS) {
      setInput(e.target.value);
    }
  };

  const selectCommand = (cmd: string) => {
    setInput(cmd);
    setShowPalette(false);
    textareaRef.current?.focus();
  };

  const charsLeft = MAX_CHARS - input.length;
  const nearLimit = charsLeft < 200;

  return (
    <div className="relative border-t border-zinc-800 px-6 py-4">
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

      <div className="flex items-end gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 transition-colors focus-within:border-blue-600">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Message OmegaClaw..."
          disabled={disabled}
          rows={1}
          aria-label="Chat message input"
          aria-describedby="chat-input-hint"
          className="flex-1 resize-none bg-transparent text-sm leading-5 text-zinc-100 placeholder-zinc-500 outline-none disabled:opacity-50"
          style={{ minHeight: '20px', maxHeight: '160px', overflowY: 'auto' }}
        />
        <button
          onClick={handleSend}
          disabled={disabled || !input.trim()}
          aria-label="Send message"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:opacity-30 disabled:hover:bg-blue-600"
        >
          <Send size={16} />
        </button>
      </div>

      <div id="chat-input-hint" className="mt-2 flex items-center justify-between px-1">
        <p className="text-xs text-zinc-600">
          Enter to send · Shift+Enter for new line · Esc to stop ·{' '}
          <span className="inline-flex items-center gap-0.5">
            <Command size={10} className="inline" />/
          </span>{' '}
          commands
        </p>
        {nearLimit && (
          <p className={`text-xs ${charsLeft < 50 ? 'text-red-400' : 'text-zinc-500'}`}>
            {charsLeft} left
          </p>
        )}
      </div>
    </div>
  );
}
