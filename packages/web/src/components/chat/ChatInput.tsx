'use client';

import { useState, useCallback, useRef, type KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const SLASH_COMMANDS = ['/stop', '/clear', '/status', '/help'];

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const historyIdx = useRef(-1);
  const [showSlashMenu, setShowSlashMenu] = useState(false);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    setHistory((prev) => [trimmed, ...prev].slice(0, 50));
    historyIdx.current = -1;
    onSend(trimmed);
    setInput('');
    setShowSlashMenu(false);
  }, [input, disabled, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    if (e.key === 'ArrowUp' && !e.shiftKey) {
      e.preventDefault();
      const nextIdx = historyIdx.current + 1;
      if (nextIdx < history.length) {
        historyIdx.current = nextIdx;
        setInput(history[nextIdx]);
      }
      return;
    }

    if (e.key === 'ArrowDown' && !e.shiftKey) {
      e.preventDefault();
      const nextIdx = historyIdx.current - 1;
      if (nextIdx < 0) {
        historyIdx.current = -1;
        setInput('');
      } else {
        historyIdx.current = nextIdx;
        setInput(history[nextIdx]);
      }
      return;
    }

    if (e.key === 'Escape') {
      setShowSlashMenu(false);
    }
  };

  const handleChange = (val: string) => {
    setInput(val);
    setShowSlashMenu(val.startsWith('/') && val.length > 0 && !val.includes(' '));
    historyIdx.current = -1;
  };

  const filteredCommands = SLASH_COMMANDS.filter((cmd) =>
    cmd.startsWith(input.toLowerCase()),
  );

  return (
    <div className="border-t border-zinc-800 px-6 py-4">
      {/* Slash command menu */}
      {showSlashMenu && filteredCommands.length > 0 && (
        <div
          className="mb-2 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
          role="listbox"
          aria-label="Slash commands"
        >
          {filteredCommands.map((cmd) => (
            <button
              key={cmd}
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
                setInput(cmd + ' ');
                setShowSlashMenu(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              <span className="font-mono text-blue-400">{cmd}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 focus-within:border-blue-600">
        <Textarea
          value={input}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message OrionOmega..."
          disabled={disabled}
          rows={1}
          aria-label="Message input"
          aria-multiline="true"
          className="max-h-32 flex-1 resize-none border-0 bg-transparent p-0 text-sm text-zinc-100 placeholder-zinc-500 shadow-none focus-visible:ring-0 disabled:opacity-50"
        />
        <Button
          onClick={handleSend}
          disabled={disabled || !input.trim()}
          size="icon"
          aria-label="Send message"
          className="h-8 w-8 shrink-0"
        >
          <Send size={16} />
        </Button>
      </div>
      <p className="mt-2 text-center text-xs text-zinc-600">
        Enter to send · Shift+Enter for newline · ↑↓ history · /command for controls
      </p>
    </div>
  );
}
