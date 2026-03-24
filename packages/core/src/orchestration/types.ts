/**
 * @module orchestration/types
 * Type definitions for the OrionOmega orchestration system.
 * Covers workflow graphs, nodes, events, planning output, execution results,
 * loop control, checkpointing, and autonomous mode.
 */

/** The kind of node in a workflow graph. */
export type NodeType = 'AGENT' | 'TOOL' | 'ROUTER' | 'PARALLEL' | 'JOIN' | 'CODING_AGENT' | 'LOOP';

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

// ── Node Configs ────────────────────────────────────────────────────────────

/**
 * Configuration for a CODING_AGENT node.
 * Executed via the Claude Agent SDK — gets the full Claude Code toolset.
 */
export interface CodingAgentNodeConfig {
  task: string;
  model?: string;
  cwd?: string;
  additionalDirectories?: string[];
  systemPrompt?: string;
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  agents?: Record<string, { description: string; prompt: string; tools?: string[] }>;
}

/** Configuration for an agent-type node. */
export interface AgentConfig {
  model: string;
  systemPrompt?: string;
  task: string;
  tools?: string[];
  skillIds?: string[];
  tokenBudget?: number;
}

/** Configuration for a tool-type node. */
export interface ToolConfig {
  name: string;
  params: Record<string, unknown>;
}

/** Configuration for a router-type node. */
export interface RouterConfig {
  condition: string;
  routes: Record<string, string>;
}

/** How the LOOP node decides whether to continue iterating. */
export interface LoopExitCondition {
  /**
   * - 'output_match': exit when the last node's output matches the regex `pattern`.
   * - 'llm_judge': an LLM evaluates `judgePrompt` against the loop output.
   * - 'all_pass': exit when every body node completes without error.
   */
  type: 'output_match' | 'llm_judge' | 'all_pass';
  /** Regex pattern (for 'output_match'). */
  pattern?: string;
  /** Prompt for the LLM to evaluate (for 'llm_judge'). Receives body output as context. */
  judgePrompt?: string;
}

/**
 * Configuration for a LOOP node.
 * The body is a mini sub-graph that gets re-executed until the exit condition is met.
 */
export interface LoopNodeConfig {
  /** Nodes that form the loop body (executed per their own dependsOn within the body). */
  body: WorkflowNode[];
  /** Maximum iterations before forced exit (safety valve). */
  maxIterations: number;
  /** How to decide when to stop looping. */
  exitCondition: LoopExitCondition;
  /**
   * If true, the output of the last body node in iteration N is injected
   * as upstream context for body nodes in iteration N+1. Default: true.
   */
  carryForward?: boolean;
}

// ── Workflow Node ───────────────────────────────────────────────────────────

/** A single node in the workflow graph. */
export interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  agent?: AgentConfig;
  tool?: ToolConfig;
  router?: RouterConfig;
  codingAgent?: CodingAgentNodeConfig;
  loop?: LoopNodeConfig;
  timeout?: number;
  retries?: number;
  fallbackNodeId?: string;
  dependsOn: string[];

  // Runtime state
  status: NodeStatus;
  startedAt?: string;
  completedAt?: string;
  output?: unknown;
  error?: string;
  progress?: number;
}

// ── Workflow Graph ──────────────────────────────────────────────────────────

export interface WorkflowGraph {
  id: string;
  name: string;
  createdAt: string;
  nodes: Map<string, WorkflowNode>;
  layers: string[][];
  entryNodes: string[];
  exitNodes: string[];
}

// ── Events ──────────────────────────────────────────────────────────────────

export interface WorkerEvent {
  /** Identifies which workflow this event belongs to. */
  workflowId?: string;
  workerId: string;
  nodeId: string;
  timestamp: string;
  type:
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'finding'
    | 'status'
    | 'error'
    | 'done'
    | 'loop_iteration'
    | 'replan';
  tool?: { name: string; action?: string; file?: string; summary: string };
  thinking?: string;
  progress?: number;
  message?: string;
  data?: unknown;
  error?: string;
}

// ── Graph State ─────────────────────────────────────────────────────────────

export interface GraphState {
  workflowId: string;
  name: string;
  status: WorkflowStatus;
  createdAt: string;
  elapsed: number;
  nodes: Record<string, WorkflowNode>;
  recentEvents: WorkerEvent[];
  completedLayers: number;
  totalLayers: number;
  estimatedCost?: number;
}

// ── Planner Output ──────────────────────────────────────────────────────────

export interface PlannerOutput {
  graph: WorkflowGraph;
  reasoning: string;
  estimatedCost: number;
  estimatedTime: number;
  summary: string;
}

// ── Execution Result ────────────────────────────────────────────────────────

/** Per-model token usage and cost summary. */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  workerCount: number;
  costUsd: number;
}

export interface ExecutionResult {
  workflowId: string;
  status: 'complete' | 'error' | 'stopped';
  taskSummary: string;
  outputPaths: string[];
  durationSec: number;
  workerCount: number;
  estimatedCost: number;
  decisions: string[];
  findings: string[];
  errors: { worker: string; message: string; resolution?: string }[];
  nodeOutputs?: Record<string, string>;
  /** Concise final results per node (from SDK result message). Prefer over nodeOutputs for display. */
  nodeFinalResults?: Record<string, string>;
  infraChanges?: string[];
  /** Per-model token usage breakdown. */
  modelUsage?: ModelUsage[];
  /** Total cost in USD. */
  totalCostUsd?: number;
}

// ── Checkpointing ───────────────────────────────────────────────────────────

/** Serializable snapshot of a workflow for resume-on-crash. */
export interface WorkflowCheckpoint {
  /** Workflow ID. */
  workflowId: string;
  /** Original task description. */
  task: string;
  /** ISO timestamp of the checkpoint. */
  timestamp: string;
  /** Serialized graph (nodes as Record, not Map). */
  graph: {
    id: string;
    name: string;
    createdAt: string;
    nodes: Record<string, WorkflowNode>;
    layers: string[][];
    entryNodes: string[];
    exitNodes: string[];
  };
  /** Completed node outputs keyed by node ID. */
  nodeOutputs: Record<string, string>;
  /** Current layer index. */
  currentLayer: number;
  /** Workflow status at checkpoint time. */
  status: WorkflowStatus;
  /** Files generated so far. */
  outputPaths: string[];
  /** Accumulated decisions/findings. */
  decisions: string[];
  findings: string[];
  errors: { worker: string; message: string; resolution?: string }[];
}

// ── DAG Dispatch Info ────────────────────────────────────────────────────────

/** Intent classification tiers for the conversational DAG system. */
export type IntentTier = 'CHAT' | 'ACTION' | 'ORCHESTRATE';

/** Info emitted when a DAG is dispatched for execution. */
export interface DAGDispatchInfo {
  workflowId: string;
  workflowName: string;
  nodeCount: number;
  estimatedTime: number;
  estimatedCost: number;
  summary: string;
  nodes: Array<{ id: string; label: string; type: string }>;
}

/** Info emitted for inline DAG progress updates. */
export interface DAGProgressInfo {
  workflowId: string;
  nodeId: string;
  nodeLabel: string;
  status: 'started' | 'progress' | 'done' | 'error';
  message?: string;
  progress?: number;
  layerProgress?: { completed: number; total: number };
}

/** Info emitted when a DAG execution completes. */
export interface DAGCompleteInfo {
  workflowId: string;
  status: 'complete' | 'error' | 'stopped';
  summary: string;
  output?: string;
  findings?: string[];
  outputPaths?: string[];
  durationSec: number;
  workerCount: number;
  totalCostUsd: number;
  modelUsage?: ModelUsage[];
}

/** Info emitted when a guarded DAG needs user confirmation. */
export interface DAGConfirmInfo {
  workflowId: string;
  summary: string;
  reasoning: string;
  estimatedCost: number;
  estimatedTime: number;
  nodes: Array<{ id: string; label: string; type: string }>;
  guardedActions: string[];
}

// ── Autonomous Mode ─────────────────────────────────────────────────────────

/** Actions that require human approval before proceeding. */
export type HumanGateAction =
  | 'deploy'
  | 'merge'
  | 'delete'
  | 'publish'
  | 'send_email'
  | 'create_vm'
  | 'destroy_vm'
  | string;

/** Configuration for autonomous execution mode. */
export interface AutonomousConfig {
  /** Whether autonomous mode is active. */
  enabled: boolean;
  /** Maximum total spend across the autonomous session (USD). */
  maxBudgetUsd: number;
  /** Maximum duration in minutes. */
  maxDurationMinutes: number;
  /** How often to emit progress summaries (minutes). */
  progressIntervalMinutes: number;
  /** Actions that require human confirmation before executing. */
  humanGates: HumanGateAction[];
  /**
   * If true, on workflow completion the executor checks for queued follow-up tasks
   * and automatically starts the next one. Default: true.
   */
  autoAdvance: boolean;
}
