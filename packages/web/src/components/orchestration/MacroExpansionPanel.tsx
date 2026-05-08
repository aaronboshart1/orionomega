'use client';

import { useMemo } from 'react';
import { Layers, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useOrchestrationStore, type WorkerEvent } from '@/stores/orchestration';

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
        {phases.map((p) => (
          <li
            key={p.key}
            className="flex items-start gap-1.5 py-0.5"
            title={`${p.specRef}::${p.phaseId}`}
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
            {p.status === 'failed' && p.error && (
              <span
                className="shrink-0 max-w-[200px] truncate text-red-400/80 text-[10px]"
                title={p.error}
              >
                {p.error}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
