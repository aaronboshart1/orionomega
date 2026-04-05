'use client';

import { useState } from 'react';
import { CheckCircle2, XCircle, Circle, FileText, ChevronRight } from 'lucide-react';
import type { InlineDAG, ModelUsageEntry } from '@/stores/orchestration';
import { useOrchestrationStore } from '@/stores/orchestration';
import { useFileViewerStore } from '@/stores/file-viewer';
import { MarkdownContent } from './MarkdownContent';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { formatTokens as fmtTokens, formatElapsed as fmtDuration } from '@/utils/format';

interface RunSummaryCardProps {
  dag: InlineDAG;
}

export function RunSummaryCard({ dag }: RunSummaryCardProps) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const isDone = dag.status === 'complete';
  const isError = dag.status === 'error';
  const isStopped = dag.status === 'stopped';
  const hasModels = dag.modelUsage && dag.modelUsage.length > 0;
  const hasResult = dag.result != null && dag.result.trim().length > 0;

  const totals = hasModels
    ? dag.modelUsage!.reduce(
        (acc, m) => ({
          input: acc.input + m.inputTokens,
          output: acc.output + m.outputTokens,
          cacheR: acc.cacheR + m.cacheReadTokens,
          cacheW: acc.cacheW + m.cacheCreationTokens,
        }),
        { input: 0, output: 0, cacheR: 0, cacheW: 0 },
      )
    : null;

  return (
    <div className={`rounded-xl border px-4 py-3 ${
      isDone
        ? 'border-green-500/20 bg-zinc-800/60'
        : isError
          ? 'border-red-500/20 bg-zinc-800/60'
          : 'border-zinc-500/20 bg-zinc-800/60'
    }`}>
      <div className="flex items-center gap-2 mb-2">
        {isDone && <CheckCircle2 size={14} className="text-green-400" />}
        {isError && <XCircle size={14} className="text-red-400" />}
        {isStopped && <Circle size={14} className="text-zinc-400" />}
        <span className="text-xs font-semibold text-zinc-200">Run Summary</span>
      </div>

      <div className="flex items-center gap-3 text-xs text-zinc-500">
        {dag.durationSec !== undefined && <span>{fmtDuration(dag.durationSec)}</span>}
        {dag.workerCount !== undefined && dag.workerCount > 1 && <span>{dag.workerCount} workers</span>}
        {dag.toolCallCount != null && dag.toolCallCount > 0 && <span>{dag.toolCallCount} tool call{dag.toolCallCount !== 1 ? 's' : ''}</span>}
        {dag.totalCostUsd !== undefined && (
          <span className="font-medium text-green-400">${dag.totalCostUsd.toFixed(4)}</span>
        )}
      </div>

      {hasModels && (
        <div className="mt-1.5 space-y-0.5">
          <div className="grid grid-cols-[1fr_3rem_3rem_3rem_3rem_3.5rem] gap-1 text-xs text-zinc-600">
            <span>Model</span>
            <span className="text-right">Input</span>
            <span className="text-right">Output</span>
            <span className="text-right">Cache R</span>
            <span className="text-right">Cache W</span>
            <span className="text-right">Cost</span>
          </div>
          {dag.modelUsage!.map((m) => (
            <div key={m.model} className="grid grid-cols-[1fr_3rem_3rem_3rem_3rem_3.5rem] gap-1 text-xs">
              <span className="truncate text-purple-400">{m.model}</span>
              <span className="text-right text-zinc-400">{fmtTokens(m.inputTokens)}</span>
              <span className="text-right text-zinc-400">{fmtTokens(m.outputTokens)}</span>
              <span className="text-right text-zinc-500">{fmtTokens(m.cacheReadTokens)}</span>
              <span className="text-right text-zinc-500">{fmtTokens(m.cacheCreationTokens)}</span>
              <span className="text-right text-zinc-300">${m.costUsd.toFixed(4)}</span>
            </div>
          ))}
          {totals && (
            <div className="grid grid-cols-[1fr_3rem_3rem_3rem_3rem_3.5rem] gap-1 border-t border-zinc-700/30 pt-0.5 text-xs font-medium">
              <span className="text-zinc-400">Total</span>
              <span className="text-right text-zinc-300">{fmtTokens(totals.input)}</span>
              <span className="text-right text-zinc-300">{fmtTokens(totals.output)}</span>
              <span className="text-right text-zinc-400">{fmtTokens(totals.cacheR)}</span>
              <span className="text-right text-zinc-400">{fmtTokens(totals.cacheW)}</span>
              <span className="text-right text-green-400">${dag.totalCostUsd?.toFixed(4) ?? '0.0000'}</span>
            </div>
          )}
        </div>
      )}

      {dag.nodeOutputPaths && Object.keys(dag.nodeOutputPaths).length > 0 && (
        <div className="mt-2 border-t border-zinc-700/50 pt-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-400 mb-1">
            <FileText size={10} />
            <span>Artifacts</span>
          </div>
          <div className="space-y-1">
            {Object.entries(dag.nodeOutputPaths).map(([nodeLabel, paths]) => (
              <div key={nodeLabel}>
                <div className="text-xs font-medium text-zinc-300">{nodeLabel}</div>
                {paths.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      useFileViewerStore.getState().openFile(p);
                      useOrchestrationStore.getState().setActiveOrchTab('files');
                      useOrchestrationStore.getState().setOrchPaneOpen(true);
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

      {hasResult && (
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
              <ErrorBoundary><MarkdownContent content={dag.result!} /></ErrorBoundary>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
