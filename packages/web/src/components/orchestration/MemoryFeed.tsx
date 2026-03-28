'use client';

import { useEffect, useRef } from 'react';
import { useOrchestrationStore, type MemoryEvent } from '@/stores/orchestration';
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
} from 'lucide-react';

const OP_CONFIG: Record<MemoryEvent['op'], { icon: typeof Brain; label: string; color: string }> = {
  bootstrap: { icon: Zap, label: 'Bootstrap', color: 'text-violet-400' },
  recall: { icon: Search, label: 'Recall', color: 'text-blue-400' },
  retain: { icon: Download, label: 'Retain', color: 'text-green-400' },
  flush: { icon: Download, label: 'Flush', color: 'text-amber-400' },
  dedup: { icon: Filter, label: 'Dedup', color: 'text-orange-400' },
  quality: { icon: Shield, label: 'Quality', color: 'text-cyan-400' },
  session_anchor: { icon: Anchor, label: 'Anchor', color: 'text-pink-400' },
  summary: { icon: FileText, label: 'Summary', color: 'text-emerald-400' },
  self_knowledge: { icon: Sparkles, label: 'Self-Knowledge', color: 'text-purple-400' },
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function MemoryEventRow({ event }: { event: MemoryEvent }) {
  const cfg = OP_CONFIG[event.op] ?? { icon: Brain, label: event.op, color: 'text-zinc-400' };
  const Icon = cfg.icon;

  return (
    <div className="flex items-start gap-3 px-3 py-2 hover:bg-zinc-800/50 transition-colors">
      <div className={`mt-0.5 flex-shrink-0 ${cfg.color}`}>
        <Icon size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
          {event.bank && (
            <span className="text-[10px] text-zinc-500 bg-zinc-800 rounded px-1.5 py-0.5 font-mono">
              {event.bank}
            </span>
          )}
          <span className="text-[10px] text-zinc-600 ml-auto flex-shrink-0">
            {formatTime(event.timestamp)}
          </span>
        </div>
        <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">{event.detail}</p>
      </div>
    </div>
  );
}

export function MemoryFeed() {
  const memoryEvents = useOrchestrationStore((s) => s.memoryEvents);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [memoryEvents.length]);

  if (memoryEvents.length === 0) {
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
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-zinc-700">
        <div className="divide-y divide-zinc-800/50">
          {memoryEvents.map((evt) => (
            <MemoryEventRow key={evt.id} event={evt} />
          ))}
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
