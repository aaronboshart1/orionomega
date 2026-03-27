'use client';

import { useOrchestrationStore, type InlineDAG } from '@/stores/orchestration';
import { OmegaSpinner } from './OmegaSpinner';
import { Badge } from '@/components/ui/badge';

export function BackgroundTaskIndicator() {
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);

  const activeDAGs: InlineDAG[] = Object.values(inlineDAGs).filter(
    (d) => d.status === 'dispatched' || d.status === 'running',
  );

  if (activeDAGs.length === 0) return null;

  const totalNodes = activeDAGs.reduce((a, d) => a + d.totalCount, 0);
  const completedNodes = activeDAGs.reduce((a, d) => a + d.completedCount, 0);
  const label =
    activeDAGs.length === 1
      ? `${completedNodes}/${totalNodes} steps`
      : `${activeDAGs.length} tasks`;

  return (
    <Badge
      variant="secondary"
      className="gap-1.5 pl-1.5 bg-blue-500/10 border-blue-500/20 text-blue-400"
      aria-label={`${activeDAGs.length} background ${activeDAGs.length === 1 ? 'task' : 'tasks'} running`}
    >
      <OmegaSpinner size={3} gap={0.5} interval={180} />
      <span className="text-[11px]">{label}</span>
    </Badge>
  );
}
