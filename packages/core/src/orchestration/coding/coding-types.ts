/**
 * @module orchestration/coding/coding-types
 * Canonical type definitions for Coding Mode.
 *
 * These types extend the core orchestration types with coding-specific
 * metadata: roles, file scopes, budget allocations, and typed node outputs.
 */

import type { CodingAgentNodeConfig, WorkflowNode } from '../types.js';

// Import test-result types for local use and re-export for consumers.
import type {
  TestFramework,
  FailureCategory,
  FailureClassification,
  TestFailure,
  TestResults,
  TestFrameworkConfig,
  ProjectProfile,
} from './test-result-parser.js';

export type {
  TestFramework,
  FailureCategory,
  FailureClassification,
  TestFailure,
  TestResults,
  TestFrameworkConfig,
  ProjectProfile,
};

// ── Coding Roles ─────────────────────────────────────────────────────────────

/**
 * The specialized role a coding node plays in a Coding Mode DAG.
 * Each role maps to a distinct system prompt, model tier, and file permission set.
 */
export type CodingRole =
  | 'codebase-scanner'   // Read-only analysis of project structure
  | 'architect'           // Design decisions; no file writes
  | 'implementer'         // Code generation and file modification
  | 'stitcher'            // Cross-file conflict resolution after parallel impl
  | 'test-writer'         // Test generation
  | 'validator'           // Build/test/lint execution (TOOL node, no LLM)
  | 'reviewer'            // Code review analysis
  | 'debugger'            // Error diagnosis and targeted fix (xhigh thinking)
  | 'review-gate'         // Risk-tiered approval gate ROUTER node (no LLM)
  | 'reporter';           // Summary generation

// ── DAG Templates ────────────────────────────────────────────────────────────

/** The five canonical Coding Mode DAG templates. */
export type CodingDAGTemplate =
  | 'feature-implementation'
  | 'bug-fix'
  | 'refactor'
  | 'test-suite'
  | 'review-iterate';

// ── File Scope ───────────────────────────────────────────────────────────────

/**
 * Defines the file access permissions for a coding node.
 * Used by FileLockManager to enforce exclusive write access.
 */
export interface FileScope {
  /** Files this node may write to exclusively. Requires lock acquisition. */
  owned: string[];
  /** Additional files this node may read (no lock required). */
  readable: string[];
  /** Glob pattern for dynamic file discovery (resolved at runtime). */
  pattern?: string;
  /** Whether file lock coordination is required before execution. */
  lockRequired: boolean;
}

// ── Node Configuration ────────────────────────────────────────────────────────

/** Configuration for a validation run (build/test/lint). */
export interface ValidationConfig {
  /** Shell commands to run, e.g. ['npm test', 'npm run lint']. */
  commands: string[];
  /** Regex pattern that indicates success in command output. */
  successPattern?: string;
  /** Regex pattern that indicates failure in command output. */
  failurePattern?: string;
  /** Maximum retry attempts before declaring validation failed. */
  maxRetries: number;
  /** Per-command timeout in milliseconds. */
  timeout: number;
}

/**
 * Extended configuration for a CODING_AGENT node in Coding Mode.
 * Adds role, file scope, and optional validation config to the base config.
 */
export interface CodingNodeConfig extends CodingAgentNodeConfig {
  /** The role this node plays in the Coding Mode DAG. */
  codingRole: CodingRole;
  /** File access permissions for this node. */
  fileScope: FileScope;
  /** Validation configuration (only for validator nodes). */
  validationConfig?: ValidationConfig;
}

// ── Coding Mode Top-Level Config ──────────────────────────────────────────────

/** Top-level Coding Mode configuration (lives in OrionOmegaConfig). */
export interface CodingModeConfig {
  /** Whether Coding Mode is active. Defaults to true. */
  enabled: boolean;
  /** Maximum parallel coding agent workers. Default: 8. */
  maxParallelAgents: number;
  /** Enable/disable individual templates. */
  templates: Record<CodingDAGTemplate, boolean>;
  /** Per-role model ID overrides (optional; default from model strategy). */
  models: Partial<Record<CodingRole, string>>;
  /** Validation settings. */
  validation: {
    /** Automatically run validation after implementation. Default: true. */
    autoRun: boolean;
    /**
     * Default validation commands. Empty = auto-detect from package.json/Makefile.
     */
    commands: string[];
  };
  /** Multiply all budget allocations by this factor. Default: 1.0. */
  budgetMultiplier: number;
  /**
   * Complexity-aware tier routing (Task #245). When enabled, low-complexity
   * phases default to a cheaper tier while hard phases still escalate to Opus.
   * Omitted/undefined = enabled (the default).
   */
  tierRouting?: {
    /** Master switch. Default: true. */
    enabled: boolean;
  };
}

/**
 * Full Coding Mode configuration (Appendix A of the system spec).
 * Supersedes CodingModeConfig with richer fields for all features.
 */
export interface OrionOmegaCodingConfig {
  /** Model overrides per role. */
  models: Partial<Record<CodingRole, string>>;

  /** Validation configuration. */
  validation: {
    /** Override auto-detected validation commands. */
    commands?: string[];
    /** Run validation automatically after implementation. Default: true. */
    autoRun: boolean;
    /** Max fix-retry iterations. Default: 3. */
    maxRetries: number;
  };

  /** Maximum parallel coding agent workers. Default: 8. */
  maxParallelAgents: number;
  /** Scale all USD caps by this factor. Default: 1.0. */
  budgetMultiplier: number;
  /** Hard USD cap per session. Default: 25.0. */
  sessionMaxUsd: number;
  /** Max session duration in seconds. Default: 7200. */
  maxDuration: number;

  /** Feature flags. */
  features: {
    /** Enable AST + dependency graph codebase indexing. Default: true. */
    codebaseIndexing: boolean;
    /** Enable embedding-based semantic search. Default: false. */
    embeddingSearch: boolean;
    /** Enable background (async) coding sessions. Default: false. */
    backgroundSessions: boolean;
    /** Enable speculative parallel branching. Default: false. */
    speculativeBranching: boolean;
    /** Enable CI/CD integration. Default: false. */
    ciIntegration: boolean;
  };

  /** Approval gate configuration. */
  approvalGate: {
    /** Auto-approve up to this risk level (inclusive). Default: 'low'. */
    autoApproveRiskLevel: 'low' | 'medium' | 'high' | 'none';
    /** Always require human review regardless of risk level. */
    requireHumanReview: boolean;
  };

  /** Workspace root directory. */
  workspaceDir: string;
  /** Directory for session checkpoint files. */
  checkpointDir: string;
  /** Directory for codebase index (SQLite). */
  indexDir: string;
}

// ── Node Output Types ─────────────────────────────────────────────────────────

/** Output produced by the codebase-scanner node. */
export interface CodebaseScanOutput {
  /** Primary programming language detected. */
  language: string;
  /** Framework detected (e.g. 'Next.js', 'Express', null). */
  framework: string | null;
  /** Test framework detected (e.g. 'jest', 'vitest', null). */
  testFramework: string | null;
  /** Build system detected (e.g. 'tsc', 'webpack', null). */
  buildSystem: string | null;
  /** Lint command detected (e.g. 'eslint .', null). */
  lintCommand: string | null;
  /** Human-readable directory tree summary (trimmed). */
  projectStructure: string;
  /** Files relevant to the coding task. */
  relevantFiles: Array<{
    path: string;
    role: 'source' | 'test' | 'config' | 'docs';
    complexity: 'low' | 'medium' | 'high';
    linesOfCode: number;
  }>;
  /** Application entry points. */
  entryPoints: string[];
  /** Runtime dependencies from package.json / requirements.txt etc. */
  dependencies: Record<string, string>;
}

/** Decision produced by the architect node for fan-out parallelism. */
export interface FanOutDecision {
  chunks: Array<{
    /** Unique chunk identifier (used to name impl-chunk-N nodes). */
    id: string;
    /** Human-readable label for the chunk. */
    label: string;
    /** Files this chunk owns exclusively (will acquire locks). */
    fileCluster: string[];
    /** Files that multiple chunks reference; stitcher resolves conflicts. */
    sharedFiles: string[];
    /** Specific instructions for the implementer assigned to this chunk. */
    task: string;
    /** Estimated complexity of this chunk. */
    estimatedComplexity: 'low' | 'medium' | 'high';
    /**
     * Task #174: Optional list of chunk IDs this chunk depends on. When
     * present, the executor serializes the chunk after its predecessors;
     * absent / empty keeps the historical all-parallel behaviour.
     * Used to honour explicit "Phase N depends on Phase M" language in
     * multi-phase specs that the planner pre-loaded.
     */
    dependsOn?: string[];
  }>;
  /** Effective parallelism, capped by worker pool maxConcurrency. */
  maxParallelism: number;

  // ── Spec §4.3 additive fields ─────────────────────────────────────────────
  /** High-level prose explaining why this decomposition was chosen. */
  approach?: string;
  /**
   * Inter-chunk dependency map: key = chunk ID, value = IDs of chunks that
   * must complete before this chunk starts (additive to per-chunk dependsOn).
   */
  taskDependencies?: Record<string, string[]>;
  /** Shared state / context injected into every chunk's prompt. */
  sharedContext?: Record<string, unknown>;
  /** High-level test strategy for the whole feature (e.g. "TDD", "integration-first"). */
  testStrategy?: string;
  /** Known risks or blockers the architect flagged for human awareness. */
  risks?: string[];
  /**
   * Number of human approvals required before execution proceeds.
   * 0 = auto-approve, 1 = standard review, 2 = critical-path double-sign-off.
   */
  requiredApprovals?: number;
  /**
   * Target level of parallelism requested by the architect.
   * Distinct from maxParallelism (which is the worker-pool cap).
   * The executor uses min(estimatedParallelism, maxParallelism).
   */
  estimatedParallelism?: number;
}

/**
 * A single concrete goal/requirement extracted from the user's task.
 * Used by the architect for plan-coverage checks and by the architect-reviewer
 * for per-goal post-implementation verification.
 */
export interface Requirement {
  /** Stable identifier (e.g. "req-1"). Used to map verdicts back. */
  id: string;
  /** Short human-readable description of what must be done. */
  description: string;
  /** Concrete acceptance criteria — what makes this requirement "met". */
  acceptance: string;
  /**
   * Chunk IDs (or file change indices) that the architect mapped this
   * requirement to. Used by the planner to enforce coverage.
   */
  coveredBy?: string[];
}

/**
 * Per-requirement verdict produced by the architect-reviewer after the
 * implementation loop has run. Used to force a `retask` when any required
 * goal is unmet, even when build/tests pass mechanically.
 */
export interface RequirementVerdict {
  /** Matches Requirement.id. */
  requirementId: string;
  /** Echo of the original description for downstream UIs. */
  description: string;
  /** Verdict from the goal-verification check. */
  status: 'met' | 'partially-met' | 'unmet' | 'unknown';
  /** Free-text evidence (file paths, log snippets, reasoning) that justified the verdict. */
  evidence: string;
  /** Reviewer confidence in this verdict (0.0–1.0). */
  confidence: number;
}

/** Output produced by the architect node. */
export interface ArchitectureDesignOutput {
  /** Prose description of the implementation approach. */
  approach: string;
  /**
   * Concrete requirements extracted from the user's task. Every requirement
   * must be mapped to at least one fan-out chunk or file change before the
   * planner releases the plan to the implementers; otherwise planning fails.
   */
  requirements: Requirement[];
  /** File-level change plan. */
  fileChanges: Array<{
    path: string;
    action: 'create' | 'modify' | 'delete' | 'rename';
    description: string;
    /** Which parallel chunk handles this file (0-indexed). */
    cluster: number;
  }>;
  /** Fan-out decision for parallel implementation nodes. */
  fanOut: FanOutDecision;
  /** Potential risks or blockers. */
  risks: string[];
  /** High-level test strategy. */
  testStrategy: string;
}

/** Output produced by an implementer node. */
export interface ImplementerOutput {
  filesModified: string[];
  filesCreated: string[];
  /** Brief description of what was done. */
  summary: string;
  /** Questions or ambiguities for the stitcher to resolve. */
  openQuestions: string[];
}

/** Output produced by the stitcher node. */
export interface StitcherOutput {
  conflictsResolved: number;
  filesModified: string[];
  /** Notes on integration decisions made. */
  integrationNotes: string;
}

/** Output produced by the validator node. */
export interface ValidatorOutput {
  /** Whether all validation commands passed. */
  passed: boolean;
  results: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
  /** Human-readable failure summary (present only when passed=false). */
  failureSummary?: string;
}

// ── Budget Types ──────────────────────────────────────────────────────────────

/** Per-role token and USD budget limits for coding agents (Section 5.6). */
export interface TokenBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
}

/** Session-level budget configuration. */
export interface SessionBudgetConfig {
  /** Hard cap for total session cost in USD. Default: 25.00. */
  sessionMaxUsd: number;
  /** Fraction of session budget reserved for retries (0–1). Default: 0.15. */
  retryReserve: number;
}

/** Per-node budget allocation. */
export interface NodeBudget {
  /** Maximum spend for this node in USD. */
  maxBudgetUsd: number;
  /** Input token estimate. */
  tokenBudget: number;
  /** Resolved model ID for this node. */
  model: string;
}

/** Full budget allocation across all nodes in a coding DAG. */
export interface BudgetAllocation {
  /** Per-node budget keyed by node ID. */
  perNode: Map<string, NodeBudget>;
  /** Amount held in reserve for retries and re-planning (USD). */
  reserve: number;
  /** Total estimated spend (sum of perNode + reserve). */
  estimated: number;
}

// ── Aggregation Types ─────────────────────────────────────────────────────────

/** A file conflict detected between parallel implementer outputs. */
export interface FileConflict {
  /** File path that was modified by multiple workers. */
  file: string;
  /** Worker IDs that modified this file. */
  workers: string[];
  /** Proposed resolution strategy. */
  resolution: 'needs-stitcher' | 'last-write-wins' | 'manual';
}

/** Merged output from parallel implementer nodes. */
export interface AggregatedOutput {
  allFilesModified: string[];
  allFilesCreated: string[];
  perWorkerSummaries: Array<{
    workerId: string;
    summary: string;
    filesModified: string[];
  }>;
  conflicts: FileConflict[];
}

// ── Lock Types ────────────────────────────────────────────────────────────────

/** Result of a file lock acquisition attempt. */
export interface AcquireResult {
  /** Whether all requested files were locked. */
  acquired: boolean;
  /** Files held by another worker (when acquired=false). */
  conflictingFiles?: string[];
  /** Worker ID that holds the conflicting lock. */
  conflictingWorker?: string;
}

/** Internal lock record (not exported). */
export interface FileLockRecord {
  holder: string;
  acquiredAt: string;
  files: Set<string>;
}

// ── Planner Output Extension ──────────────────────────────────────────────────

/** Extended planner output produced by CodingPlanner. */
export interface CodingPlannerOutput {
  /** The selected template. */
  template: CodingDAGTemplate;
  /** Codebase profile from the scanner node (populated after scan). */
  codebaseProfile?: CodebaseScanOutput;
  /** Budget allocation across all nodes. */
  budgetAllocation: BudgetAllocation;
  /** Model assignments per node ID. */
  modelAssignments: Map<string, { model: string; thinking: { type: string } }>;
  /** True if Layer 2 needs dynamic expansion from architect fan-out. */
  fanOutPending: boolean;
  /** Pre-built workflow nodes for the selected template. */
  nodes: WorkflowNode[];
}

// ── Quality Assurance Types ───────────────────────────────────────────────────

/** Risk tier for the approval gate ROUTER node. */
export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

/** A single file change in the diff-based approval package. */
export interface FileChange {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  linesAdded: number;
  linesRemoved: number;
  diff: string;
  rationale: string;

  // ── Spec §4.7 additive fields ─────────────────────────────────────────────
  /**
   * Spec-aligned operation name (create|modify|delete|rename).
   * Mirrors `action` but uses the canonical spec vocabulary.
   */
  operation?: 'create' | 'modify' | 'delete' | 'rename';
  /** Full previous file contents before the change (for 3-way merge). */
  oldContent?: string;
  /** Full new file contents after the change. */
  newContent?: string;
  /** Detected programming language of the file (e.g. 'typescript', 'python'). */
  language?: string;
}

/** A single issue identified during code review (Section 4.4). */
export interface ReviewIssue {
  severity: 'critical' | 'major' | 'minor' | 'nit';
  file: string;
  line: number;
  description: string;
  suggestedFix?: string;
}

/** Output produced by the reviewer node (code review verdict, Section 4.4). */
export interface ReviewResult {
  verdict: 'approve' | 'request_changes' | 'reject';
  issues: ReviewIssue[];
  suggestions: string[];
  securityConcerns: string[];
  performanceConcerns: string[];
}

/** A single SAST finding from the security scan step. */
export interface SecurityFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  rule: string;
  file: string;
  line: number;
  description: string;
}

/** Output from the security scan validation step (Step 6 of the QA pipeline). */
export interface SecurityResults {
  passed: boolean;
  issues: SecurityFinding[];
}

/** Full diff + metadata package presented at the review gate (Section 4.7). */
export interface ApprovalPackage {
  /** 1-line intent summary. */
  summary: string;
  riskLevel: RiskTier;
  filesChanged: FileChange[];
  testResults: TestResults;
  securityScanResults: SecurityResults;
  /** Why this approach was chosen (from the architect's output). */
  architectDecision: string;
  /** How to undo all changes. */
  rollbackPlan: string;
  estimatedImpact: string;

  // ── Spec §4.7 additive fields ─────────────────────────────────────────────
  /**
   * Spec-aligned file-change list (synonym for filesChanged).
   * Use `changes` in new code; `filesChanged` retained for backward compat.
   */
  changes?: FileChange[];
  /** Structured code-review verdict from the reviewer node. */
  reviewResult?: ReviewResult;
  /**
   * Overall confidence score (0–1) that the changes are correct and safe.
   * Aggregated from test coverage, reviewer approval, and security scan.
   */
  confidence?: number;
  /**
   * When true the approval gate must block and wait for human sign-off
   * before the commit step may proceed, regardless of risk tier.
   */
  requiresHumanReview?: boolean;
}

/**
 * Decision output from a ROUTER node (review-gate or DAG routing node).
 * Carries the selected route ID plus a rationale for traceability.
 *
 * Also doubles as the ROUTER node configuration when used as a node-level
 * config (spec §4.5): `condition` + `routes` + `defaultRoute` + `evaluator`
 * define how the router resolves; `selectedRoute` + `rationale` carry the
 * runtime result back to the orchestrator.
 */
export interface RouterDecision {
  /** The ID of the next node to execute (must match a key in router.routes). */
  selectedRoute: string;
  /** Human-readable rationale for the routing decision. */
  rationale: string;
  /** Optional metadata from the routing evaluation (e.g. risk score, flags). */
  metadata?: Record<string, unknown>;

  // ── Spec §4.5 router-node configuration fields (additive) ─────────────────
  /**
   * JSONata / simple expression evaluated against the DAG context to produce
   * a route key.  Example: `"riskTier"` evaluates the `riskTier` field of the
   * upstream node's output artifact.
   */
  condition?: string;
  /**
   * Map of condition-result value → target node ID.
   * Example: `{ low: 'auto-commit', high: 'human-review' }`.
   */
  routes?: Record<string, string>;
  /**
   * Node ID to route to when `condition` evaluates to a value not present
   * in `routes`, or when the evaluator throws.
   */
  defaultRoute?: string;
  /**
   * Strategy used to evaluate `condition`.
   *   'expression' — simple field lookup / comparison (default)
   *   'llm'        — delegate evaluation to an LLM call
   *   'fn'         — call a registered custom evaluator function
   */
  evaluator?: 'expression' | 'llm' | 'fn';
}

/**
 * Escalation signal emitted by the debugger when a fix requires
 * architectural changes beyond its assigned files.
 */
export interface EscalationSignal {
  type: 'replan_required';
  reason: string;
  affectedFiles: string[];
  suggestedApproach: string;
}

// ── Dynamic DAG Adaptation Types ──────────────────────────────────────────────

/** Trigger conditions for dynamic DAG adaptation. */
export type DagAdaptationTrigger =
  | 'task_failure'          // Node returned error status → insert debugger
  | 'scope_expansion'       // Implementer reported additional_file_needed
  | 'validation_escalation' // Validation failed 2+ times → replan
  | 'review_override';      // User provided direct feedback

/** Describes a pending DAG adaptation to be applied by the orchestrator. */
export interface DagAdaptation {
  trigger: DagAdaptationTrigger;
  failedNodeId: string;
  /** The node(s) to insert into the live DAG. */
  insertNodes: WorkflowNode[];
  /** Existing node IDs whose dependsOn should be updated. */
  rewireDependencies: Array<{ nodeId: string; addDeps: string[] }>;
  /** Human-readable explanation for the UI / logs. */
  description: string;
}

// ── Review Gate Types ──────────────────────────────────────────────────────────

/**
 * Input context used to classify the risk tier of a coding session's changes.
 * Assembled by the orchestrator from DAG artifacts before the review-gate node runs.
 */
export interface ReviewGateInput {
  /** Complexity tier from the original intent classification. */
  complexityTier: 'trivial' | 'small' | 'medium' | 'large' | 'epic';
  /** All files modified by the session (relative paths). */
  filesChanged: string[];
  /**
   * Whether the architect flagged this change as requiring human review.
   * Maps to `FanOutDecision.risks.manualReviewRequired`.
   */
  manualReviewRequired: boolean;
  /** True when any changed file matches security-relevant patterns. */
  hasSecurityRelevantChanges: boolean;
  /** True when any changed file is a database migration. */
  hasDatabaseMigrations: boolean;
  /** True when any changed file is auth/session-related. */
  hasAuthChanges: boolean;
  /** True when any changed file is a deployment/infra config. */
  hasDeploymentConfigChanges: boolean;
  /** Whether the validation loop passed on its last iteration. */
  validationPassed: boolean;
}

/**
 * Decision produced by the review-gate risk classifier.
 * Determines whether execution auto-proceeds or blocks for human approval.
 */
export interface ReviewGateDecision {
  riskTier: RiskTier;
  /**
   * - `auto-approve`: proceed immediately (low risk)
   * - `notify-and-approve`: proceed but send notification (medium risk)
   * - `block-for-review`: pause and emit ApprovalPackage, require 1 approval (high)
   * - `block-require-2-approvals`: pause and require 2 separate approvals (critical)
   */
  action: 'auto-approve' | 'notify-and-approve' | 'block-for-review' | 'block-require-2-approvals';
  /** Human-readable rationale for this decision. */
  reason: string;
  /** Present when action is block-for-review or block-require-2-approvals. */
  approvalPackage?: ApprovalPackage;
}

// ── Confidence Indicator Types ─────────────────────────────────────────────────

/**
 * Per-change confidence score displayed in the diff viewer (Section 9.5).
 * Color-coded: green (>0.8), yellow (0.5–0.8), red (<0.5).
 */
export interface ChangeConfidence {
  /** Composite score 0–1. Higher means more confident the change is correct. */
  overall: number;
  factors: {
    /** Fraction of changed lines covered by tests (0–1). */
    testsCovering: number;
    /** Whether the reviewer agent approved the change. */
    reviewerApproval: boolean;
    /** Whether the security scan found no issues. */
    securityClean: boolean;
    /** How well the change matches existing project conventions (0–1). */
    stylisticMatch: number;
    /** Risk contribution from change complexity (0–1; lower is better). */
    complexityRisk: number;
  };
  /** Human-readable explanation of the score rationale. */
  explanation: string;
}

// ── Progress Event Types ───────────────────────────────────────────────────────

/**
 * Real-time progress event emitted via WebSocket during a coding session
 * (Section 4.5). Carries phase, status, and optional telemetry fields.
 */
export interface CodingProgressEvent {
  sessionId: string;
  phase:
    | 'repo-setup'
    | 'scanning'
    | 'designing'
    | 'implementing'
    | 'testing'
    | 'reviewing'
    | 'review-gate'
    | 'committing';
  status: 'started' | 'in-progress' | 'completed' | 'failed';
  nodeId?: string;
  message: string;
  /** 0–100 completion percentage. */
  progress?: number;
  /** Number of agents currently executing in this layer. */
  activeAgents?: number;
  /** Total agents in the current DAG layer. */
  totalAgents?: number;
  /** Cumulative input + output tokens used so far in this session. */
  tokensUsed?: TokenUsage;
  /** Cumulative cost in USD for this session so far. */
  costUsd?: number;
  /** Session budget ceiling in USD. */
  budgetUsd?: number;
  /** Short preview of the architect's plan (present during 'designing' phase). */
  planPreview?: string;
  /** Populated when phase='review-gate'; triggers the approval modal. */
  approvalPackage?: ApprovalPackage;
  /** Progressive disclosure level requested by this event (1–4). */
  disclosureLevel?: 1 | 2 | 3 | 4;

  // ── Spec §4.5 additive fields ─────────────────────────────────────────────
  /** The coding role of the node that emitted this event. */
  role?: CodingRole;
  /** ISO-8601 timestamp when this event was emitted. */
  timestamp?: string;
  /**
   * Snapshot of DAG artifacts available at the time of this event.
   * Keyed by node ID; values are opaque artifact payloads.
   */
  artifacts?: Record<string, unknown>;
}

// ── Token & Cost Types ────────────────────────────────────────────────────────

/** Structured token counts returned by the Anthropic API for a single node. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Record of a model tier upgrade event during DAG execution. */
export interface ModelUpgradeEvent {
  nodeId: string;
  role: CodingRole;
  fromModel: string;
  toModel: string;
  reason: string;
  timestamp: Date;
}
