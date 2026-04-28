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

export type { ParsedLogLine } from './parser.js';
export { parseLogLine, passesLevelFilter, asLogLevel, LOG_LEVELS, LOG_LEVEL_ORDER } from './parser.js';

export type { AuditCategory, AuditEntry } from './audit.js';
export {
  emitAuditEvent,
  auditToolInvocation,
  auditApiRequest,
  auditAuthEvent,
  auditConfigChange,
} from './audit.js';
