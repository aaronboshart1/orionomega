/**
 * @module orchestration/types
 * Type definitions for the OrionOmega orchestration system.
 * Covers workflow graphs, nodes, events, planning output, execution results,
 * loop control, checkpointing, and autonomous mode.
 */

/** The kind of node in a workflow graph. */
export type NodeType = 'AGENT' | 'TOOL' | 'ROUTER' | 'PARALLEL' | 'JOIN' | 'CODING_AGENT' | 'LOOP' | 'MACRO_NODE';

/**
 * Task #197 — Hierarchical macro planning.
 *
 * A MACRO_NODE is a placeholder emitted by the macro planner for a single
 * spec phase. It carries enough metadata for a per-node sub-planner to
 * expand it into a concrete sub-DAG at execution time. The executor
 * detects MACRO_NODE nodes in each layer and splices the resulting
 * sub-DAG into the live graph, rewriting downstream `dependsOn` edges
 * to fan-in across the sub-DAG's exit nodes.
 *
 * The macro layer keeps the top-level plan small enough to fit inside
 * the planner LLM's output budget for very large multi-phase specs (the
 * Cannabis MSO Legal Operations Platform is the canonical 17-phase /
 * ~150 KB stress case that motivated the feature).
 *
 * Phase BODIES are deliberately NOT carried on this struct — we keep
 * the planner LLM's output payload tiny by referencing the spec /
 * phase by id only. The executor resolves the body at expansion time
 * from the trusted preloaded `SpecReference` list (see
 * `ExecutorConfig.macroExpansionCallback`'s closure in
 * `OrchestrationBridge.executePlan`). This addresses the "primary
 * objective regression" raised by the Task #197 code review — putting
 * 150 KB of phase bodies back into the planner's TOOL output would
 * have re-triggered the very `stop_reason=max_tokens` failure the
 * macro plan was designed to avoid.
 */
export interface MacroNodeConfig {
  /** The spec reference token from the user's task (e.g. `SPEC.md`). */
  specRef: string;
  /** Stable phase id (e.g. `phase-1`). */
  phaseId: string;
  /** Phase title (heading text). Cosmetic — used for labels / logs. */
  phaseTitle: string;
  /** Other macro phase ids this phase depends on (mirrors WorkflowNode.dependsOn). */
  phaseDependsOn?: string[];
}

/** Runtime status of a single workflow node. */
export type NodeStatus =
  | 'pending'
  | 'waiting'
  | 'running'
  | 'done'
  | 'error'
  | 'skipped'
  | 'cancelled';

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
  /** Task #197: Set when `type === 'MACRO_NODE'`. */
  macro?: MacroNodeConfig;
  timeout?: number;
  retries?: number;
  fallbackNodeId?: string;
  dependsOn: string[];
  /** Optional Coding Mode metadata overlay (added by CodingPlanner). */
  codingConfig?: import('./coding/coding-types.js').CodingNodeConfig;

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
    | 'replan'
    | 'macro_expansion_started'
    | 'macro_expansion_complete'
    | 'macro_expansion_failed';
  tool?: { name: string; action?: string; file?: string; summary: string; id?: string };
  thinking?: string;
  progress?: number;
  message?: string;
  data?: unknown;
  error?: string;
  /** Coding Mode: file lock lifecycle event. */
  fileLock?: {
    action: 'acquire' | 'release' | 'conflict' | 'timeout';
    files: string[];
    holder?: string;
  };
  /**
   * Task #199: macro-expansion progress payload, set on the three
   * `macro_expansion_*` event types so the orchestration UI can render
   * a "Sub-planning…" panel while the executor is splicing per-phase
   * sub-DAGs into the live graph.
   */
  macro?: {
    macroNodeId: string;
    specRef: string;
    phaseId: string;
    phaseTitle: string;
    /** Index into the current expansion batch (1-based) and the batch size. */
    index: number;
    total: number;
    /** Set on `macro_expansion_complete` — number of sub-nodes spliced in. */
    subNodeCount?: number;
    /**
     * Task #201: ids of the sub-nodes spliced in by this expansion, in
     * the order returned by the sub-planner. Populated on
     * `macro_expansion_complete` so the UI's MacroExpansionPanel can
     * deep-link a row to the first spliced sub-node once the macro
     * itself has been removed from the live graph.
     */
    subNodeIds?: string[];
    /** Set on `macro_expansion_failed`. */
    error?: string;
  };
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
  nodeOutputPaths?: Record<string, string[]>;
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
  /** Total tool calls across all workers. */
  toolCallCount?: number;
  /**
   * Task #197: hierarchical macro-planning telemetry. Populated only
   * when the run included MACRO_NODE expansion; absent otherwise so
   * existing summaries stay visually identical for the common path.
   */
  macroPlanning?: MacroPlanningStats;
}

/**
 * Task #197: per-run macro-planning telemetry surfaced into
 * `run-summary.json/md` for diagnosing very-large-spec dispatches.
 */
export interface MacroPlanningStats {
  /** Number of MACRO_NODE expansions attempted (incl. failures). */
  expansionsAttempted: number;
  /** Number of MACRO_NODE expansions that succeeded (sub-DAG spliced). */
  expansionsSucceeded: number;
  /** Total sub-nodes added to the live graph across all expansions. */
  subNodesAdded: number;
  /** Per-expansion breakdown for inspection. */
  expansions: MacroExpansionRecord[];
}

export interface MacroExpansionRecord {
  /** The MACRO_NODE id that was expanded (or attempted). */
  macroNodeId: string;
  /** Spec reference + phase id, mirroring the bridge's lookup key. */
  specRef: string;
  phaseId: string;
  phaseTitle: string;
  /** Number of sub-nodes the sub-planner returned (0 on failure). */
  subNodeCount: number;
  /**
   * Per-pass sub-planner token usage when the callback reports it (the
   * bridge-wired callback always does; ad-hoc test callbacks may not).
   * Surfaced into run-summary so operators can tune phase sizes.
   */
  inputTokens?: number;
  outputTokens?: number;
  /** Populated on failure. */
  error?: string;
}

/**
 * Task #197: richer macro-expansion callback return shape so the
 * executor can record per-pass token usage. The simple
 * `WorkflowNode[]` return remains supported as the back-compat path
 * for ad-hoc / test callbacks that don't have token info.
 */
export interface MacroExpansionResult {
  nodes: WorkflowNode[];
  usage?: { inputTokens: number; outputTokens: number };
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
  /** Coding Mode: persisted file lock state for resume-after-crash. */
  fileLockState?: Record<string, { holder: string; files: string[] }>;
  /** Coding Mode: the template that was selected for this workflow. */
  codingModeTemplate?: import('./coding/coding-types.js').CodingDAGTemplate;
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
  nodes: Array<{ id: string; label: string; type: string; dependsOn?: string[] }>;
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
  /** Tool call data forwarded from the underlying WorkerEvent */
  tool?: { name: string; action?: string; file?: string; summary?: string };
  /** Worker ID that emitted this progress */
  workerId?: string;
}

/** Info emitted when a DAG execution completes. */
export interface DAGCompleteInfo {
  workflowId: string;
  status: 'complete' | 'error' | 'stopped';
  summary: string;
  output?: string;
  findings?: string[];
  outputPaths?: string[];
  nodeOutputPaths?: Record<string, string[]>;
  durationSec: number;
  workerCount: number;
  totalCostUsd: number;
  modelUsage?: ModelUsage[];
  toolCallCount?: number;
}


/** Info emitted when a direct (non-DAG) conversation turn completes with stats. */
export interface DirectCompleteInfo {
  /** Unique ID for this direct run. */
  runId: string;
  /** Model used for the response. */
  model: string;
  /** Duration of the response in seconds. */
  durationSec: number;
  /** Per-model token usage (single entry for direct mode). */
  modelUsage: ModelUsage[];
  /** Total cost in USD for this turn. */
  totalCostUsd: number;
  /** Set when the run terminated abnormally; UI should show error state. */
  error?: string;
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
