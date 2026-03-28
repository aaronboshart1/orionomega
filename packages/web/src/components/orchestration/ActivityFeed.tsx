'use client';

import { useRef, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { useOrchestrationStore, type WorkerEvent } from '@/stores/orchestration';

const typeIcons: Record<string, string> = {
  thinking: '🧠',
  tool_call: '🔧',
  tool_result: '📋',
  finding: '💡',
  status: '📊',
  error: '❌',
  done: '✅',
};

function formatTime(ts: string) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '--:--:--';
  }
}

function EventRow({ event }: { event: WorkerEvent }) {
  const icon = typeIcons[event.type] || '📊';

  return (
    <div className="flex items-start gap-2 border-b border-zinc-800/50 px-4 py-1.5 text-xs font-mono hover:bg-zinc-800/30">
      <span className="shrink-0 text-zinc-600">{formatTime(event.timestamp)}</span>
      <span className="shrink-0">{icon}</span>
      <span className="shrink-0 text-zinc-500">{event.workerId}</span>
      <span className="min-w-0 flex-1 truncate">
        {event.type === 'tool_call' && event.tool && (
          <>
            <span className="text-yellow-500">{event.tool.name}</span>
            {event.tool.action && <span className="text-zinc-500"> .{event.tool.action}</span>}
            {event.tool.file && <span className="ml-1 text-zinc-600">{event.tool.file}</span>}
            <span className="ml-1 text-zinc-400">{event.tool.summary}</span>
          </>
        )}
        {event.type === 'thinking' && (
          <span className="italic text-zinc-500">
            {event.thinking ? (event.thinking.length > 80 ? event.thinking.slice(0, 80) + '…' : event.thinking) : 'Thinking...'}
          </span>
        )}
        {event.type === 'finding' && (
          <span className="text-green-400">{event.message}</span>
        )}
        {event.type === 'error' && (
          <span className="text-red-400">{event.error || event.message}</span>
        )}
        {event.type === 'done' && (
          <span className="text-green-400">{event.message || 'Complete'}</span>
        )}
        {event.type === 'status' && (
          <span className="text-zinc-400">{event.message}</span>
        )}
        {event.type === 'tool_result' && (
          <span className="text-zinc-400">{event.message || 'Result received'}</span>
        )}
      </span>
      {event.progress !== undefined && (
        <span className="shrink-0 text-zinc-600">{event.progress}%</span>
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
          <span className="text-[10px] text-zinc-600">0 events</span>
        </button>
        <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">
          Waiting for events…
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <button
        onClick={toggleCollapsed}
        className="flex items-center justify-between border-b border-zinc-800 px-4 py-2 w-full cursor-pointer hover:bg-zinc-800/30 transition-colors shrink-0"
      >
        <div className="flex items-center gap-2">
          <ChevronDown
            size={14}
            className={`text-zinc-500 transition-transform duration-300 ${collapsed ? '-rotate-90' : 'rotate-0'}`}
          />
          <h3 className="text-xs font-semibold text-zinc-400">Activity Feed</h3>
        </div>
        <span className="text-[10px] text-zinc-600">{events.length} events</span>
      </button>
      {!collapsed && (
        <div className="flex-1 overflow-y-auto" ref={scrollContainerRef} onScroll={handleScroll}>
          {events.map((event, i) => (
            <EventRow key={`${event.timestamp}-${i}`} event={event} />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
