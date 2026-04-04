/**
 * @module logging/logger
 * Structured logger with configurable levels, colour-coded console output,
 * and optional file output.
 *
 * Usage:
 *   import { createLogger, setGlobalLogLevel, enableFileLogging } from '../logging/logger.js';
 *   setGlobalLogLevel('verbose');
 *   enableFileLogging('/path/to/log.log');
 *   const log = createLogger('my-module');
 *   log.verbose('Processing request', { requestId: 'abc', tokens: 1234 });
 *
 * Log level tiers (ascending verbosity — pick the right tier):
 *   error  — unrecoverable failure; the operation cannot continue
 *   warn   — recoverable issue; operation continues but something is wrong
 *   info   — lifecycle milestone; start/stop/config events worth noting
 *   verbose — operational detail for live troubleshooting (tool calls, tokens,
 *             Hindsight access, timing, conversations)
 *   debug  — full payloads and internal state; only useful when debugging
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** Log level names in ascending verbosity. */
export type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  verbose: 3,
  debug: 4,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  error: '\x1b[31m',   // red
  warn: '\x1b[33m',    // yellow
  info: '\x1b[36m',    // cyan
  verbose: '\x1b[35m', // magenta
  debug: '\x1b[90m',   // grey
};

const RESET = '\x1b[0m';

/** Global log level — set once at startup via `setGlobalLogLevel()`. */
let globalLevel: LogLevel = 'info';

/** Optional file path for log output. */
let logFilePath: string | null = null;

/** Whether to log to console (can be disabled for pure file logging). */
let consoleEnabled = true;

/**
 * Sets the global log level. Only messages at or below this level are emitted.
 */
export function setGlobalLogLevel(level: LogLevel): void {
  globalLevel = level;
}

/**
 * Returns the current global log level.
 */
export function getGlobalLogLevel(): LogLevel {
  return globalLevel;
}

/**
 * Enable file logging. Log lines are appended to the specified path (no colour codes).
 * Creates parent directories if they don't exist.
 */
export function enableFileLogging(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  logFilePath = filePath;
}

/**
 * Disable console output (useful if logs are redirected via systemd/journald).
 */
export function setConsoleLogging(enabled: boolean): void {
  consoleEnabled = enabled;
}

/** A structured logger instance with a fixed name prefix. */
export interface Logger {
  error(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  verbose(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

/**
 * Creates a named logger instance.
 *
 * Console output: `[ISO-timestamp] [LEVEL] [name] message {data}` (colour-coded)
 * File output:    `[ISO-timestamp] [LEVEL] [name] message {data}` (plain text)
 *
 * @param name - Logger name (typically a module or component name).
 * @returns A Logger instance.
 */

// ── Telemetry hook ─────────────────────────────────────────────────────────

/** A structured log event passed to the telemetry hook. */
export interface LogTelemetryEvent {
  level: LogLevel;
  name: string;
  message: string;
  data?: Record<string, unknown>;
  ts: string;
}

/** Optional hook invoked for every warn/error log call. */
let telemetryHook: ((event: LogTelemetryEvent) => void) | null = null;

/**
 * Register a telemetry hook for structured error and warning events.
 * The hook is called synchronously — keep it fast (queue, don't block).
 * Only fires for warn and error levels to avoid overhead on verbose/debug.
 */
export function setLogTelemetryHook(hook: (event: LogTelemetryEvent) => void): void {
  telemetryHook = hook;
}

export function clearLogTelemetryHook(): void {
  telemetryHook = null;
}

export function createLogger(name: string): Logger {
  function log(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[globalLevel]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(7);

    // Telemetry hook — fires for warn and error to enable external monitoring
    if (telemetryHook && LEVEL_ORDER[level] <= LEVEL_ORDER['warn']) {
      try {
        telemetryHook({ level, name, message, data, ts: timestamp });
      } catch {
        // Never let a hook crash the logger
      }
    }

    // Data serialization (shared between console and file)
    const dataStr = data !== undefined && Object.keys(data).length > 0
      ? ' ' + JSON.stringify(data, truncateValues)
      : '';

    // Console output (colour-coded)
    if (consoleEnabled) {
      const color = LEVEL_COLORS[level];
      const prefix = `${color}[${timestamp}] [${tag}] [${name}]${RESET}`;
      console.log(`${prefix} ${message}${dataStr}`);
    }

    // File output (plain text, append)
    if (logFilePath) {
      const line = `[${timestamp}] [${tag}] [${name}] ${message}${dataStr}\n`;
      try {
        appendFileSync(logFilePath, line);
      } catch {
        // Silently ignore file write errors to avoid log recursion
      }
    }
  }

  return {
    error: (msg, data) => log('error', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    info: (msg, data) => log('info', msg, data),
    verbose: (msg, data) => log('verbose', msg, data),
    debug: (msg, data) => log('debug', msg, data),
  };
}

/**
 * JSON replacer that truncates long string values to prevent log bloat.
 * Strings over 500 chars are truncated with a [truncated] marker.
 */
function truncateValues(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.length > 500) {
    return value.slice(0, 500) + `... [truncated, ${value.length} chars]`;
  }
  return value;
}
