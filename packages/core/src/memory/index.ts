/**
 * @module memory
 * Memory integration. Generic Hindsight operations (bank management, mental models,
 * session bootstrap) live in @orionomega/hindsight. Orchestration-specific memory
 * features (retention during workflows, compaction flush, session summaries) stay here.
 */

// Re-export from @orionomega/hindsight (these modules moved there for clean boundaries)
export { BankManager, MentalModelManager, SessionBootstrap } from '@orionomega/hindsight';
export type { BootstrapContext } from '@orionomega/hindsight';

// Retention Engine (stays in core — needs EventBus, WorkerEvent types)
export type { RetentionConfig, WorkflowOutcome } from './retention-engine.js';
export { RetentionEngine, scoreMemoryQuality, computeImportance, isMemoryExpired, consolidateMemories } from './retention-engine.js';
export type { QualityScore } from './retention-engine.js';

// Run Artifact Collector — stores all .md files from completed runs to Hindsight
export { RunArtifactCollector, collectRunArtifacts } from './run-artifact-collector.js';
export type { RunArtifactCollectorConfig, CollectionResult } from './run-artifact-collector.js';

// Compaction Flush (stays in core — needs AnthropicClient)
export type { FlushResult } from './compaction-flush.js';
export { CompactionFlush } from './compaction-flush.js';

// Session Summary (stays in core — needs AnthropicClient)
export { SessionSummarizer } from './session-summary.js';

// Context Assembler — hot window + Hindsight recall for token-aware context
export { ContextAssembler } from "./context-assembler.js";
export type { AssembledContext, ContextAssemblerConfig, ConversationMessage, ConfidenceSummary } from "./context-assembler.js";

// Query Classifier — adaptive recall strategy per query type
export { classifyQuery, getRecallStrategy } from "./query-classifier.js";
export type { QueryType, QueryClassification, RecallStrategy } from "./query-classifier.js";

// Dynamic Summary Generator — on-demand project summaries from recalled memories
export { DynamicSummaryGenerator } from "./dynamic-summary.js";
export type { DynamicSummaryOptions, DynamicSummaryResult } from "./dynamic-summary.js";

// Memory Telemetry — token efficiency, latency, dedup tracking
export {
  recordRecall, recordRetain, recordRetainDedup, recordError,
  getRecallEffectiveness, getBankEffectiveness, getAvgRecallLatency, getTokenEfficiency,
  getSnapshot, logTelemetrySummary, setMonitoringHook, resetTelemetry,
} from './memory-telemetry.js';
export type { BankCounters, TelemetrySnapshot, TelemetryEvent } from './memory-telemetry.js';
