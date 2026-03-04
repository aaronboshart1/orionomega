'use client';

import { useMemo } from 'react';
import { useOrchestrationStore } from '@/stores/orchestration';

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

const statusBadge: Record<string, { bg: string; text: string }> = {
  planning: { bg: 'bg-yellow-500/10', text: 'text-yellow-500' },
  planned: { bg: 'bg-yellow-500/10', text: 'text-yellow-500' },
  running: { bg: 'bg-blue-500/10', text: 'text-blue-400' },
  paused: { bg: 'bg-orange-500/10', text: 'text-orange-400' },
  complete: { bg: 'bg-green-500/10', text: 'text-green-400' },
  error: { bg: 'bg-red-500/10', text: 'text-red-400' },
  stopped: { bg: 'bg-zinc-500/10', text: 'text-zinc-400' },
};

export function WorkflowSummary() {
  const graphState = useOrchestrationStore((s) => s.graphState);

  const stats = useMemo(() => {
    if (!graphState) return null;
    const nodes = Object.values(graphState.nodes);
    return {
      running: nodes.filter((n) => n.status === 'running').length,
      done: nodes.filter((n) => n.status === 'done').length,
      pending: nodes.filter((n) => n.status === 'pending' || n.status === 'waiting').length,
      error: nodes.filter((n) => n.status === 'error').length,
      total: nodes.length,
    };
  }, [graphState]);

  if (!graphState || !stats) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        No active workflow
      </div>
    );
  }

  const badge = statusBadge[graphState.status] || statusBadge.running;
  const progressPct =
    stats.total > 0 ? Math.round(((stats.done + stats.error) / stats.total) * 100) : 0;

  return (
    <div className="flex h-full items-center gap-6 px-6">
      {/* Workflow name and status */}
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-semibold text-zinc-200">{graphState.name}</h3>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.bg} ${badge.text}`}>
          {graphState.status.toUpperCase()}
        </span>
      </div>

      {/* Divider */}
      <div className="h-6 w-px bg-zinc-800" />

      {/* Layers progress */}
      <div className="text-xs text-zinc-400">
        <span className="text-zinc-200">{graphState.completedLayers}</span>
        <span className="text-zinc-600">/</span>
        <span>{graphState.totalLayers}</span>
        <span className="ml-1 text-zinc-600">layers</span>
      </div>

      {/* Worker breakdown */}
      <div className="flex items-center gap-3 text-xs">
        {stats.running > 0 && (
          <span className="text-blue-400">
            {stats.running} running
          </span>
        )}
        {stats.done > 0 && (
          <span className="text-green-400">
            {stats.done} done
          </span>
        )}
        {stats.pending > 0 && (
          <span className="text-zinc-500">
            {stats.pending} pending
          </span>
        )}
        {stats.error > 0 && (
          <span className="text-red-400">
            {stats.error} error
          </span>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Progress bar */}
      <div className="flex items-center gap-3">
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-blue-500 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <span className="text-xs text-zinc-500">{progressPct}%</span>
      </div>

      {/* Elapsed time */}
      <span className="text-xs text-zinc-500">
        ⏱ {formatElapsed(graphState.elapsed)}
      </span>
    </div>
  );
}
