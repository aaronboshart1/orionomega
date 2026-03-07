/**
 * @module @orionomega/core
 * Core package for OrionOmega — configuration, orchestration types, and utilities.
 */

// Configuration
export type { OrionOmegaConfig } from './config/index.js';
export {
  readConfig,
  writeConfig,
  getConfigPath,
  getDefaultConfig,
} from './config/index.js';

// Orchestration types
export type {
  NodeType,
  NodeStatus,
  WorkflowStatus,
  AgentConfig,
  ToolConfig,
  RouterConfig,
  WorkflowNode,
  WorkflowGraph,
  WorkerEvent,
  GraphState,
  PlannerOutput,
  ExecutionResult,
} from './orchestration/index.js';

// Orchestration utilities
export type { ValidationError } from './orchestration/index.js';
export { buildGraph, topologicalSort, validateGraph } from './orchestration/index.js';

// Event bus
export type { EventHandler, ThrottleConfig } from './orchestration/index.js';
export { EventBus } from './orchestration/index.js';

// State management
export type { StateEntry } from './orchestration/index.js';
export { WorkflowState } from './orchestration/index.js';

// Worker
export type { WorkerResult } from './orchestration/index.js';
export { WorkerProcess } from './orchestration/index.js';

// Executor
export type { ExecutorConfig } from './orchestration/index.js';
export { GraphExecutor } from './orchestration/index.js';

// Planner
export type { PlannerConfig } from './orchestration/index.js';
export { Planner } from './orchestration/index.js';

// Recovery
export type { RecoverableWorkflow, RecoveryResult } from './orchestration/index.js';
export { RecoveryManager } from './orchestration/index.js';

// Commands
export type { OrchestratorCommandResult } from './orchestration/index.js';
export { OrchestratorCommands } from './orchestration/index.js';

// Logging
export type { Logger, LogLevel } from './logging/index.js';
export { createLogger, setGlobalLogLevel, getGlobalLogLevel } from './logging/index.js';

// Anthropic API integration
export { AnthropicClient, getBuiltInTools, runAgentLoop } from './anthropic/index.js';
export type {
  AnthropicMessage,
  ContentBlock,
  ToolDefinition,
  AnthropicStreamEvent,
  CreateMessageOptions,
  MessageResponse,
  BuiltInTool,
  ToolContext,
  AgentLoopOptions,
  AgentLoopResult,
} from './anthropic/index.js';

// Agent
export type { MainAgentConfig, MainAgentCallbacks, PromptContext } from './agent/index.js';
export { MainAgent, buildSystemPrompt } from './agent/index.js';

// Memory
export type { BootstrapContext, RetentionConfig, WorkflowOutcome, FlushResult } from './memory/index.js';
export {
  BankManager,
  SessionBootstrap,
  RetentionEngine,
  MentalModelManager,
  SessionSummarizer,
  CompactionFlush,
} from './memory/index.js';

export { discoverModels, buildModelGuide, pickModelByTier, clearModelCache } from "./models/model-discovery.js";
export type { DiscoveredModel } from "./models/model-discovery.js";
