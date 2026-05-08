'use client';

import { useMemo } from 'react';
import { Loader2, XCircle, Map as MapIcon, CheckCircle2 } from 'lucide-react';
import { useOrchestrationStore, type WorkerEvent } from '@/stores/orchestration';
import {
  formatPlanningCost,
  formatTokenInOut,
  buildTokenTooltip,
  type PlanningTokenUsage as TokenUsage,
} from '@/lib/planning-format';

type PlannerState =
  | { status: 'running'; model: string; promptChars: number; startedAt: string }
  | {
      status: 'done';
      model: string;
      promptChars: number;
      nodeCount: number;
      endedAt: string;
      tokenUsage?: TokenUsage;
    }
  | {
      status: 'failed';
      model: string;
      promptChars: number;
      error?: string;
      endedAt: string;
    };

/**
 * Task #200: derive a top-level planner state from `planner_*`
 * events on the active workflow. Renders a small "Planning…"
 * indicator while `Planner.plan` is in flight.
 *
 * Task #204: keep the indicator visible on completion to surface
 * planner LLM token usage ("X in / Y out") and cost when known —
 * mirrors the per-agent cost pill so users can see what a single
 * planning pass actually cost without trawling logs.
 */
export function PlanningIndicator() {
  const events = useOrchestrationStore((s) => s.events);

  const state = useMemo<PlannerState | null>(() => {
    let latest: PlannerState | null = null;
    for (const e of events as WorkerEvent[]) {
      if (
        e.type !== 'planner_started' &&
        e.type !== 'planner_complete' &&
        e.type !== 'planner_failed'
      ) {
        continue;
      }
      const p = e.planner;
      if (!p) continue;
      if (e.type === 'planner_started') {
        latest = {
          status: 'running',
          model: p.model,
          promptChars: p.promptChars,
          startedAt: e.timestamp,
        };
      } else if (e.type === 'planner_complete') {
        latest = {
          status: 'done',
          model: p.model,
          promptChars: p.promptChars,
          nodeCount: p.nodeCount ?? 0,
          endedAt: e.timestamp,
          tokenUsage: p.tokenUsage,
        };
      } else {
        latest = {
          status: 'failed',
          model: p.model,
          promptChars: p.promptChars,
          error: p.error ?? e.error,
          endedAt: e.timestamp,
        };
      }
    }
    return latest;
  }, [events]);

  if (!state) return null;

  const tone =
    state.status === 'failed'
      ? 'bg-red-950/10'
      : state.status === 'done'
        ? 'bg-emerald-950/10'
        : 'bg-indigo-950/10';

  const labelText =
    state.status === 'running'
      ? 'Planning…'
      : state.status === 'done'
        ? 'Plan ready'
        : 'Planning failed';

  const labelTone =
    state.status === 'failed'
      ? 'text-red-300'
      : state.status === 'done'
        ? 'text-emerald-300'
        : 'text-indigo-300';

  return (
    <div className={`border-b border-zinc-800 ${tone}`}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        {state.status === 'running' ? (
          <Loader2 size={12} className="animate-spin text-indigo-400" aria-hidden />
        ) : state.status === 'done' ? (
          <CheckCircle2 size={12} className="text-emerald-400" aria-hidden />
        ) : (
          <XCircle size={12} className="text-red-400" aria-hidden />
        )}
        <span
          className={`text-[10px] font-semibold uppercase tracking-widest ${labelTone}`}
        >
          {labelText}
        </span>
        <span className="text-[10px] text-zinc-500 truncate flex items-center gap-1.5">
          <MapIcon size={10} aria-hidden className="text-zinc-600" />
          <span className="font-mono">{state.model}</span>
          <span className="text-zinc-600">·</span>
          <span>{state.promptChars.toLocaleString()} chars</span>
          {state.status === 'done' && (
            <>
              <span className="text-zinc-600">·</span>
              <span>{state.nodeCount.toLocaleString()} node{state.nodeCount === 1 ? '' : 's'}</span>
              {state.tokenUsage && (
                <>
                  <span className="text-zinc-600">·</span>
                  <span
                    className="font-mono text-zinc-400"
                    title={buildTokenTooltip(state.tokenUsage)}
                  >
                    {formatTokenInOut(state.tokenUsage)}
                  </span>
                  {state.tokenUsage.costUsd != null && (
                    <>
                      <span className="text-zinc-600">·</span>
                      <span className="font-mono text-emerald-300/80">
                        {formatPlanningCost(state.tokenUsage.costUsd)}
                      </span>
                    </>
                  )}
                </>
              )}
            </>
          )}
          {state.status === 'failed' && state.error && (
            <>
              <span className="text-zinc-600">·</span>
              <span className="text-red-400/80 truncate" title={state.error}>
                {state.error}
              </span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

