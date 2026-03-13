'use client';

import { useOrchestrationStore, type InlineDAG } from '@/stores/orchestration';
import { OmegaSpinner } from './OmegaSpinner';

export function BackgroundTaskIndicator() {
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);

  const activeDAGs: InlineDAG[] = Object.values(inlineDAGs).filter(
    (d) => d.status === 'dispatched' || d.status === 'running',
  );

  if (activeDAGs.length === 0) return null;

  const totalNodes = activeDAGs.reduce((a, d) => a + d.totalCount, 0);
  const completedNodes = activeDAGs.reduce((a, d) => a + d.completedCount, 0);

  return (
    <div className="flex items-center gap-2 rounded-full bg-blue-500/10 px-3 py-1">
      <OmegaSpinner size={3} gap={0.5} interval={180} />
      <span className="text-[11px] text-blue-400">
        {activeDAGs.length === 1
          ? `${completedNodes}/${totalNodes} steps`
          : `${activeDAGs.length} tasks`}
      </span>
    </div>
  );
}
