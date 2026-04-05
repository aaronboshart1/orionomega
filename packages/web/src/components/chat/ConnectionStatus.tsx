'use client';

import { Link2, Link2Off, Diamond } from 'lucide-react';
import { useConnectionStore } from '@/stores/connection';

export function ConnectionStatus() {
  const gatewayConnected = useConnectionStore((s) => s.gatewayConnected);
  const hindsightConnected = useConnectionStore((s) => s.hindsightConnected);
  const hindsightBusy = useConnectionStore((s) => s.hindsightBusy);

  const gatewayTitle = gatewayConnected ? 'Gateway: connected' : 'Gateway: disconnected';
  const hindsightTitle = !hindsightConnected
    ? 'Hindsight: offline'
    : hindsightBusy
      ? 'Hindsight: busy'
      : 'Hindsight: idle';

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

      {/* Hindsight / memory status */}
      <div className="flex items-center gap-1" title={hindsightTitle}>
        {hindsightConnected ? (
          <Diamond
            size={11}
            className={
              hindsightBusy
                ? 'animate-hindsight-pulse text-blue-400'
                : 'text-green-400'
            }
            fill="currentColor"
            aria-hidden="true"
          />
        ) : (
          <>
            <Diamond size={11} className="text-red-400/70" fill="currentColor" aria-hidden="true" />
            <span className="hidden md:inline text-[11px] font-medium text-red-400/80" aria-hidden="true">
              MEM
            </span>
          </>
        )}
        <span className="sr-only">{hindsightTitle}</span>
      </div>
    </div>
  );
}
