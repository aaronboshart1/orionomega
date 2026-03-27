'use client';

import { useState, useCallback, useRef, type KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import { SlashCommandAutocomplete, getFilteredCommands } from './SlashCommandAutocomplete';

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  pendingPlanId?: string | null;
  onPlanRespond?: (planId: string, action: string, modification?: string) => void;
}

const APPROVE_PATTERN = /^(y|yes|go|do it|go ahead|ok|okay|approve|run it|execute|looks good|lgtm|ship it|send it|this is correct|correct|perfect|that works|sounds good|exactly)$/i;
const REJECT_PATTERN = /^(n|no|nah|nope|reject|cancel|scrap it|start over|nevermind|never mind)$/i;

export function ChatInput({ onSend, disabled, pendingPlanId, onPlanRespond }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;

    if (pendingPlanId && onPlanRespond) {
      const lower = trimmed.toLowerCase();
      if (APPROVE_PATTERN.test(lower)) {
        onPlanRespond(pendingPlanId, 'approve');
        setInput('');
        return;
      }
      if (REJECT_PATTERN.test(lower)) {
        onPlanRespond(pendingPlanId, 'reject');
        setInput('');
        return;
      }
      onPlanRespond(pendingPlanId, 'modify', trimmed);
      setInput('');
      return;
    }

    onSend(trimmed);
    setInput('');
    setShowSlashMenu(false);
  }, [input, disabled, onSend, pendingPlanId, onPlanRespond]);

  const handleSlashSelect = useCallback((command: string) => {
    setInput(command + ' ');
    setShowSlashMenu(false);
    setSlashIndex(0);
    textareaRef.current?.focus();
  }, []);

  const handleChange = (value: string) => {
    setInput(value);
    if (value.startsWith('/') && !value.includes('\n')) {
      const filtered = getFilteredCommands(value);
      setShowSlashMenu(filtered.length > 0);
      setSlashIndex(0);
    } else {
      setShowSlashMenu(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashMenu) {
      const filtered = getFilteredCommands(input);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (filtered[slashIndex]) {
          handleSlashSelect(filtered[slashIndex].name);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashMenu(false);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (filtered[slashIndex]) {
          handleSlashSelect(filtered[slashIndex].name);
        }
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const planHint = pendingPlanId
    ? 'Plan pending — type "yes" to approve, "no" to reject, or describe changes'
    : null;

  return (
    <div className="border-t border-zinc-800 px-6 py-4">
      {planHint && (
        <div className="mb-2 rounded-lg bg-blue-500/10 px-3 py-1.5 text-xs text-blue-400">
          {planHint}
        </div>
      )}
      <div className="relative">
        {showSlashMenu && (
          <SlashCommandAutocomplete
            filter={input}
            selectedIndex={slashIndex}
            onSelect={handleSlashSelect}
          />
        )}
        <div className="flex items-end gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 focus-within:border-blue-600">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message OrionOmega..."
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
          Press Enter to send · Shift+Enter for new line · /command for controls
        </p>
      </div>
    </div>
  );
}
