'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { OmegaSpinner } from './OmegaSpinner';

interface ThinkingIndicatorProps {
  content?: string;
  statusText?: string;
}

export function ThinkingIndicator({ content, statusText }: ThinkingIndicatorProps) {
  const [expanded, setExpanded] = useState(false);

  const hasContent = !!content && content.length > 0;
  const truncated = hasContent && content.length > 100 ? content.slice(-100) + '…' : content;
  const displayText = hasContent ? (expanded ? content : truncated) : null;

  return (
    <div className="my-3 flex justify-start" aria-live="polite">
      <div className="flex max-w-[85%] items-start gap-3 rounded-2xl bg-zinc-800/50 px-4 py-3">
        <div className="flex items-center pt-0.5">
          <OmegaSpinner size={5} gap={1.5} interval={180} />
        </div>
        <div className="min-w-0 flex-1">
          {statusText && (
            <p className="text-xs font-medium text-blue-400">{statusText}</p>
          )}
          {hasContent && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="mt-1 flex items-start gap-1 text-left"
            >
              {expanded ? (
                <ChevronDown size={12} className="mt-0.5 shrink-0 text-zinc-500" />
              ) : (
                <ChevronRight size={12} className="mt-0.5 shrink-0 text-zinc-500" />
              )}
              <p
                className={`text-xs italic text-zinc-500 ${
                  expanded ? 'whitespace-pre-wrap' : 'max-w-xs truncate'
                }`}
              >
                {displayText}
              </p>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
