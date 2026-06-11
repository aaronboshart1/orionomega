'use client';

/**
 * @module gateway/logs-client
 * Typed wrappers around the gateway's `/api/logs/{meta,tail,stream,download}`
 * endpoints. Fully self-contained (no WebSocket singleton coupling) so the Logs
 * pane can consume them independently of the live chat socket.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug';

export interface ParsedLogLine {
  ts: string;
  level: LogLevel;
  name: string;
  msg: string;
  data?: Record<string, unknown>;
  raw: string;
}

export interface LogsMeta {
  filePath: string;
  fileName: string;
  level: LogLevel;
  exists: boolean;
  sizeBytes: number;
  mtime: string | null;
}

export interface LogsTailResponse {
  filePath: string;
  level: LogLevel;
  lines: ParsedLogLine[];
  sizeBytes: number;
  truncated: boolean;
  nextCursor: number;
  missing: boolean;
}

export interface LogsTailParams {
  lines?: number;
  level?: LogLevel;
  q?: string;
  /** ISO timestamp; only return entries with `ts > since`. */
  since?: string;
  signal?: AbortSignal;
}

export async function fetchLogsMeta(signal?: AbortSignal): Promise<LogsMeta> {
  const url = '/api/gateway/api/logs/meta';
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`Logs meta failed: HTTP ${r.status} (${url})`);
  return r.json() as Promise<LogsMeta>;
}

export async function fetchLogsTail(params: LogsTailParams = {}): Promise<LogsTailResponse> {
  const qs = new URLSearchParams();
  if (params.lines !== undefined) qs.set('lines', String(params.lines));
  if (params.level) qs.set('level', params.level);
  if (params.q) qs.set('q', params.q);
  if (params.since) qs.set('since', params.since);
  const url = `/api/gateway/api/logs/tail?${qs}`;
  const r = await fetch(url, { signal: params.signal });
  if (!r.ok) throw new Error(`Logs tail failed: HTTP ${r.status} (${url})`);
  return r.json() as Promise<LogsTailResponse>;
}

export function getLogsDownloadUrl(): string {
  return '/api/gateway/api/logs/download';
}

export interface LogsStreamHandlers {
  onMeta?: (m: { filePath: string; level: LogLevel; cursor: number }) => void;
  onLine: (line: ParsedLogLine) => void;
  onCursor?: (cursor: number) => void;
  onRotated?: () => void;
  onError?: (err: Error) => void;
  onState?: (state: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
}

export interface LogsStreamOptions {
  offset: number;
  level?: LogLevel;
  handlers: LogsStreamHandlers;
}

export interface LogsStreamHandle {
  close: () => void;
  getCursor: () => number;
}

const SSE_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000];

/**
 * Open an SSE connection to /api/logs/stream with auto-reconnect and backoff.
 * Reconnects resume from the latest committed cursor (no replay, no loss).
 */
export function openLogsStream(opts: LogsStreamOptions): LogsStreamHandle {
  const { handlers } = opts;
  let es: EventSource | null = null;
  let closed = false;
  let cursor = opts.offset;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const setState = (s: 'connecting' | 'open' | 'reconnecting' | 'closed') => {
    handlers.onState?.(s);
  };

  const teardown = () => {
    if (es) {
      try { es.close(); } catch { /* ignore */ }
      es = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const connect = () => {
    if (closed) return;
    teardown();
    setState('connecting');
    const qs = new URLSearchParams({ offset: String(cursor) });
    if (opts.level) qs.set('level', opts.level);
    try {
      es = new EventSource(`/api/gateway/api/logs/stream?${qs}`);
    } catch (err) {
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      scheduleReconnect();
      return;
    }

    es.addEventListener('meta', (ev) => {
      try {
        const m = JSON.parse((ev as MessageEvent).data) as { filePath: string; level: LogLevel; cursor: number };
        setState('open');
        reconnectAttempt = 0;
        handlers.onMeta?.(m);
      } catch { /* ignore */ }
    });

    es.addEventListener('line', (ev) => {
      try {
        handlers.onLine(JSON.parse((ev as MessageEvent).data) as ParsedLogLine);
      } catch { /* ignore */ }
    });

    es.addEventListener('cursor', (ev) => {
      try {
        const { cursor: c } = JSON.parse((ev as MessageEvent).data) as { cursor: number };
        if (typeof c === 'number') {
          cursor = c;
          handlers.onCursor?.(c);
        }
      } catch { /* ignore */ }
    });

    es.addEventListener('rotated', () => {
      cursor = 0;
      handlers.onRotated?.();
    });

    es.onerror = () => {
      handlers.onError?.(new Error('SSE connection error'));
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (closed) return;
    teardown();
    setState('reconnecting');
    const delay = SSE_BACKOFF_MS[Math.min(reconnectAttempt, SSE_BACKOFF_MS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  };

  connect();

  return {
    close: () => {
      if (closed) return;
      closed = true;
      teardown();
      setState('closed');
    },
    getCursor: () => cursor,
  };
}
