'use client';

import { useCallback, useMemo } from 'react';
import { Layers, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useOrchestrationStore, type WorkerEvent } from '@/stores/orchestration';
import {
  formatPlanningCost,
  formatTokenInOut,
  buildTokenTooltip,
  type PlanningTokenUsage,
} from '@/lib/planning-format';

type Phase = {
  key: string;
  macroNodeId: string;
  specRef: string;
  phaseId: string;
  phaseTitle: string;
  index: number;
  total: number;
  status: 'running' | 'done' | 'failed';
  subNodeCount?: number;
  /** Task #201: ids of spliced sub-nodes; populated on completion. */
  subNodeIds?: string[];
  /** Task #204: per-pass sub-planner token usage; populated on completion. */
  tokenUsage?: PlanningTokenUsage;
  error?: string;
  startedAt?: string;
  endedAt?: string;
};

/**
 * Task #199: derive a Sub-planning section from `macro_expansion_*`
 * events on the active workflow. Renders nothing when no macro events
 * have been seen — the common path stays visually identical.
 */
export function MacroExpansionPanel() {
  const events = useOrchestrationStore((s) => s.events);
  const graphState = useOrchestrationStore((s) => s.graphState);
  const activeWorkflowId = useOrchestrationStore((s) => s.activeWorkflowId);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const selectedWorker = useOrchestrationStore((s) => s.selectedWorker);
  const selectWorker = useOrchestrationStore((s) => s.selectWorker);

  /**
   * Task #201: resolve a phase row to a node id that exists in the live
   * DAG. Prefers the macro node itself (still present while the phase is
   * running) and falls back to the first spliced sub-node once the macro
   * has been removed from the graph by `expandMacroNodesInLayer`.
   */
  const resolveTargetNodeId = useCallback(
    (p: Phase): string | null => {
      const liveNodeIds = new Set<string>();
      if (graphState) {
        for (const id of Object.keys(graphState.nodes)) liveNodeIds.add(id);
      }
      const dag = activeWorkflowId ? inlineDAGs[activeWorkflowId] : null;
      if (dag) {
        for (const n of dag.nodes) liveNodeIds.add(n.id);
      }
      if (liveNodeIds.has(p.macroNodeId)) return p.macroNodeId;
      if (p.subNodeIds && p.subNodeIds.length > 0) {
        const firstLive = p.subNodeIds.find((id) => liveNodeIds.has(id));
        if (firstLive) return firstLive;
        // Graph state may not have arrived yet — still useful to select
        // the id so it highlights once the next snapshot lands.
        return p.subNodeIds[0];
      }
      // No expansion data yet — best-effort select the macro id so it
      // matches if/when it appears.
      return p.macroNodeId;
    },
    [graphState, activeWorkflowId, inlineDAGs],
  );

  const phases = useMemo<Phase[]>(() => {
    const map = new Map<string, Phase>();
    for (const e of events as WorkerEvent[]) {
      if (
        e.type !== 'macro_expansion_started' &&
        e.type !== 'macro_expansion_complete' &&
        e.type !== 'macro_expansion_failed'
      ) {
        continue;
      }
      const m = e.macro;
      if (!m) continue;
      const key = `${m.specRef}::${m.phaseId}::${m.macroNodeId}`;
      const prior = map.get(key);
      const base: Phase = prior ?? {
        key,
        macroNodeId: m.macroNodeId,
        specRef: m.specRef,
        phaseId: m.phaseId,
        phaseTitle: m.phaseTitle,
        index: m.index,
        total: m.total,
        status: 'running',
      };
      if (e.type === 'macro_expansion_started') {
        map.set(key, { ...base, status: 'running', startedAt: e.timestamp });
      } else if (e.type === 'macro_expansion_complete') {
        map.set(key, {
          ...base,
          status: 'done',
          subNodeCount: m.subNodeCount,
          subNodeIds: m.subNodeIds,
          tokenUsage: m.tokenUsage,
          endedAt: e.timestamp,
        });
      } else {
        map.set(key, {
          ...base,
          status: 'failed',
          error: m.error ?? e.error ?? e.message,
          endedAt: e.timestamp,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.index - b.index);
  }, [events]);

  if (phases.length === 0) return null;

  const running = phases.filter((p) => p.status === 'running').length;
  const done = phases.filter((p) => p.status === 'done').length;
  const failed = phases.filter((p) => p.status === 'failed').length;
  const total = phases[0]?.total ?? phases.length;
  const allDone = running === 0 && failed === 0 && done >= total;

  return (
    <div className="border-b border-zinc-800 bg-fuchsia-950/10">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Layers size={12} className="text-fuchsia-400" aria-hidden />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-fuchsia-300">
          Sub-planning
        </span>
        <span className="text-[10px] text-zinc-500">
          {done}/{total} done
          {running > 0 && <span className="ml-1 text-fuchsia-300">· {running} in flight</span>}
          {failed > 0 && <span className="ml-1 text-red-400">· {failed} failed</span>}
        </span>
        {!allDone && running > 0 && (
          <Loader2 size={11} className="ml-1 animate-spin text-fuchsia-400" aria-hidden />
        )}
      </div>
      <ul className="max-h-32 overflow-y-auto px-3 pb-1.5 text-xs">
        {phases.map((p) => {
          const targetId = resolveTargetNodeId(p);
          const isSelected =
            !!targetId &&
            (selectedWorker === targetId ||
              selectedWorker === p.macroNodeId ||
              (p.subNodeIds?.includes(selectedWorker ?? '') ?? false));
          return (
          <li
            key={p.key}
            role="button"
            tabIndex={0}
            onClick={() => {
              if (targetId) selectWorker(targetId);
            }}
            onKeyDown={(ev) => {
              if (!targetId) return;
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                selectWorker(targetId);
              }
            }}
            className={`flex items-start gap-1.5 py-0.5 -mx-1 px-1 rounded cursor-pointer hover:bg-fuchsia-900/20 focus:outline-none focus-visible:ring-1 focus-visible:ring-fuchsia-400 ${
              isSelected ? 'bg-fuchsia-900/30 ring-1 ring-fuchsia-500/60' : ''
            }`}
            title={`${p.specRef}::${p.phaseId}${targetId ? ` — click to focus ${targetId}` : ''}`}
            aria-label={`Focus DAG node for phase ${p.phaseTitle}`}
          >
            <span className="shrink-0 mt-0.5">
              {p.status === 'running' && (
                <Loader2 size={10} className="animate-spin text-fuchsia-400" aria-hidden />
              )}
              {p.status === 'done' && (
                <CheckCircle2 size={10} className="text-emerald-400" aria-hidden />
              )}
              {p.status === 'failed' && (
                <XCircle size={10} className="text-red-400" aria-hidden />
              )}
            </span>
            <span className="shrink-0 text-zinc-600 font-mono text-[10px]">
              {p.index}/{p.total}
            </span>
            <span className="min-w-0 flex-1 truncate text-zinc-300">{p.phaseTitle}</span>
            {p.status === 'done' && p.subNodeCount !== undefined && (
              <span className="shrink-0 text-emerald-400/80 text-[10px]">
                +{p.subNodeCount}
              </span>
            )}
            {p.status === 'done' && p.tokenUsage && (
              <span
                className="shrink-0 text-zinc-500 font-mono text-[10px]"
                title={buildTokenTooltip(p.tokenUsage)}
              >
                {formatTokenInOut(p.tokenUsage)}
                {p.tokenUsage.costUsd != null && (
                  <span className="ml-1 text-emerald-300/80">
                    {formatPlanningCost(p.tokenUsage.costUsd)}
                  </span>
                )}
              </span>
            )}
            {p.status === 'failed' && p.error && (
              <span
                className="shrink-0 max-w-[200px] truncate text-red-400/80 text-[10px]"
                title={p.error}
              >
                {p.error}
              </span>
            )}
          </li>
          );
        })}
      </ul>
    </div>
  );
}
