import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync, existsSync, watch, type FSWatcher } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  readConfig,
  parseLogLine,
  passesLevelFilter,
  asLogLevel,
  type LogLevel,
  type ParsedLogLine,
  BUILD_INFO as CORE_BUILD_INFO,
} from '@orionomega/core';
import { BUILD_INFO as GATEWAY_BUILD_INFO } from '../generated/build-info.js';

const TAIL_MAX_BYTES = 2 * 1024 * 1024;
const TAIL_MAX_LINES = 5_000;
const TAIL_DEFAULT_LINES = 500;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_CHUNK_BYTES = 256 * 1024;

interface LogContext {
  filePath: string;
  level: LogLevel;
}

function resolveLogContext(): LogContext {
  const cfg = readConfig();
  return { filePath: cfg.logging.file, level: cfg.logging.level };
}

export function handleLogsMeta(_req: IncomingMessage, res: ServerResponse): void {
  let ctx: LogContext;
  try {
    ctx = resolveLogContext();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read config', detail: errMsg(err) }));
    return;
  }

  let exists = false;
  let sizeBytes = 0;
  let mtime: string | null = null;
  try {
    if (existsSync(ctx.filePath)) {
      const st = statSync(ctx.filePath);
      exists = true;
      sizeBytes = st.size;
      mtime = st.mtime.toISOString();
    }
  } catch { /* treat as missing */ }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    filePath: ctx.filePath,
    fileName: basename(ctx.filePath),
    level: ctx.level,
    exists,
    sizeBytes,
    mtime,
  }));
}

/**
 * GET /api/logs/tail?lines=N&level=LVL&q=text&since=ISO
 *
 * Returns the most recent log lines. `since` is an optional ISO timestamp;
 * when provided, only entries with `ts > since` are returned (used for
 * incremental polling fallbacks). The response's `nextCursor` is a byte
 * offset into the file for use by the SSE stream endpoint's `offset` param.
 * `truncated` is true when results were dropped by the byte-window cap OR
 * the line-count cap.
 */
export async function handleLogsTail(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let ctx: LogContext;
  try {
    ctx = resolveLogContext();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read config', detail: errMsg(err) }));
    return;
  }

  const params = new URLSearchParams((req.url ?? '/').split('?')[1] ?? '');
  const linesParam = parseInt(params.get('lines') ?? '', 10);
  const lines = Number.isFinite(linesParam) && linesParam > 0
    ? Math.min(linesParam, TAIL_MAX_LINES)
    : TAIL_DEFAULT_LINES;
  const levelFilter = asLogLevel(params.get('level'));
  const q = (params.get('q') ?? '').toLowerCase();
  const since = params.get('since');

  if (!existsSync(ctx.filePath)) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      filePath: ctx.filePath,
      level: ctx.level,
      lines: [],
      sizeBytes: 0,
      truncated: false,
      nextCursor: 0,
      missing: true,
    }));
    return;
  }

  let sizeBytes = 0;
  try {
    sizeBytes = statSync(ctx.filePath).size;
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to stat log file', detail: errMsg(err) }));
    return;
  }

  const readFromBytes = Math.max(0, sizeBytes - TAIL_MAX_BYTES);
  const byteTruncated = readFromBytes > 0;
  let buf: Buffer;
  try {
    const fh = await openFile(ctx.filePath, 'r');
    try {
      const length = sizeBytes - readFromBytes;
      buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, readFromBytes);
    } finally {
      await fh.close();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read log file', detail: errMsg(err) }));
    return;
  }

  // Drop the partial leading line when slicing mid-file. If the slice has no
  // newline at all (single line > 2 MB), drop the whole slice.
  const text = buf.toString('utf-8');
  let startIdx = 0;
  if (readFromBytes > 0) {
    const firstNl = text.indexOf('\n');
    startIdx = firstNl < 0 ? text.length : firstNl + 1;
  }
  const allRaw = text.slice(startIdx).split('\n');
  if (allRaw.length > 0 && allRaw[allRaw.length - 1] === '') allRaw.pop();

  let parsed: ParsedLogLine[] = allRaw.map(parseLogLine);

  if (levelFilter) parsed = parsed.filter((p) => passesLevelFilter(p.level, levelFilter));
  if (q) parsed = parsed.filter((p) => p.raw.toLowerCase().includes(q));
  if (since) parsed = parsed.filter((p) => p.ts > since);

  const lineCapped = parsed.length > lines;
  if (lineCapped) parsed = parsed.slice(parsed.length - lines);

  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    filePath: ctx.filePath,
    level: ctx.level,
    lines: parsed,
    sizeBytes,
    truncated: byteTruncated || lineCapped,
    nextCursor: sizeBytes,
    missing: false,
  }));
}

/**
 * GET /api/logs/stream?offset=N&level=LVL
 *
 * SSE live tail. Emits `event: line` per parsed log line, `event: cursor`
 * with the latest committed byte offset (excludes any partial trailing line),
 * `event: rotated` when the file shrinks, and a 15s heartbeat comment.
 */
export function handleLogsStream(req: IncomingMessage, res: ServerResponse): void {
  let ctx: LogContext;
  try {
    ctx = resolveLogContext();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read config', detail: errMsg(err) }));
    return;
  }

  const params = new URLSearchParams((req.url ?? '/').split('?')[1] ?? '');
  const levelFilter = asLogLevel(params.get('level'));
  const offsetParam = parseInt(params.get('offset') ?? '', 10);
  let cursor = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`: orionomega-logs stream open\n\n`);
  res.write(`event: meta\ndata: ${JSON.stringify({ filePath: ctx.filePath, level: ctx.level, cursor })}\n\n`);

  let closed = false;
  let polling = false;
  let watcher: FSWatcher | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let leftover = '';
  // Read cursor minus leftover bytes — the offset clients should resume from.
  let committedCursor = cursor;

  const sendEvent = (event: string, data: unknown): void => {
    if (closed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      cleanup();
    }
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    if (interval) clearInterval(interval);
    if (heartbeat) clearInterval(heartbeat);
    try { res.end(); } catch { /* ignore */ }
  };

  const poll = async (): Promise<void> => {
    if (closed || polling) return;
    polling = true;
    try {
      if (!existsSync(ctx.filePath)) return;
      let size = 0;
      try { size = statSync(ctx.filePath).size; } catch { return; }

      if (size < cursor) {
        cursor = 0;
        committedCursor = 0;
        leftover = '';
        sendEvent('rotated', { sizeBytes: size });
      }

      if (size <= cursor) return;

      const toRead = Math.min(size - cursor, SSE_MAX_CHUNK_BYTES);
      let buf: Buffer;
      try {
        const fh = await openFile(ctx.filePath, 'r');
        try {
          buf = Buffer.alloc(toRead);
          await fh.read(buf, 0, toRead, cursor);
        } finally {
          await fh.close();
        }
      } catch {
        return;
      }
      cursor += toRead;

      const chunk = leftover + buf.toString('utf-8');
      const lastNl = chunk.lastIndexOf('\n');
      if (lastNl < 0) {
        leftover = chunk;
        return;
      }
      const complete = chunk.slice(0, lastNl);
      leftover = chunk.slice(lastNl + 1);

      const lines = complete.split('\n');
      for (const raw of lines) {
        if (!raw) continue;
        const parsed = parseLogLine(raw);
        if (levelFilter && !passesLevelFilter(parsed.level, levelFilter)) continue;
        sendEvent('line', parsed);
      }
      committedCursor = cursor - Buffer.byteLength(leftover, 'utf-8');
      sendEvent('cursor', { cursor: committedCursor });
    } finally {
      polling = false;
    }
  };

  try {
    if (existsSync(ctx.filePath)) {
      watcher = watch(ctx.filePath, { persistent: false }, () => { void poll(); });
    }
  } catch { /* watcher unavailable on this fs — interval handles it */ }

  interval = setInterval(() => { void poll(); }, 1_000);

  heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { cleanup(); }
  }, SSE_HEARTBEAT_MS);

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  void poll();
}

export function handleLogsDownload(_req: IncomingMessage, res: ServerResponse): void {
  let ctx: LogContext;
  try {
    ctx = resolveLogContext();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read config', detail: errMsg(err) }));
    return;
  }

  if (!existsSync(ctx.filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Log file does not exist', filePath: ctx.filePath }));
    return;
  }

  let sizeBytes = 0;
  try {
    sizeBytes = statSync(ctx.filePath).size;
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to stat log file', detail: errMsg(err) }));
    return;
  }

  const shortCommit = GATEWAY_BUILD_INFO.shortCommit
    || CORE_BUILD_INFO.shortCommit
    || 'unknown';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const downloadName = `orionomega-${shortCommit}-${stamp}.log`;

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(sizeBytes),
    'Content-Disposition': `attachment; filename="${downloadName}"`,
    'Cache-Control': 'no-store',
  });

  const stream = createReadStream(ctx.filePath);
  stream.on('error', () => {
    try { res.destroy(); } catch { /* ignore */ }
  });
  stream.pipe(res);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
