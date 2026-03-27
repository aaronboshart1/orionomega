'use client';

import { useState } from 'react';
import {
  Terminal,
  FileText,
  Pencil,
  Search,
  Globe,
  FolderTree,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
} from 'lucide-react';
import type { ToolCallData } from '@/stores/chat';

const toolIconMap: Record<string, React.ReactNode> = {
  bash: <Terminal size={13} className="text-yellow-400" />,
  read: <FileText size={13} className="text-blue-400" />,
  write: <Pencil size={13} className="text-emerald-400" />,
  edit: <Pencil size={13} className="text-emerald-400" />,
  grep: <Search size={13} className="text-purple-400" />,
  glob: <FolderTree size={13} className="text-orange-400" />,
  websearch: <Globe size={13} className="text-cyan-400" />,
  web_search: <Globe size={13} className="text-cyan-400" />,
};

function getToolIcon(toolName: string): React.ReactNode {
  const key = toolName.toLowerCase().replace(/[^a-z_]/g, '');
  return toolIconMap[key] || <Terminal size={13} className="text-zinc-400" />;
}

const statusIcon: Record<string, React.ReactNode> = {
  running: <Loader2 size={12} className="animate-spin text-blue-400" />,
  done: <CheckCircle2 size={12} className="text-green-400" />,
  error: <XCircle size={12} className="text-red-400" />,
};

interface ToolCallCardProps {
  toolCall: ToolCallData;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { toolName, action, file, summary, status } = toolCall;

  const hasDetails = !!(action || file);
  const displayTarget = file || action || '';

  return (
    <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/60 px-3 py-2 transition-colors">
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={`flex w-full items-center gap-2 text-left text-xs ${
          hasDetails ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        {statusIcon[status]}
        {getToolIcon(toolName)}
        <span className="font-medium text-zinc-300">{toolName}</span>
        {displayTarget && (
          <span className="truncate text-zinc-500" title={displayTarget}>
            {displayTarget}
          </span>
        )}
        <span className="ml-auto flex-shrink-0 text-zinc-500">
          {summary}
        </span>
        {hasDetails && (
          expanded
            ? <ChevronDown size={10} className="flex-shrink-0 text-zinc-500" />
            : <ChevronRight size={10} className="flex-shrink-0 text-zinc-500" />
        )}
      </button>

      {expanded && hasDetails && (
        <div className="mt-1.5 space-y-1 border-t border-zinc-700/40 pt-1.5 text-[11px] text-zinc-500">
          {action && (
            <div>
              <span className="text-zinc-600">action: </span>
              {action}
            </div>
          )}
          {file && (
            <div>
              <span className="text-zinc-600">file: </span>
              <span className="text-zinc-400">{file}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ToolCallGroupProps {
  nodeLabel: string;
  toolCalls: { id: string; toolCall: ToolCallData }[];
}

export function ToolCallGroup({ nodeLabel, toolCalls }: ToolCallGroupProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="my-2 flex justify-start">
      <div className="max-w-[85%] w-full">
        <div className="rounded-xl border border-zinc-700/40 bg-zinc-850/50 overflow-hidden">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-zinc-500 hover:bg-zinc-700/30 transition-colors"
          >
            {expanded
              ? <ChevronDown size={12} />
              : <ChevronRight size={12} />}
            <span className="font-medium text-zinc-400">{nodeLabel}</span>
            <span className="ml-auto text-zinc-600">
              {toolCalls.length} tool call{toolCalls.length !== 1 ? 's' : ''}
            </span>
          </button>

          {expanded && (
            <div className="space-y-1 px-2 pb-2">
              {toolCalls.map((tc) => (
                <ToolCallCard key={tc.id} toolCall={tc.toolCall} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
