'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  GitCommit,
  GitBranch,
  FileText,
  Clock,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { CodingSession } from '@/stores/coding-mode';
import { formatElapsedMs } from '@/utils/format';

// ── CodingSessionSummary ───────────────────────────────────────────────────────

interface CodingSessionSummaryProps {
  session: CodingSession;
}

export function CodingSessionSummary({ session }: CodingSessionSummaryProps) {
  const [filesExpanded, setFilesExpanded] = useState(false);

  const isComplete = session.status === 'completed';
  const isFailed = session.status === 'failed';

  const completedSteps = session.steps.filter((s) => s.status === 'completed').length;
  const totalSteps = session.steps.length;

  const borderColor = isComplete
    ? 'border-emerald-500/30'
    : isFailed
      ? 'border-red-500/30'
      : 'border-zinc-700';

  return (
    <div className={`rounded-xl border ${borderColor} bg-zinc-800/60 px-4 py-4 space-y-3`}>
      {/* Title row */}
      <div className="flex items-center gap-2">
        {isComplete
          ? <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
          : <XCircle size={16} className="text-red-400 shrink-0" />}
        <span className="text-sm font-semibold text-zinc-100">
          {isComplete ? 'Session Complete' : 'Session Failed'}
        </span>
        {session.totalDurationMs !== undefined && (
          <span className="ml-auto flex items-center gap-1 text-xs text-zinc-500">
            <Clock size={11} />
            {formatElapsedMs(session.totalDurationMs)}
          </span>
        )}
      </div>

      {/* Task description */}
      <p className="text-xs text-zinc-400 leading-relaxed line-clamp-2">{session.taskDescription}</p>

      {/* Stats row */}
      <div className="flex flex-wrap gap-3 text-xs text-zinc-500">
        <span className="flex items-center gap-1">
          <CheckCircle2 size={10} className="text-green-400" />
          {completedSteps}/{totalSteps} steps
        </span>
        {session.reviews.length > 0 && (
          <span>
            {session.reviews.length} review{session.reviews.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Commit & branch */}
      {(session.commitHash || session.branch) && (
        <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/60 px-3 py-2 space-y-1.5">
          {session.branch && (
            <div className="flex items-center gap-2 text-xs">
              <GitBranch size={11} className="text-zinc-500 shrink-0" />
              <span className="text-zinc-400 font-mono">{session.branch}</span>
            </div>
          )}
          {session.commitHash && (
            <div className="flex items-center gap-2 text-xs">
              <GitCommit size={11} className="text-zinc-500 shrink-0" />
              <span className="text-zinc-300 font-mono">{session.commitHash}</span>
            </div>
          )}
        </div>
      )}

      {/* Files changed */}
      {session.filesChanged && session.filesChanged.length > 0 && (
        <div>
          <button
            onClick={() => setFilesExpanded((o) => !o)}
            className="flex w-full items-center gap-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-300 transition-colors"
          >
            <FileText size={11} />
            <span>{session.filesChanged.length} file{session.filesChanged.length !== 1 ? 's' : ''} changed</span>
            <span className="ml-auto">
              {filesExpanded
                ? <ChevronDown size={11} />
                : <ChevronRight size={11} />}
            </span>
          </button>
          {filesExpanded && (
            <div className="mt-1.5 rounded-lg border border-zinc-700/50 bg-zinc-900/60 px-3 py-2 space-y-1 max-h-48 overflow-y-auto">
              {session.filesChanged.map((f) => (
                <div key={f} className="flex items-center gap-2 text-xs">
                  <FileText size={10} className="text-zinc-600 shrink-0" />
                  <span className="font-mono text-zinc-400 break-all">{f}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Iteration count */}
      {session.currentIteration > 1 && (
        <p className="text-xs text-zinc-600">
          Completed in {session.currentIteration} iteration{session.currentIteration !== 1 ? 's' : ''}
        </p>
      )}
    </div>
  );
}
