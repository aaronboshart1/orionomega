'use client';

import { ShieldAlert, Play, X } from 'lucide-react';
import type { DAGConfirmation } from '@/stores/orchestration';

interface DAGConfirmationCardProps {
  confirmation: DAGConfirmation;
  onRespond: (dagId: string, approved: boolean) => void;
}

export function DAGConfirmationCard({ confirmation, onRespond }: DAGConfirmationCardProps) {
  return (
    <div className="rounded-xl border border-yellow-500/30 bg-zinc-800/80 p-4">
      <div className="mb-2 flex items-center gap-2">
        <ShieldAlert size={14} className="text-yellow-500" />
        <span className="text-xs font-semibold text-yellow-400">Confirmation Required</span>
      </div>

      <p className="mb-2 text-sm text-zinc-200">{confirmation.summary}</p>
      <p className="mb-3 text-xs text-zinc-500">{confirmation.reason}</p>

      {confirmation.guardedNodes.length > 0 && (
        <div className="mb-3 space-y-1">
          {confirmation.guardedNodes.map((node) => (
            <div key={node.id} className="flex items-center gap-2 rounded bg-zinc-900 px-3 py-1.5 text-xs">
              <ShieldAlert size={10} className="text-yellow-600" />
              <span className="flex-1 text-zinc-300">{node.label}</span>
              <span className="text-[10px] text-yellow-500/70">{node.risk}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => onRespond(confirmation.dagId, true)}
          className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-green-500"
        >
          <Play size={12} />
          Start
        </button>
        <button
          onClick={() => onRespond(confirmation.dagId, false)}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-600 px-4 py-2 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
        >
          <X size={12} />
          Deny
        </button>
      </div>
    </div>
  );
}
