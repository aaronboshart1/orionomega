'use client';

import { useState } from 'react';
import {
  GitBranch,
  Search,
  ListTodo,
  Code2,
  TestTube2,
  Eye,
  GitCommit,
  Wrench,
  CheckCircle2,
  XCircle,
  Circle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Clock,
} from 'lucide-react';
import type { CodingStep, CodingStepStatus, CodingStepType } from '@/stores/coding-mode';
import { formatElapsedMs } from '@/utils/format';

// ── Step type icons ────────────────────────────────────────────────────────────

const stepTypeIcon: Record<CodingStepType, React.ReactNode> = {
  clone: <GitBranch size={13} className="shrink-0" />,
  analyze: <Search size={13} className="shrink-0" />,
  plan: <ListTodo size={13} className="shrink-0" />,
  implement: <Code2 size={13} className="shrink-0" />,
  test: <TestTube2 size={13} className="shrink-0" />,
  review: <Eye size={13} className="shrink-0" />,
  commit: <GitCommit size={13} className="shrink-0" />,
  custom: <Wrench size={13} className="shrink-0" />,
};

// ── Status styling ─────────────────────────────────────────────────────────────

interface StatusStyle {
  icon: React.ReactNode;
  textColor: string;
  lineColor: string;
  dotBg: string;
}

function getStatusStyle(status: CodingStepStatus): StatusStyle {
  switch (status) {
    case 'completed':
      return {
        icon: <CheckCircle2 size={16} className="text-green-400 shrink-0" />,
        textColor: 'text-zinc-200',
        lineColor: 'bg-green-500/40',
        dotBg: 'bg-green-500',
      };
    case 'failed':
      return {
        icon: <XCircle size={16} className="text-red-400 shrink-0" />,
        textColor: 'text-red-300',
        lineColor: 'bg-red-500/40',
        dotBg: 'bg-red-500',
      };
    case 'running':
      return {
        icon: <Loader2 size={16} className="animate-spin text-blue-400 shrink-0" />,
        textColor: 'text-blue-300',
        lineColor: 'bg-blue-500/40',
        dotBg: 'bg-blue-500',
      };
    default:
      return {
        icon: <Circle size={16} className="text-zinc-600 shrink-0" />,
        textColor: 'text-zinc-500',
        lineColor: 'bg-zinc-700',
        dotBg: 'bg-zinc-700',
      };
  }
}

// ── StepNode (single row in the pipeline) ─────────────────────────────────────

interface StepNodeProps {
  step: CodingStep;
  isLast: boolean;
  onExpand: (stepId: string) => void;
  expanded: boolean;
}

function StepNode({ step, isLast, onExpand, expanded }: StepNodeProps) {
  const style = getStatusStyle(step.status);
  const hasDetails = !!(step.output || step.error || step.codeDiff);
  const typeIcon = stepTypeIcon[step.type] ?? stepTypeIcon.custom;

  return (
    <div className="flex gap-3">
      {/* Left connector column */}
      <div className="flex flex-col items-center" style={{ width: 20 }}>
        <div className="mt-1">{style.icon}</div>
        {!isLast && (
          <div className={`mt-1 w-0.5 flex-1 ${style.lineColor} min-h-[20px]`} />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 pb-3">
        <button
          onClick={() => hasDetails && onExpand(step.id)}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors
            ${hasDetails ? 'cursor-pointer hover:bg-zinc-800/60' : 'cursor-default'}
            ${step.status === 'running' ? 'bg-zinc-800/40' : ''}`}
        >
          {/* Type icon */}
          <span className={`${style.textColor} opacity-70`}>{typeIcon}</span>

          {/* Label */}
          <span className={`flex-1 text-left font-medium ${style.textColor}`}>
            {step.label}
          </span>

          {/* Duration */}
          {step.durationMs !== undefined && step.durationMs > 0 && (
            <span className="flex items-center gap-1 text-zinc-600">
              <Clock size={10} />
              {formatElapsedMs(step.durationMs)}
            </span>
          )}
          {step.status === 'running' && (
            <span className="text-blue-500 text-xs">running…</span>
          )}

          {/* Expand chevron */}
          {hasDetails && (
            <span className="text-zinc-600">
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </button>

        {/* Expanded details inline */}
        {expanded && hasDetails && (
          <div className="mt-1 ml-2 rounded-lg border border-zinc-700/50 bg-zinc-900/80 p-3 text-xs">
            {step.error && (
              <p className="mb-2 text-red-400">{step.error}</p>
            )}
            {step.output && !step.codeDiff && (
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap text-zinc-400 font-mono leading-relaxed">
                {step.output}
              </pre>
            )}
            {step.codeDiff && (
              <DiffView diff={step.codeDiff} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Simple diff view ───────────────────────────────────────────────────────────

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="max-h-48 overflow-y-auto font-mono text-xs leading-relaxed">
      {diff.split('\n').map((line, i) => {
        let cls = 'text-zinc-400';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-green-400 bg-green-950/30';
        if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400 bg-red-950/30';
        if (line.startsWith('@@')) cls = 'text-blue-400/70';
        if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ '))
          cls = 'text-zinc-500';
        return (
          <span key={i} className={`block ${cls}`}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}

// ── WorkflowProgress ──────────────────────────────────────────────────────────

interface WorkflowProgressProps {
  steps: CodingStep[];
}

export function WorkflowProgress({ steps }: WorkflowProgressProps) {
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);

  const handleExpand = (stepId: string) => {
    setExpandedStepId((prev) => (prev === stepId ? null : stepId));
  };

  if (steps.length === 0) {
    return (
      <div className="flex flex-col gap-2 px-1">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3">
            <div className="mt-1 h-4 w-4 animate-pulse rounded-full bg-zinc-700" />
            <div className={`mt-1.5 h-3 animate-pulse rounded bg-zinc-700`} style={{ width: `${40 + i * 15}%` }} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col px-1">
      {steps.map((step, idx) => (
        <StepNode
          key={step.id}
          step={step}
          isLast={idx === steps.length - 1}
          onExpand={handleExpand}
          expanded={expandedStepId === step.id}
        />
      ))}
    </div>
  );
}
