'use client';

import dynamic from 'next/dynamic';
import { useOrchestrationStore } from '@/stores/orchestration';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ActivityFeed } from './ActivityFeed';
import { MacroExpansionPanel } from './MacroExpansionPanel';
import { PlanningIndicator } from './PlanningIndicator';
import { WorkerDetail } from './WorkerDetail';
import { WorkflowSummary } from './WorkflowSummary';
import { MemoryFeed } from './MemoryFeed';
import { LogsPane } from './LogsPane';
import { FileViewer } from './FileViewer';

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

const SchedulesPane = dynamic(
  () => import('./SchedulesPane').then((m) => m.SchedulesPane),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        Loading Tasker…
      </div>
    ),
  },
);

const GitPane = dynamic(
  () => import('./GitPane').then((m) => m.GitPane),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        Loading Git…
      </div>
    ),
  },
);

export type OrchTabKind = 'memory' | 'schedules' | 'git' | 'logs' | 'files' | 'workflow';

/**
 * Renders just the per-tab content of the orchestration pane (no tab strip).
 * Shared between the in-app pane and the standalone `/orch/...` pop-out route
 * so both stay visually and behaviourally identical.
 */
export function OrchPaneBody({
  kind,
  workflowId,
}: {
  kind: OrchTabKind;
  workflowId?: string;
}) {
  const selectedWorker = useOrchestrationStore((s) => s.selectedWorker);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const activeWorkflowId = useOrchestrationStore((s) => s.activeWorkflowId);
  const activitySectionCollapsed = useOrchestrationStore((s) => s.activitySectionCollapsed);

  if (kind === 'files') {
    return (
      <div className="flex-1 min-h-0 h-full overflow-hidden">
        <FileViewer />
      </div>
    );
  }
  if (kind === 'memory') {
    return (
      <div className="flex-1 min-h-0 h-full overflow-hidden">
        <MemoryFeed />
      </div>
    );
  }
  if (kind === 'logs') {
    return (
      <div className="flex-1 min-h-0 h-full overflow-hidden">
        <LogsPane />
      </div>
    );
  }
  if (kind === 'schedules') {
    return (
      <div className="flex-1 min-h-0 h-full overflow-hidden">
        <SchedulesPane />
      </div>
    );
  }
  if (kind === 'git') {
    return (
      <div className="flex-1 min-h-0 h-full overflow-hidden">
        <GitPane />
      </div>
    );
  }

  // Workflow body — needs an active workflow id in the store.
  const targetId = workflowId ?? activeWorkflowId;
  const targetDag = targetId ? inlineDAGs[targetId] : null;
  const activeIsDirect = !!targetDag?.isDirect;

  if (!targetId || !targetDag) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-sm text-zinc-400">Workflow not found</div>
        <div className="max-w-xs text-xs text-zinc-600">
          This workflow is not in the current session, or hasn&apos;t arrived yet.
          It may have been removed, or the gateway is still syncing state.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {!activeIsDirect && (
        <div className="flex-[4] min-h-0 border-b border-zinc-800 relative overflow-hidden">
          <div className="flex items-center px-3 py-1.5 border-b border-zinc-800/60 bg-zinc-900/30">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Graph</span>
          </div>
          <ErrorBoundary>
            <DAGVisualization />
          </ErrorBoundary>
        </div>
      )}

      {!activeIsDirect && <PlanningIndicator />}
      {!activeIsDirect && <MacroExpansionPanel />}

      <div
        className={`border-b border-zinc-800 overflow-hidden transition-[flex] duration-300 ease-in-out ${
          activitySectionCollapsed ? 'flex-none' : (activeIsDirect ? 'flex-[8] min-h-0' : 'flex-[4] min-h-0')
        }`}
      >
        {selectedWorker ? <WorkerDetail /> : <ActivityFeed />}
      </div>

      <div className="flex-[2] min-h-0">
        <div className="flex items-center px-3 py-1.5 border-b border-zinc-800/60 bg-zinc-900/30">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Summary</span>
        </div>
        <WorkflowSummary />
      </div>
    </div>
  );
}
