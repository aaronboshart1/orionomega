'use client';

import { useMemo, useState } from 'react';
import { FileText, ChevronRight } from 'lucide-react';
import { useOrchestrationStore } from '@/stores/orchestration';
import { useFileViewerStore } from '@/stores/file-viewer';
import type { ModelUsageEntry } from '@/stores/orchestration';
import { MarkdownContent } from '../chat/MarkdownContent';

import { formatElapsed, formatTokens as fmtTokens } from '@/utils/format';

const statusBadge: Record<string, { bg: string; text: string }> = {
  planning: { bg: 'bg-yellow-500/10', text: 'text-yellow-500' },
  planned: { bg: 'bg-yellow-500/10', text: 'text-yellow-500' },
  running: { bg: 'bg-blue-500/10', text: 'text-blue-400' },
  paused: { bg: 'bg-orange-500/10', text: 'text-orange-400' },
  complete: { bg: 'bg-green-500/10', text: 'text-green-400' },
  error: { bg: 'bg-red-500/10', text: 'text-red-400' },
  stopped: { bg: 'bg-zinc-500/10', text: 'text-zinc-400' },
};

function ModelUsageTable({ models, totalCostUsd }: { models: ModelUsageEntry[]; totalCostUsd?: number }) {
  const totals = models.reduce(
    (acc, m) => ({
      input: acc.input + m.inputTokens,
      output: acc.output + m.outputTokens,
      cacheR: acc.cacheR + m.cacheReadTokens,
      cacheW: acc.cacheW + m.cacheCreationTokens,
    }),
    { input: 0, output: 0, cacheR: 0, cacheW: 0 },
  );

  return (
    <div className="mt-2 space-y-0.5 text-xs">
      <div className="grid grid-cols-[1fr_4rem_4rem_4rem_4rem_4.5rem] gap-1 text-zinc-600 font-medium">
        <span>Model</span>
        <span className="text-right">Input</span>
        <span className="text-right">Output</span>
        <span className="text-right">Cache R</span>
        <span className="text-right">Cache W</span>
        <span className="text-right">Cost</span>
      </div>
      <div className="border-t border-zinc-700/50" />
      {models.map((m) => (
        <div key={m.model} className="grid grid-cols-[1fr_4rem_4rem_4rem_4rem_4.5rem] gap-1">
          <span className="truncate text-purple-400">{m.model}</span>
          <span className="text-right text-zinc-400">{fmtTokens(m.inputTokens)}</span>
          <span className="text-right text-zinc-400">{fmtTokens(m.outputTokens)}</span>
          <span className="text-right text-zinc-500">{fmtTokens(m.cacheReadTokens)}</span>
          <span className="text-right text-zinc-500">{fmtTokens(m.cacheCreationTokens)}</span>
          <span className="text-right text-zinc-300">${m.costUsd.toFixed(4)}</span>
        </div>
      ))}
      <div className="border-t border-zinc-700/50" />
      <div className="grid grid-cols-[1fr_4rem_4rem_4rem_4rem_4.5rem] gap-1 font-medium">
        <span className="text-zinc-400">Total</span>
        <span className="text-right text-zinc-300">{fmtTokens(totals.input)}</span>
        <span className="text-right text-zinc-300">{fmtTokens(totals.output)}</span>
        <span className="text-right text-zinc-400">{fmtTokens(totals.cacheR)}</span>
        <span className="text-right text-zinc-400">{fmtTokens(totals.cacheW)}</span>
        <span className="text-right text-green-400">${totalCostUsd?.toFixed(4) ?? '0.0000'}</span>
      </div>
    </div>
  );
}

export function WorkflowSummary() {
  const graphState = useOrchestrationStore((s) => s.graphState);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);
  const activeWorkflowId = useOrchestrationStore((s) => s.activeWorkflowId);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const completedDAG = useMemo(() => {
    const dagId = activeWorkflowId;
    if (dagId) {
      const dag = inlineDAGs[dagId];
      if (dag && (dag.status === 'complete' || dag.status === 'error' || dag.status === 'stopped')) {
        return dag;
      }
    }
    return undefined;
  }, [inlineDAGs, activeWorkflowId]);

  const stats = useMemo(() => {
    if (!graphState) return null;
    const nodes = Object.values(graphState.nodes);
    return {
      running: nodes.filter((n) => n.status === 'running').length,
      done: nodes.filter((n) => n.status === 'done').length,
      pending: nodes.filter((n) => n.status === 'pending' || n.status === 'waiting').length,
      error: nodes.filter((n) => n.status === 'error').length,
      total: nodes.length,
    };
  }, [graphState]);

  if (!graphState && !completedDAG) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        No active workflow
      </div>
    );
  }

  const isGraphTerminal = !graphState || graphState.status === 'complete' || graphState.status === 'error' || graphState.status === 'stopped';
  if (completedDAG && isGraphTerminal) {
    const hasDetailedStats = !!(completedDAG.modelUsage || completedDAG.totalCostUsd !== undefined || (completedDAG.result && completedDAG.result.trim().length > 0) || (completedDAG.nodeOutputPaths && Object.keys(completedDAG.nodeOutputPaths).length > 0));
    const badge = statusBadge[completedDAG.status] || statusBadge.complete;
    return (
      <div className="h-full overflow-y-auto px-6 py-3">
        <div className="flex items-center gap-3 mb-0.5">
          <h3 className="text-sm font-semibold text-zinc-200">Run Summary</h3>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.bg} ${badge.text}`}>
            {completedDAG.status.toUpperCase()}
          </span>
          {completedDAG.durationSec !== undefined && (
            <span className="text-xs text-zinc-500">⏱ {formatElapsed(completedDAG.durationSec)}</span>
          )}
          {completedDAG.workerCount !== undefined && (
            <span className="text-xs text-zinc-500">{completedDAG.workerCount} worker{completedDAG.workerCount !== 1 ? 's' : ''}</span>
          )}
          {completedDAG.totalCostUsd !== undefined && (
            <span className="text-xs font-medium text-green-400">${completedDAG.totalCostUsd.toFixed(4)}</span>
          )}
        </div>
        <div className="text-[10px] font-mono text-zinc-600 mb-2">{completedDAG.dagId}</div>
        {!hasDetailedStats && (
          <div className="mt-2 text-xs text-zinc-500">
            Run completed{completedDAG.status === 'error' ? ' with errors' : completedDAG.status === 'stopped' ? ' (stopped)' : ''}.
            {completedDAG.nodes.length > 0 && ` ${completedDAG.nodes.length} node${completedDAG.nodes.length !== 1 ? 's' : ''} executed.`}
          </div>
        )}
        {completedDAG.modelUsage && completedDAG.modelUsage.length > 0 && (
          <ModelUsageTable models={completedDAG.modelUsage} totalCostUsd={completedDAG.totalCostUsd} />
        )}

        {completedDAG.nodeOutputPaths && Object.keys(completedDAG.nodeOutputPaths).length > 0 && (
          <div className="mt-2 border-t border-zinc-700/50 pt-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-400 mb-1">
              <FileText size={10} />
              <span>Artifacts</span>
            </div>
            <div className="space-y-1">
              {Object.entries(completedDAG.nodeOutputPaths).map(([nodeLabel, paths]) => (
                <div key={nodeLabel}>
                  <div className="text-xs font-medium text-zinc-300">{nodeLabel}</div>
                  {paths.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        useFileViewerStore.getState().openFile(p);
                        useOrchestrationStore.getState().setActiveOrchTab('files');
                      }}
                      className="ml-3 text-xs text-blue-400/80 hover:text-blue-300 hover:underline cursor-pointer text-left block w-full break-all"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {completedDAG.result != null && completedDAG.result.trim().length > 0 && (
          <div className="mt-2 border-t border-zinc-700/50 pt-2">
            <button
              type="button"
              aria-expanded={summaryOpen}
              onClick={() => setSummaryOpen((o) => !o)}
              className="flex w-full items-center gap-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-300 transition-colors"
            >
              <ChevronRight
                size={10}
                className={`transition-transform duration-200 ${summaryOpen ? 'rotate-90' : ''}`}
              />
              <span>Summary</span>
            </button>
            <div
              className={`overflow-hidden transition-all duration-200 ease-in-out ${
                summaryOpen ? 'max-h-[2000px] opacity-100 mt-1.5' : 'max-h-0 opacity-0'
              }`}
            >
              <div className="text-xs text-zinc-300">
                <MarkdownContent content={completedDAG.result} />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!graphState || !stats) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
        No active workflow
      </div>
    );
  }

  const badge = statusBadge[graphState.status] || statusBadge.running;
  const progressPct =
    stats.total > 0 ? Math.round(((stats.done + stats.error) / stats.total) * 100) : 0;

  return (
    <div className="flex h-full items-center gap-6 px-6">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-zinc-200">{graphState.name}</h3>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.bg} ${badge.text}`}>
            {graphState.status.toUpperCase()}
          </span>
        </div>
        <span className="text-[10px] font-mono text-zinc-600">{graphState.workflowId}</span>
      </div>

      <div className="h-6 w-px bg-zinc-800" />

      <div className="text-xs text-zinc-400">
        <span className="text-zinc-200">{graphState.completedLayers}</span>
        <span className="text-zinc-600">/</span>
        <span>{graphState.totalLayers}</span>
        <span className="ml-1 text-zinc-600">layers</span>
      </div>

      <div className="flex items-center gap-3 text-xs">
        {stats.running > 0 && (
          <span className="text-blue-400">
            {stats.running} running
          </span>
        )}
        {stats.done > 0 && (
          <span className="text-green-400">
            {stats.done} done
          </span>
        )}
        {stats.pending > 0 && (
          <span className="text-zinc-500">
            {stats.pending} pending
          </span>
        )}
        {stats.error > 0 && (
          <span className="text-red-400">
            {stats.error} error
          </span>
        )}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-3">
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-blue-500 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <span className="text-xs text-zinc-500">{progressPct}%</span>
      </div>

      <span className="text-xs text-zinc-500">
        ⏱ {formatElapsed(graphState.elapsed)}
      </span>
    </div>
  );
}
