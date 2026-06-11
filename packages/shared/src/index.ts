/**
 * @module @orionomega/shared
 * Cross-package utilities shared across the OrionOmega monorepo.
 *
 * Subpath entry points:
 *   - `@orionomega/shared/logger`      — structured logger + telemetry hook
 *   - `@orionomega/shared/truncate`    — string truncation helper
 *   - `@orionomega/shared/ws-contract` — Zod schemas + derived types for the
 *                                        gateway↔client WebSocket protocol
 */

export * from './logger.js';
export * from './truncate.js';
export * from './ws-contract.js';
