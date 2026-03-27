'use client';

import { useOrchestrationStore } from '@/stores/orchestration';
import { DAGVisualization } from './DAGVisualization';
import { ActivityFeed } from './ActivityFeed';
import { WorkerDetail } from './WorkerDetail';
import { WorkflowSummary } from './WorkflowSummary';
import { WorkflowTabs } from './WorkflowTabs';

export function OrchestrationPane() {
  const selectedWorker = useOrchestrationStore((s) => s.selectedWorker);

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <WorkflowTabs />

      <div className="flex-[4] min-h-0 border-b border-zinc-800">
        <DAGVisualization />
      </div>

      <div className="flex-[4] min-h-0 border-b border-zinc-800 overflow-hidden">
        {selectedWorker ? <WorkerDetail /> : <ActivityFeed />}
      </div>

      <div className="flex-[2] min-h-0">
        <WorkflowSummary />
      </div>
    </div>
  );
}
