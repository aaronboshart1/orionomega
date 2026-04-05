'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  X, ChevronDown, Copy, Check, Clock, Cpu,
  ArrowRight, ChevronRight, AlertCircle,
} from 'lucide-react';
import { useOrchestrationStore, type WorkerEvent, type WorkerEventType } from '@/stores/orchestration';
import { TabGroup } from '../shared/TabGroup';
import { formatElapsed } from '@/utils/format';

type Tab = 'activity' | 'reasoning' | 'tools' | 'output' | 'info';

/** Classify tool result rendering */
function classifyToolResult(call: WorkerEvent, result?: WorkerEvent): 'code' | 'file' | 'bash' | 'error' | 'json' | 'text' {
  if (result?.error) return 'error';
  const name = call.tool?.name?.toLowerCase() ?? '';
  if (name.includes('bash') || name.includes('shell') || name.includes('exec') || name.includes('terminal')) return 'bash';
  if (name.includes('read') || name.includes('file') || name.includes('glob')) return 'file';
  if (name.includes('code') || name.includes('write') || name.includes('edit')) return 'code';
  if (result?.data && typeof result.data === 'object') return 'json';
  return 'text';
}

/** Detect likely language from file extension for syntax-aware rendering */
function detectLang(filePath?: string): string {
  if (!filePath) return '';
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
    sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', yaml: 'yaml',
    yml: 'yaml', md: 'markdown', css: 'css', html: 'html', sql: 'sql',
  };
  return langMap[ext] || ext;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Fallback for non-secure contexts
    });
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
    </button>
  );
}

function ToolResultContent({ call, result }: { call: WorkerEvent; result?: WorkerEvent }) {
  const [expanded, setExpanded] = useState(false);
  const resultType = classifyToolResult(call, result);

  if (!result) {
    return <p className="text-xs text-zinc-600 italic">Awaiting result...</p>;
  }

  const content = result.message || (result.data ? JSON.stringify(result.data, null, 2) : 'No output');
  const isLong = content.length > 500;
  const displayContent = isLong && !expanded ? content.slice(0, 500) + '...' : content;

  return (
    <div className="space-y-1">
      {/* Result type badge and copy */}
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-medium rounded px-1.5 py-0.5 ${
          resultType === 'error'
            ? 'bg-red-500/10 text-red-400'
            : resultType === 'bash'
              ? 'bg-emerald-500/10 text-emerald-400'
              : resultType === 'file'
                ? 'bg-blue-500/10 text-blue-400'
                : 'bg-zinc-700/50 text-zinc-400'
        }`}>
          {resultType === 'error' ? 'ERROR' : resultType.toUpperCase()}
          {resultType === 'file' && call.tool?.file && (
            <span className="ml-1 text-zinc-500">{call.tool.file}</span>
          )}
        </span>
        <CopyButton text={content} />
      </div>

      {/* File path header for file reads */}
      {resultType === 'file' && call.tool?.file && (
        <div className="flex items-center gap-1 text-[10px] text-zinc-500 font-mono">
          <span>{call.tool.file}</span>
          {detectLang(call.tool.file) && (
            <span className="rounded bg-zinc-800 px-1 py-0.5 text-zinc-600">{detectLang(call.tool.file)}</span>
          )}
        </div>
      )}

      {/* Bash command header */}
      {resultType === 'bash' && call.tool?.summary && (
        <div className="flex items-center gap-1 rounded bg-zinc-800/50 px-2 py-1 text-[10px] font-mono text-emerald-400">
          <span className="text-zinc-600">$</span> {call.tool.summary}
        </div>
      )}

      {/* Content */}
      <pre className={`overflow-x-auto rounded-md border px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all ${
        resultType === 'error'
          ? 'border-red-800/50 bg-red-950/30 text-red-300'
          : 'border-zinc-800 bg-zinc-900/50 text-zinc-400'
      }`}>
        {displayContent}
      </pre>

      {/* Expand/collapse for long results */}
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
        >
          <ChevronRight
            size={10}
            className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
          {expanded ? 'Show less' : `Show all (${content.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

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

  /** Compute node duration from first to last event */
  const nodeDuration = useMemo(() => {
    if (workerEvents.length < 2) return null;
    const first = new Date(workerEvents[0].timestamp).getTime();
    const last = new Date(workerEvents[workerEvents.length - 1].timestamp).getTime();
    const diffSec = (last - first) / 1000;
    return diffSec > 0 ? diffSec : null;
  }, [workerEvents]);

  /** Aggregate token usage from events */
  const totalTokens = useMemo(() => {
    const agg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const ev of workerEvents) {
      if (ev.tokenUsage) {
        agg.input += ev.tokenUsage.input;
        agg.output += ev.tokenUsage.output;
        agg.cacheRead += ev.tokenUsage.cacheRead ?? 0;
        agg.cacheWrite += ev.tokenUsage.cacheWrite ?? 0;
      }
    }
    return agg.input + agg.output > 0 ? agg : null;
  }, [workerEvents]);

  /** Event type counts for summary */
  const eventTypeCounts = useMemo(() => {
    const counts: Partial<Record<WorkerEventType, number>> = {};
    for (const ev of workerEvents) {
      counts[ev.type] = (counts[ev.type] ?? 0) + 1;
    }
    return counts;
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
    { key: 'info', label: 'Info' },
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
            {nodeDuration !== null && (
              <span className="flex items-center gap-0.5 text-[10px] text-zinc-600">
                <Clock size={9} />
                {formatElapsed(nodeDuration)}
              </span>
            )}
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
                <div key={i} className={`flex gap-2 text-zinc-400 ${
                  ev.type === 'error' ? 'text-red-400' : ev.type === 'warning' ? 'text-amber-400' : ''
                }`}>
                  <span className="shrink-0 text-zinc-600">
                    {new Date(ev.timestamp).toLocaleTimeString('en-US', { hour12: false })}
                  </span>
                  <span className={`text-zinc-500 ${
                    ev.type === 'error' ? '!text-red-500' : ev.type === 'tool_call' ? '!text-yellow-500' : ''
                  }`}>[{ev.type}]</span>
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
          <div className="space-y-3">
            {toolPairs.length === 0 ? (
              <p className="text-xs text-zinc-600">No tool calls</p>
            ) : (
              toolPairs.map((pair, i) => (
                <details key={i} className="rounded-lg border border-zinc-800 overflow-hidden">
                  <summary className="cursor-pointer px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800/50 flex items-center gap-2">
                    <ChevronRight size={12} className="shrink-0 text-zinc-600 transition-transform details-open:rotate-90" />
                    <span className="text-yellow-500 font-medium">{pair.call.tool?.name}</span>
                    {pair.call.tool?.action && (
                      <span className="text-zinc-500">.{pair.call.tool.action}</span>
                    )}
                    {pair.call.tool?.file && (
                      <span className="text-zinc-600 text-[10px] truncate max-w-[200px]">{pair.call.tool.file}</span>
                    )}
                    <span className="text-zinc-500 truncate">{pair.call.tool?.summary}</span>
                    {/* Status indicator */}
                    {pair.result ? (
                      pair.result.error ? (
                        <AlertCircle size={11} className="shrink-0 text-red-400 ml-auto" />
                      ) : (
                        <Check size={11} className="shrink-0 text-green-400 ml-auto" />
                      )
                    ) : (
                      <span className="ml-auto shrink-0 h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                    )}
                  </summary>
                  <div className="border-t border-zinc-800 px-3 py-2">
                    <ToolResultContent call={pair.call} result={pair.result} />
                  </div>
                </details>
              ))
            )}
          </div>
        )}

        {activeTab === 'output' && (
          <div className="space-y-2">
            {node.output ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-400">Node Output</span>
                  <CopyButton text={JSON.stringify(node.output, null, 2)} />
                </div>
                <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-400 font-mono">
                  {JSON.stringify(node.output, null, 2)}
                </pre>
              </>
            ) : (
              <p className="text-xs text-zinc-600">No output yet</p>
            )}
          </div>
        )}

        {activeTab === 'info' && (
          <div className="space-y-4 text-xs">
            {/* Node details */}
            <div>
              <h4 className="font-semibold text-zinc-300 mb-2">Node Details</h4>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <span className="text-zinc-500">ID</span>
                <span className="text-zinc-300 font-mono text-[10px]">{node.id}</span>
                <span className="text-zinc-500">Type</span>
                <span className="text-zinc-300">{node.type}</span>
                <span className="text-zinc-500">Status</span>
                <span className={statusColor[node.status] || 'text-zinc-400'}>{node.status.toUpperCase()}</span>
                {node.agent && (
                  <>
                    <span className="text-zinc-500">Model</span>
                    <span className="text-purple-400">{node.agent.model}</span>
                    <span className="text-zinc-500">Task</span>
                    <span className="text-zinc-300">{node.agent.task}</span>
                  </>
                )}
                {nodeDuration !== null && (
                  <>
                    <span className="text-zinc-500">Duration</span>
                    <span className="text-zinc-300 flex items-center gap-1">
                      <Clock size={10} />
                      {formatElapsed(nodeDuration)}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Dependencies */}
            {node.dependsOn.length > 0 && (
              <div>
                <h4 className="font-semibold text-zinc-300 mb-2">Dependencies</h4>
                <div className="space-y-1">
                  {node.dependsOn.map((depId) => {
                    const depNode = graphState?.nodes[depId];
                    return (
                      <button
                        key={depId}
                        type="button"
                        onClick={() => selectWorker(depId)}
                        className="flex items-center gap-2 rounded px-2 py-1 hover:bg-zinc-800/50 transition-colors w-full text-left"
                      >
                        <ArrowRight size={10} className="text-zinc-600" />
                        <span className="text-blue-400 hover:underline">{depNode?.label || depId}</span>
                        {depNode && (
                          <span className={`text-[10px] ${statusColor[depNode.status] || 'text-zinc-500'}`}>
                            {depNode.status}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Token usage */}
            {totalTokens && (
              <div>
                <h4 className="font-semibold text-zinc-300 mb-2 flex items-center gap-1.5">
                  <Cpu size={12} />
                  Token Usage
                </h4>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <span className="text-zinc-500">Input</span>
                  <span className="text-zinc-300">{totalTokens.input.toLocaleString()}</span>
                  <span className="text-zinc-500">Output</span>
                  <span className="text-zinc-300">{totalTokens.output.toLocaleString()}</span>
                  {totalTokens.cacheRead > 0 && (
                    <>
                      <span className="text-zinc-500">Cache Read</span>
                      <span className="text-zinc-400">{totalTokens.cacheRead.toLocaleString()}</span>
                    </>
                  )}
                  {totalTokens.cacheWrite > 0 && (
                    <>
                      <span className="text-zinc-500">Cache Write</span>
                      <span className="text-zinc-400">{totalTokens.cacheWrite.toLocaleString()}</span>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Event summary */}
            <div>
              <h4 className="font-semibold text-zinc-300 mb-2">Event Summary</h4>
              <div className="flex flex-wrap gap-2">
                {Object.entries(eventTypeCounts).map(([type, count]) => (
                  <span
                    key={type}
                    className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400"
                  >
                    {type}: {count}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
          </div>
        </>
      )}
    </div>
  );
}
