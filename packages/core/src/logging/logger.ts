/**
 * @module logging/logger
 * Thin re-export of the canonical logger from `@orionomega/shared`.
 *
 * The implementation used to live here; it now lives in `@orionomega/shared`
 * so every package shares one copy (DUP-12). Existing imports of
 * `../logging/logger.js` continue to work unchanged.
 */

export type { LogLevel, Logger, LogTelemetryEvent } from '@orionomega/shared/logger';
export {
  createLogger,
  setGlobalLogLevel,
  getGlobalLogLevel,
  enableFileLogging,
  setConsoleLogging,
  setLogTelemetryHook,
  clearLogTelemetryHook,
  truncateValues,
} from '@orionomega/shared/logger';
