'use client';

import { useEffect, useState } from 'react';
import { Wifi, WifiOff, RefreshCw, Clock, Users, Layers, DollarSign, Cpu, BrainCircuit } from 'lucide-react';
import { useOrchestrationStore } from '@/stores/orchestration';

function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

function fmtCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function StatusBar() {
  const connectionStatus = useOrchestrationStore((s) => s.connectionStatus);
  const metrics = useOrchestrationStore((s) => s.sessionMetrics);
  const runStartTime = useOrchestrationStore((s) => s.runStartTime);
  const hindsight = useOrchestrationStore((s) => s.hindsight);
  const [liveElapsed, setLiveElapsed] = useState(0);

  useEffect(() => {
    if (!runStartTime) {
      setLiveElapsed(0);
      return;
    }
    const tick = () => setLiveElapsed(Math.floor((Date.now() - runStartTime) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [runStartTime]);

  const elapsed = runStartTime ? liveElapsed : metrics.elapsed;
  const isRunning = runStartTime !== null;
  const showElapsed = elapsed > 0;

  return (
    <div className="flex items-center gap-3 border-t border-zinc-800 bg-zinc-900/80 px-4 py-1.5 text-[11px] text-zinc-500">
      <div className="flex items-center gap-1.5">
        {connectionStatus === 'connected' && (
          <>
            <Wifi size={10} className="text-green-400" />
            <span className="text-green-400">Connected</span>
          </>
        )}
        {connectionStatus === 'reconnecting' && (
          <>
            <RefreshCw size={10} className="animate-spin text-yellow-400" />
            <span className="text-yellow-400">Reconnecting</span>
          </>
        )}
        {connectionStatus === 'disconnected' && (
          <>
            <WifiOff size={10} className="text-red-400" />
            <span className="text-red-400">Disconnected</span>
          </>
        )}
      </div>

      <span className="text-zinc-700">|</span>

      {hindsight.connected !== null && (
        <>
          <div className="flex items-center gap-1">
            <BrainCircuit
              size={10}
              className={hindsight.connected ? (hindsight.busy ? 'animate-pulse text-blue-400' : 'text-green-400') : 'text-red-400'}
            />
            <span className={hindsight.connected ? 'text-zinc-400' : 'text-red-400'}>
              {hindsight.connected ? (hindsight.busy ? 'Hindsight…' : 'Hindsight') : 'Hindsight OFF'}
            </span>
          </div>
          <span className="text-zinc-700">|</span>
        </>
      )}

      {metrics.model && (
        <>
          <div className="flex items-center gap-1">
            <Cpu size={10} className="text-purple-400" />
            <span className="text-zinc-400">{metrics.model}</span>
          </div>
          <span className="text-zinc-700">|</span>
        </>
      )}

      {metrics.totalLayers > 0 && (
        <>
          <div className="flex items-center gap-1">
            <Layers size={10} className="text-blue-400" />
            <span className="text-blue-400">
              Layer {metrics.completedLayers}/{metrics.totalLayers}
            </span>
          </div>
          <span className="text-zinc-700">|</span>
        </>
      )}

      {metrics.totalNodes > 0 && (
        <>
          <span className="text-zinc-400">
            {metrics.completedNodes}/{metrics.totalNodes} nodes
          </span>
          <span className="text-zinc-700">|</span>
        </>
      )}

      {metrics.activeWorkers > 0 && (
        <>
          <div className="flex items-center gap-1">
            <Users size={10} className="text-blue-400" />
            <span className="text-blue-400">{metrics.activeWorkers} active</span>
          </div>
          <span className="text-zinc-700">|</span>
        </>
      )}

      {showElapsed && (
        <>
          <div className="flex items-center gap-1">
            <Clock size={10} className={isRunning ? 'text-blue-400' : ''} />
            <span className={isRunning ? 'text-blue-400' : ''}>{fmtDuration(elapsed)}</span>
          </div>
          <span className="text-zinc-700">|</span>
        </>
      )}

      <div className="flex items-center gap-1">
        <DollarSign size={10} />
        <span className={metrics.sessionCostUsd >= 10 ? 'text-red-400' : 'text-zinc-400'}>
          {fmtCost(metrics.sessionCostUsd)}
        </span>
      </div>
    </div>
  );
}
