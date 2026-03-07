/**
 * @module logging/logger
 * Lightweight logger for the hindsight package. Same interface as core's logger.
 */

/** Log level names. */
export type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0, warn: 1, info: 2, verbose: 3, debug: 4,
};

let globalLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void { globalLevel = level; }

export interface Logger {
  error(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  verbose(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export function createLogger(name: string): Logger {
  function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[globalLevel]) return;
    const tag = level.toUpperCase().padEnd(7);
    const line = `[${new Date().toISOString()}] [${tag}] [${name}] ${message}`;
    if (data && Object.keys(data).length > 0) {
      console.log(line, data);
    } else {
      console.log(line);
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
