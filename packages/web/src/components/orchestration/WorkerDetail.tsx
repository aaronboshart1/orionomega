'use client';

import { useState, useMemo } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { useOrchestrationStore, type WorkerEvent } from '@/stores/orchestration';
import { TabGroup } from '../shared/TabGroup';

type Tab = 'activity' | 'reasoning' | 'tools' | 'output';

export function WorkerDetail() {
  const selectedWorker = useOrchestrationStore((s) => s.selectedWorker);
  const graphState = useOrchestrationStore((s) => s.graphState);
  const events = useOrchestrationStore((s) => s.events);
  const selectWorker = useOrchestrationStore((s) => s.selectWorker);
  const collapsed = useOrchestrationStore((s) => s.activitySectionCollapsed);
  const toggleCollapsed = useOrchestrationStore((s) => s.toggleActivitySectionCollapsed);
  const [activeTab, setActiveTab] = useState<Tab>('activity');

  const activeWorkflowId = useOrchestrationStore((s) => s.activeWorkflowId);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);

  const node = selectedWorker && graphState ? graphState.nodes[selectedWorker] : null;

  const workflowLabel = activeWorkflowId
    ? inlineDAGs[activeWorkflowId]?.summary || graphState?.name || activeWorkflowId.slice(0, 8)
    : null;

  const workerEvents = useMemo(
    () => events.filter((e) => e.workerId === selectedWorker),
    [events, selectedWorker],
  );

  const thinkingContent = useMemo(
    () =>
      workerEvents
        .filter((e) => e.type === 'thinking' && e.thinking)
        .map((e) => e.thinking)
        .join('\n'),
    [workerEvents],
  );

  const toolPairs = useMemo(() => {
    const pairs: { call: WorkerEvent; result?: WorkerEvent }[] = [];
    let lastCall: WorkerEvent | null = null;
    for (const ev of workerEvents) {
      if (ev.type === 'tool_call') {
        if (lastCall) pairs.push({ call: lastCall });
        lastCall = ev;
      } else if (ev.type === 'tool_result' && lastCall) {
        pairs.push({ call: lastCall, result: ev });
        lastCall = null;
      }
    }
    if (lastCall) pairs.push({ call: lastCall });
    return pairs;
  }, [workerEvents]);

  if (!node) return null;

  const statusColor: Record<string, string> = {
    pending: 'text-zinc-400',
    running: 'text-blue-400',
    done: 'text-green-400',
    error: 'text-red-400',
    skipped: 'text-zinc-600',
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'activity', label: 'Activity' },
    { key: 'reasoning', label: 'Reasoning' },
    { key: 'tools', label: `Tools (${toolPairs.length})` },
    { key: 'output', label: 'Output' },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center border-b border-zinc-800 shrink-0">
        <button
          onClick={toggleCollapsed}
          className="flex flex-1 items-center gap-2 px-4 py-2 cursor-pointer hover:bg-zinc-800/30 transition-colors"
        >
          <ChevronDown
            size={14}
            className={`text-zinc-500 transition-transform duration-300 ${collapsed ? '-rotate-90' : 'rotate-0'}`}
          />
          <div className="flex items-center gap-3 min-w-0">
            {workflowLabel && (
              <span className="flex items-center gap-1 text-[10px] text-zinc-500 shrink-0">
                <span className="max-w-[100px] truncate">{workflowLabel}</span>
                <span>/</span>
              </span>
            )}
            <h3 className="text-xs font-semibold text-zinc-200 truncate">{node.label}</h3>
            {node.agent && (
              <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400">
                {node.agent.model}
              </span>
            )}
            <span className={`text-xs font-medium ${statusColor[node.status] || 'text-zinc-400'}`}>
              {node.status.toUpperCase()}
            </span>
          </div>
        </button>
        <button
          onClick={() => selectWorker(null)}
          className="rounded p-1 mr-3 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <X size={14} />
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Tabs */}
          <div className="border-b border-zinc-800">
            <TabGroup
              tabs={tabs}
              active={activeTab}
              onSelect={setActiveTab}
              variant="underline"
            />
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'activity' && (
          <div className="space-y-1 font-mono text-xs">
            {workerEvents.length === 0 ? (
              <p className="text-zinc-600">No events yet</p>
            ) : (
              workerEvents.map((ev, i) => (
                <div key={i} className="flex gap-2 text-zinc-400">
                  <span className="shrink-0 text-zinc-600">
                    {new Date(ev.timestamp).toLocaleTimeString('en-US', { hour12: false })}
                  </span>
                  <span className="text-zinc-500">[{ev.type}]</span>
                  <span className="truncate">{ev.message || ev.tool?.summary || ev.thinking?.slice(0, 60) || ''}</span>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'reasoning' && (
          <div className="whitespace-pre-wrap text-xs italic text-zinc-400">
            {thinkingContent || 'No reasoning content captured'}
          </div>
        )}

        {activeTab === 'tools' && (
          <div className="space-y-2">
            {toolPairs.length === 0 ? (
              <p className="text-xs text-zinc-600">No tool calls</p>
            ) : (
              toolPairs.map((pair, i) => (
                <details key={i} className="rounded-lg border border-zinc-800">
                  <summary className="cursor-pointer px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800/50">
                    <span className="text-yellow-500">{pair.call.tool?.name}</span>
                    {pair.call.tool?.action && (
                      <span className="text-zinc-500"> .{pair.call.tool.action}</span>
                    )}
                    {' — '}
                    <span className="text-zinc-400">{pair.call.tool?.summary}</span>
                  </summary>
                  <div className="border-t border-zinc-800 px-3 py-2">
                    {pair.result ? (
                      <pre className="overflow-x-auto text-xs text-zinc-500">
                        {pair.result.message || JSON.stringify(pair.result.data, null, 2)}
                      </pre>
                    ) : (
                      <p className="text-xs text-zinc-600">Awaiting result…</p>
                    )}
                  </div>
                </details>
              ))
            )}
          </div>
        )}

        {activeTab === 'output' && (
          <pre className="overflow-x-auto text-xs text-zinc-400">
            {node.output ? JSON.stringify(node.output, null, 2) : 'No output yet'}
          </pre>
        )}
          </div>
        </>
      )}
    </div>
  );
}
