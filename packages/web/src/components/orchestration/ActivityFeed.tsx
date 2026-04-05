'use client';

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import {
  ChevronDown,
  Brain,
  Wrench,
  ClipboardList,
  Lightbulb,
  BarChart3,
  XCircle,
  CheckCircle2,
  Repeat,
  RefreshCw,
  Lock,
  Map,
  AlertTriangle,
  Play,
  Square,
  Info,
  Filter,
} from 'lucide-react';
import { useOrchestrationStore, type WorkerEvent, type WorkerEventType } from '@/stores/orchestration';

const typeIcons: Record<string, React.ReactNode> = {
  thinking: <Brain size={12} aria-hidden className="text-purple-400" />,
  tool_call: <Wrench size={12} aria-hidden className="text-yellow-400" />,
  tool_result: <ClipboardList size={12} aria-hidden className="text-cyan-400" />,
  finding: <Lightbulb size={12} aria-hidden className="text-green-400" />,
  status: <BarChart3 size={12} aria-hidden className="text-blue-400" />,
  error: <XCircle size={12} aria-hidden className="text-red-400" />,
  done: <CheckCircle2 size={12} aria-hidden className="text-green-400" />,
  loop_iteration: <Repeat size={12} aria-hidden className="text-orange-400" />,
  replan: <RefreshCw size={12} aria-hidden className="text-amber-400" />,
  fileLock: <Lock size={12} aria-hidden className="text-pink-400" />,
  planning: <Map size={12} aria-hidden className="text-indigo-400" />,
  warning: <AlertTriangle size={12} aria-hidden className="text-amber-400" />,
  agent_start: <Play size={12} aria-hidden className="text-blue-400" />,
  agent_complete: <Square size={12} aria-hidden className="text-green-400" />,
  info: <Info size={12} aria-hidden className="text-sky-400" />,
};

// Left-border accent color per event type (CSS color value)
const typeBorderColors: Partial<Record<string, string>> = {
  thinking:      '#a855f7',
  tool_call:     '#eab308',
  tool_result:   '#06b6d4',
  finding:       '#22c55e',
  error:         '#ef4444',
  warning:       '#f59e0b',
  done:          '#22c55e',
  loop_iteration:'#f97316',
  replan:        '#f59e0b',
  fileLock:      '#ec4899',
  planning:      '#6366f1',
  agent_start:   '#3b82f6',
  agent_complete:'#22c55e',
  info:          '#0ea5e9',
  status:        '#3b82f6',
};

const typeLabels: Record<WorkerEventType, string> = {
  thinking: 'Thinking',
  tool_call: 'Tool Call',
  tool_result: 'Tool Result',
  finding: 'Finding',
  status: 'Status',
  error: 'Error',
  done: 'Done',
  loop_iteration: 'Loop',
  replan: 'Replan',
  fileLock: 'File Lock',
  planning: 'Planning',
  warning: 'Warning',
  agent_start: 'Agent Start',
  agent_complete: 'Agent Done',
  info: 'Info',
};

const defaultIcon = <BarChart3 size={12} aria-hidden className="text-zinc-400" />;

function formatTime(ts: string) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '--:--:--';
  }
}

function truncateParams(params: Record<string, unknown> | undefined, maxLen = 60): string {
  if (!params) return '';
  const str = Object.entries(params)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${val && val.length > 30 ? val.slice(0, 30) + '...' : val}`;
    })
    .join(' ');
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

function EventContent({ event }: { event: WorkerEvent }) {
  switch (event.type) {
    case 'tool_call':
      return event.tool ? (
        <>
          <span className="text-yellow-500 font-semibold">{event.tool.name}</span>
          {event.tool.action && <span className="text-zinc-500"> .{event.tool.action}</span>}
          {event.tool.file && <span className="ml-1 text-zinc-600">{event.tool.file}</span>}
          {event.tool.summary && <span className="ml-1 text-zinc-400">{event.tool.summary}</span>}
          {event.tool.params && !event.tool.summary && (
            <span className="ml-1 text-zinc-600 text-[10px]">{truncateParams(event.tool.params)}</span>
          )}
        </>
      ) : <span className="text-zinc-500">Tool invoked</span>;

    case 'tool_result':
      return (
        <span className="text-cyan-400/80">
          {event.tool?.name && <span className="text-cyan-500">{event.tool.name}</span>}
          {event.tool?.name && ' '}
          {event.error ? (
            <span className="text-red-400">{event.error}</span>
          ) : (
            <span>{event.message || 'Result received'}</span>
          )}
        </span>
      );

    case 'thinking':
      return (
        <span className="italic text-zinc-500">
          {event.thinking ? (event.thinking.length > 120 ? event.thinking.slice(0, 120) + '...' : event.thinking) : 'Thinking...'}
        </span>
      );

    case 'finding':
      return <span className="text-green-400">{event.message}</span>;

    case 'error':
      return <span className="text-red-400 font-medium">{event.error || event.message}</span>;

    case 'warning':
      return <span className="text-amber-400">{event.message}</span>;

    case 'done':
      return (
        <span className="text-green-400">
          {event.message || 'Complete'}
          {event.durationMs !== undefined && (
            <span className="ml-1 text-zinc-600">({event.durationMs}ms)</span>
          )}
        </span>
      );

    case 'status':
      return <span className="text-zinc-400">{event.message}</span>;

    case 'info':
      return <span className="text-sky-400/80">{event.message}</span>;

    case 'loop_iteration':
      return (
        <span className="text-orange-400">
          Iteration {event.iteration ?? '?'}
          {event.totalIterations != null && <span className="text-zinc-600">/{event.totalIterations}</span>}
          {event.message && <span className="ml-1 text-zinc-400">{event.message}</span>}
        </span>
      );

    case 'replan':
      return (
        <span className="text-amber-400">
          Replanning
          {event.message && <span className="ml-1 text-zinc-400">- {event.message}</span>}
        </span>
      );

    case 'fileLock':
      if (!event.fileLock) return <span className="text-pink-400">File lock event</span>;
      return (
        <span className="text-pink-400">
          <span className="font-medium">{event.fileLock.action}</span>
          {' '}
          <span className="text-zinc-400">{event.fileLock.file}</span>
          {event.fileLock.holder && (
            <span className="ml-1 text-zinc-600">by {event.fileLock.holder}</span>
          )}
        </span>
      );

    case 'planning':
      return <span className="text-indigo-400">{event.message || 'Generating execution plan...'}</span>;

    case 'agent_start':
      return (
        <span className="text-blue-400">
          Agent started
          {event.message && <span className="text-zinc-400"> - {event.message}</span>}
        </span>
      );

    case 'agent_complete':
      return (
        <span className="text-green-400">
          Agent completed
          {event.durationMs !== undefined && (
            <span className="ml-1 text-zinc-600">({event.durationMs}ms)</span>
          )}
          {event.message && <span className="ml-1 text-zinc-400">{event.message}</span>}
        </span>
      );

    default:
      return <span className="text-zinc-400">{event.message || event.type}</span>;
  }
}

function EventRow({ event }: { event: WorkerEvent }) {
  const icon = typeIcons[event.type] || defaultIcon;

  const isError = event.type === 'error';
  const isWarning = event.type === 'warning';
  const rowBg = isError
    ? 'bg-red-500/5 hover:bg-red-500/10'
    : isWarning
      ? 'bg-amber-500/5 hover:bg-amber-500/10'
      : 'hover:bg-zinc-800/30';

  const borderColor = typeBorderColors[event.type] ?? '#3f3f46';

  return (
    <div
      className={`flex items-start gap-2 border-b border-zinc-800/40 py-1.5 text-xs font-mono ${rowBg}`}
      style={{ paddingLeft: '12px', borderLeft: `2px solid ${borderColor}20`, paddingRight: '16px' }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderLeftColor = `${borderColor}60`; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderLeftColor = `${borderColor}20`; }}
    >
      <span className="shrink-0 text-zinc-600">{formatTime(event.timestamp)}</span>
      <span className="shrink-0 flex items-center" title={typeLabels[event.type] ?? event.type}>{icon}</span>
      <span className="shrink-0 text-zinc-500 max-w-[80px] truncate" title={event.workerId}>{event.workerId}</span>
      <span className="min-w-0 flex-1 truncate">
        <EventContent event={event} />
      </span>
      {event.progress !== undefined && (
        <span className="shrink-0 text-zinc-600">{event.progress}%</span>
      )}
      {event.tokenUsage && (
        <span className="shrink-0 text-zinc-700 text-[10px]" title="Tokens: in/out">
          {event.tokenUsage.input}↓{event.tokenUsage.output}↑
        </span>
      )}
    </div>
  );
}

const ALL_EVENT_TYPES: WorkerEventType[] = [
  'thinking', 'tool_call', 'tool_result', 'finding', 'status',
  'error', 'done', 'loop_iteration', 'replan', 'fileLock',
  'planning', 'warning', 'agent_start', 'agent_complete', 'info',
];

function FilterBar({
  activeTypes,
  onToggleType,
  nodeFilter,
  onSetNodeFilter,
  availableNodes,
}: {
  activeTypes: Set<WorkerEventType> | null;
  onToggleType: (t: WorkerEventType) => void;
  nodeFilter: string | null;
  onSetNodeFilter: (n: string | null) => void;
  availableNodes: string[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800 px-3 py-1.5">
      {ALL_EVENT_TYPES.map((t) => {
        const active = !activeTypes || activeTypes.has(t);
        return (
          <button
            key={t}
            type="button"
            onClick={() => onToggleType(t)}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
              active
                ? 'bg-zinc-700/50 text-zinc-300'
                : 'bg-zinc-800/30 text-zinc-600 line-through'
            }`}
            title={`Toggle ${typeLabels[t]}`}
          >
            {typeIcons[t]}
            <span className="hidden sm:inline">{typeLabels[t]}</span>
          </button>
        );
      })}
      {availableNodes.length > 1 && (
        <select
          value={nodeFilter || ''}
          onChange={(e) => onSetNodeFilter(e.target.value || null)}
          className="ml-auto rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 border border-zinc-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">All nodes</option>
          {availableNodes.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      )}
    </div>
  );
}

export function ActivityFeed() {
  const events = useOrchestrationStore((s) => s.events);
  const collapsed = useOrchestrationStore((s) => s.activitySectionCollapsed);
  const toggleCollapsed = useOrchestrationStore((s) => s.toggleActivitySectionCollapsed);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [filterOpen, setFilterOpen] = useState(false);
  const [activeTypes, setActiveTypes] = useState<Set<WorkerEventType> | null>(null);
  const [nodeFilter, setNodeFilter] = useState<string | null>(null);

  const availableNodes = useMemo(() => {
    const ids = new Set(events.map((e) => e.workerId));
    return Array.from(ids).sort();
  }, [events]);

  const filteredEvents = useMemo(() => {
    let result = events;
    if (activeTypes) {
      result = result.filter((e) => activeTypes.has(e.type));
    }
    if (nodeFilter) {
      result = result.filter((e) => e.workerId === nodeFilter);
    }
    return result;
  }, [events, activeTypes, nodeFilter]);

  const toggleType = useCallback((t: WorkerEventType) => {
    setActiveTypes((prev) => {
      if (!prev) {
        // First click: show only this type
        const newSet = new Set<WorkerEventType>(ALL_EVENT_TYPES);
        newSet.delete(t);
        return newSet;
      }
      const next = new Set(prev);
      if (next.has(t)) {
        next.delete(t);
        // If nothing left, reset to show all
        return next.size === 0 ? null : next;
      } else {
        next.add(t);
        // If all types active, reset to null (show all)
        return next.size === ALL_EVENT_TYPES.length ? null : next;
      }
    });
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distanceFromBottom > 50;
  }, []);

  useEffect(() => {
    if (collapsed) return;
    if (userScrolledUpRef.current) return;
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      if (!userScrolledUpRef.current) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }, 200);
    return () => {
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
    };
  }, [events, collapsed]);

  const isFiltered = activeTypes !== null || nodeFilter !== null;

  if (events.length === 0 && !collapsed) {
    return (
      <div className="flex h-full flex-col">
        <button
          onClick={toggleCollapsed}
          className="flex items-center justify-between border-b border-zinc-800 px-4 py-2 w-full cursor-pointer hover:bg-zinc-800/30 transition-colors"
        >
          <div className="flex items-center gap-2">
            <ChevronDown
              size={14}
              className="text-zinc-500 transition-transform duration-300 rotate-0"
            />
            <h3 className="text-xs font-semibold text-zinc-400">Activity Feed</h3>
          </div>
          <span className="text-xs text-zinc-600">0 events</span>
        </button>
        <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">
          Waiting for events...
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b border-zinc-800 shrink-0">
        <button
          onClick={toggleCollapsed}
          className="flex flex-1 items-center justify-between px-4 py-2 cursor-pointer hover:bg-zinc-800/30 transition-colors"
        >
          <div className="flex items-center gap-2">
            <ChevronDown
              size={14}
              className={`text-zinc-500 transition-transform duration-300 ${collapsed ? '-rotate-90' : 'rotate-0'}`}
            />
            <h3 className="text-xs font-semibold text-zinc-400">Activity Feed</h3>
          </div>
          <span className="text-xs text-zinc-600">
            {isFiltered ? `${filteredEvents.length}/` : ''}{events.length} events
          </span>
        </button>
        {!collapsed && events.length > 0 && (
          <button
            type="button"
            onClick={() => setFilterOpen((o) => !o)}
            className={`mr-2 rounded p-1 transition-colors ${
              filterOpen || isFiltered
                ? 'bg-blue-500/20 text-blue-400'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
            }`}
            title="Toggle filters"
          >
            <Filter size={12} />
          </button>
        )}
      </div>
      {!collapsed && filterOpen && (
        <FilterBar
          activeTypes={activeTypes}
          onToggleType={toggleType}
          nodeFilter={nodeFilter}
          onSetNodeFilter={setNodeFilter}
          availableNodes={availableNodes}
        />
      )}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto" ref={scrollContainerRef} onScroll={handleScroll}>
          {filteredEvents.map((event, i) => (
            <EventRow key={`${event.timestamp}-${event.type}-${i}`} event={event} />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
