'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Layers, ChevronRight, ChevronDown } from 'lucide-react';

/**
 * Task #233: macro phase → sub-DAG nesting.
 *
 * `GroupContainerNode` is a non-interactive hull drawn *behind* an expanded
 * sub-DAG with a clickable header to collapse it. `GroupSummaryNode` is the
 * single node that replaces a collapsed sub-DAG, showing aggregate progress.
 */

export interface GroupSummaryData {
  title: string;
  memberCount: number;
  doneCount: number;
  runningCount: number;
  errorCount: number;
  status: 'pending' | 'running' | 'done' | 'error';
  onToggleGroup?: (groupId: string) => void;
  groupId: string;
  [key: string]: unknown;
}

export interface GroupContainerData {
  title: string;
  memberCount: number;
  onToggleGroup?: (groupId: string) => void;
  groupId: string;
  [key: string]: unknown;
}

const summaryColors: Record<string, string> = {
  pending: 'border-zinc-600 text-zinc-300',
  running: 'border-blue-500 text-blue-300',
  done: 'border-green-500/70 text-green-300',
  error: 'border-red-500 text-red-300',
};

function GroupSummaryComponent({ data }: NodeProps) {
  const d = data as GroupSummaryData;
  const color = summaryColors[d.status] || summaryColors.pending;
  return (
    <>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-zinc-600 !bg-zinc-500" />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          d.onToggleGroup?.(d.groupId);
        }}
        title={`Expand sub-DAG (${d.memberCount} nodes)`}
        className={`min-w-[180px] max-w-[300px] cursor-pointer overflow-hidden rounded-lg border-2 border-dashed bg-zinc-800/90 px-3 py-2 text-left shadow-lg transition-all hover:brightness-110 ${color}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="h-3.5 w-3.5 flex-shrink-0" />
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1 min-w-0 truncate text-xs font-semibold">{d.title}</span>
          <span className="flex-shrink-0 font-mono text-[10px] text-zinc-400">
            {d.doneCount}/{d.memberCount}
          </span>
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-zinc-700">
          <div
            className={`h-full rounded-full transition-all ${
              d.status === 'error' ? 'bg-red-500' : d.status === 'done' ? 'bg-green-500' : 'bg-blue-500'
            }`}
            style={{ width: `${d.memberCount > 0 ? Math.round((d.doneCount / d.memberCount) * 100) : 0}%` }}
          />
        </div>
      </button>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-zinc-600 !bg-zinc-500" />
    </>
  );
}

function GroupContainerComponent({ data, width, height }: NodeProps) {
  const d = data as GroupContainerData;
  return (
    <div
      className="pointer-events-none rounded-xl border border-dashed border-zinc-600/60 bg-zinc-700/[0.07]"
      style={{ width: width ?? 200, height: height ?? 120 }}
    >
      <div className="pointer-events-auto flex items-center gap-1.5 px-2.5 py-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            d.onToggleGroup?.(d.groupId);
          }}
          title="Collapse sub-DAG"
          className="flex items-center gap-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300 transition-colors hover:bg-zinc-700"
        >
          <ChevronDown className="h-3 w-3" />
          <Layers className="h-3 w-3" />
          <span className="max-w-[160px] truncate">{d.title}</span>
          <span className="font-mono text-zinc-500">{d.memberCount}</span>
        </button>
      </div>
    </div>
  );
}

export const GroupSummaryNode = memo(GroupSummaryComponent);
export const GroupContainerNode = memo(GroupContainerComponent);
