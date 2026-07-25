'use client';

import { Link2, Link2Off, Diamond } from 'lucide-react';
import { useConnectionStore } from '@/stores/connection';

/** Human-readable label for each memory health state. Never says "offline". */
const MEMORY_LABEL = {
  ready: 'Memory: ready',
  rebuilding: 'Memory: rebuilding index',
  degraded: 'Memory: degraded — recall is limited',
} as const;

export function ConnectionStatus() {
  const gatewayConnected = useConnectionStore((s) => s.gatewayConnected);
  const memory = useConnectionStore((s) => s.memoryActivity);

  const gatewayTitle = gatewayConnected ? 'Gateway: connected' : 'Gateway: disconnected';

  // The memory indicator is always rendered and always describes capability —
  // what memory can do — never whether a socket is open.
  let memoryTitle: string = MEMORY_LABEL[memory.health];
  if (memory.health === 'rebuilding' && memory.pct !== undefined) {
    memoryTitle += ` (${Math.round(memory.pct)}%)`;
  }
  if (memory.reason) memoryTitle += ` [${memory.reason}]`;
  if (memory.busy) memoryTitle += ' — working';

  const memoryColor =
    memory.health === 'ready'
      ? 'text-green-400'
      : memory.health === 'rebuilding'
        ? 'text-amber-400'
        : 'text-red-400';

  return (
    <div className="flex items-center gap-2">
      {/* Gateway status */}
      <div className="flex items-center gap-1.5" title={gatewayTitle}>
        {gatewayConnected ? (
          <Link2 size={14} className="text-green-400" aria-hidden="true" />
        ) : (
          <Link2Off size={14} className="text-red-400" aria-hidden="true" />
        )}
        <span
          className={`hidden md:inline text-[11px] font-medium tabular-nums ${
            gatewayConnected ? 'text-zinc-600' : 'text-red-400'
          }`}
        >
          {gatewayConnected ? 'GW' : 'GW offline'}
        </span>
        <span className="sr-only">{gatewayTitle}</span>
      </div>

      {/* Memory status — always shown, no connectivity gate */}
      <div className="flex items-center gap-1" title={memoryTitle}>
        <Diamond
          size={11}
          className={memory.busy ? 'animate-memory-pulse text-blue-400' : memoryColor}
          fill="currentColor"
          aria-hidden="true"
        />
        {memory.health !== 'ready' && (
          <span
            className={`hidden md:inline text-[11px] font-medium ${
              memory.health === 'rebuilding' ? 'text-amber-400/80' : 'text-red-400/80'
            }`}
            aria-hidden="true"
          >
            {memory.health === 'rebuilding'
              ? memory.pct !== undefined
                ? `MEM ${Math.round(memory.pct)}%`
                : 'MEM'
              : 'MEM'}
          </span>
        )}
        <span className="sr-only">{memoryTitle}</span>
      </div>
    </div>
  );
}
