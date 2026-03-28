'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useOrchestrationStore, useFilteredMemoryEvents, type MemoryEvent, type MemoryFilterState, type RecallMeta, type RetainMeta, type QualityMeta, type DedupMeta } from '@/stores/orchestration';
import {
  Brain,
  Download,
  Search,
  Filter,
  Shield,
  Zap,
  Anchor,
  FileText,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  X,
} from 'lucide-react';

const OP_CONFIG: Record<MemoryEvent['op'], { icon: typeof Brain; label: string; color: string; bgColor: string }> = {
  bootstrap: { icon: Zap, label: 'Bootstrap', color: 'text-violet-400', bgColor: 'bg-violet-500/10' },
  recall: { icon: Search, label: 'Recall', color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  retain: { icon: Download, label: 'Retain', color: 'text-green-400', bgColor: 'bg-green-500/10' },
  flush: { icon: Download, label: 'Flush', color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
  dedup: { icon: Filter, label: 'Dedup', color: 'text-orange-400', bgColor: 'bg-orange-500/10' },
  quality: { icon: Shield, label: 'Quality', color: 'text-cyan-400', bgColor: 'bg-cyan-500/10' },
  session_anchor: { icon: Anchor, label: 'Anchor', color: 'text-pink-400', bgColor: 'bg-pink-500/10' },
  summary: { icon: FileText, label: 'Summary', color: 'text-emerald-400', bgColor: 'bg-emerald-500/10' },
  self_knowledge: { icon: Sparkles, label: 'Self-Knowledge', color: 'text-purple-400', bgColor: 'bg-purple-500/10' },
};

const ALL_OPS = Object.keys(OP_CONFIG) as MemoryEvent['op'][];

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function RelevanceBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = score >= 0.7 ? 'bg-green-500' : score >= 0.4 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-10 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-zinc-500">{score.toFixed(2)}</span>
    </div>
  );
}

function QualityDot({ score }: { score: number }) {
  const color = score >= 0.7 ? 'bg-green-500' : score >= 0.4 ? 'bg-yellow-500' : 'bg-red-500';
  return <span className={`inline-block w-2 h-2 rounded-full ${color} flex-shrink-0`} title={`Quality: ${score.toFixed(2)}`} />;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [text]);
  return (
    <button
      onClick={handleCopy}
      className="flex-shrink-0 text-zinc-600 hover:text-zinc-400 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}
    </button>
  );
}

function MemoryContentCard({ memory }: { memory: { content: string; context: string; timestamp: string; relevance?: number } }) {
  const [showFull, setShowFull] = useState(false);
  const isLong = memory.content.length > 200;
  const displayContent = showFull ? memory.content : memory.content.slice(0, 200);

  return (
    <div className="rounded border border-zinc-700/40 bg-zinc-900/50 p-2 mt-1.5">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="text-xs px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-400 font-mono">
          {memory.context}
        </span>
        {memory.timestamp && (
          <span className="text-xs text-zinc-600">{formatDate(memory.timestamp)}</span>
        )}
        {memory.relevance !== undefined && <RelevanceBar score={memory.relevance} />}
        <span className="ml-auto">
          <CopyButton text={memory.content} />
        </span>
      </div>
      <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap break-words">
        {displayContent}
        {isLong && !showFull && '…'}
      </p>
      {isLong && (
        <button
          onClick={() => setShowFull(!showFull)}
          className="text-xs text-violet-400 mt-1 hover:text-violet-300"
        >
          {showFull ? 'Show less' : `Show full (${memory.content.length} chars)`}
        </button>
      )}
    </div>
  );
}

function ExpandedRecall({ meta }: { meta: RecallMeta }) {
  return (
    <div className="mt-2 space-y-2 text-xs">
      {meta.query && (
        <div className="flex gap-1.5">
          <span className="text-zinc-600 flex-shrink-0">Query:</span>
          <span className="text-zinc-300 break-words">&ldquo;{meta.query}&rdquo;</span>
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-zinc-500">
        {meta.budget && <span>Budget: <span className="text-zinc-400">{meta.budget}</span></span>}
        {meta.maxTokens != null && <span>Max tokens: <span className="text-zinc-400 font-mono">{meta.maxTokens}</span></span>}
        {meta.minRelevance != null && <span>Floor: <span className="text-zinc-400 font-mono">{meta.minRelevance}</span></span>}
        {meta.tokensUsed != null && <span>Used: <span className="text-zinc-400 font-mono">{meta.tokensUsed} tok</span></span>}
        {meta.clientScored && <span className="text-yellow-500/80">client-scored</span>}
      </div>
      {(meta.totalFromApi != null || meta.droppedByRelevance != null) && (
        <div className="text-zinc-500">
          Funnel:{' '}
          <span className="text-zinc-400 font-mono">{meta.totalFromApi ?? '?'}</span> API
          {meta.droppedByRelevance != null && meta.droppedByRelevance > 0 && (
            <> → <span className="text-zinc-400 font-mono">{(meta.totalFromApi ?? 0) - meta.droppedByRelevance}</span> passed filter</>
          )}
          {meta.resultCount != null && (
            <> → <span className="text-zinc-400 font-mono">{meta.resultCount}</span> deduped</>
          )}
        </div>
      )}
      {meta.results && meta.results.length > 0 && (
        <div className="space-y-1">
          <span className="text-zinc-600">Results:</span>
          {meta.results.map((r, i) => (
            <MemoryContentCard key={i} memory={r} />
          ))}
        </div>
      )}
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
      {meta.signals && meta.signals.length > 0 && (
        <div>
          <span className="text-zinc-600">Signals: </span>
          <span className="text-zinc-400 break-words">{meta.signals.join(', ')}</span>
        </div>
      )}
      {meta.durationMs != null && (
        <span className="text-zinc-600">Duration: <span className="text-zinc-400 font-mono">{meta.durationMs}ms</span></span>
      )}
      {meta.items && meta.items.length > 0 ? (
        <div className="space-y-1">
          <span className="text-zinc-600">Items:</span>
          {meta.items.map((item, i) => (
            <MemoryContentCard key={i} memory={item} />
          ))}
        </div>
      ) : meta.contentPreview ? (
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-zinc-600">Content{meta.contentLength != null ? ` (${meta.contentLength} chars)` : ''}:</span>
            <CopyButton text={meta.contentPreview} />
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
            <CopyButton text={meta.contentPreview} />
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
            <CopyButton text={meta.contentPreview} />
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

function ExpandedGeneric({ meta }: { meta: Record<string, unknown> }) {
  return (
    <div className="mt-2">
      <pre className="text-xs text-zinc-500 font-mono whitespace-pre-wrap break-words bg-zinc-900/50 rounded border border-zinc-700/40 p-2">
        {JSON.stringify(meta, null, 2)}
      </pre>
    </div>
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
            {event.bank && (
              <span className="text-xs text-zinc-500 bg-zinc-800 rounded px-1.5 py-0.5 font-mono">
                {event.bank}
              </span>
            )}
            {recallMeta?.topScore != null && <RelevanceBar score={recallMeta.topScore} />}
            {retainMeta?.score != null && <QualityDot score={retainMeta.score} />}
            {qualityMeta?.score != null && <QualityDot score={qualityMeta.score} />}
            {(meta.durationMs as number | undefined) != null && (
              <span className="text-xs text-zinc-600 font-mono">{meta.durationMs as number}ms</span>
            )}
            {recallMeta?.tokensUsed != null && (
              <span className="text-xs text-zinc-600 font-mono">{recallMeta.tokensUsed}tok</span>
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
            {!recallMeta && !retainMeta && !qualityMeta && !dedupMeta && (
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
  const banks = [...new Set(events.map(e => e.bank).filter(Boolean))] as string[];
  const activeOps = filter.ops;
  const hasActiveFilter = activeOps !== null || filter.bank !== null || filter.searchText !== '';

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
        {banks.length > 0 && (
          <select
            value={filter.bank ?? ''}
            onChange={e => setFilter({ bank: e.target.value || null })}
            className="bg-zinc-800/60 border border-zinc-700/50 rounded px-2 py-1 text-xs text-zinc-400 outline-none focus:border-violet-500/50"
          >
            <option value="">All banks</option>
            {banks.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        )}
        {hasActiveFilter && (
          <button
            onClick={() => setFilter({ ops: null, bank: null, searchText: '' })}
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
            Real-time Hindsight memory operations will appear here as the agent works.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <FilterBar
        events={allEvents}
        filter={filter}
        setFilter={setMemoryFilter}
        filteredCount={filteredEvents.length}
      />
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-zinc-700">
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
