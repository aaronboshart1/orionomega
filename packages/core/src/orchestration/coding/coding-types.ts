/**
 * @module orchestration/coding/coding-types
 * Canonical type definitions for Coding Mode.
 *
 * These types extend the core orchestration types with coding-specific
 * metadata: roles, file scopes, budget allocations, and typed node outputs.
 */

import type { CodingAgentNodeConfig, WorkflowNode } from '../types.js';

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
  /** Maximum parallel coding agent workers. Default: 4. */
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
  }>;
  /** Effective parallelism, capped by worker pool maxConcurrency. */
  maxParallelism: number;
}

/** Output produced by the architect node. */
export interface ArchitectureDesignOutput {
  /** Prose description of the implementation approach. */
  approach: string;
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

/** Per-node budget allocation. */
export interface NodeBudget {
  /** Maximum spend for this node in USD. */
  maxBudgetUsd: number;
  /** Maximum agentic turns (tool-use round trips). */
  maxTurns: number;
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
