'use client';

import dynamic from 'next/dynamic';
import { useOrchestrationStore } from '@/stores/orchestration';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ActivityFeed } from './ActivityFeed';
import { WorkerDetail } from './WorkerDetail';
import { WorkflowSummary } from './WorkflowSummary';
import { MemoryFeed } from './MemoryFeed';
import { X, Play, Pause, Square } from 'lucide-react';
import { useGateway } from '@/lib/gateway';
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

const DAGVisualization = dynamic(
  () => import('./DAGVisualization').then((m) => m.DAGVisualization),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        Loading graph…
      </div>
    ),
  },
);

export function OrchestrationPane() {
  const selectedWorker = useOrchestrationStore((s) => s.selectedWorker);
  const activeOrchTab = useOrchestrationStore((s) => s.activeOrchTab);
  const setActiveOrchTab = useOrchestrationStore((s) => s.setActiveOrchTab);
  const memoryCount = useOrchestrationStore((s) => s.memoryEvents.length);
  const workflows = useOrchestrationStore((s) => s.workflows);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const activeWorkflowId = useOrchestrationStore((s) => s.activeWorkflowId);
  const setActiveWorkflowId = useOrchestrationStore((s) => s.setActiveWorkflowId);
  const removeWorkflow = useOrchestrationStore((s) => s.removeWorkflow);
  const activitySectionCollapsed = useOrchestrationStore((s) => s.activitySectionCollapsed);
  const { sendWorkflowCommand } = useGateway();

  const workflowIds = Object.keys(workflows);

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div role="tablist" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 px-2 py-1.5">
        <button
          role="tab"
          aria-selected={activeOrchTab === 'memory'}
          onClick={() => setActiveOrchTab('memory')}
          className={`px-3 py-1.5 text-xs font-medium transition-colors relative rounded-md ${
            activeOrchTab === 'memory'
              ? 'bg-zinc-800 text-violet-400 ring-1 ring-zinc-600'
              : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
          }`}
        >
          Memory
          {memoryCount > 0 && (
            <span className="ml-1.5 text-[10px] bg-violet-500/20 text-violet-400 rounded-full px-1.5 py-0.5 font-mono">
              {memoryCount}
            </span>
          )}
        </button>

        {workflowIds.map((wfId) => {
          const dag = inlineDAGs[wfId];
          const graph = workflows[wfId]?.graphState;
          const status = getWorkflowStatus(dag?.status, graph?.status);
          const label = dag?.summary || graph?.name || wfId.slice(0, 8);
          const isActive = activeOrchTab === 'workflow' && wfId === activeWorkflowId;
          const isTerminal = status === 'complete' || status === 'error' || status === 'stopped';
          const dotColor = statusColors[status] || 'bg-zinc-500';

          const isRunning = status === 'dispatched' || status === 'running';
          const isPaused = status === 'paused';
          const isInterrupted = status === 'interrupted';

          const showPlayResume = isPaused || isInterrupted;
          const showPause = isRunning;
          const showStop = isRunning || isPaused;

          const hoverOnly = isActive ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100';

          return (
            <div
              key={wfId}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              onClick={() => {
                setActiveWorkflowId(wfId);
                setActiveOrchTab('workflow');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  setActiveWorkflowId(wfId);
                  setActiveOrchTab('workflow');
                }
              }}
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
              <div className="flex items-center gap-0.5">
                {showPlayResume && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      sendWorkflowCommand('resume', wfId);
                    }}
                    className={`rounded p-0.5 transition-all focus-visible:opacity-100 ${hoverOnly} ${
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
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      sendWorkflowCommand('pause', wfId);
                    }}
                    className={`rounded p-0.5 text-zinc-400 transition-all hover:bg-zinc-700 hover:text-amber-400 focus-visible:opacity-100 ${hoverOnly}`}
                    title="Pause at next layer boundary"
                  >
                    <Pause size={12} />
                  </button>
                )}
                {showStop && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      sendWorkflowCommand('stop', wfId);
                    }}
                    className={`rounded p-0.5 text-zinc-400 transition-all hover:bg-zinc-700 hover:text-red-400 focus-visible:opacity-100 ${hoverOnly}`}
                    title="Stop workflow"
                  >
                    <Square size={12} />
                  </button>
                )}
              </div>
              {isTerminal && (
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeWorkflow(wfId);
                  }}
                  className="ml-0.5 rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-zinc-300 group-hover:opacity-100 group-focus-visible:opacity-100 focus-visible:opacity-100"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {activeOrchTab === 'memory' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <MemoryFeed />
        </div>
      ) : (
        <>
          <div className="flex-[4] min-h-0 border-b border-zinc-800">
            <ErrorBoundary>
              <DAGVisualization />
            </ErrorBoundary>
          </div>

          <div
            className={`border-b border-zinc-800 overflow-hidden transition-[flex] duration-300 ease-in-out ${activitySectionCollapsed ? 'flex-none' : 'flex-[4] min-h-0'}`}
          >
            {selectedWorker ? <WorkerDetail /> : <ActivityFeed />}
          </div>

          <div className="flex-[2] min-h-0">
            <WorkflowSummary />
          </div>
        </>
      )}
    </div>
  );
}
