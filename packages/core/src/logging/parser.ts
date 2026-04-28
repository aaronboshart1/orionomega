import type { LogLevel } from './logger.js';

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  verbose: 3,
  debug: 4,
};

export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'verbose', 'debug'];

export interface ParsedLogLine {
  ts: string;
  level: LogLevel;
  name: string;
  msg: string;
  data?: Record<string, unknown>;
  raw: string;
}

const LINE_RE = /^\[([^\]]+)\] \[([^\]]+)\] \[([^\]]+)\] (.*)$/;

export function parseLogLine(raw: string): ParsedLogLine {
  const trimmed = raw.replace(/\r$/, '');
  const m = LINE_RE.exec(trimmed);
  if (!m) {
    return { ts: '', level: 'info', name: '', msg: trimmed, raw };
  }

  const ts = m[1]!;
  const levelToken = m[2]!.trim().toLowerCase();
  const name = m[3]!;
  const rest = m[4]!;

  const level: LogLevel = (LOG_LEVELS as readonly string[]).includes(levelToken)
    ? (levelToken as LogLevel)
    : 'info';

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
      // not JSON
    }
  }

  return { ts, level, name, msg, data, raw };
}

export function passesLevelFilter(lineLevel: LogLevel, minLevel: LogLevel): boolean {
  return LOG_LEVEL_ORDER[lineLevel] <= LOG_LEVEL_ORDER[minLevel];
}

export function asLogLevel(s: string | null | undefined): LogLevel | null {
  if (!s) return null;
  const lower = s.toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(lower) ? (lower as LogLevel) : null;
}
