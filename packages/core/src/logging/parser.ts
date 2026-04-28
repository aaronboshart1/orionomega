/**
 * @module logging/parser
 * Parses log lines written by `createLogger()` (see `logger.ts`) back into
 * structured records, and exposes shared level ordering for use by both
 * server-side filters (the gateway's `/api/logs/tail` endpoint) and the web
 * UI (the LogsPane component).
 *
 * The on-disk line format is:
 *   `[ISO-8601-timestamp] [LEVEL  ] [name] message {optional-json}`
 *
 * Where LEVEL is right-padded to 7 chars (matches `logger.ts`). The optional
 * JSON object is appended only when the call passed a `data` argument.
 *
 * Parsing is **tolerant**: any line that doesn't match the format is returned
 * with `level: 'info'`, `name: ''`, `ts: ''`, and the original line as `msg`,
 * so unstructured log output (stack traces, native crashes, lines written by
 * something other than `createLogger`) is still surfaced rather than silently
 * dropped.
 */

import type { LogLevel } from './logger.js';

/** Numeric ordering — lower is more severe. Matches `LEVEL_ORDER` in logger.ts. */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  verbose: 3,
  debug: 4,
};

/** Ordered tuple from most severe to least severe. */
export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'verbose', 'debug'];

/** A parsed log record. */
export interface ParsedLogLine {
  /** ISO timestamp string from the log line. Empty string for unparseable lines. */
  ts: string;
  /** Log level. Defaults to `info` for unparseable lines. */
  level: LogLevel;
  /** Logger name (the module/component tag). Empty string for unparseable lines. */
  name: string;
  /** The human-readable message (without the trailing JSON blob, if any). */
  msg: string;
  /** Optional structured data parsed from the trailing JSON blob, if present and valid. */
  data?: Record<string, unknown>;
  /** The original raw line as it was read from disk. */
  raw: string;
}

// Matches:  [TS] [LEVEL  ] [name] rest...
// Capture groups: 1=timestamp, 2=raw level token, 3=name, 4=rest of line.
const LINE_RE = /^\[([^\]]+)\] \[([^\]]+)\] \[([^\]]+)\] (.*)$/;

/**
 * Parse a single log line. Tolerant to unrecognized formats — returns an
 * `info`-level entry with `msg` set to the raw line on any parse failure so
 * the line is still rendered.
 */
export function parseLogLine(raw: string): ParsedLogLine {
  // Strip a single trailing newline if present (the on-disk file uses `\n`
  // separators; callers typically split on `\n` and may keep the `\r` on
  // Windows-formatted files).
  const trimmed = raw.replace(/\r$/, '');

  const m = LINE_RE.exec(trimmed);
  if (!m) {
    return { ts: '', level: 'info', name: '', msg: trimmed, raw };
  }

  const ts = m[1]!;
  const levelToken = m[2]!.trim().toLowerCase();
  const name = m[3]!;
  const rest = m[4]!;

  // Validate level — fall back to info if the token isn't a known level.
  const level: LogLevel = (LOG_LEVELS as readonly string[]).includes(levelToken)
    ? (levelToken as LogLevel)
    : 'info';

  // Try to detach a trailing JSON object. The logger appends ` {…}` only when
  // there's a non-empty `data` arg, so we look for the LAST opening `{` that
  // gives a balanced parse. We don't run a full grammar — just an optimistic
  // tail-JSON probe.
  let msg = rest;
  let data: Record<string, unknown> | undefined;
  const lastBrace = rest.lastIndexOf(' {');
  if (lastBrace > 0 && rest.endsWith('}')) {
    const candidate = rest.slice(lastBrace + 1);
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
        msg = rest.slice(0, lastBrace);
      }
    } catch {
      // JSON parse failed — leave msg as-is.
    }
  }

  return { ts, level, name, msg, data, raw };
}

/**
 * Returns true if `lineLevel` is at or below `minLevel` (i.e. would be emitted
 * by a logger configured at `minLevel`). Used by the tail endpoint to filter
 * server-side and reduce payload size.
 *
 * Example: `passesLevelFilter('error', 'warn')` → true (error is more severe).
 */
export function passesLevelFilter(lineLevel: LogLevel, minLevel: LogLevel): boolean {
  return LOG_LEVEL_ORDER[lineLevel] <= LOG_LEVEL_ORDER[minLevel];
}

/** Type guard for the LogLevel union, with case-insensitive matching. */
export function asLogLevel(s: string | null | undefined): LogLevel | null {
  if (!s) return null;
  const lower = s.toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(lower) ? (lower as LogLevel) : null;
}
