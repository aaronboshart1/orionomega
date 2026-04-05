'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Hammer,
  TestTube2,
  BarChart3,
  MessageSquare,
  RotateCcw,
} from 'lucide-react';
import type { ArchitectReview } from '@/stores/coding-mode';

// ── Build status badge ─────────────────────────────────────────────────────────

function BuildBadge({ status }: { status: ArchitectReview['buildStatus'] }) {
  if (status === 'pass')
    return (
      <span className="flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-400">
        <CheckCircle2 size={10} /> Build pass
      </span>
    );
  if (status === 'fail')
    return (
      <span className="flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-400">
        <XCircle size={10} /> Build fail
      </span>
    );
  return (
    <span className="flex items-center gap-1 rounded-full bg-zinc-700/50 px-2 py-0.5 text-xs font-medium text-zinc-500">
      <Clock size={10} /> Pending
    </span>
  );
}

// ── Decision badge ─────────────────────────────────────────────────────────────

function DecisionBadge({ decision }: { decision: ArchitectReview['decision'] }) {
  if (decision === 'approved')
    return (
      <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-400">
        <CheckCircle2 size={11} /> Approved
      </span>
    );
  if (decision === 'retask')
    return (
      <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-400">
        <RotateCcw size={11} /> Retasked
      </span>
    );
  return (
    <span className="flex items-center gap-1 rounded-full bg-zinc-700/50 px-2.5 py-1 text-xs font-semibold text-zinc-500">
      <Clock size={11} /> Reviewing…
    </span>
  );
}

// ── Quality score bar ──────────────────────────────────────────────────────────

function QualityBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score));
  const color = pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-zinc-700 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-medium text-zinc-300 w-8 text-right">{pct}</span>
    </div>
  );
}

// ── Single review card ─────────────────────────────────────────────────────────

function ReviewCard({ review, defaultOpen }: { review: ArchitectReview; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  const borderColor =
    review.decision === 'approved'
      ? 'border-emerald-500/30'
      : review.decision === 'retask'
        ? 'border-amber-500/30'
        : 'border-zinc-700';

  return (
    <div className={`rounded-xl border ${borderColor} bg-zinc-800/60`}>
      {/* Header row */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="text-xs font-semibold text-zinc-300">
          Review #{review.iteration}
        </span>
        {review.reviewedAt && (
          <span className="text-xs text-zinc-600">
            {new Date(review.reviewedAt).toLocaleTimeString()}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <DecisionBadge decision={review.decision} />
          {open ? <ChevronDown size={13} className="text-zinc-500" /> : <ChevronRight size={13} className="text-zinc-500" />}
        </div>
      </button>

      {/* Expanded body */}
      {open && (
        <div className="border-t border-zinc-700/50 px-4 pb-4 pt-3 space-y-3">
          {/* Build + test row */}
          <div className="flex flex-wrap gap-2">
            <BuildBadge status={review.buildStatus} />
            {review.testResults && (
              <span
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium
                  ${review.testResults.failed === 0
                    ? 'bg-green-500/15 text-green-400'
                    : 'bg-red-500/15 text-red-400'}`}
              >
                <TestTube2 size={10} />
                {review.testResults.passed}/{review.testResults.total} tests passed
              </span>
            )}
          </div>

          {/* Test details */}
          {review.testResults?.details && (
            <div className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2">
              <pre className="max-h-32 overflow-y-auto text-xs text-zinc-400 font-mono whitespace-pre-wrap leading-relaxed">
                {review.testResults.details}
              </pre>
            </div>
          )}

          {/* Quality score */}
          {review.qualityScore !== undefined && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-400">
                <BarChart3 size={11} />
                <span>Code Quality</span>
              </div>
              <QualityBar score={review.qualityScore} />
            </div>
          )}

          {/* Feedback */}
          {review.feedback && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-400">
                <MessageSquare size={11} />
                <span>Feedback</span>
              </div>
              <p className="text-xs text-zinc-300 leading-relaxed">{review.feedback}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── ArchitectReviewPanel ──────────────────────────────────────────────────────

interface ArchitectReviewPanelProps {
  reviews: ArchitectReview[];
}

export function ArchitectReviewPanel({ reviews }: ArchitectReviewPanelProps) {
  if (reviews.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-700 bg-zinc-800/40 px-4 py-5 text-center">
        <Hammer size={18} className="mx-auto mb-2 text-zinc-600" />
        <p className="text-xs text-zinc-500">Awaiting architect review…</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400 px-1">
        <Hammer size={12} />
        <span>Architect Reviews</span>
        <span className="ml-auto rounded-full bg-zinc-700 px-1.5 py-0.5 text-zinc-400">
          {reviews.length}
        </span>
      </div>
      {reviews.map((review, idx) => (
        <ReviewCard
          key={review.iteration}
          review={review}
          defaultOpen={idx === reviews.length - 1}
        />
      ))}
    </div>
  );
}
