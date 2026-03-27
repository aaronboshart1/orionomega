'use client';

import { useState } from 'react';
import { Clock, DollarSign, Users, Play, Pencil, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
    <Card role="region" aria-label="Execution plan">
      <CardContent className="p-5">
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
                  <Badge variant="secondary" className="text-[10px]">
                    {node.agent.model}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Modify input */}
        {showModify && (
          <div className="mb-4 flex gap-2">
            <Input
              type="text"
              value={modification}
              onChange={(e) => setModification(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleModify()}
              placeholder="Describe modifications..."
              autoFocus
              aria-label="Plan modification"
            />
            <Button onClick={handleModify} size="sm">
              Send
            </Button>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <Button
            onClick={() => onRespond(plan.id, 'approve')}
            size="sm"
          >
            <Play size={12} />
            Approve & Execute
          </Button>
          <Button
            onClick={() => setShowModify(!showModify)}
            variant="outline"
            size="sm"
          >
            <Pencil size={12} />
            Modify
          </Button>
          <Button
            onClick={() => onRespond(plan.id, 'reject')}
            variant="ghost"
            size="sm"
          >
            <X size={12} />
            Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
