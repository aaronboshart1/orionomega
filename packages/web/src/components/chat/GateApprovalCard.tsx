'use client';

import { ShieldAlert, Check, X } from 'lucide-react';
import type { PendingGate } from '@/stores/orchestration';

interface GateApprovalCardProps {
  gate: PendingGate;
  resolved?: 'approved' | 'denied' | 'expired' | null;
  onRespond: (gateId: string, approved: boolean) => void;
}

export function GateApprovalCard({ gate, resolved, onRespond }: GateApprovalCardProps) {
  const isResolved =
    resolved === 'approved' || resolved === 'denied' || resolved === 'expired';
  const resolvedLabel =
    resolved === 'approved' ? 'Approved'
      : resolved === 'denied' ? 'Denied'
        : resolved === 'expired' ? 'Expired — no response needed'
          : '';
  const resolvedClass =
    resolved === 'approved' ? 'text-green-400' : 'text-zinc-500';

  return (
    <div className="rounded-xl border border-yellow-500/30 bg-zinc-800/80 p-4">
      <div className="mb-2 flex items-center gap-2">
        <ShieldAlert size={14} className="text-yellow-500" />
        <span className="text-xs font-semibold text-yellow-400">Tool Approval Required</span>
        {gate.workflowName && (
          <span className="ml-auto text-xs text-zinc-500">{gate.workflowName}</span>
        )}
      </div>

      <p className="mb-1 text-sm text-zinc-200">
        <span className="font-mono text-yellow-300">{gate.action}</span>
      </p>
      <p className="mb-3 text-xs text-zinc-400">{gate.description}</p>

      {isResolved ? (
        <div className={`text-xs font-medium ${resolvedClass}`}>
          {resolvedLabel}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button
            onClick={() => onRespond(gate.gateId, true)}
            className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-green-500"
          >
            <Check size={12} />
            Allow
          </button>
          <button
            onClick={() => onRespond(gate.gateId, false)}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-600 px-4 py-2 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
          >
            <X size={12} />
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
