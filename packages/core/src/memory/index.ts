/**
 * @module memory
 * Hindsight memory integration — bank management, session bootstrap,
 * retention engine, compaction flush, session summaries, and mental models.
 */

// Bank Manager
export { BankManager } from './bank-manager.js';

// Session Bootstrap
export type { BootstrapContext } from './session-bootstrap.js';
export { SessionBootstrap } from './session-bootstrap.js';

// Retention Engine
export type { RetentionConfig, WorkflowOutcome } from './retention-engine.js';
export { RetentionEngine } from './retention-engine.js';

// Compaction Flush
export type { FlushResult } from './compaction-flush.js';
export { CompactionFlush } from './compaction-flush.js';

// Session Summary
export { SessionSummarizer } from './session-summary.js';

// Mental Models
export { MentalModelManager } from './mental-models.js';
