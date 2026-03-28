'use client';

import { useState } from 'react';
import { Clock, DollarSign, Users, Play, Pencil, X } from 'lucide-react';
import type { PlanData, GraphNode } from '@/stores/orchestration';

interface PlanCardProps {
  plan: PlanData;
  onRespond: (planId: string, action: string, modification?: string) => void;
}

function nodeTypeIcon(type: string) {
  switch (type) {
    case 'AGENT': return '🤖';
    case 'TOOL': return '🔧';
    case 'ROUTER': return '🔀';
    case 'PARALLEL': return '⚡';
    case 'JOIN': return '🔗';
    default: return '📦';
  }
}

export function PlanCard({ plan, onRespond }: PlanCardProps) {
  const [showModify, setShowModify] = useState(false);
  const [modification, setModification] = useState('');

  const nodes = plan.graph?.nodes ? Object.values(plan.graph.nodes) : [];
  const workerCount = nodes.filter((n: GraphNode) => n.type === 'AGENT').length;

  const handleModify = () => {
    if (modification.trim()) {
      onRespond(plan.id, 'modify', modification.trim());
      setShowModify(false);
      setModification('');
    }
  };

  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-5">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-100">📋 Execution Plan</h3>
        <div className="flex items-center gap-4 text-xs text-zinc-400">
          <span className="flex items-center gap-1">
            <Clock size={12} />
            {plan.estimatedTime}s
          </span>
          <span className="flex items-center gap-1">
            <DollarSign size={12} />
            ${plan.estimatedCost.toFixed(3)}
          </span>
          <span className="flex items-center gap-1">
            <Users size={12} />
            {workerCount} workers
          </span>
        </div>
      </div>

      {/* Summary */}
      <p className="mb-3 text-sm text-zinc-300">{plan.summary}</p>

      {/* Reasoning */}
      <p className="mb-4 text-xs italic text-zinc-500">{plan.reasoning}</p>

      {/* Workers */}
      {nodes.length > 0 && (
        <div className="mb-4 space-y-2">
          {nodes.map((node: GraphNode) => (
            <div
              key={node.id}
              className="flex items-center gap-3 rounded-lg bg-zinc-800 px-3 py-2 text-xs"
            >
              <span>{nodeTypeIcon(node.type)}</span>
              <span className="flex-1 text-zinc-200">{node.label}</span>
              {node.agent && (
                <span className="rounded bg-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400">
                  {node.agent.model}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Modify input */}
      {showModify && (
        <div className="mb-4 flex gap-2">
          <input
            type="text"
            value={modification}
            onChange={(e) => setModification(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleModify()}
            placeholder="Describe modifications..."
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-200 placeholder-zinc-500 outline-none focus:border-blue-600"
            autoFocus
          />
          <button
            onClick={handleModify}
            className="min-h-[44px] rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-500 md:min-h-0 md:text-xs"
          >
            Send
          </button>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onRespond(plan.id, 'approve')}
          className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 md:min-h-0 md:text-xs"
        >
          <Play size={12} />
          Approve & Execute
        </button>
        <button
          onClick={() => setShowModify(!showModify)}
          className="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 md:min-h-0 md:text-xs"
        >
          <Pencil size={12} />
          Modify
        </button>
        <button
          onClick={() => onRespond(plan.id, 'reject')}
          className="flex min-h-[44px] items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-300 md:min-h-0 md:text-xs"
        >
          <X size={12} />
          Reject
        </button>
      </div>
    </div>
  );
}
