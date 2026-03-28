'use client';

import { AlertTriangle } from 'lucide-react';
import { MarkdownContent } from './MarkdownContent';

interface ErrorMessageProps {
  content: string;
}

export function ErrorMessage({ content }: ErrorMessageProps) {
  return (
    <div className="my-3 flex justify-start">
      <div className="max-w-[85%] rounded-xl border border-red-500/30 bg-red-950/30 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-400" />
          <div className="text-sm leading-relaxed text-red-300">
            <MarkdownContent content={content} />
          </div>
        </div>
      </div>
    </div>
  );
}
