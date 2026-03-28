'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2, Circle, Play, Pause, Square } from 'lucide-react';
import { OmegaSpinner } from './OmegaSpinner';
import { useOrchestrationStore } from '@/stores/orchestration';
import { useGateway } from '@/lib/gateway';
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
          <span className="text-xs text-blue-400">{node.progress}%</span>
        )}
        {hasOutput && (
          expanded
            ? <ChevronDown size={10} className="text-zinc-500" />
            : <ChevronRight size={10} className="text-zinc-500" />
        )}
      </button>
      {expanded && node.output && (
        <div className="ml-6 mt-1 mb-1 rounded bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
          {node.output}
        </div>
      )}
    </div>
  );
}

export function InlineDAGCard({ dag }: InlineDAGCardProps) {
  const [expanded, setExpanded] = useState(false);
  const openOrchPane = useOrchestrationStore((s) => s.openOrchPane);
  const { sendWorkflowCommand } = useGateway();

  const isActive = dag.status === 'dispatched' || dag.status === 'running';
  const isDone = dag.status === 'complete';
  const isError = dag.status === 'error';
  const isStopped = dag.status === 'stopped';
  const isPaused = dag.status === 'paused';
  const isInterrupted = dag.status === 'interrupted';

  const showPlayResume = isPaused || isInterrupted;
  const showPause = isActive;
  const showStop = isActive || isPaused;

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
            : isPaused || isInterrupted
              ? 'border-amber-500/30 bg-zinc-800/70'
              : 'border-zinc-500/20 bg-zinc-800/60'
    }`}>
      <div className="flex items-center gap-2">
        {isActive && <OmegaSpinner size={3} gap={1} interval={180} />}
        {isDone && <CheckCircle2 size={14} className="text-green-400" />}
        {isError && <XCircle size={14} className="text-red-400" />}
        {isStopped && <Circle size={14} className="text-zinc-400" />}
        {isPaused && <Pause size={14} className="text-amber-400" />}
        {isInterrupted && <Circle size={14} className="text-amber-400" />}

        <span className="flex-1 text-xs font-medium text-zinc-200">
          {dag.summary}
        </span>

        <span className="text-xs text-zinc-500">
          {dag.completedCount}/{dag.totalCount}
        </span>

        <div className="flex items-center gap-1">
          {showPlayResume && (
            <button
              onClick={() => sendWorkflowCommand('resume', dag.dagId)}
              className={`rounded p-1 transition-colors ${
                isInterrupted
                  ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                  : 'text-green-400 hover:bg-green-500/20'
              }`}
              title={isInterrupted ? 'Resume interrupted workflow' : 'Resume'}
            >
              <Play size={12} />
            </button>
          )}
          {showPause && (
            <button
              onClick={() => sendWorkflowCommand('pause', dag.dagId)}
              className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-amber-400"
              title="Pause at next layer boundary"
            >
              <Pause size={12} />
            </button>
          )}
          {showStop && (
            <button
              onClick={() => sendWorkflowCommand('stop', dag.dagId)}
              className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-red-400"
              title="Stop workflow"
            >
              <Square size={12} />
            </button>
          )}
        </div>

        {dag.nodes.length > 0 && (
          <button
            onClick={() => {
              setExpanded(!expanded);
              if (!expanded) {
                openOrchPane(dag.dagId);
              }
            }}
            className="rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
          >
            {expanded
              ? <ChevronDown size={14} />
              : <ChevronRight size={14} />}
          </button>
        )}
      </div>

      {(isActive || isPaused) && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-700">
          <div
            className={`h-full rounded-full transition-all duration-300 ${isPaused ? 'bg-amber-500' : 'bg-blue-500'}`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {(isActive || isPaused) && dag.elapsed > 0 && (
        <div className="mt-1 text-right text-xs text-zinc-600">
          {isPaused && <span className="mr-1 text-amber-500">paused</span>}
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

      {expanded && dag.nodes.length === 0 && isActive && (
        <div className="mt-2 space-y-2 border-t border-zinc-700/50 pt-2">
          <div className="flex items-center gap-2 px-2">
            <div className="h-3 w-3 animate-pulse rounded-full bg-zinc-700" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-700" />
          </div>
          <div className="flex items-center gap-2 px-2">
            <div className="h-3 w-3 animate-pulse rounded-full bg-zinc-700/70" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-zinc-700/70" />
          </div>
          <div className="flex items-center gap-2 px-2">
            <div className="h-3 w-3 animate-pulse rounded-full bg-zinc-700/50" />
            <div className="h-3 w-3/5 animate-pulse rounded bg-zinc-700/50" />
          </div>
        </div>
      )}

      {(isError || isStopped) && dag.error && (
        <p className="mt-2 text-xs text-red-400">{dag.error}</p>
      )}

      {isInterrupted && dag.error && (
        <p className="mt-2 text-xs text-amber-400">{dag.error}</p>
      )}
    </div>
  );
}
