'use client';

/**
 * LogsPane — read, filter, live-tail and download the gateway/system log file.
 *
 * The pane talks to the gateway through the same `/api/gateway/...` reverse
 * proxy used by every other web → gateway request. Endpoints:
 *   GET /api/gateway/api/logs/meta     — header info (path / level / size)
 *   GET /api/gateway/api/logs/tail     — last N lines (initial load + Refresh)
 *   GET /api/gateway/api/logs/stream   — SSE: live tail (Live-tail toggle)
 *   GET /api/gateway/api/logs/download — full-file download
 *
 * Virtualization: we cap the in-memory ring buffer at MAX_BUFFER_LINES so a
 * 50k-line live tail doesn't lock the browser. When new lines arrive past the
 * cap, the oldest are dropped (the user can always re-fetch from the server).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug';

interface ParsedLogLine {
  ts: string;
  level: LogLevel;
  name: string;
  msg: string;
  data?: Record<string, unknown>;
  raw: string;
}

interface LogsMeta {
  filePath: string;
  fileName: string;
  level: LogLevel;
  exists: boolean;
  sizeBytes: number;
  mtime: string | null;
}

interface LogsTailResponse {
  filePath: string;
  level: LogLevel;
  lines: ParsedLogLine[];
  sizeBytes: number;
  truncated: boolean;
  nextCursor: number;
  missing: boolean;
}

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

/** Cap in-memory log lines so live-tailing a busy gateway doesn't OOM the tab. */
const MAX_BUFFER_LINES = 5_000;
/** Initial number of lines fetched on mount and on Refresh. */
const INITIAL_TAIL_LINES = 500;
/** Live-tail re-fetch backoff schedule (ms). */
const SSE_BACKOFF = [500, 1_000, 2_000, 5_000, 10_000];

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

/** Stable key for a log row — combines timestamp + index because timestamps may collide. */
function rowKey(line: ParsedLogLine, idx: number): string {
  return `${line.ts}::${idx}::${line.raw.length}`;
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
  const [cursor, setCursor] = useState<number>(0);
  const [serverLevel, setServerLevel] = useState<LogLevel>('info');
  const [displayLevel, setDisplayLevel] = useState<LogLevel | null>(null);
  const [search, setSearch] = useState('');
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<'idle' | 'connecting' | 'open' | 'reconnecting' | 'error'>('idle');
  const [truncated, setTruncated] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const sseRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  // Used to abort the meta/tail fetches on unmount.
  const fetchAbortRef = useRef<AbortController | null>(null);
  // Mirror of `cursor` accessible from the SSE reconnect closure. We can't
  // depend on `cursor` in `openStream`'s memo deps without tearing the SSE
  // down on every cursor bump (every batch of new lines), so the ref is read
  // at reconnect time to avoid stale-closure replay.
  const cursorRef = useRef(0);

  // Load meta on mount.
  const loadMeta = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await fetch('/api/gateway/api/logs/meta', { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: LogsMeta = await r.json();
      setMeta(data);
      setServerLevel(data.level);
      // Default the display filter to whatever the gateway is configured at.
      setDisplayLevel((prev) => prev ?? data.level);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setError(`Failed to load log info: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const loadTail = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ lines: String(INITIAL_TAIL_LINES) });
      // Server-side level filter trims payload — apply the *most permissive* of
      // the configured server level and the display filter so we don't miss
      // entries the user might want to see when they widen the filter.
      const r = await fetch(`/api/gateway/api/logs/tail?${params}`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: LogsTailResponse = await r.json();
      setLines(data.lines);
      setCursor(data.nextCursor);
      cursorRef.current = data.nextCursor;
      setTruncated(data.truncated);
      setServerLevel(data.level);
      // After a fresh load, jump to bottom unless the user is actively scrolled up.
      requestAnimationFrame(() => {
        if (scrollRef.current && !userScrolledUpRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      setError(`Failed to load logs: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    void loadMeta(controller.signal);
    void loadTail(controller.signal);
    return () => {
      controller.abort();
      fetchAbortRef.current = null;
    };
  }, [loadMeta, loadTail]);

  // ── SSE live-tail with backoff reconnect ──────────────────────────────────
  const closeStream = useCallback(() => {
    if (sseRef.current) {
      try { sseRef.current.close(); } catch { /* ignore */ }
      sseRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // Note: openStream intentionally has NO `cursor` dep — it reads cursorRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const openStream = useCallback(() => {
    closeStream();
    setStreamState('connecting');
    // Read from the ref — NOT from a closed-over `cursor` value — so reconnects
    // resume from the latest committed cursor rather than the stale offset
    // that was current when openStream was last memoized. This is what
    // prevents duplicate line replays after a transient SSE drop.
    const params = new URLSearchParams({ offset: String(cursorRef.current) });
    // We don't pass the level filter to the server — the user can change the
    // display dropdown without re-establishing the SSE, and we filter
    // client-side. This costs a small amount of bandwidth on chatty logs but
    // keeps the UX snappy.
    const url = `/api/gateway/api/logs/stream?${params}`;
    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch (err) {
      setStreamState('error');
      setError(`Stream init failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    sseRef.current = es;

    es.addEventListener('meta', () => {
      setStreamState('open');
      reconnectAttemptRef.current = 0;
    });

    es.addEventListener('line', (ev) => {
      try {
        const line: ParsedLogLine = JSON.parse((ev as MessageEvent).data);
        setLines((prev) => {
          const next = [...prev, line];
          if (next.length > MAX_BUFFER_LINES) {
            return next.slice(next.length - MAX_BUFFER_LINES);
          }
          return next;
        });
      } catch {
        // Bad payload — drop silently rather than crash the stream.
      }
    });

    es.addEventListener('cursor', (ev) => {
      try {
        const { cursor: c } = JSON.parse((ev as MessageEvent).data) as { cursor: number };
        if (typeof c === 'number') {
          setCursor(c);
          cursorRef.current = c;
        }
      } catch { /* ignore */ }
    });

    es.addEventListener('rotated', () => {
      // File was truncated/rotated. Reset cursor and surface a marker line.
      setCursor(0);
      cursorRef.current = 0;
      setLines((prev) => [...prev, {
        ts: new Date().toISOString(),
        level: 'warn',
        name: 'logs',
        msg: '— log file rotated/truncated —',
        raw: '— log file rotated/truncated —',
      }]);
    });

    es.onerror = () => {
      setStreamState('reconnecting');
      closeStream();
      // Reconnect with exponential backoff if still in live mode.
      const delay = SSE_BACKOFF[Math.min(reconnectAttemptRef.current, SSE_BACKOFF.length - 1)];
      reconnectAttemptRef.current++;
      reconnectTimerRef.current = setTimeout(() => { openStream(); }, delay);
    };
  }, [closeStream]);

  useEffect(() => {
    if (live) {
      openStream();
    } else {
      closeStream();
      setStreamState('idle');
    }
    return closeStream;
    // We intentionally don't depend on `cursor` — openStream() reads the latest
    // cursor at call time, and we don't want to tear down the SSE every time
    // a new line bumps the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // Auto-scroll to bottom on new lines while live, unless the user scrolled up.
  useEffect(() => {
    if (!live) return;
    const el = scrollRef.current;
    if (!el) return;
    if (userScrolledUpRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, live]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distFromBottom > 60;
  }, []);

  const filteredLines = useMemo(() => {
    const minLevel = displayLevel ?? serverLevel;
    const minOrder = LEVEL_ORDER[minLevel];
    const q = search.trim().toLowerCase();
    return lines.filter((l) => {
      if (LEVEL_ORDER[l.level] > minOrder) return false;
      if (q && !l.raw.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [lines, displayLevel, serverLevel, search]);

  const hiddenCount = lines.length - filteredLines.length;

  const handleDownload = useCallback(() => {
    // Use a synthetic anchor click so the browser respects Content-Disposition
    // and our same-origin cookies/auth context.
    const a = document.createElement('a');
    a.href = '/api/gateway/api/logs/download';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const handleRefresh = useCallback(() => {
    userScrolledUpRef.current = false;
    void loadMeta();
    void loadTail();
  }, [loadMeta, loadTail]);

  // Empty-state when the log file doesn't exist yet.
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
            logging configuration, run <span className="font-mono text-zinc-500">orionomega ln</span> from a
            terminal on the host.
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
            value={displayLevel ?? serverLevel}
            onChange={(e) => setDisplayLevel(e.target.value as LogLevel)}
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

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-[var(--background)]"
      >
        {filteredLines.length === 0 && !loading ? (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            {lines.length === 0 ? 'No log entries yet.' : 'No lines match the current filter.'}
          </div>
        ) : (
          filteredLines.map((line, i) => (
            <LogRow key={rowKey(line, i)} line={line} />
          ))
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
        disabled={loading}
        className="rounded px-1.5 py-1 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-50"
        title="Refresh"
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
