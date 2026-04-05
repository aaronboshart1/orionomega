'use client';

import { useState, useCallback } from 'react';
import {
  Code2,
  GitBranch,
  Link,
  PlayCircle,
  RotateCcw,
  Loader2,
  CheckCircle2,
  XCircle,
  Circle,
} from 'lucide-react';
import { useCodingModeStore, type CodingStep, type CodingStepStatus } from '@/stores/coding-mode';
import { useGateway } from '@/lib/gateway';
import { WorkflowProgress } from './WorkflowProgress';
import { ArchitectReviewPanel } from './ArchitectReviewPanel';
import { CodingSessionSummary } from './CodingSessionSummary';
import { StepDetail } from './StepDetail';

// ── Duration helper ────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Step status style ──────────────────────────────────────────────────────────

function getStepStyle(status: CodingStepStatus) {
  switch (status) {
    case 'completed':
      return {
        icon: <CheckCircle2 size={16} className="text-green-400 shrink-0" />,
        textColor: 'text-zinc-200',
        lineColor: 'bg-green-500/40',
      };
    case 'failed':
      return {
        icon: <XCircle size={16} className="text-red-400 shrink-0" />,
        textColor: 'text-red-300',
        lineColor: 'bg-red-500/40',
      };
    case 'running':
      return {
        icon: <Loader2 size={16} className="animate-spin text-blue-400 shrink-0" />,
        textColor: 'text-blue-300',
        lineColor: 'bg-blue-500/40',
      };
    default:
      return {
        icon: <Circle size={16} className="text-zinc-600 shrink-0" />,
        textColor: 'text-zinc-500',
        lineColor: 'bg-zinc-700',
      };
  }
}

// ── WorkflowProgress with click-to-select ─────────────────────────────────────

interface WorkflowProgressWithDetailProps {
  steps: CodingStep[];
  onSelectStep: (step: CodingStep) => void;
  selectedStepId: string | null;
}

function WorkflowProgressWithDetail({
  steps,
  onSelectStep,
  selectedStepId,
}: WorkflowProgressWithDetailProps) {
  const hasDetail = (step: CodingStep) =>
    !!(step.output || step.error || step.codeDiff);

  if (steps.length === 0) {
    return (
      <div className="flex flex-col gap-2 px-1">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3">
            <div className="mt-1 h-4 w-4 animate-pulse rounded-full bg-zinc-700" />
            <div
              className="mt-1.5 h-3 animate-pulse rounded bg-zinc-700"
              style={{ width: `${40 + i * 15}%` }}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {steps.map((step, idx) => {
        const style = getStepStyle(step.status);
        const clickable = hasDetail(step);
        const isSelected = step.id === selectedStepId;

        return (
          <div key={step.id} className="flex gap-3">
            {/* Connector column */}
            <div className="flex flex-col items-center" style={{ width: 20 }}>
              <div className="mt-1">{style.icon}</div>
              {idx < steps.length - 1 && (
                <div className={`mt-1 w-0.5 flex-1 ${style.lineColor} min-h-[20px]`} />
              )}
            </div>
            {/* Row */}
            <div className="flex-1 pb-3">
              <button
                onClick={() => clickable && onSelectStep(step)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors
                  ${clickable ? 'cursor-pointer hover:bg-zinc-700/50' : 'cursor-default'}
                  ${isSelected ? 'bg-zinc-700/60 ring-1 ring-emerald-500/30' : ''}
                  ${step.status === 'running' ? 'bg-zinc-800/40' : ''}`}
              >
                <span className={`flex-1 text-left font-medium ${style.textColor}`}>
                  {step.label}
                </span>
                {step.durationMs !== undefined && step.durationMs > 0 && (
                  <span className="text-zinc-600">{fmtMs(step.durationMs)}</span>
                )}
                {step.status === 'running' && (
                  <span className="text-blue-500">running…</span>
                )}
                {clickable && !isSelected && (
                  <span className="text-zinc-600">details →</span>
                )}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Start form ─────────────────────────────────────────────────────────────────

interface StartFormProps {
  onStart: (repoUrl: string, branch: string, taskDescription: string) => void;
  loading: boolean;
}

function StartForm({ onStart, loading }: StartFormProps) {
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [taskDescription, setTaskDescription] = useState('');

  const canSubmit =
    repoUrl.trim().length > 0 && taskDescription.trim().length > 0 && !loading;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onStart(repoUrl.trim(), branch.trim() || 'main', taskDescription.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* Repo URL */}
      <div>
        <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-400">
          <Link size={11} />
          Repository URL
        </label>
        <input
          type="text"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/owner/repo"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200
            placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none focus:ring-1
            focus:ring-emerald-500/30 transition-colors"
          required
        />
      </div>

      {/* Branch */}
      <div>
        <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-400">
          <GitBranch size={11} />
          Branch
        </label>
        <input
          type="text"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="main"
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200
            placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none focus:ring-1
            focus:ring-emerald-500/30 transition-colors"
        />
      </div>

      {/* Task description */}
      <div>
        <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-400">
          <Code2 size={11} />
          Task Description
        </label>
        <textarea
          value={taskDescription}
          onChange={(e) => setTaskDescription(e.target.value)}
          placeholder="Describe what you want to implement or fix…"
          rows={4}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200
            placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none focus:ring-1
            focus:ring-emerald-500/30 transition-colors resize-none leading-relaxed"
          required
        />
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={!canSubmit}
        className="flex items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm
          font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-40
          disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-emerald-500
          focus:ring-offset-1 focus:ring-offset-zinc-900"
      >
        {loading ? (
          <>
            <Loader2 size={15} className="animate-spin" />
            Starting…
          </>
        ) : (
          <>
            <PlayCircle size={15} />
            Start Coding Session
          </>
        )}
      </button>
    </form>
  );
}

// ── Active session view ────────────────────────────────────────────────────────

function ActiveSession() {
  const session = useCodingModeStore((s) => s.session)!;
  const clearSession = useCodingModeStore((s) => s.clearSession);
  const [selectedStep, setSelectedStep] = useState<CodingStep | null>(null);

  const isFinished =
    session.status === 'completed' || session.status === 'failed';

  // Always read the latest step data from the store
  const stepForDetail = selectedStep
    ? session.steps.find((s) => s.id === selectedStep.id) ?? selectedStep
    : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Session header */}
      <div className="rounded-xl border border-zinc-700 bg-zinc-800/60 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-zinc-200 truncate">
              {session.taskDescription}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
              <span className="flex items-center gap-1 font-mono truncate max-w-[180px]">
                <Link size={10} />
                {session.repoUrl.replace(/^https?:\/\//, '')}
              </span>
              <span className="flex items-center gap-1">
                <GitBranch size={10} />
                {session.branch}
              </span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-xs font-medium capitalize
                  ${session.status === 'running'
                    ? 'bg-blue-500/15 text-blue-400'
                    : session.status === 'reviewing'
                      ? 'bg-amber-500/15 text-amber-400'
                      : session.status === 'completed'
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : session.status === 'failed'
                          ? 'bg-red-500/15 text-red-400'
                          : 'bg-zinc-700/50 text-zinc-500'}`}
              >
                {session.status}
              </span>
            </div>
          </div>
          {isFinished && (
            <button
              onClick={clearSession}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5
                text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
              title="Start a new session"
            >
              <RotateCcw size={12} />
              New
            </button>
          )}
        </div>
      </div>

      {/* Summary (only when finished) */}
      {isFinished && <CodingSessionSummary session={session} />}

      {/* Workflow steps */}
      <div>
        <p className="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold text-zinc-400">
          <Code2 size={12} />
          Workflow Steps
        </p>
        <div className="rounded-xl border border-zinc-700 bg-zinc-800/40 px-3 py-3">
          <WorkflowProgressWithDetail
            steps={session.steps}
            onSelectStep={setSelectedStep}
            selectedStepId={selectedStep?.id ?? null}
          />
        </div>
      </div>

      {/* Step detail */}
      {stepForDetail && (
        <StepDetail
          step={stepForDetail}
          onClose={() => setSelectedStep(null)}
        />
      )}

      {/* Architect reviews */}
      {session.reviews.length > 0 && (
        <ArchitectReviewPanel reviews={session.reviews} />
      )}
    </div>
  );
}

// ── CodingModeSelector (root export) ──────────────────────────────────────────

export function CodingModeSelector() {
  const session = useCodingModeStore((s) => s.session);
  const pendingStart = useCodingModeStore((s) => s.pendingStart);
  const setPendingStart = useCodingModeStore((s) => s.setPendingStart);
  const { send } = useGateway();

  const isLoading = pendingStart !== null && session === null;

  const handleStart = useCallback(
    (repoUrl: string, branch: string, taskDescription: string) => {
      setPendingStart({ repoUrl, branch, taskDescription });
      send({
        type: 'coding_start',
        repoUrl,
        branch,
        taskDescription,
      });
    },
    [send, setPendingStart],
  );

  return (
    <div className="flex flex-col gap-4 px-3 md:px-6 py-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Code2 size={16} className="text-emerald-400" />
        <h2 className="text-sm font-semibold text-zinc-100">Coding Mode</h2>
        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400">
          automated
        </span>
      </div>

      {session ? (
        <ActiveSession />
      ) : (
        <>
          <p className="text-xs text-zinc-500 leading-relaxed">
            Point at a repo, describe the task, and the coding agent will implement it
            with automated tests and architect review.
          </p>
          <StartForm onStart={handleStart} loading={isLoading} />
        </>
      )}
    </div>
  );
}

// Re-export WorkflowProgress for use elsewhere
export { WorkflowProgress };
