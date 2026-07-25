'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { useOrchestrationStore, useFilteredMemoryEvents, type MemoryEvent, type MemoryFilterState, type RecallMeta, type RetainMeta, type QualityMeta, type DedupMeta, type ToolMeta, type FlushMeta } from '@/stores/orchestration';
import { CopyButton } from '@/components/shared/CopyButton';
import { formatTime } from '@/utils/format';
import {
  Brain,
  Download,
  Search,
  Filter,
  Shield,
  Zap,
  FileText,
  Wrench,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';

/**
 * One entry per op the memory system actually emits.
 *
 * `session_anchor` and `self_knowledge` used to appear here. Both survive as
 * record *contexts* in the retention engine's TTL and importance tables, but
 * nothing has ever emitted them as event *ops* — they were filters that could
 * only ever match zero events.
 */
const OP_CONFIG: Record<MemoryEvent['op'], { icon: typeof Brain; label: string; color: string; bgColor: string }> = {
  bootstrap: { icon: Zap, label: 'Bootstrap', color: 'text-violet-400', bgColor: 'bg-violet-500/10' },
  recall: { icon: Search, label: 'Recall', color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  retain: { icon: Download, label: 'Retain', color: 'text-green-400', bgColor: 'bg-green-500/10' },
  flush: { icon: Download, label: 'Flush', color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
  dedup: { icon: Filter, label: 'Dedup', color: 'text-orange-400', bgColor: 'bg-orange-500/10' },
  quality: { icon: Shield, label: 'Quality', color: 'text-cyan-400', bgColor: 'bg-cyan-500/10' },
  summary: { icon: FileText, label: 'Summary', color: 'text-emerald-400', bgColor: 'bg-emerald-500/10' },
  // memory_search / memory_read / memory_pin — memory the agent asked for
  // itself, as opposed to what the framework did on its behalf.
  tool: { icon: Wrench, label: 'Tool', color: 'text-purple-400', bgColor: 'bg-purple-500/10' },
};

const ALL_OPS = Object.keys(OP_CONFIG) as MemoryEvent['op'][];

// `RelevanceBar`, `MemoryContentCard` and `formatDate` were removed with the
// meta they rendered. Both cards were reachable only through the recall
// `records` array and the retain `items` array — neither of which the Redis
// memory system emits. Recall now reports a record COUNT, and per-record
// content is not carried on the event at all.

function QualityDot({ score }: { score: number }) {
  const color = score >= 0.7 ? 'bg-green-500' : score >= 0.4 ? 'bg-yellow-500' : 'bg-red-500';
  return <span className={`inline-block w-2 h-2 rounded-full ${color} flex-shrink-0`} title={`Quality: ${score.toFixed(2)}`} />;
}

/**
 * Recall detail.
 *
 * Recall is emitted from three places with different shapes: the context
 * assembler reports a per-turn token budget and what it filled, while planning
 * and architect recalls report record counts and the scopes they queried.
 * Everything here is a field the current system emits — the previous version
 * rendered a remote-service funnel (`N API → M passed filter`) that no longer
 * exists, so the panel was blank in practice.
 */
function ExpandedRecall({ meta }: { meta: RecallMeta }) {
  const skipped = meta.recallTokens === 0;

  return (
    <div className="mt-2 space-y-2 text-xs">
      {skipped && (
        <div className="text-zinc-500">
          Skipped — <span className="text-zinc-400">external action query</span>
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-zinc-500">
        {meta.recallTokens != null && meta.recallTokens > 0 && (
          <span>Budget: <span className="text-zinc-400 font-mono">{meta.recallTokens.toLocaleString()} tok</span></span>
        )}
        {meta.recalledTokens != null && (
          <span>Recalled: <span className="text-zinc-400 font-mono">{meta.recalledTokens.toLocaleString()} tok</span></span>
        )}
        {meta.records != null && (
          <span>Records: <span className="text-zinc-400 font-mono">{meta.records}</span></span>
        )}
        {meta.totalResults != null && (
          <span>Results: <span className="text-zinc-400 font-mono">{meta.totalResults}</span></span>
        )}
        {meta.totalTokensUsed != null && (
          <span>Used: <span className="text-zinc-400 font-mono">{meta.totalTokensUsed.toLocaleString()} tok</span></span>
        )}
        {meta.durationMs != null && (
          <span><span className="text-zinc-400 font-mono">{meta.durationMs}</span> ms</span>
        )}
        {meta.queryKind && <span className="text-zinc-400">{meta.queryKind}</span>}
      </div>
      {/* How much of the turn's budget the recall actually used. */}
      {meta.recallTokens != null && meta.recallTokens > 0 && meta.recalledTokens != null && (
        <BudgetBar used={meta.recalledTokens} total={meta.recallTokens} />
      )}
      {meta.scopesQueried && meta.scopesQueried.length > 0 && (
        <div className="flex flex-wrap gap-1">
          <span className="text-zinc-600">Scopes:</span>
          {meta.scopesQueried.map(sc => (
            <span key={sc} className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono text-[10px]">
              {sc}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Fill bar for recalled-vs-budget tokens. */
function BudgetBar({ used, total }: { used: number; total: number }) {
  const pct = Math.max(0, Math.min(100, (used / total) * 100));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-zinc-800 rounded overflow-hidden">
        <div className="h-full bg-blue-500/60 rounded" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-zinc-600 font-mono text-[10px]">{pct.toFixed(0)}%</span>
    </div>
  );
}

/** Memory-tool detail — what the agent asked memory for, and what it got. */
function ExpandedTool({ meta }: { meta: ToolMeta }) {
  const OUTCOME_COLOR: Record<NonNullable<ToolMeta['outcome']>, string> = {
    ok: 'text-emerald-400',
    no_results: 'text-zinc-400',
    refused: 'text-amber-400',
    error: 'text-red-400',
  };

  return (
    <div className="mt-2 space-y-2 text-xs">
      {meta.query && (
        <div className="flex gap-1.5">
          <span className="text-zinc-600 flex-shrink-0">Query:</span>
          <span className="text-zinc-300 break-words">&ldquo;{meta.query}&rdquo;</span>
        </div>
      )}
      {meta.segment && (
        <div className="flex gap-1.5">
          <span className="text-zinc-600 flex-shrink-0">Segment:</span>
          <span className="text-zinc-300 font-mono break-all">{meta.segment}</span>
        </div>
      )}
      {meta.key && (
        <div className="flex gap-1.5">
          <span className="text-zinc-600 flex-shrink-0">Key:</span>
          <span className="text-zinc-300 font-mono break-all">{meta.key}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-zinc-500">
        {meta.tool && <span className="text-zinc-400 font-mono">{meta.tool}</span>}
        {meta.outcome && (
          <span className={OUTCOME_COLOR[meta.outcome]}>
            {meta.outcome === 'refused' ? 'refused — turn budget spent' : meta.outcome.replace('_', ' ')}
          </span>
        )}
        {meta.durationMs != null && (
          <span><span className="text-zinc-400 font-mono">{meta.durationMs}</span> ms</span>
        )}
      </div>
    </div>
  );
}

function ExpandedRetain({ meta }: { meta: RetainMeta }) {
  return (
    <div className="mt-2 space-y-2 text-xs">
      {meta.score != null && (
        <div className="flex items-center gap-2">
          <span className="text-zinc-600">Quality:</span>
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${meta.score >= 0.7 ? 'bg-green-500' : meta.score >= 0.4 ? 'bg-yellow-500' : 'bg-red-500'}`}
                style={{ width: `${Math.round(meta.score * 100)}%` }}
              />
            </div>
            <span className="font-mono text-zinc-400">{meta.score.toFixed(2)}</span>
          </div>
        </div>
      )}
      {meta.importance != null && (
        <div className="flex items-center gap-2">
          <span className="text-zinc-600">Importance:</span>
          <span className="font-mono text-zinc-400">{meta.importance.toFixed(2)}</span>
        </div>
      )}
      {meta.signals && meta.signals.length > 0 && (
        <div>
          <span className="text-zinc-600">Signals: </span>
          <span className="text-zinc-400 break-words">{meta.signals.join(', ')}</span>
        </div>
      )}
      {/* Buffered conversation message (context assembler) rather than a scored record. */}
      {meta.role && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-zinc-500">
          <span>Role: <span className="text-zinc-400 font-mono">{meta.role}</span></span>
          {meta.chars != null && <span>Chars: <span className="text-zinc-400 font-mono">{meta.chars}</span></span>}
          {meta.bufferSize != null && <span>Buffered: <span className="text-zinc-400 font-mono">{meta.bufferSize}</span></span>}
        </div>
      )}
      {/* Persisted coding run (memory bridge). */}
      {(meta.requirementsCount != null || meta.verdictsCount != null) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-zinc-500">
          {meta.requirementsCount != null && (
            <span>Requirements: <span className="text-zinc-400 font-mono">{meta.requirementsCount}</span></span>
          )}
          {meta.verdictsCount != null && (
            <span>Verdicts: <span className="text-zinc-400 font-mono">{meta.verdictsCount}</span></span>
          )}
          {meta.decision && <span className="text-zinc-400">{meta.decision}</span>}
        </div>
      )}
      {meta.contentPreview ? (
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-zinc-600">Content{meta.contentLength != null ? ` (${meta.contentLength} chars)` : ''}:</span>
            <CopyButton text={meta.contentPreview} stopPropagation />
          </div>
          <div className="rounded border border-zinc-700/40 bg-zinc-900/50 p-2">
            <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap break-words">
              {meta.contentPreview}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ExpandedQuality({ meta }: { meta: QualityMeta }) {
  return (
    <div className="mt-2 space-y-2 text-xs">
      {meta.score != null && (
        <div className="flex items-center gap-2">
          <span className="text-zinc-600">Score:</span>
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-red-500" style={{ width: `${Math.round(meta.score * 100)}%` }} />
            </div>
            <span className="font-mono text-zinc-400">{meta.score.toFixed(2)}</span>
          </div>
          {meta.threshold != null && (
            <span className="text-zinc-600">(threshold: <span className="font-mono text-zinc-400">{meta.threshold}</span>)</span>
          )}
        </div>
      )}
      {meta.signals && meta.signals.length > 0 && (
        <div>
          <span className="text-zinc-600">Signals: </span>
          <span className="text-zinc-400 break-words">{meta.signals.join(', ')}</span>
        </div>
      )}
      {meta.wordCount != null && (
        <span className="text-zinc-600">Words: <span className="text-zinc-400 font-mono">{meta.wordCount}</span></span>
      )}
      {meta.contentPreview && (
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-zinc-600">Content:</span>
            <CopyButton text={meta.contentPreview} stopPropagation />
          </div>
          <div className="rounded border border-zinc-700/40 bg-zinc-900/50 p-2">
            <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap break-words">
              {meta.contentPreview}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ExpandedDedup({ meta }: { meta: DedupMeta }) {
  return (
    <div className="mt-2 space-y-2 text-xs">
      {meta.context && (
        <span className="text-zinc-600">Context: <span className="text-zinc-400">{meta.context}</span></span>
      )}
      {meta.similarityThreshold != null && (
        <span className="text-zinc-600">Similarity threshold: <span className="font-mono text-zinc-400">{meta.similarityThreshold}</span></span>
      )}
      {meta.contentPreview && (
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-zinc-600">Duplicate content:</span>
            <CopyButton text={meta.contentPreview} stopPropagation />
          </div>
          <div className="rounded border border-zinc-700/40 bg-zinc-900/50 p-2">
            <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap break-words">
              {meta.contentPreview}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Flush detail — buffered conversation messages written in one batch. */
function ExpandedFlush({ meta }: { meta: FlushMeta }) {
  return (
    <div className="mt-2 space-y-2 text-xs">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-zinc-500">
        {meta.count != null && (
          <span>Messages: <span className="text-zinc-400 font-mono">{meta.count}</span></span>
        )}
      </div>
    </div>
  );
}

function ExpandedGeneric({ meta }: { meta: Record<string, unknown> }) {
  return (
    <div className="mt-2">
      <pre className="text-xs text-zinc-500 font-mono whitespace-pre-wrap break-words bg-zinc-900/50 rounded border border-zinc-700/40 p-2">
        {JSON.stringify(meta, null, 2)}
      </pre>
    </div>
  );
}

function SessionProvenancePill({ op, sessionId }: { op: MemoryEvent['op']; sessionId: string }) {
  // For retain ops, the session is where the memory was STORED (origin).
  // For recall ops, the session is where the memory was RECALLED INTO (target).
  const verb = op === 'recall' ? 'recalled into' : 'stored in';
  const short = sessionId.length > 12 ? `${sessionId.slice(0, 8)}…` : sessionId;
  return (
    <span
      className="text-xs px-1.5 py-0.5 bg-violet-500/10 text-violet-300 rounded font-mono"
      title={`${verb} session ${sessionId}`}
    >
      {verb} {short}
    </span>
  );
}

const MemoryEventRow = function MemoryEventRow({ event }: { event: MemoryEvent }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = OP_CONFIG[event.op] ?? { icon: Brain, label: event.op, color: 'text-zinc-400', bgColor: 'bg-zinc-800' };
  const Icon = cfg.icon;
  const meta = event.meta ?? {};

  const recallMeta = event.op === 'recall' ? (meta as RecallMeta) : null;
  const retainMeta = event.op === 'retain' ? (meta as RetainMeta) : null;
  const qualityMeta = event.op === 'quality' ? (meta as QualityMeta) : null;
  const dedupMeta = event.op === 'dedup' ? (meta as DedupMeta) : null;
  const toolMeta = event.op === 'tool' ? (meta as ToolMeta) : null;
  const flushMeta = event.op === 'flush' ? (meta as FlushMeta) : null;
  const provenanceSessionId = (meta as { sessionId?: unknown }).sessionId;
  const sessionIdStr = typeof provenanceSessionId === 'string' && provenanceSessionId.length > 0
    ? provenanceSessionId
    : null;

  const hasExpandable = Object.keys(meta).length > 0;

  return (
    <div className="border-b border-zinc-800/50 last:border-0">
      <button
        onClick={() => hasExpandable && setExpanded(!expanded)}
        className={`w-full flex items-start gap-3 px-3 py-2 text-left transition-colors ${
          hasExpandable ? 'hover:bg-zinc-800/50 cursor-pointer' : 'cursor-default'
        }`}
      >
        <div className={`mt-0.5 flex-shrink-0 ${cfg.color}`}>
          <Icon size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
            {event.scope && (
              <span className="text-xs text-zinc-500 bg-zinc-800 rounded px-1.5 py-0.5 font-mono">
                {event.scope}
              </span>
            )}
            {sessionIdStr && (event.op === 'retain' || event.op === 'recall') && (
              <SessionProvenancePill op={event.op} sessionId={sessionIdStr} />
            )}
            {retainMeta?.score != null && <QualityDot score={retainMeta.score} />}
            {qualityMeta?.score != null && <QualityDot score={qualityMeta.score} />}
            {toolMeta?.outcome != null && toolMeta.outcome !== 'ok' && (
              <span className={`text-xs font-mono ${
                toolMeta.outcome === 'error' ? 'text-red-400'
                  : toolMeta.outcome === 'refused' ? 'text-amber-400'
                    : 'text-zinc-500'
              }`}>
                {toolMeta.outcome.replace('_', ' ')}
              </span>
            )}
            {(meta.durationMs as number | undefined) != null && (
              <span className="text-xs text-zinc-600 font-mono">{meta.durationMs as number}ms</span>
            )}
            {recallMeta?.recalledTokens != null && (
              <span className="text-xs text-zinc-600 font-mono">{recallMeta.recalledTokens}tok</span>
            )}
            <span className="text-xs text-zinc-600 ml-auto flex-shrink-0">
              {formatTime(event.timestamp)}
            </span>
            {hasExpandable && (
              expanded
                ? <ChevronDown size={10} className="flex-shrink-0 text-zinc-600" />
                : <ChevronRight size={10} className="flex-shrink-0 text-zinc-600" />
            )}
          </div>
          <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">{event.detail}</p>
        </div>
      </button>

      {expanded && hasExpandable && (
        <div className="px-3 pb-3 ml-[26px]">
          <div className="border-t border-zinc-700/40 pt-2">
            {recallMeta && <ExpandedRecall meta={recallMeta} />}
            {retainMeta && <ExpandedRetain meta={retainMeta} />}
            {qualityMeta && <ExpandedQuality meta={qualityMeta} />}
            {dedupMeta && <ExpandedDedup meta={dedupMeta} />}
            {toolMeta && <ExpandedTool meta={toolMeta} />}
            {flushMeta && <ExpandedFlush meta={flushMeta} />}
            {!recallMeta && !retainMeta && !qualityMeta && !dedupMeta && !toolMeta && !flushMeta && (
              <ExpandedGeneric meta={meta} />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

function FilterBar({
  events,
  filter,
  setFilter,
  filteredCount,
}: {
  events: MemoryEvent[];
  filter: MemoryFilterState;
  setFilter: (f: Partial<MemoryFilterState>) => void;
  filteredCount: number;
}) {
  const scopes = [...new Set(events.map(e => e.scope).filter(Boolean))] as string[];
  const activeOps = filter.ops;
  const hasActiveFilter = activeOps !== null || filter.scope !== null || filter.searchText !== '';

  const toggleOp = (op: MemoryEvent['op']) => {
    if (!activeOps) {
      setFilter({ ops: new Set(ALL_OPS.filter(o => o !== op)) });
    } else {
      const next = new Set(activeOps);
      if (next.has(op)) {
        next.delete(op);
      } else {
        next.add(op);
      }
      setFilter({ ops: next.size === ALL_OPS.length ? null : (next.size === 0 ? activeOps : next) });
    }
  };

  const isOpActive = (op: MemoryEvent['op']) => !activeOps || activeOps.has(op);

  return (
    <div className="border-b border-zinc-800 px-3 py-2 space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input
            type="text"
            placeholder="Search events..."
            value={filter.searchText}
            onChange={e => setFilter({ searchText: e.target.value })}
            className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded px-2 py-1 pl-6 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-violet-500/50"
          />
          {filter.searchText && (
            <button
              onClick={() => setFilter({ searchText: '' })}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400"
            >
              <X size={10} />
            </button>
          )}
        </div>
        {scopes.length > 0 && (
          <select
            value={filter.scope ?? ''}
            onChange={e => setFilter({ scope: e.target.value || null })}
            className="bg-zinc-800/60 border border-zinc-700/50 rounded px-2 py-1 text-xs text-zinc-400 outline-none focus:border-violet-500/50"
          >
            <option value="">All scopes</option>
            {scopes.map(sc => <option key={sc} value={sc}>{sc}</option>)}
          </select>
        )}
        {hasActiveFilter && (
          <button
            onClick={() => setFilter({ ops: null, scope: null, searchText: '' })}
            className="text-xs text-violet-400 hover:text-violet-300 flex-shrink-0"
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {ALL_OPS.map(op => {
          const cfg = OP_CONFIG[op];
          const active = isOpActive(op);
          return (
            <button
              key={op}
              onClick={() => toggleOp(op)}
              className={`text-xs px-1.5 py-0.5 rounded font-medium transition-colors ${
                active
                  ? `${cfg.color} ${cfg.bgColor}`
                  : 'text-zinc-600 bg-zinc-800/40'
              }`}
            >
              {cfg.label}
            </button>
          );
        })}
      </div>
      {hasActiveFilter && (
        <p className="text-xs text-zinc-600">
          Showing {filteredCount} of {events.length} events
        </p>
      )}
    </div>
  );
}

function MemoryStatsBar({ events }: { events: MemoryEvent[] }) {
  const stats = useMemo(() => {
    const counts: Partial<Record<MemoryEvent['op'], number>> = {};
    let totalTokens = 0;
    for (const e of events) {
      counts[e.op] = (counts[e.op] ?? 0) + 1;
      const meta = e.meta as Record<string, unknown> | undefined;
      if (meta?.tokensUsed) totalTokens += meta.tokensUsed as number;
    }
    return { counts, totalTokens };
  }, [events]);

  const highlights: { op: MemoryEvent['op']; label: string }[] = [
    { op: 'retain', label: 'Stored' },
    { op: 'recall', label: 'Recalled' },
    { op: 'dedup', label: 'Deduped' },
    { op: 'quality', label: 'Filtered' },
  ];

  return (
    <div className="flex items-center gap-3 border-b border-zinc-800 px-3 py-1.5 text-[10px] font-mono text-zinc-600 bg-zinc-900/30">
      <span className="text-zinc-500 font-medium">{events.length} ops</span>
      {highlights.map(({ op, label }) =>
        stats.counts[op] ? (
          <span key={op} className="flex items-center gap-1">
            <span className={OP_CONFIG[op]?.color ?? 'text-zinc-500'}>{label}</span>
            <span className="text-zinc-500">{stats.counts[op]}</span>
          </span>
        ) : null
      )}
      {stats.totalTokens > 0 && (
        <span className="ml-auto text-zinc-700">
          {stats.totalTokens.toLocaleString()} tok recalled
        </span>
      )}
    </div>
  );
}

export function MemoryFeed() {
  const allEvents = useOrchestrationStore((s) => s.memoryEvents);
  const filter = useOrchestrationStore((s) => s.memoryFilter);
  const setMemoryFilter = useOrchestrationStore((s) => s.setMemoryFilter);
  const filteredEvents = useFilteredMemoryEvents();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [filteredEvents.length]);

  if (allEvents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-3">
        <Brain size={28} className="text-zinc-600" />
        <div className="text-center">
          <p className="text-sm font-medium">Memory Feed</p>
          <p className="text-xs mt-1 text-zinc-600 max-w-[220px]">
            Real-time memory operations will appear here as the agent works.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <MemoryStatsBar events={allEvents} />
      <FilterBar
        events={allEvents}
        filter={filter}
        setFilter={setMemoryFilter}
        filteredCount={filteredEvents.length}
      />
      <div className="flex-1 overflow-y-auto">
        {filteredEvents.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-zinc-600 text-xs">
            No events match current filters
          </div>
        ) : (
          filteredEvents.map((evt) => (
            <MemoryEventRow key={evt.id} event={evt} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
