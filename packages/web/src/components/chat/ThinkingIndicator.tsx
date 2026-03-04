'use client';

interface ThinkingIndicatorProps {
  content?: string;
}

export function ThinkingIndicator({ content }: ThinkingIndicatorProps) {
  const truncated = content && content.length > 100 ? content.slice(-100) + '…' : content;

  return (
    <div className="my-3 flex justify-start">
      <div className="flex items-start gap-3 rounded-2xl bg-zinc-800/50 px-4 py-3">
        <div className="flex items-center gap-1 pt-0.5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" style={{ animationDelay: '0ms' }} />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" style={{ animationDelay: '150ms' }} />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" style={{ animationDelay: '300ms' }} />
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
