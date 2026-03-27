'use client';

import { useState, useRef, type KeyboardEvent } from 'react';
import { FileText, ChevronDown, ChevronUp, X } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextThumbnailItem {
  id: string;
  text: string;
}

interface TextThumbnailProps {
  item: TextThumbnailItem;
  onRemove: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREVIEW_CHARS = 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatStats(text: string): string {
  const chars = text.length;
  const lines = text.split('\n').length;
  return lines > 1
    ? `${chars.toLocaleString()} chars · ${lines} lines`
    : `${chars.toLocaleString()} chars`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TextThumbnail({ item, onRemove }: TextThumbnailProps) {
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const rawPreview = item.text.slice(0, PREVIEW_CHARS);
  const preview = rawPreview.replace(/\n/g, '↵');
  const hasMore = item.text.length > PREVIEW_CHARS;
  const stats = formatStats(item.text);

  // Handle keyboard events on the outer container (when the container itself
  // has focus, not a child button).
  const handleContainerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== containerRef.current) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setExpanded((prev) => !prev);
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onRemove(item.id);
    }
  };

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={`Pasted text thumbnail: ${stats}`}
      tabIndex={0}
      onKeyDown={handleContainerKeyDown}
      className="rounded-lg border border-zinc-700 bg-zinc-800/60 text-xs text-zinc-300 overflow-hidden focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
    >
      {/* Header row */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <FileText size={12} className="shrink-0 text-zinc-400" aria-hidden="true" />

        {/* Truncated preview */}
        <span
          className="flex-1 truncate font-mono text-zinc-400"
          title={item.text}
        >
          {preview}
          {hasMore && !expanded ? '…' : ''}
        </span>

        {/* Character / line count */}
        <span className="shrink-0 text-zinc-500 ml-1 tabular-nums">{stats}</span>

        {/* Expand / collapse toggle */}
        {hasMore && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-label={expanded ? 'Collapse pasted text' : 'Expand pasted text'}
            aria-expanded={expanded}
            className="shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-zinc-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        )}

        {/* Remove button */}
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          aria-label="Remove pasted text"
          className="shrink-0 rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-red-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
        >
          <X size={12} />
        </button>
      </div>

      {/* Expanded full-text panel */}
      <div
        className={`transition-all duration-200 ease-in-out overflow-hidden ${
          expanded ? 'max-h-48 opacity-100' : 'max-h-0 opacity-0'
        }`}
        aria-hidden={!expanded}
      >
        <div className="border-t border-zinc-700 px-2.5 py-2">
          <pre className="whitespace-pre-wrap break-words font-mono text-zinc-400 max-h-40 overflow-y-auto leading-4 text-xs">
            {item.text}
          </pre>
        </div>
      </div>
    </div>
  );
}
