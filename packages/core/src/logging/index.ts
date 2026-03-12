/**
 * @module logging
 * Logging utilities for OrionOmega.
 */

export type { Logger, LogLevel } from './logger.js';
export {
  createLogger,
  setGlobalLogLevel,
  getGlobalLogLevel,
  enableFileLogging,
  setConsoleLogging,
} from './logger.js';
