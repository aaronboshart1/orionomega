/**
 * @module memory
 * Memory integration: the backend-neutral `MemoryStore` interface, the context
 * assembler that rebuilds the window each turn, and the orchestration-specific
 * pieces (retention during workflows, run artifact collection, session
 * summaries, telemetry).
 */

// Memory subsystem exports.
export type {
  MemoryStore,
  MemoryWrite,
  RecalledRecord,
  RecallQuery,
  RecallOutcome,
  RetainOutcome,
  ScopeInfo,
} from './store.js';

// There is no scope manager and no session bootstrap (§16). Scopes are
// implicit — nothing needs creating — durable facts are captured by explicit
// pins (memory_pin), and the per-turn orientation block is the Memory Map.

// Retention Engine (stays in core — needs EventBus, WorkerEvent types)
export type { RetentionConfig, WorkflowOutcome } from './retention-engine.js';
export { RetentionEngine, scoreMemoryQuality, computeImportance, isMemoryExpired, consolidateMemories } from './retention-engine.js';
export type { QualityScore } from './retention-engine.js';

// Run Artifact Collector — stores all .md files from completed runs to memory
export { RunArtifactCollector, collectRunArtifacts } from './run-artifact-collector.js';
export type { RunArtifactCollectorConfig, CollectionResult } from './run-artifact-collector.js';

// CompactionFlush deleted (§12.1): it salvaged context "before compaction
// discards them", but this system does not compact — its only entry point,
// MainAgent.flushMemory(), had zero callers repo-wide. memory_pin now serves
// the durable-facts role, explicitly and on demand.

// Session Summary (stays in core — needs AnthropicClient)
export { SessionSummarizer } from './session-summary.js';
export type { SummarizeResult, SummarizeSkipReason } from './session-summary.js';

// Context Assembler — hot window + budgeted recall + Memory Map, per turn
export { ContextAssembler } from "./context-assembler.js";
export type { AssembledContext, ContextAssemblerConfig, ConversationMessage } from "./context-assembler.js";

// Query Classifier — adaptive recall strategy per query type
export { isExternalAction } from "./query-classifier.js";

// Dynamic Summary Generator — on-demand project summaries from recalled memories

// Memory Telemetry — token efficiency, latency, dedup tracking
export {
  recordRecall, recordRetain, recordRetainDedup, recordError,
  getRecallEffectiveness, getBankEffectiveness, getAvgRecallLatency, getTokenEfficiency,
  getSnapshot, logTelemetrySummary, setMonitoringHook, resetTelemetry,
} from './memory-telemetry.js';
export type { BankCounters, TelemetrySnapshot, TelemetryEvent } from './memory-telemetry.js';
