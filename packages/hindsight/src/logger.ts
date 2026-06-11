/**
 * @module logger
 * Thin re-export of the canonical logger from `@orionomega/shared`.
 *
 * The hindsight package used to carry its own lightweight copy of the logger
 * (DUP-12). It now re-exports the shared implementation so there is a single
 * copy across the monorepo. `setLogLevel` is preserved as an alias of the
 * shared `setGlobalLogLevel` to keep hindsight's public API unchanged.
 */

export type { LogLevel, Logger } from '@orionomega/shared/logger';
export { createLogger, setGlobalLogLevel as setLogLevel } from '@orionomega/shared/logger';
