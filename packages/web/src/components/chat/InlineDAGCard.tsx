'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2, Circle } from 'lucide-react';
import { OmegaSpinner } from './OmegaSpinner';
import type { InlineDAG, InlineDAGNode, ModelUsageEntry } from '@/stores/orchestration';

interface InlineDAGCardProps {
  dag: InlineDAG;
}

const nodeStatusIcon: Record<string, React.ReactNode> = {
  pending: <Circle size={12} className="text-zinc-500" />,
  running: <Loader2 size={12} className="animate-spin text-blue-400" />,
  done: <CheckCircle2 size={12} className="text-green-400" />,
  error: <XCircle size={12} className="text-red-400" />,
  skipped: <Circle size={12} className="text-zinc-600" />,
  cancelled: <XCircle size={12} className="text-zinc-400" />,
};

function NodeRow({ node }: { node: InlineDAGNode }) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = !!node.output;

  return (
    <div>
      <button
        onClick={() => hasOutput && setExpanded(!expanded)}
        className={`flex w-full items-center gap-2 rounded px-2 py-1 text-xs transition-colors ${
          hasOutput ? 'cursor-pointer hover:bg-zinc-700/50' : 'cursor-default'
        }`}
      >
        {nodeStatusIcon[node.status] || nodeStatusIcon.pending}
        <span className={`flex-1 text-left ${node.status === 'done' ? 'text-zinc-300' : node.status === 'error' ? 'text-red-300' : 'text-zinc-400'}`}>
          {node.label}
        </span>
        {node.status === 'running' && node.progress !== undefined && (
          <span className="text-[10px] text-blue-400">{node.progress}%</span>
        )}
        {hasOutput && (
          expanded
            ? <ChevronDown size={10} className="text-zinc-500" />
            : <ChevronRight size={10} className="text-zinc-500" />
        )}
      </button>
      {expanded && node.output && (
        <div className="ml-6 mt-1 mb-1 rounded bg-zinc-900 px-3 py-2 text-[11px] text-zinc-400">
          {node.output}
        </div>
      )}
    </div>
  );
}

export function InlineDAGCard({ dag }: InlineDAGCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isActive = dag.status === 'dispatched' || dag.status === 'running';
  const isDone = dag.status === 'complete';
  const isError = dag.status === 'error';
  const isStopped = dag.status === 'stopped';
  const isTerminal = isDone || isError || isStopped;

  const progressPct = dag.totalCount > 0
    ? Math.round((dag.completedCount / dag.totalCount) * 100)
    : 0;

  return (
    <div className={`rounded-xl border px-4 py-3 transition-colors ${
      isActive
        ? 'border-blue-500/30 bg-zinc-800/80'
        : isDone
          ? 'border-green-500/20 bg-zinc-800/60'
          : isError
            ? 'border-red-500/20 bg-zinc-800/60'
            : 'border-zinc-500/20 bg-zinc-800/60'
    }`}>
      {/* Header row */}
      <div className="flex items-center gap-2">
        {isActive && <OmegaSpinner size={4} gap={1} interval={180} />}
        {isDone && <CheckCircle2 size={14} className="text-green-400" />}
        {isError && <XCircle size={14} className="text-red-400" />}
        {isStopped && <Circle size={14} className="text-zinc-400" />}

        <span className="flex-1 text-xs font-medium text-zinc-200">
          {dag.summary}
        </span>

        <span className="text-[10px] text-zinc-500">
          {dag.completedCount}/{dag.totalCount}
        </span>

        {dag.nodes.length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
          >
            {expanded
              ? <ChevronDown size={14} />
              : <ChevronRight size={14} />}
          </button>
        )}
      </div>

      {/* Progress bar */}
      {isActive && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-700">
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {/* Elapsed time for active DAGs */}
      {isActive && dag.elapsed > 0 && (
        <div className="mt-1 text-right text-[10px] text-zinc-600">
          {dag.elapsed < 60 ? `${Math.round(dag.elapsed)}s` : `${Math.floor(dag.elapsed / 60)}m ${Math.round(dag.elapsed % 60)}s`}
        </div>
      )}

      {/* Expanded node list */}
      {expanded && dag.nodes.length > 0 && (
        <div className="mt-2 space-y-0.5 border-t border-zinc-700/50 pt-2">
          {dag.nodes.map((node) => (
            <NodeRow key={node.id} node={node} />
          ))}
        </div>
      )}

      {/* Run Stats */}
      {isTerminal && (dag.modelUsage || dag.totalCostUsd !== undefined) && (
        <RunStats dag={dag} />
      )}

      {/* Error message */}
      {isError && dag.error && (
        <p className="mt-2 text-xs text-red-400">{dag.error}</p>
      )}
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

function RunStats({ dag }: { dag: InlineDAG }) {
  const hasModels = dag.modelUsage && dag.modelUsage.length > 0;

  const totals = hasModels
    ? dag.modelUsage!.reduce(
        (acc, m) => ({
          input: acc.input + m.inputTokens,
          output: acc.output + m.outputTokens,
          cacheR: acc.cacheR + m.cacheReadTokens,
          cacheW: acc.cacheW + m.cacheCreationTokens,
        }),
        { input: 0, output: 0, cacheR: 0, cacheW: 0 },
      )
    : null;

  return (
    <div className="mt-2 border-t border-zinc-700/50 pt-2">
      <div className="flex items-center gap-3 text-[10px] text-zinc-500">
        {dag.durationSec !== undefined && <span>{fmtDuration(dag.durationSec)}</span>}
        {dag.workerCount !== undefined && <span>{dag.workerCount} worker{dag.workerCount !== 1 ? 's' : ''}</span>}
        {dag.totalCostUsd !== undefined && (
          <span className="font-medium text-green-400">${dag.totalCostUsd.toFixed(4)}</span>
        )}
      </div>

      {hasModels && (
        <div className="mt-1.5 space-y-0.5">
          <div className="grid grid-cols-[1fr_3rem_3rem_3rem_3rem_3.5rem] gap-1 text-[9px] text-zinc-600">
            <span>Model</span>
            <span className="text-right">Input</span>
            <span className="text-right">Output</span>
            <span className="text-right">Cache R</span>
            <span className="text-right">Cache W</span>
            <span className="text-right">Cost</span>
          </div>
          {dag.modelUsage!.map((m) => (
            <div key={m.model} className="grid grid-cols-[1fr_3rem_3rem_3rem_3rem_3.5rem] gap-1 text-[10px]">
              <span className="truncate text-purple-400">{m.model}</span>
              <span className="text-right text-zinc-400">{fmtTokens(m.inputTokens)}</span>
              <span className="text-right text-zinc-400">{fmtTokens(m.outputTokens)}</span>
              <span className="text-right text-zinc-500">{fmtTokens(m.cacheReadTokens)}</span>
              <span className="text-right text-zinc-500">{fmtTokens(m.cacheCreationTokens)}</span>
              <span className="text-right text-zinc-300">${m.costUsd.toFixed(4)}</span>
            </div>
          ))}
          {totals && (
            <div className="grid grid-cols-[1fr_3rem_3rem_3rem_3rem_3.5rem] gap-1 border-t border-zinc-700/30 pt-0.5 text-[10px] font-medium">
              <span className="text-zinc-400">Total</span>
              <span className="text-right text-zinc-300">{fmtTokens(totals.input)}</span>
              <span className="text-right text-zinc-300">{fmtTokens(totals.output)}</span>
              <span className="text-right text-zinc-400">{fmtTokens(totals.cacheR)}</span>
              <span className="text-right text-zinc-400">{fmtTokens(totals.cacheW)}</span>
              <span className="text-right text-green-400">${dag.totalCostUsd?.toFixed(4) ?? '0.0000'}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
