/**
 * @module logging/logger
 * Simple colour-coded console logger with configurable log levels.
 */

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

/**
 * Sets the global log level. Only messages at or below this level are emitted.
 *
 * @param level - The minimum log level to display.
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

/** A structured logger instance with a fixed name prefix. */
export interface Logger {
  /** Log an error message. */
  error(message: string, data?: Record<string, unknown>): void;
  /** Log a warning. */
  warn(message: string, data?: Record<string, unknown>): void;
  /** Log an informational message. */
  info(message: string, data?: Record<string, unknown>): void;
  /** Log a verbose message. */
  verbose(message: string, data?: Record<string, unknown>): void;
  /** Log a debug message. */
  debug(message: string, data?: Record<string, unknown>): void;
}

/**
 * Creates a named logger instance.
 *
 * Output format: `[ISO-timestamp] [LEVEL] [name] message {data}`
 *
 * @param name - Logger name (typically a module or component name).
 * @returns A Logger instance.
 */
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
    const color = LEVEL_COLORS[level];
    const tag = level.toUpperCase().padEnd(7);
    const prefix = `${color}[${timestamp}] [${tag}] [${name}]${RESET}`;

    if (data !== undefined && Object.keys(data).length > 0) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
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
