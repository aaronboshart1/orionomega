'use client';

import { X, Clock, CheckCircle2, XCircle, Loader2, Circle, Code2 } from 'lucide-react';
import type { CodingStep } from '@/stores/coding-mode';
import { formatElapsedMs } from '@/utils/format';

// ── Diff view ──────────────────────────────────────────────────────────────────

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <div className="overflow-auto rounded-lg border border-zinc-700 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-700 px-3 py-2">
        <Code2 size={12} className="text-zinc-500" />
        <span className="text-xs font-medium text-zinc-400">Diff</span>
        <span className="ml-auto text-xs text-zinc-600">
          +{lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length} &nbsp;
          -{lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length}
        </span>
      </div>
      <pre className="max-h-80 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
        {lines.map((line, i) => {
          let cls = 'text-zinc-400';
          if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-green-300 bg-green-950/40';
          if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-300 bg-red-950/40';
          if (line.startsWith('@@')) cls = 'text-blue-400/80';
          if (
            line.startsWith('diff ') ||
            line.startsWith('index ') ||
            line.startsWith('--- ') ||
            line.startsWith('+++ ')
          )
            cls = 'text-zinc-500';
          return (
            <span key={i} className={`block whitespace-pre ${cls}`}>
              {line || ' '}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CodingStep['status'] }) {
  switch (status) {
    case 'completed':
      return (
        <span className="flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-400">
          <CheckCircle2 size={10} /> Completed
        </span>
      );
    case 'failed':
      return (
        <span className="flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-400">
          <XCircle size={10} /> Failed
        </span>
      );
    case 'running':
      return (
        <span className="flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-400">
          <Loader2 size={10} className="animate-spin" /> Running
        </span>
      );
    default:
      return (
        <span className="flex items-center gap-1 rounded-full bg-zinc-700/50 px-2 py-0.5 text-xs font-medium text-zinc-500">
          <Circle size={10} /> Pending
        </span>
      );
  }
}

// ── StepDetail ─────────────────────────────────────────────────────────────────

interface StepDetailProps {
  step: CodingStep;
  onClose: () => void;
}

export function StepDetail({ step, onClose }: StepDetailProps) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-zinc-700 bg-zinc-900 p-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-zinc-100 truncate">{step.label}</h3>
            <StatusBadge status={step.status} />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
            <span className="capitalize">{step.type}</span>
            {step.startedAt && (
              <span>{new Date(step.startedAt).toLocaleTimeString()}</span>
            )}
            {step.durationMs !== undefined && step.durationMs > 0 && (
              <span className="flex items-center gap-1">
                <Clock size={10} />
                {formatElapsedMs(step.durationMs)}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
          aria-label="Close step detail"
        >
          <X size={14} />
        </button>
      </div>

      {/* Error */}
      {step.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2">
          <p className="text-xs font-medium text-red-300 mb-1">Error</p>
          <pre className="whitespace-pre-wrap text-xs text-red-400/80 font-mono">{step.error}</pre>
        </div>
      )}

      {/* Output logs */}
      {step.output && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-zinc-400">Output</p>
          <div className="rounded-lg border border-zinc-700 bg-zinc-950">
            <pre className="max-h-64 overflow-y-auto p-3 font-mono text-xs leading-relaxed text-zinc-300 whitespace-pre-wrap">
              {step.output}
            </pre>
          </div>
        </div>
      )}

      {/* Code diff */}
      {step.codeDiff && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-zinc-400">Code Changes</p>
          <DiffView diff={step.codeDiff} />
        </div>
      )}

      {/* Empty state */}
      {!step.error && !step.output && !step.codeDiff && (
        <p className="text-center text-xs text-zinc-600 py-4">No details available yet.</p>
      )}
    </div>
  );
}
