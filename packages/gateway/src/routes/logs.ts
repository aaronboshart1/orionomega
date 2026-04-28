/**
 * @module routes/logs
 * REST + SSE endpoints for reading and downloading the gateway/system log file.
 *
 *   GET /api/logs/meta      — { filePath, level, exists, sizeBytes, mtime }
 *   GET /api/logs/tail      — last N lines (server-side level + search filter)
 *   GET /api/logs/stream    — SSE: live-tail new lines from a byte offset cursor
 *   GET /api/logs/download  — streams the full configured log file as an attachment
 *
 * The log file path is **always** resolved via `readConfig().logging.file`
 * — it is never accepted from a query parameter, eliminating any path-traversal
 * surface. Every request also re-reads config so changes saved through the
 * Settings modal are picked up without a gateway restart.
 */

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

/** Maximum bytes the tail endpoint will read from the end of the file. */
const TAIL_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
/** Maximum lines the tail endpoint will return after filtering. */
const TAIL_MAX_LINES = 5_000;
/** Default number of lines requested by the tail endpoint. */
const TAIL_DEFAULT_LINES = 500;
/** SSE heartbeat interval — must be < typical proxy idle timeout (60s for nginx). */
const SSE_HEARTBEAT_MS = 15_000;
/** Maximum bytes to stream per SSE poll cycle (guards against 100s-of-MB bursts). */
const SSE_MAX_CHUNK_BYTES = 256 * 1024;

/** Resolved log file context — re-read on every request so config edits take effect. */
interface LogContext {
  filePath: string;
  level: LogLevel;
}

function resolveLogContext(): LogContext {
  const cfg = readConfig();
  return { filePath: cfg.logging.file, level: cfg.logging.level };
}

/**
 * GET /api/logs/meta
 * Returns the resolved path, configured level, and basic stat info so the UI
 * header can render the path/level and decide whether to show an empty state.
 */
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
  } catch {
    // Treat stat failure as "doesn't exist" for meta purposes.
  }

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
 * Reads the last `lines` log lines (capped at TAIL_MAX_LINES, also capped by
 * TAIL_MAX_BYTES from the tail end of the file) and returns them as parsed
 * records. Optional `level` filter passes through the shared
 * `passesLevelFilter()` so only entries at-or-more-severe than the filter
 * are returned. Optional `q` filter is a case-insensitive substring search
 * over the raw line. Optional `since` filter drops entries with a timestamp
 * strictly less-than-or-equal to the cursor (used for incremental polling).
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

  // Read up to TAIL_MAX_BYTES from the end of the file.
  const readFromBytes = Math.max(0, sizeBytes - TAIL_MAX_BYTES);
  const truncated = readFromBytes > 0;
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

  // Drop the partial leading line if we sliced into the middle of one — we
  // can't trust its prefix (timestamp/level/name). Edge case: if there's no
  // newline at all in the slice (a single >2 MB line), drop the whole slice
  // rather than treating it as one valid line — `indexOf('\n')` returns -1
  // and naive +1 would yield 0, incorrectly keeping the partial line.
  const text = buf.toString('utf-8');
  let startIdx = 0;
  if (readFromBytes > 0) {
    const firstNl = text.indexOf('\n');
    if (firstNl < 0) {
      // The entire 2 MB slice is one mid-stream fragment — nothing usable.
      startIdx = text.length;
    } else {
      startIdx = firstNl + 1;
    }
  }
  const allRaw = text.slice(startIdx).split('\n');
  // Trailing empty string after the final `\n` — drop it.
  if (allRaw.length > 0 && allRaw[allRaw.length - 1] === '') allRaw.pop();

  // Parse every line so we can apply structured filters.
  let parsed: ParsedLogLine[] = allRaw.map(parseLogLine);

  if (levelFilter) {
    parsed = parsed.filter((p) => passesLevelFilter(p.level, levelFilter));
  }
  if (q) {
    parsed = parsed.filter((p) => p.raw.toLowerCase().includes(q));
  }
  if (since) {
    parsed = parsed.filter((p) => p.ts > since);
  }

  // Cap to last `lines` entries after filtering so the user always sees the
  // most recent matching entries (even if older ones were filtered).
  if (parsed.length > lines) {
    parsed = parsed.slice(parsed.length - lines);
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    filePath: ctx.filePath,
    level: ctx.level,
    lines: parsed,
    sizeBytes,
    truncated,
    nextCursor: sizeBytes,
    missing: false,
  }));
}

/**
 * GET /api/logs/stream?offset=N&level=LVL
 *
 * Server-Sent Events endpoint that emits new log lines as the file grows.
 * The client passes an `offset` cursor (the byte position where it last
 * stopped reading — typically the `nextCursor` from a previous `tail` call)
 * so a reconnect doesn't replay the entire file from byte 0.
 *
 * Each event has `event: line` and `data: <json-of-ParsedLogLine>`. We also
 * emit `event: heartbeat` every SSE_HEARTBEAT_MS so proxies don't time out
 * idle connections, and `event: rotated` if the file shrinks (rotation /
 * truncation) so the client can reset its cursor.
 *
 * Implementation notes:
 *  - We poll every 500ms via fs.watch + a fallback interval (fs.watch can
 *    miss events on some filesystems, especially network mounts).
 *  - Each poll reads at most SSE_MAX_CHUNK_BYTES so a giant log burst doesn't
 *    block the event loop or balloon a single SSE message.
 *  - The level filter is applied per-line; lines that fail the filter still
 *    advance the cursor so the client doesn't re-request them on reconnect.
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

  // SSE response headers. `X-Accel-Buffering: no` disables nginx buffering;
  // the local Next.js proxy uses .pipe() so it flushes naturally.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Initial comment + meta event so the client knows the connection is open
  // and which file/level it's tailing.
  res.write(`: orionomega-logs stream open\n\n`);
  res.write(`event: meta\ndata: ${JSON.stringify({ filePath: ctx.filePath, level: ctx.level, cursor })}\n\n`);

  let closed = false;
  let polling = false;
  let watcher: FSWatcher | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Carry-over for a partial last line between polls. */
  let leftover = '';
  /**
   * Bytes of the read-cursor that have been "committed" — i.e. correspond to
   * the start of the last fully-emitted line. We send THIS to the client (not
   * the raw read cursor) so a reconnect from the published cursor never skips
   * the prefix of a partially-buffered line. `cursor - committedCursor`
   * always equals `Buffer.byteLength(leftover, 'utf-8')`.
   */
  let committedCursor = cursor;

  const sendEvent = (event: string, data: unknown): void => {
    if (closed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Connection went away mid-write — treat as closed.
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
      if (!existsSync(ctx.filePath)) {
        // File doesn't exist yet — keep cursor at 0 so the first append is read in full.
        return;
      }
      let size = 0;
      try { size = statSync(ctx.filePath).size; } catch { return; }

      // File shrunk → rotation/truncation. Reset and notify the client.
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
        // No new full lines — committed cursor unchanged. Nothing to publish.
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
      // The committed cursor is the read cursor MINUS the leftover bytes that
      // belong to a not-yet-complete line. Publishing this (rather than
      // `cursor`) guarantees a reconnect from the published cursor will pick
      // up the still-incomplete line in full and never lose its prefix.
      committedCursor = cursor - Buffer.byteLength(leftover, 'utf-8');
      sendEvent('cursor', { cursor: committedCursor });
    } finally {
      polling = false;
    }
  };

  // fs.watch fires on append; poll() does the actual reading.
  try {
    if (existsSync(ctx.filePath)) {
      watcher = watch(ctx.filePath, { persistent: false }, () => { void poll(); });
    }
  } catch {
    // Watcher creation can fail on some filesystems — the interval-based
    // fallback below handles those cases.
  }

  // Polling fallback: 1s on file existence + always 500ms read cycle when the
  // watcher missed an event (some filesystems debounce / coalesce).
  interval = setInterval(() => { void poll(); }, 1_000);

  // Heartbeat keeps the SSE connection alive through proxies.
  heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { cleanup(); }
  }, SSE_HEARTBEAT_MS);

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  // Kick off an immediate poll so the first batch flows without waiting for
  // the interval tick.
  void poll();
}

/**
 * GET /api/logs/download
 *
 * Streams the entire configured log file as an attachment. Filename embeds the
 * git short commit + timestamp so saved copies are easy to correlate with a
 * specific gateway build. Streams via fs.createReadStream so multi-hundred-MB
 * logs don't get buffered into memory.
 */
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

  // Build a descriptive filename. Prefer the gateway short-commit, fall back
  // to core's, fall back to "unknown". Replace colons in the timestamp so
  // it's filesystem-safe across Windows/macOS/Linux.
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
    // Headers already sent — best we can do is destroy the response so the
    // client sees a truncated download rather than hanging forever.
    try { res.destroy(); } catch { /* ignore */ }
  });
  stream.pipe(res);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
