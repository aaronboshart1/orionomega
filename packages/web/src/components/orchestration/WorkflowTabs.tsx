'use client';

import { X } from 'lucide-react';
import { useOrchestrationStore } from '@/stores/orchestration';
import type { InlineDAGStatus } from '@/stores/orchestration';

const statusColors: Record<string, string> = {
  dispatched: 'bg-yellow-500',
  running: 'bg-blue-500',
  complete: 'bg-green-500',
  error: 'bg-red-500',
  stopped: 'bg-zinc-500',
  pending: 'bg-zinc-500',
  planned: 'bg-yellow-500',
  planning: 'bg-yellow-500',
  paused: 'bg-orange-500',
};

function getWorkflowStatus(
  dagStatus?: InlineDAGStatus,
  graphStatus?: string,
): string {
  return dagStatus || graphStatus || 'pending';
}

export function WorkflowTabs() {
  const workflows = useOrchestrationStore((s) => s.workflows);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const activeWorkflowId = useOrchestrationStore((s) => s.activeWorkflowId);
  const setActiveWorkflowId = useOrchestrationStore((s) => s.setActiveWorkflowId);
  const removeWorkflow = useOrchestrationStore((s) => s.removeWorkflow);

  const workflowIds = Object.keys(workflows);

  if (workflowIds.length <= 1) return null;

  return (
    <div role="tablist" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-900/50 px-2 py-1.5">
      {workflowIds.map((wfId) => {
        const dag = inlineDAGs[wfId];
        const graph = workflows[wfId]?.graphState;
        const status = getWorkflowStatus(dag?.status, graph?.status);
        const label = dag?.summary || graph?.name || wfId.slice(0, 8);
        const isActive = wfId === activeWorkflowId;
        const isTerminal = status === 'complete' || status === 'error' || status === 'stopped';
        const dotColor = statusColors[status] || 'bg-zinc-500';

        return (
          <div
            key={wfId}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            onClick={() => setActiveWorkflowId(wfId)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setActiveWorkflowId(wfId); }}
            className={`group flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              isActive
                ? 'bg-zinc-800 text-zinc-200 ring-1 ring-zinc-600'
                : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
            }`}
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${dotColor} ${
                status === 'running' ? 'animate-pulse' : ''
              }`}
            />
            <span className="max-w-[140px] truncate">{label}</span>
            {isTerminal && (
              <button
                type="button"
                aria-label={`Close ${label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  removeWorkflow(wfId);
                }}
                className="ml-0.5 rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-300 group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
