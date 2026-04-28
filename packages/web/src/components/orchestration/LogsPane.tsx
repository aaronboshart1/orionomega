'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import {
  RefreshCw,
  Download,
  Play,
  Pause,
  Search,
  AlertTriangle,
  XCircle,
  Info,
  Eye,
  Bug,
  FileText,
  X,
} from 'lucide-react';
import {
  fetchLogsMeta,
  fetchLogsTail,
  openLogsStream,
  getLogsDownloadUrl,
  type LogLevel,
  type ParsedLogLine,
  type LogsMeta,
  type LogsStreamHandle,
} from '@/lib/gateway';

const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'verbose', 'debug'];
const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, verbose: 3, debug: 4 };

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'text-red-400 bg-red-500/10 border-red-500/30',
  warn: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  info: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  verbose: 'text-violet-400 bg-violet-500/10 border-violet-500/30',
  debug: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30',
};

const LEVEL_ICON: Record<LogLevel, React.ReactNode> = {
  error: <XCircle size={10} aria-hidden />,
  warn: <AlertTriangle size={10} aria-hidden />,
  info: <Info size={10} aria-hidden />,
  verbose: <Eye size={10} aria-hidden />,
  debug: <Bug size={10} aria-hidden />,
};

const MAX_BUFFER_LINES = 50_000;
const INITIAL_TAIL_LINES = 1_000;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso.slice(11, 19);
  }
}

function LogRow({ line }: { line: ParsedLogLine }) {
  const [expanded, setExpanded] = useState(false);
  const hasData = line.data && Object.keys(line.data).length > 0;
  const colorCls = LEVEL_COLOR[line.level];

  return (
    <div
      className={`border-b border-zinc-800/40 px-2 py-1 text-xs font-mono hover:bg-zinc-800/30 ${
        line.level === 'error' ? 'bg-red-500/5' : line.level === 'warn' ? 'bg-amber-500/5' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-zinc-600 tabular-nums" title={line.ts}>
          {formatTime(line.ts)}
        </span>
        <span
          className={`shrink-0 inline-flex items-center gap-1 rounded border px-1 text-[9px] uppercase tracking-wider font-semibold ${colorCls}`}
          title={`Level: ${line.level}`}
        >
          {LEVEL_ICON[line.level]}
          {line.level}
        </span>
        {line.name && (
          <span className="shrink-0 text-zinc-500 truncate max-w-[140px]" title={line.name}>
            [{line.name}]
          </span>
        )}
        <span className="min-w-0 flex-1 break-words text-zinc-300 whitespace-pre-wrap">
          {line.msg}
        </span>
        {hasData && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 text-[10px] text-zinc-500 hover:text-zinc-300 underline-offset-2 hover:underline"
            title={expanded ? 'Hide data' : 'Show data'}
          >
            {expanded ? 'hide data' : 'data'}
          </button>
        )}
      </div>
      {expanded && hasData && (
        <pre className="mt-1 ml-[60px] rounded border border-zinc-700/40 bg-zinc-900/60 p-2 text-[10px] text-zinc-400 whitespace-pre-wrap break-words">
          {JSON.stringify(line.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function LogsPane() {
  const [meta, setMeta] = useState<LogsMeta | null>(null);
  const [lines, setLines] = useState<ParsedLogLine[]>([]);
  const [serverLevel, setServerLevel] = useState<LogLevel>('info');
  const [filterLevel, setFilterLevel] = useState<LogLevel | null>(null);
  const [search, setSearch] = useState('');
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<'idle' | 'connecting' | 'open' | 'reconnecting' | 'error'>('idle');
  const [truncated, setTruncated] = useState(false);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const atBottomRef = useRef(true);
  const streamHandleRef = useRef<LogsStreamHandle | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const cursorRef = useRef(0);

  const effectiveLevel: LogLevel = filterLevel ?? serverLevel;

  const loadAll = useCallback(async (explicitLevel?: LogLevel) => {
    if (fetchAbortRef.current) fetchAbortRef.current.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      let levelForTail = explicitLevel;
      if (!levelForTail) {
        const m = await fetchLogsMeta(controller.signal);
        setMeta(m);
        setServerLevel(m.level);
        setFilterLevel((prev) => prev ?? m.level);
        levelForTail = m.level;
      }
      const t = await fetchLogsTail({
        lines: INITIAL_TAIL_LINES,
        level: levelForTail,
        signal: controller.signal,
      });
      setLines(t.lines);
      cursorRef.current = t.nextCursor;
      setTruncated(t.truncated);
      if (explicitLevel) {
        const m = await fetchLogsMeta(controller.signal);
        setMeta(m);
        setServerLevel(m.level);
      }
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setError(`Failed to load logs: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
    return () => {
      fetchAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeStream = useCallback(() => {
    if (streamHandleRef.current) {
      streamHandleRef.current.close();
      streamHandleRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!live) {
      closeStream();
      setStreamState('idle');
      return;
    }
    const handle = openLogsStream({
      offset: cursorRef.current,
      level: effectiveLevel,
      handlers: {
        onState: (s) => setStreamState(s === 'closed' ? 'idle' : s),
        onLine: (line) => {
          setLines((prev) => {
            const next = prev.length >= MAX_BUFFER_LINES
              ? [...prev.slice(prev.length - MAX_BUFFER_LINES + 1), line]
              : [...prev, line];
            return next;
          });
        },
        onCursor: (c) => { cursorRef.current = c; },
        onRotated: () => {
          cursorRef.current = 0;
          setLines((prev) => [...prev, {
            ts: new Date().toISOString(),
            level: 'warn',
            name: 'logs',
            msg: '— log file rotated/truncated —',
            raw: '— log file rotated/truncated —',
          }]);
        },
        onError: (e) => {
          setError((prev) => prev ?? `Live-tail error: ${e.message} (auto-reconnecting…)`);
        },
      },
    });
    streamHandleRef.current = handle;
    return () => {
      handle.close();
      streamHandleRef.current = null;
    };
  }, [live, effectiveLevel, closeStream]);

  useEffect(() => {
    if (!live) return;
    if (!atBottomRef.current) return;
    const idx = lines.length - 1;
    if (idx < 0) return;
    virtuosoRef.current?.scrollToIndex({ index: idx, align: 'end', behavior: 'auto' });
  }, [lines, live]);

  // Client-side re-filter (instant for stricter dropdown choices and search).
  const filteredLines = useMemo(() => {
    const q = search.trim().toLowerCase();
    const minOrder = LEVEL_ORDER[effectiveLevel];
    return lines.filter((l) => {
      if (LEVEL_ORDER[l.level] > minOrder) return false;
      if (q && !l.raw.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [lines, effectiveLevel, search]);

  const hiddenCount = lines.length - filteredLines.length;

  const handleDownload = useCallback(() => {
    const a = document.createElement('a');
    a.href = getLogsDownloadUrl();
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const handleRefresh = useCallback(() => {
    atBottomRef.current = true;
    void loadAll(effectiveLevel);
  }, [loadAll, effectiveLevel]);

  const handleLevelChange = useCallback((next: LogLevel) => {
    // Client-side re-filter only; user can hit Refresh to widen the buffer.
    setFilterLevel(next);
  }, []);

  if (meta && !meta.exists && !loading) {
    return (
      <div className="flex h-full flex-col">
        <Header
          meta={meta}
          live={live}
          onToggleLive={() => setLive((v) => !v)}
          onRefresh={handleRefresh}
          onDownload={handleDownload}
          downloadDisabled
          loading={loading}
          streamState={streamState}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <FileText size={32} className="text-zinc-700" />
          <div className="text-sm text-zinc-400">No log file yet</div>
          <div className="max-w-md text-xs text-zinc-600">
            The gateway hasn&apos;t written to <span className="font-mono text-zinc-500">{meta.filePath}</span> yet.
            Once it logs a startup event the file will appear here. To verify your
            logging configuration, run{' '}
            <span className="font-mono text-zinc-500">orionomega doctor</span> from a terminal on the host.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Header
        meta={meta}
        live={live}
        onToggleLive={() => setLive((v) => !v)}
        onRefresh={handleRefresh}
        onDownload={handleDownload}
        downloadDisabled={!meta?.exists}
        loading={loading}
        streamState={streamState}
      />

      {/* Filter bar */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <div className="relative flex-1">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter lines (case-insensitive)…"
            className="w-full rounded bg-zinc-800/60 border border-zinc-700/50 pl-7 pr-7 py-1 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-blue-500/50"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300"
              aria-label="Clear search"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <label className="flex items-center gap-1 text-[10px] text-zinc-500">
          Min level
          <select
            value={effectiveLevel}
            onChange={(e) => handleLevelChange(e.target.value as LogLevel)}
            className="rounded bg-zinc-800 border border-zinc-700 px-1.5 py-1 text-xs text-zinc-300 outline-none focus:border-blue-500/50"
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
        {hiddenCount > 0 && (
          <span className="text-[10px] text-zinc-600">{hiddenCount} hidden</span>
        )}
      </div>

      {/* Status banner — errors, truncation, buffer-cap notices. */}
      {(error || truncated || lines.length >= MAX_BUFFER_LINES) && (
        <div className="border-b border-zinc-800 px-3 py-1 text-[10px]">
          {error && (
            <div className="flex items-center gap-1.5 text-red-400">
              <XCircle size={10} /> {error}
              <button
                type="button"
                onClick={() => setError(null)}
                className="ml-auto text-zinc-500 hover:text-zinc-300"
                aria-label="Dismiss error"
              >
                <X size={11} />
              </button>
            </div>
          )}
          {truncated && !error && (
            <div className="text-amber-500">
              Showing the most recent ~2 MB of the log. Use Download for the full file.
            </div>
          )}
          {lines.length >= MAX_BUFFER_LINES && !error && (
            <div className="text-zinc-500">
              In-memory buffer at {MAX_BUFFER_LINES.toLocaleString()} lines — older lines
              are being dropped. Use Refresh or Download to see the full file.
            </div>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 bg-[var(--background)]">
        {filteredLines.length === 0 && !loading ? (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            {lines.length === 0 ? 'No log entries yet.' : 'No lines match the current filter.'}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={filteredLines}
            itemContent={(_idx, line) => <LogRow line={line} />}
            initialTopMostItemIndex={filteredLines.length > 0 ? filteredLines.length - 1 : 0}
            followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
            atBottomStateChange={(b) => { atBottomRef.current = b; }}
            atBottomThreshold={50}
            overscan={400}
            className="h-full"
            style={{ height: '100%', overscrollBehavior: 'none' }}
          />
        )}
      </div>
    </div>
  );
}

function Header({
  meta,
  live,
  onToggleLive,
  onRefresh,
  onDownload,
  downloadDisabled,
  loading,
  streamState,
}: {
  meta: LogsMeta | null;
  live: boolean;
  onToggleLive: () => void;
  onRefresh: () => void;
  onDownload: () => void;
  downloadDisabled?: boolean;
  loading: boolean;
  streamState: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'error';
}) {
  const liveDot =
    streamState === 'open' ? 'bg-green-500 animate-pulse' :
    streamState === 'connecting' || streamState === 'reconnecting' ? 'bg-yellow-500 animate-pulse' :
    streamState === 'error' ? 'bg-red-500' :
    'bg-zinc-600';

  return (
    <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 bg-zinc-900/40">
      <FileText size={12} className="text-zinc-500" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-zinc-300 font-mono" title={meta?.filePath ?? ''}>
          {meta?.filePath ?? 'Loading…'}
        </div>
        <div className="text-[10px] text-zinc-600">
          Level: <span className="text-zinc-400">{meta?.level ?? '—'}</span>
          {' · '}
          <button
            type="button"
            onClick={() => {
              try {
                window.dispatchEvent(new CustomEvent('orionomega:open-settings'));
              } catch { /* ignore */ }
            }}
            className="text-zinc-500 hover:text-zinc-300 underline-offset-2 hover:underline"
            title="Open Settings to change the configured logging level"
          >
            change in Settings
          </button>
          {meta?.exists && (
            <>
              {' · '}Size: <span className="text-zinc-400">{formatBytes(meta.sizeBytes)}</span>
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onToggleLive}
        className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors ${
          live
            ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
            : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
        }`}
        title={live ? 'Stop live tail' : 'Start live tail'}
      >
        {live ? <Pause size={11} /> : <Play size={11} />}
        Live
        {live && <span className={`ml-0.5 inline-block h-1.5 w-1.5 rounded-full ${liveDot}`} />}
      </button>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading || live}
        className="rounded px-1.5 py-1 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
        title={live ? 'Pause live tail to refresh' : 'Refresh'}
      >
        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
      </button>
      <button
        type="button"
        onClick={onDownload}
        disabled={downloadDisabled}
        className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-[10px] font-medium text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
        title="Download full log file"
      >
        <Download size={11} />
        Download
      </button>
    </div>
  );
}
