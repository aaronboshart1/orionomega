'use client';
import { useOrchestrationStore } from '@/stores/orchestration';
import { DAGVisualization } from './DAGVisualization';
import { ActivityFeed } from './ActivityFeed';
import { WorkerDetail } from './WorkerDetail';
import { WorkflowSummary } from './WorkflowSummary';
export function OrchestrationPane() {
    const selectedWorker = useOrchestrationStore((s) => s.selectedWorker);
    return (<div className="flex h-full flex-col bg-[var(--background)]">
      {/* DAG Visualization — 40% */}
      <div className="h-[40%] border-b border-zinc-800">
        <DAGVisualization />
      </div>

      {/* Activity Feed or Worker Detail — 40% */}
      <div className="h-[40%] border-b border-zinc-800 overflow-hidden">
        {selectedWorker ? <WorkerDetail /> : <ActivityFeed />}
      </div>

      {/* Workflow Summary — 20% */}
      <div className="h-[20%]">
        <WorkflowSummary />
      </div>
    </div>);
}
//# sourceMappingURL=OrchestrationPane.js.map