'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Bot, Wrench, GitBranch, Zap, Link, Clock, CheckCircle2, XCircle, Minus } from 'lucide-react';
import { useOrchestrationStore } from '@/stores/orchestration';
import { OmegaSpinner } from '../chat/OmegaSpinner';

interface WorkerNodeData {
  label: string;
  nodeType: string;
  status: string;
  progress?: number;
  model?: string;
  [key: string]: unknown;
}

const statusColors: Record<string, { border: string; bg: string; text: string }> = {
  pending: { border: 'border-zinc-600', bg: 'bg-zinc-800', text: 'text-zinc-400' },
  waiting: { border: 'border-zinc-600', bg: 'bg-zinc-800', text: 'text-zinc-400' },
  running: { border: 'border-blue-500', bg: 'bg-zinc-800', text: 'text-blue-400' },
  done: { border: 'border-green-500/70', bg: 'bg-zinc-800', text: 'text-green-400' },
  error: { border: 'border-red-500', bg: 'bg-zinc-800', text: 'text-red-400' },
  skipped: { border: 'border-zinc-700', bg: 'bg-zinc-900', text: 'text-zinc-600' },
};

function StatusIcon({ status }: { status: string }) {
  const cls = 'h-3.5 w-3.5 flex-shrink-0';
  switch (status) {
    case 'running':  return <OmegaSpinner size={3} gap={1} interval={180} />;
    case 'done':     return <CheckCircle2 className={`${cls} text-green-400`} />;
    case 'error':    return <XCircle className={`${cls} text-red-400`} />;
    case 'skipped':  return <Minus className={`${cls} text-zinc-600`} />;
    default:         return <Clock className={`${cls} text-zinc-500`} />;
  }
}

function NodeTypeIcon({ type }: { type: string }) {
  const cls = 'h-3.5 w-3.5 flex-shrink-0';
  switch (type) {
    case 'AGENT':    return <Bot className={cls} />;
    case 'TOOL':     return <Wrench className={cls} />;
    case 'ROUTER':   return <GitBranch className={cls} />;
    case 'PARALLEL': return <Zap className={cls} />;
    case 'JOIN':     return <Link className={cls} />;
    default:         return <Bot className={cls} />;
  }
}

function WorkerNodeComponent({ data, id }: NodeProps) {
  const selectedWorker = useOrchestrationStore((s) => s.selectedWorker);
  const d = data as WorkerNodeData;
  const colors = statusColors[d.status] || statusColors.pending;
  const isSelected = selectedWorker === id;

  return (
    <>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-zinc-600 !bg-zinc-500" />
      <div
        className={`min-w-[140px] max-w-[300px] overflow-hidden rounded-lg border-2 ${colors.border} ${colors.bg} px-3 py-2 shadow-lg transition-all cursor-pointer hover:brightness-110 ${
          isSelected ? 'ring-2 ring-blue-400 ring-offset-1 ring-offset-zinc-900' : ''
        } ${d.status === 'skipped' ? 'opacity-50' : ''}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <StatusIcon status={d.status as string} />
          <NodeTypeIcon type={d.nodeType as string} />
          <span className={`flex-1 min-w-0 text-xs font-medium ${colors.text} truncate`}>{d.label as string}</span>
        </div>

        {/* Progress bar */}
        {d.status === 'running' && d.progress !== undefined && (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-zinc-700">
            <div
              className="h-full rounded-full bg-blue-500 transition-all"
              style={{ width: `${d.progress}%` }}
            />
          </div>
        )}

        {/* Model badge */}
        {d.model && (
          <div className="mt-1.5">
            <span className="rounded bg-zinc-700/80 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">
              {d.model as string}
            </span>
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-zinc-600 !bg-zinc-500" />
    </>
  );
}

export const WorkerNode = memo(WorkerNodeComponent);
