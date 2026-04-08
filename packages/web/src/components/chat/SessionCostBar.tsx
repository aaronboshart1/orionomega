'use client';

import { useChatStore } from '@/stores/chat';
import { useOrchestrationStore } from '@/stores/orchestration';
import { formatTokens, formatCost } from '@/utils/format';
import { useMemo } from 'react';

/**
 * Compact cost/token summary bar combining session-level chat totals
 * with DAG run costs for a complete picture.
 */
export function SessionCostBar() {
  const sessionTotals = useChatStore((s) => s.sessionTotals);
  const inlineDAGs = useOrchestrationStore((s) => s.inlineDAGs);

  const dagTotals = useMemo(() => {
    let cost = 0;
    let input = 0;
    let output = 0;
    let runs = 0;
    for (const dag of Object.values(inlineDAGs)) {
      if (dag.totalCostUsd) cost += dag.totalCostUsd;
      if (dag.modelUsage) {
        for (const m of dag.modelUsage) {
          input += m.inputTokens;
          output += m.outputTokens;
        }
      }
      runs++;
    }
    return { cost, input, output, runs };
  }, [inlineDAGs]);

  const totalInput = sessionTotals.inputTokens + dagTotals.input;
  const totalOutput = sessionTotals.outputTokens + dagTotals.output;
  const totalCost = sessionTotals.totalCostUsd + dagTotals.cost;

  if (totalInput === 0 && totalOutput === 0 && totalCost === 0) return null;

  return (
    <div className="flex items-center gap-2 text-[10px] text-zinc-600 select-none">
      <span title="Total input tokens">
        <span className="text-zinc-500">{formatTokens(totalInput)}</span> in
      </span>
      <span className="text-zinc-700">·</span>
      <span title="Total output tokens">
        <span className="text-zinc-500">{formatTokens(totalOutput)}</span> out
      </span>
      {dagTotals.runs > 0 && (
        <>
          <span className="text-zinc-700">·</span>
          <span title="Completed runs">
            {dagTotals.runs} run{dagTotals.runs !== 1 ? 's' : ''}
          </span>
        </>
      )}
      <span className="ml-2 font-medium text-green-500/70" title="Estimated total cost">
        {formatCost(totalCost)}
      </span>
    </div>
  );
}
