'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Loader2,
  CheckCircle,
  AlertCircle,
  XCircle,
  Power,
  RotateCw,
  Play,
  Wifi,
  WifiOff,
  Clock,
  Activity,
  Server,
} from 'lucide-react';

interface GatewayStatus {
  gateway: { status: string; version: string; uptime: number };
  sessions: { total: number; active: number };
  hindsight: { connected: boolean; url: string };
  workflows: { active: number };
  systemHealth: string;
}

type ActionState = 'idle' | 'stopping' | 'restarting' | 'starting' | 'polling';

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'ok'
      ? 'bg-green-500/20 text-green-400 border-green-500/30'
      : status === 'degraded'
        ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
        : 'bg-red-500/20 text-red-400 border-red-500/30';
  const label = status === 'ok' ? 'Healthy' : status === 'degraded' ? 'Degraded' : 'Unreachable';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === 'ok' ? 'bg-green-400' : status === 'degraded' ? 'bg-amber-400' : 'bg-red-400'}`} />
      {label}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, sub }: { icon: typeof Server; label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="flex items-center gap-2 text-zinc-500 text-xs mb-1">
        <Icon size={12} />
        <span>{label}</span>
      </div>
      <div className="text-sm text-zinc-200 font-medium">{value}</div>
      {sub && <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export function GatewayTab() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/gateway/api/status', { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = await res.json();
      if (mountedRef.current) {
        setStatus(data);
        setReachable(true);
        setError(null);
      }
    } catch {
      if (mountedRef.current) {
        setStatus(null);
        setReachable(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, 5000);
    return () => {
      mountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [fetchStatus]);

  const pollForReconnection = useCallback((attempts = 0) => {
    if (!mountedRef.current || attempts > 30) {
      setActionState('idle');
      setError('Gateway did not come back online in time.');
      return;
    }
    pollTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/gateway/api/health', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          await fetchStatus();
          if (mountedRef.current) {
            setActionState('idle');
            setError(null);
          }
          return;
        }
      } catch {}
      pollForReconnection(attempts + 1);
    }, 2000);
  }, [fetchStatus]);

  const handleStop = async () => {
    setActionState('stopping');
    setError(null);
    try {
      const res = await fetch('/api/gateway/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((body as { error?: string }).error || `Stop failed (${res.status})`);
      }
      if (mountedRef.current) {
        setStatus(null);
        setReachable(false);
        setActionState('idle');
      }
    } catch (err) {
      if (mountedRef.current) {
        const isNetworkError = err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError');
        if (isNetworkError) {
          setStatus(null);
          setReachable(false);
          setActionState('idle');
        } else {
          setError(err instanceof Error ? err.message : 'Failed to stop gateway');
          setActionState('idle');
        }
      }
    }
  };

  const handleRestart = async () => {
    setActionState('restarting');
    setError(null);
    try {
      const res = await fetch('/api/gateway/api/restart', { method: 'POST', signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((body as { error?: string }).error || `Restart failed (${res.status})`);
      }
    } catch (err) {
      const isNetworkError = err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError');
      if (!isNetworkError && mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to restart gateway');
        setActionState('idle');
        return;
      }
    }
    if (mountedRef.current) {
      setActionState('polling');
      setStatus(null);
      setReachable(false);
      pollForReconnection();
    }
  };

  const handleStart = async () => {
    setActionState('starting');
    setError(null);
    try {
      const res = await fetch('/api/gateway/api/health', { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        await fetchStatus();
        if (mountedRef.current) {
          setActionState('idle');
        }
        return;
      }
    } catch {}
    if (mountedRef.current) {
      setActionState('polling');
      pollForReconnection();
    }
  };

  const busy = actionState !== 'idle';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">Gateway Status</h3>
        <StatusBadge status={reachable === false ? 'unreachable' : status?.systemHealth ?? 'ok'} />
      </div>

      {actionState === 'polling' && (
        <div className="flex items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-400">
          <Loader2 size={14} className="animate-spin" />
          <span>Waiting for gateway to come back online…</span>
        </div>
      )}

      {actionState === 'stopping' && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <Loader2 size={14} className="animate-spin" />
          <span>Stopping gateway…</span>
        </div>
      )}

      {actionState === 'restarting' && (
        <div className="flex items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-400">
          <Loader2 size={14} className="animate-spin" />
          <span>Restarting gateway…</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <XCircle size={14} />
          <span>{error}</span>
        </div>
      )}

      {reachable && status ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              icon={Server}
              label="Version"
              value={status.gateway.version}
            />
            <StatCard
              icon={Clock}
              label="Uptime"
              value={formatUptime(status.gateway.uptime)}
            />
            <StatCard
              icon={Activity}
              label="System Health"
              value={status.systemHealth === 'ok' ? 'Healthy' : 'Degraded'}
            />
            <StatCard
              icon={status.hindsight.connected ? Wifi : WifiOff}
              label="Hindsight"
              value={status.hindsight.connected ? 'Connected' : 'Disconnected'}
              sub={status.hindsight.url}
            />
            <StatCard
              icon={Server}
              label="Active Sessions"
              value={`${status.sessions.active} / ${status.sessions.total}`}
            />
            <StatCard
              icon={Activity}
              label="Active Workflows"
              value={String(status.workflows.active)}
            />
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={handleStop}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Power size={12} />
              Stop
            </button>
            <button
              onClick={handleRestart}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RotateCw size={12} />
              Restart
            </button>
          </div>
        </>
      ) : reachable === false && actionState === 'idle' ? (
        <div className="flex flex-col items-center justify-center gap-4 py-8">
          <div className="flex flex-col items-center gap-2">
            <XCircle size={32} className="text-zinc-600" />
            <p className="text-sm text-zinc-400">Gateway is unreachable</p>
            <p className="text-xs text-zinc-500">The gateway may be stopped or the connection may be down. Start it via the CLI or systemd, then click below to reconnect.</p>
          </div>
          <button
            onClick={handleStart}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md border border-green-500/30 bg-green-500/10 px-4 py-2 text-xs font-medium text-green-400 transition-colors hover:bg-green-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Polls for the gateway to come back online after being started externally"
          >
            <Play size={12} />
            Reconnect
          </button>
        </div>
      ) : reachable === null ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={20} className="animate-spin text-zinc-500" />
          <span className="ml-2 text-xs text-zinc-500">Checking gateway status…</span>
        </div>
      ) : null}

      <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-500 leading-relaxed">
        The gateway manages agent sessions, WebSocket connections, and API routing.
        Use the controls above to stop, restart, or start the gateway service.
        Configuration changes (port, bind address) are available in the <span className="text-zinc-400">OmegaClaw</span> tab.
      </div>
    </div>
  );
}
