'use client';

import { Link2, Link2Off, Diamond } from 'lucide-react';
import { useConnectionStore } from '@/stores/connection';

export function ConnectionStatus() {
  const gatewayConnected = useConnectionStore((s) => s.gatewayConnected);
  const hindsightConnected = useConnectionStore((s) => s.hindsightConnected);
  const hindsightBusy = useConnectionStore((s) => s.hindsightBusy);

  return (
    <div className="flex items-center gap-3">
      {gatewayConnected ? (
        <Link2 size={16} className="text-green-400" />
      ) : (
        <Link2Off size={16} className="text-red-400" />
      )}

      <div className="flex items-center gap-1">
        {hindsightConnected ? (
          <Diamond
            size={12}
            className={
              hindsightBusy
                ? 'animate-hindsight-pulse text-blue-400'
                : 'text-green-400'
            }
            fill="currentColor"
          />
        ) : (
          <>
            <Diamond size={12} className="text-red-400" fill="currentColor" />
            <span className="text-[10px] font-medium text-red-400">
              OFFLINE
            </span>
          </>
        )}
      </div>
    </div>
  );
}
