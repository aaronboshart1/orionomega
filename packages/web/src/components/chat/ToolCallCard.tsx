'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import type { ToolCall } from '@/stores/chat';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

const statusConfig = {
  pending: {
    icon: <Loader2 size={12} className="animate-spin text-zinc-400" />,
    label: 'Pending',
    border: 'border-zinc-700',
    bg: 'bg-zinc-800/60',
  },
  running: {
    icon: <Loader2 size={12} className="animate-spin text-blue-400" />,
    label: 'Running',
    border: 'border-blue-500/30',
    bg: 'bg-zinc-800/80',
  },
  done: {
    icon: <CheckCircle2 size={12} className="text-green-400" />,
    label: 'Done',
    border: 'border-green-500/20',
    bg: 'bg-zinc-800/60',
  },
  error: {
    icon: <XCircle size={12} className="text-red-400" />,
    label: 'Error',
    border: 'border-red-500/20',
    bg: 'bg-zinc-800/60',
  },
};

/** Serialise any value to a display string */
function toDisplayString(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const cfg = statusConfig[toolCall.status] ?? statusConfig.pending;

  const hasDetails = !!(toolCall.input || toolCall.output || toolCall.error);

  return (
    <div className={`rounded-xl border px-4 py-3 transition-colors ${cfg.border} ${cfg.bg}`}>
      {/* Header */}
      <button
        onClick={() => hasDetails && setExpanded((v) => !v)}
        className={`flex w-full items-center gap-2 text-left ${hasDetails ? 'cursor-pointer' : 'cursor-default'}`}
        aria-expanded={expanded}
        aria-label={`Tool call: ${toolCall.name}`}
      >
        <Wrench size={13} className="shrink-0 text-zinc-400" />
        <span className="flex-1 text-xs font-medium text-zinc-200">{toolCall.name}</span>
        {cfg.icon}
        <span className="text-[10px] text-zinc-500">{cfg.label}</span>
        {hasDetails && (
          expanded
            ? <ChevronDown size={12} className="text-zinc-500" />
            : <ChevronRight size={12} className="text-zinc-500" />
        )}
      </button>

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="mt-3 space-y-2">
          {toolCall.input !== undefined && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Input</p>
              <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3 text-[11px] text-zinc-300 ring-1 ring-zinc-800">
                {toDisplayString(toolCall.input)}
              </pre>
            </div>
          )}
          {toolCall.output !== undefined && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Output</p>
              <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3 text-[11px] text-zinc-300 ring-1 ring-zinc-800">
                {toDisplayString(toolCall.output)}
              </pre>
            </div>
          )}
          {toolCall.error && (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-red-500">Error</p>
              <pre className="overflow-x-auto rounded-lg bg-red-950/20 p-3 text-[11px] text-red-300 ring-1 ring-red-900/40">
                {toolCall.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
