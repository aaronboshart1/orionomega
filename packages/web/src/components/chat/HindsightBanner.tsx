'use client';

import { AlertTriangle } from 'lucide-react';
import { useOrchestrationStore } from '@/stores/orchestration';

export function HindsightBanner() {
  const hindsight = useOrchestrationStore((s) => s.hindsight);

  if (hindsight.connected !== false) return null;

  return (
    <div className="flex items-center gap-2 border-b border-yellow-500/20 bg-yellow-500/5 px-6 py-2">
      <AlertTriangle size={14} className="shrink-0 text-yellow-500" />
      <p className="text-xs text-yellow-400">
        Memory offline — agent context is limited to recent messages.
      </p>
    </div>
  );
}
