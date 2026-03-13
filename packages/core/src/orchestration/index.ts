/**
 * @module orchestration
 * Orchestration system: types, graph utilities, event distribution,
 * state management, execution, planning, recovery, and commands.
 */

// Types
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
} from './types.js';

// Graph
export type { ValidationError } from './graph.js';
export { buildGraph, topologicalSort, validateGraph } from './graph.js';

// Event bus
export type { EventHandler, ThrottleConfig } from './event-bus.js';
export { EventBus } from './event-bus.js';

// State
export type { StateEntry } from './state.js';
export { WorkflowState } from './state.js';

// Worker
export type { WorkerResult } from './worker.js';
export { WorkerProcess } from './worker.js';

// Executor
export type { ExecutorConfig } from './executor.js';
export { GraphExecutor } from './executor.js';

// Planner
export type { PlannerConfig } from './planner.js';
export { Planner } from './planner.js';

// Recovery
export type { RecoverableWorkflow, RecoveryResult } from './recovery.js';
export { RecoveryManager } from './recovery.js';

// Commands
export type { OrchestratorCommandResult } from './commands.js';
export { OrchestratorCommands } from './commands.js';

export { executeCodingAgent } from "./agent-sdk-bridge.js";
export type { CodingAgentResult, CodingAgentConfig } from "./agent-sdk-bridge.js";

// Checkpoint
export { CheckpointManager } from './checkpoint.js';
export type {
  WorkflowCheckpoint, LoopNodeConfig, LoopExitCondition, AutonomousConfig, HumanGateAction,
  IntentTier, DAGDispatchInfo, DAGProgressInfo, DAGCompleteInfo, DAGConfirmInfo,
} from './types.js';
