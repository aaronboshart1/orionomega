'use client';
import { useRef, useEffect } from 'react';
import { useOrchestrationStore } from '@/stores/orchestration';
const typeIcons = {
    thinking: '🧠',
    tool_call: '🔧',
    tool_result: '📋',
    finding: '💡',
    status: '📊',
    error: '❌',
    done: '✅',
};
function formatTime(ts) {
    try {
        const d = new Date(ts);
        return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    catch {
        return '--:--:--';
    }
}
function EventRow({ event }) {
    const icon = typeIcons[event.type] || '📊';
    return (<div className="flex items-start gap-2 border-b border-zinc-800/50 px-4 py-1.5 text-xs font-mono hover:bg-zinc-800/30">
      <span className="shrink-0 text-zinc-600">{formatTime(event.timestamp)}</span>
      <span className="shrink-0">{icon}</span>
      <span className="shrink-0 text-zinc-500">{event.workerId}</span>
      <span className="min-w-0 flex-1 truncate">
        {event.type === 'tool_call' && event.tool && (<>
            <span className="text-yellow-500">{event.tool.name}</span>
            {event.tool.action && <span className="text-zinc-500"> .{event.tool.action}</span>}
            {event.tool.file && <span className="ml-1 text-zinc-600">{event.tool.file}</span>}
            <span className="ml-1 text-zinc-400">{event.tool.summary}</span>
          </>)}
        {event.type === 'thinking' && (<span className="italic text-zinc-500">
            {event.thinking ? (event.thinking.length > 80 ? event.thinking.slice(0, 80) + '…' : event.thinking) : 'Thinking...'}
          </span>)}
        {event.type === 'finding' && (<span className="text-green-400">{event.message}</span>)}
        {event.type === 'error' && (<span className="text-red-400">{event.error || event.message}</span>)}
        {event.type === 'done' && (<span className="text-green-400">{event.message || 'Complete'}</span>)}
        {event.type === 'status' && (<span className="text-zinc-400">{event.message}</span>)}
        {event.type === 'tool_result' && (<span className="text-zinc-400">{event.message || 'Result received'}</span>)}
      </span>
      {event.progress !== undefined && (<span className="shrink-0 text-zinc-600">{event.progress}%</span>)}
    </div>);
}
export function ActivityFeed() {
    const events = useOrchestrationStore((s) => s.events);
    const bottomRef = useRef(null);
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [events]);
    if (events.length === 0) {
        return (<div className="flex h-full items-center justify-center text-xs text-zinc-600">
        Waiting for events…
      </div>);
    }
    return (<div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <h3 className="text-xs font-semibold text-zinc-400">Activity Feed</h3>
        <span className="text-[10px] text-zinc-600">{events.length} events</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {events.map((event, i) => (<EventRow key={`${event.timestamp}-${i}`} event={event}/>))}
        <div ref={bottomRef}/>
      </div>
    </div>);
}
//# sourceMappingURL=ActivityFeed.js.map