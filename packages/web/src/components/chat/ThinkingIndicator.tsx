'use client';

import { OmegaSpinner } from './OmegaSpinner';

interface ThinkingIndicatorProps {
  content?: string;
}

export function ThinkingIndicator({ content }: ThinkingIndicatorProps) {
  const truncated = content && content.length > 100 ? content.slice(-100) + '…' : content;

  return (
    <div className="my-3 flex justify-start" role="status" aria-label="AI is thinking" aria-live="polite">
      <div className="flex items-start gap-3 rounded-2xl bg-zinc-800/50 px-4 py-3">
        <div className="flex items-center pt-0.5">
          <OmegaSpinner size={6} gap={1.5} interval={180} />
        </div>
        {truncated && (
          <p className="max-w-xs truncate text-xs italic text-zinc-500">
            {truncated}
          </p>
        )}
      </div>
    </div>
  );
}
