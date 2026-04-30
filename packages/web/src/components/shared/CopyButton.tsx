'use client';

import { useState, useRef, useEffect, useCallback, type MouseEvent } from 'react';
import { Copy, Check } from 'lucide-react';
import { copyToClipboard } from '@/utils/clipboard';

interface CopyButtonProps {
  text: string;
  size?: number;
  /** If true, calls e.stopPropagation() on click (useful inside clickable rows) */
  stopPropagation?: boolean;
}

export function CopyButton({ text, size = 12, stopPropagation = false }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(
    (e: MouseEvent) => {
      if (stopPropagation) e.stopPropagation();
      copyToClipboard(text).then((ok) => {
        if (!ok) return;
        setCopied(true);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          setCopied(false);
        }, 2000);
      });
    },
    [text, stopPropagation],
  );

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check size={size} className="text-green-400" />
      ) : (
        <Copy size={size} />
      )}
    </button>
  );
}
