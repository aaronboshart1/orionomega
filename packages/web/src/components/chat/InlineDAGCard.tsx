'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2, Circle } from 'lucide-react';
import { OmegaSpinner } from './OmegaSpinner';
import type { InlineDAG, InlineDAGNode } from '@/stores/orchestration';

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

      {isActive && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-700">
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {isActive && dag.elapsed > 0 && (
        <div className="mt-1 text-right text-[10px] text-zinc-600">
          {dag.elapsed < 60 ? `${Math.round(dag.elapsed)}s` : `${Math.floor(dag.elapsed / 60)}m ${Math.round(dag.elapsed % 60)}s`}
        </div>
      )}

      {expanded && dag.nodes.length > 0 && (
        <div className="mt-2 space-y-0.5 border-t border-zinc-700/50 pt-2">
          {dag.nodes.map((node) => (
            <NodeRow key={node.id} node={node} />
          ))}
        </div>
      )}

      {isError && dag.error && (
        <p className="mt-2 text-xs text-red-400">{dag.error}</p>
      )}
    </div>
  );
}
