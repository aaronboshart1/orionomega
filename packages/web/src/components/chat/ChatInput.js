'use client';
import { useState, useCallback } from 'react';
import { Send } from 'lucide-react';
export function ChatInput({ onSend, disabled }) {
    const [input, setInput] = useState('');
    const handleSend = useCallback(() => {
        const trimmed = input.trim();
        if (!trimmed || disabled)
            return;
        onSend(trimmed);
        setInput('');
    }, [input, disabled, onSend]);
    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };
    return (<div className="border-t border-zinc-800 px-6 py-4">
      <div className="flex items-end gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 focus-within:border-blue-600">
        <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder="Message OrionOmega..." disabled={disabled} rows={1} className="max-h-32 flex-1 resize-none bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none disabled:opacity-50"/>
        <button onClick={handleSend} disabled={disabled || !input.trim()} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:opacity-30 disabled:hover:bg-blue-600">
          <Send size={16}/>
        </button>
      </div>
      <p className="mt-2 text-center text-xs text-zinc-600">
        Press Enter to send · Shift+Enter for new line · /command for controls
      </p>
    </div>);
}
//# sourceMappingURL=ChatInput.js.map