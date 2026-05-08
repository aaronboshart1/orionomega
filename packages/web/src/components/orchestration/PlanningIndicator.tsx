'use client';

import { useMemo } from 'react';
import { Loader2, XCircle, Map as MapIcon } from 'lucide-react';
import { useOrchestrationStore, type WorkerEvent } from '@/stores/orchestration';

type PlannerState =
  | { status: 'running'; model: string; promptChars: number; startedAt: string }
  | { status: 'done'; model: string; promptChars: number; nodeCount: number; endedAt: string }
  | { status: 'failed'; model: string; promptChars: number; error?: string; endedAt: string };

/**
 * Task #200: derive a top-level planner state from `planner_*`
 * events on the active workflow. Renders a small "Planning…"
 * indicator while `Planner.plan` is in flight, then disappears once
 * the macro plan arrives (planner_complete). Failures stay visible
 * inline so the user can see what went wrong — consistent with how
 * MacroExpansionPanel keeps failed phases on screen.
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
  // Per task spec: indicator disappears once the macro plan arrives.
  // Failures remain visible so the user can read the inline error.
  if (state.status === 'done') return null;

  return (
    <div
      className={`border-b border-zinc-800 ${
        state.status === 'failed' ? 'bg-red-950/10' : 'bg-indigo-950/10'
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        {state.status === 'running' ? (
          <Loader2 size={12} className="animate-spin text-indigo-400" aria-hidden />
        ) : (
          <XCircle size={12} className="text-red-400" aria-hidden />
        )}
        <span
          className={`text-[10px] font-semibold uppercase tracking-widest ${
            state.status === 'failed' ? 'text-red-300' : 'text-indigo-300'
          }`}
        >
          {state.status === 'running' ? 'Planning…' : 'Planning failed'}
        </span>
        <span className="text-[10px] text-zinc-500 truncate flex items-center gap-1.5">
          <MapIcon size={10} aria-hidden className="text-zinc-600" />
          <span className="font-mono">{state.model}</span>
          <span className="text-zinc-600">·</span>
          <span>{state.promptChars.toLocaleString()} chars</span>
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
