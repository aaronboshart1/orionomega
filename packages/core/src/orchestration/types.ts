/**
 * @module orchestration/types
 * Type definitions for the OrionOmega orchestration system.
 * Covers workflow graphs, nodes, events, planning output, and execution results.
 */

/** The kind of node in a workflow graph. */
export type NodeType = 'AGENT' | 'TOOL' | 'ROUTER' | 'PARALLEL' | 'JOIN';

/** Runtime status of a single workflow node. */
export type NodeStatus =
  | 'pending'
  | 'waiting'
  | 'running'
  | 'done'
  | 'error'
  | 'skipped';

/** Overall status of a workflow execution. */
export type WorkflowStatus =
  | 'planning'
  | 'planned'
  | 'running'
  | 'paused'
  | 'complete'
  | 'error'
  | 'stopped';

/** Configuration for an agent-type node. */
export interface AgentConfig {
  /** Model identifier (e.g. 'claude-sonnet-4-20250514'). */
  model: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** The task description for the agent. */
  task: string;
  /** Tool names available to the agent. */
  tools?: string[];
  /** Skill IDs to load for the agent. */
  skillIds?: string[];
  /**
   * Maximum input tokens this worker may consume before being stopped.
   * At 80% a warning is injected; at 100% the loop halts gracefully.
   * If unset, defaults are applied by tier: haiku=100K, sonnet=300K, opus=500K.
   */
  tokenBudget?: number;
}

/** Configuration for a tool-type node. */
export interface ToolConfig {
  /** Tool name. */
  name: string;
  /** Parameters to pass to the tool. */
  params: Record<string, unknown>;
}

/** Configuration for a router-type node. */
export interface RouterConfig {
  /** Condition expression to evaluate. */
  condition: string;
  /** Mapping of condition results to target node IDs. */
  routes: Record<string, string>;
}

/** A single node in the workflow graph. */
export interface WorkflowNode {
  /** Unique node identifier. */
  id: string;
  /** Node type. */
  type: NodeType;
  /** Human-readable label. */
  label: string;
  /** Agent configuration (when type is 'AGENT'). */
  agent?: AgentConfig;
  /** Tool configuration (when type is 'TOOL'). */
  tool?: ToolConfig;
  /** Router configuration (when type is 'ROUTER'). */
  router?: RouterConfig;
  /** Execution timeout in seconds. */
  timeout?: number;
  /** Maximum retry attempts. */
  retries?: number;
  /** Node ID to execute if this node fails. */
  fallbackNodeId?: string;
  /** IDs of nodes that must complete before this one starts. */
  dependsOn: string[];

  // Runtime state

  /** Current execution status. */
  status: NodeStatus;
  /** ISO timestamp when execution started. */
  startedAt?: string;
  /** ISO timestamp when execution completed. */
  completedAt?: string;
  /** Node output data. */
  output?: unknown;
  /** Error message if status is 'error'. */
  error?: string;
  /** Progress percentage (0–100). */
  progress?: number;
}

/** The complete workflow graph with topology metadata. */
export interface WorkflowGraph {
  /** Unique workflow identifier. */
  id: string;
  /** Human-readable workflow name. */
  name: string;
  /** ISO timestamp of graph creation. */
  createdAt: string;
  /** All nodes keyed by ID. */
  nodes: Map<string, WorkflowNode>;
  /** Topologically sorted parallel layers (each layer is a list of node IDs). */
  layers: string[][];
  /** Node IDs with no dependencies (graph entry points). */
  entryNodes: string[];
  /** Node IDs with no dependents (graph exit points). */
  exitNodes: string[];
}

/** An event emitted by a worker during execution. */
export interface WorkerEvent {
  /** Worker identifier. */
  workerId: string;
  /** ID of the node being executed. */
  nodeId: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Event type. */
  type:
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'finding'
    | 'status'
    | 'error'
    | 'done';
  /** Tool invocation details (for tool_call / tool_result events). */
  tool?: {
    name: string;
    action?: string;
    file?: string;
    summary: string;
  };
  /** Thinking content. */
  thinking?: string;
  /** Progress percentage (0–100). */
  progress?: number;
  /** Human-readable message. */
  message?: string;
  /** Arbitrary event data. */
  data?: unknown;
  /** Error message (for error events). */
  error?: string;
}

/** Snapshot of the current workflow execution state. */
export interface GraphState {
  /** Workflow identifier. */
  workflowId: string;
  /** Workflow name. */
  name: string;
  /** Current workflow status. */
  status: WorkflowStatus;
  /** ISO timestamp of workflow creation. */
  createdAt: string;
  /** Elapsed time in seconds. */
  elapsed: number;
  /** All nodes keyed by ID (serialisable record form). */
  nodes: Record<string, WorkflowNode>;
  /** Recent worker events. */
  recentEvents: WorkerEvent[];
  /** Number of completed topological layers. */
  completedLayers: number;
  /** Total number of topological layers. */
  totalLayers: number;
  /** Estimated cost so far. */
  estimatedCost?: number;
}

/** Output from the planner phase. */
export interface PlannerOutput {
  /** The generated workflow graph. */
  graph: WorkflowGraph;
  /** Planner's reasoning for the decomposition. */
  reasoning: string;
  /** Estimated cost in dollars. */
  estimatedCost: number;
  /** Estimated execution time in seconds. */
  estimatedTime: number;
  /** Human-readable plan summary. */
  summary: string;
}

/** Final result of a workflow execution. */
export interface ExecutionResult {
  /** Workflow identifier. */
  workflowId: string;
  /** Terminal status. */
  status: 'complete' | 'error' | 'stopped';
  /** Summary of the task that was executed. */
  taskSummary: string;
  /** Paths to output files. */
  outputPaths: string[];
  /** Total duration in seconds. */
  durationSec: number;
  /** Number of workers spawned. */
  workerCount: number;
  /** Estimated total cost. */
  estimatedCost: number;
  /** Key decisions made during execution. */
  decisions: string[];
  /** Notable findings. */
  findings: string[];
  /** Errors encountered. */
  errors: { worker: string; message: string; resolution?: string }[];
  /** Output text from each completed node, keyed by node ID. */
  nodeOutputs?: Record<string, string>;
  /** Infrastructure changes made (if any). */
  infraChanges?: string[];
}
