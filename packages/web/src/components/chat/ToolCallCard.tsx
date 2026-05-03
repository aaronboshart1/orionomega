'use client';

import { useState, useCallback } from 'react';
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
  Copy,
  Check,
  ExternalLink,
} from 'lucide-react';
import type { ToolCallData } from '@/stores/chat';
import { copyToClipboard } from '@/utils/clipboard';
import { useOrchestrationStore } from '@/stores/orchestration';

const toolIconMap: Record<string, React.ReactNode> = {
  bash: <Terminal size={13} className="text-yellow-400" />,
  exec: <Terminal size={13} className="text-yellow-400" />,
  read: <FileText size={13} className="text-blue-400" />,
  read_file: <FileText size={13} className="text-blue-400" />,
  write: <Pencil size={13} className="text-emerald-400" />,
  write_file: <Pencil size={13} className="text-emerald-400" />,
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
  /** Optional retry handler — when provided, an error card shows a Retry action. */
  onRetry?: () => void;
  /**
   * Workflow id this tool call belongs to. When provided, the expanded
   * card shows a "View in Activity Feed" link that focuses the matching
   * workflow tab in the orchestration pane.
   */
  workflowId?: string;
}

function InlineCopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      copyToClipboard(text).then((ok) => {
        if (!ok) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    },
    [text],
  );
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-200"
      aria-label={`Copy ${label}`}
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function ToolCallCard({ toolCall, onRetry, workflowId }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const setActiveWorkflowId = useOrchestrationStore((s) => s.setActiveWorkflowId);
  const setActiveOrchTab = useOrchestrationStore((s) => s.setActiveOrchTab);
  const { toolName, action, file, summary, status, params, result, isError, durationMs } = toolCall;
  const handleViewInFeed = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!workflowId) return;
    // Open the Workflow tab and focus the matching workflow id so the
    // Activity Feed scrolls to / highlights this run.
    setActiveOrchTab('workflow');
    setActiveWorkflowId(workflowId);
  }, [workflowId, setActiveWorkflowId, setActiveOrchTab]);

  const hasResult = !!result;
  const hasParams = !!params && Object.keys(params).length > 0;
  const hasDetails = !!(action || file || hasResult || hasParams);
  const displayTarget = file || action || '';

  const errorTone = isError || status === 'error';
  const containerCls = errorTone
    ? 'rounded-lg border border-red-700/50 bg-red-950/20 px-3 py-2 transition-colors'
    : 'rounded-lg border border-zinc-700/50 bg-zinc-800/60 px-3 py-2 transition-colors';

  return (
    <div className={containerCls}>
      <button
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={`flex w-full min-h-[44px] md:min-h-0 items-center gap-2 text-left text-xs ${
          hasDetails ? 'cursor-pointer' : 'cursor-default'
        }`}
        aria-expanded={hasDetails ? expanded : undefined}
      >
        {statusIcon[status]}
        {getToolIcon(toolName)}
        <span className={`font-medium ${errorTone ? 'text-red-300' : 'text-zinc-300'}`}>{toolName}</span>
        {displayTarget && (
          <span className="truncate text-zinc-500" title={displayTarget}>
            {displayTarget}
          </span>
        )}
        <span className="ml-auto flex-shrink-0 text-zinc-500">
          {durationMs != null && status !== 'running' ? `${(durationMs / 1000).toFixed(2)}s` : summary}
        </span>
        {hasDetails && (
          expanded
            ? <ChevronDown size={10} className="flex-shrink-0 text-zinc-500" />
            : <ChevronRight size={10} className="flex-shrink-0 text-zinc-500" />
        )}
      </button>

      {expanded && hasDetails && (
        <div className="mt-1.5 space-y-1.5 border-t border-zinc-700/40 pt-1.5 text-xs text-zinc-500">
          {action && (
            <div>
              <span className="text-zinc-600">action: </span>
              <span className="break-all text-zinc-300 font-mono">{action}</span>
            </div>
          )}
          {file && (
            <div>
              <span className="text-zinc-600">file: </span>
              <span className="text-zinc-400 font-mono">{file}</span>
            </div>
          )}
          {hasParams && (
            <div>
              <div className="mb-0.5 flex items-center text-[10px] uppercase tracking-wider text-zinc-600">
                params
                <InlineCopyButton text={JSON.stringify(params, null, 2)} label="parameters" />
              </div>
              <pre className="max-h-40 overflow-auto rounded bg-zinc-900/70 p-2 text-[11px] text-zinc-300">
                {JSON.stringify(params, null, 2)}
              </pre>
            </div>
          )}
          {hasResult && (
            <div>
              <div className="mb-0.5 flex items-center text-[10px] uppercase tracking-wider text-zinc-600">
                {errorTone ? 'error' : 'result'}
                <InlineCopyButton text={result || ''} label="result" />
              </div>
              <pre className={`max-h-64 overflow-auto rounded p-2 text-[11px] whitespace-pre-wrap break-words ${
                errorTone ? 'bg-red-950/40 text-red-200' : 'bg-zinc-900/70 text-zinc-300'
              }`}>
                {result}
              </pre>
            </div>
          )}
          <div className="flex items-center justify-end gap-1.5">
            {workflowId && (
              <button
                type="button"
                onClick={handleViewInFeed}
                className="flex items-center gap-1 rounded border border-zinc-700/60 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                aria-label="Open this tool call in the Activity Feed"
                title="View in Activity Feed"
              >
                <ExternalLink size={10} />
                Activity Feed
              </button>
            )}
            {errorTone && onRetry && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRetry(); }}
                className="flex items-center gap-1 rounded border border-red-700/50 bg-red-950/40 px-2 py-1 text-[11px] text-red-200 transition-colors hover:bg-red-900/60"
                aria-label="Retry this tool call"
              >
                Retry
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface ToolCallGroupProps {
  nodeLabel: string;
  toolCalls: { id: string; toolCall: ToolCallData; workflowId?: string; onRetry?: () => void }[];
}

export function ToolCallGroup({ nodeLabel, toolCalls }: ToolCallGroupProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="my-2 flex justify-start">
      <div className="max-w-[85%] w-full">
        <div className="rounded-xl border border-zinc-700/40 bg-zinc-850/50 overflow-hidden">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-500 hover:bg-zinc-700/30 transition-colors"
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
                <ToolCallCard
                  key={tc.id}
                  toolCall={tc.toolCall}
                  onRetry={tc.onRetry}
                  workflowId={tc.workflowId}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
