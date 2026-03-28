'use client';

import { useOrchestrationStore } from '@/stores/orchestration';
import { DAGVisualization } from './DAGVisualization';
import { ActivityFeed } from './ActivityFeed';
import { WorkerDetail } from './WorkerDetail';
import { WorkflowSummary } from './WorkflowSummary';
import { WorkflowTabs } from './WorkflowTabs';
import { MemoryFeed } from './MemoryFeed';

export function OrchestrationPane() {
  const selectedWorker = useOrchestrationStore((s) => s.selectedWorker);
  const activeOrchTab = useOrchestrationStore((s) => s.activeOrchTab);
  const setActiveOrchTab = useOrchestrationStore((s) => s.setActiveOrchTab);
  const hasWorkflows = useOrchestrationStore((s) => Object.keys(s.workflows).length > 0);
  const memoryCount = useOrchestrationStore((s) => s.memoryEvents.length);

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div className="flex items-center border-b border-zinc-800">
        <button
          onClick={() => setActiveOrchTab('memory')}
          className={`px-4 py-2.5 text-xs font-medium transition-colors relative ${
            activeOrchTab === 'memory'
              ? 'text-violet-400'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Memory
          {memoryCount > 0 && (
            <span className="ml-1.5 text-[10px] bg-violet-500/20 text-violet-400 rounded-full px-1.5 py-0.5 font-mono">
              {memoryCount}
            </span>
          )}
          {activeOrchTab === 'memory' && (
            <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-violet-400 rounded-full" />
          )}
        </button>
        <button
          onClick={() => setActiveOrchTab('activity')}
          className={`px-4 py-2.5 text-xs font-medium transition-colors relative ${
            activeOrchTab === 'activity'
              ? 'text-blue-400'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Activity
          {activeOrchTab === 'activity' && (
            <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-blue-400 rounded-full" />
          )}
        </button>
      </div>

      {activeOrchTab === 'memory' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <MemoryFeed />
        </div>
      ) : (
        <>
          {hasWorkflows && <WorkflowTabs />}

          <div className="flex-[4] min-h-0 border-b border-zinc-800">
            <DAGVisualization />
          </div>

          <div className="flex-[4] min-h-0 border-b border-zinc-800 overflow-hidden">
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
