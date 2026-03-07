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
export { RetentionEngine } from './retention-engine.js';

// Compaction Flush (stays in core — needs AnthropicClient)
export type { FlushResult } from './compaction-flush.js';
export { CompactionFlush } from './compaction-flush.js';

// Session Summary (stays in core — needs AnthropicClient)
export { SessionSummarizer } from './session-summary.js';

// Context Assembler — hot window + Hindsight recall for token-aware context
export { ContextAssembler } from "./context-assembler.js";
export type { AssembledContext, ContextAssemblerConfig, ConversationMessage } from "./context-assembler.js";
