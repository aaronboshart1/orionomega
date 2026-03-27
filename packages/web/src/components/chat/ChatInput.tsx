'use client';

import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react';
import { Send } from 'lucide-react';

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

const MAX_CHARS = 4000;

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea up to ~8 lines
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
    // Reset height
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }, [input, disabled, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (e.target.value.length <= MAX_CHARS) {
      setInput(e.target.value);
    }
  };

  const charsLeft = MAX_CHARS - input.length;
  const nearLimit = charsLeft < 200;

  return (
    <div className="border-t border-zinc-800 px-6 py-4">
      <div className="flex items-end gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 focus-within:border-blue-600 transition-colors">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Message OrionOmega..."
          disabled={disabled}
          rows={1}
          aria-label="Chat message input"
          aria-describedby="chat-input-hint"
          className="flex-1 resize-none bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none disabled:opacity-50 leading-5"
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
          Enter to send · Shift+Enter for new line · /command for controls
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
