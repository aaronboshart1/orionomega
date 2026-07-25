/**
 * @module orchestration/coding/memory-system
 * Three-level memory system for Coding Mode (Section 6.6 of the system spec).
 *
 * Memory levels:
 *  1. Session Memory  — ephemeral, per-coding-session, checkpoint-backed
 *  2. Project Memory  — persistent per project, stored in {workspaceDir}/.orion/
 *  3. Global Memory   — long-lived, stored in a memory scope
 *
 * Cross-agent context is always passed as typed DAGArtifact values — never as
 * raw conversation text. This prevents context pollution and enables caching.
 */

import type {
  CodebaseScanOutput,
  ArchitectureDesignOutput,
  ImplementerOutput,
  StitcherOutput,
  ValidatorOutput,
  ReviewResult,
  FileLockRecord,
  CodingDAGTemplate,
  TestResults,
} from './coding-types.js';

// ── DAGArtifact — typed cross-agent context sharing (Section 6.5) ─────────────

/**
 * Discriminated union of all typed artifacts that coding agents may produce
 * and consume. Agents receive only structured artifacts — never raw conversation
 * history or tool-call sequences from upstream agents.
 */
export type DAGArtifact =
  | { kind: 'codebase-scan'; data: CodebaseScanOutput }
  | { kind: 'architecture-design'; data: ArchitectureDesignOutput }
  | { kind: 'implementer'; data: ImplementerOutput }
  | { kind: 'stitcher'; data: StitcherOutput }
  | { kind: 'validator'; data: ValidatorOutput }
  | { kind: 'review'; data: ReviewResult }
  // ── Spec §6.5 additional variants ───────────────────────────────────────────
  /** Output from the test-writer node: generated test results and file paths. */
  | { kind: 'test-results'; data: TestResults }
  /** Output from the debugger node: fix description and modified files. */
  | {
      kind: 'debug';
      data: {
        /** Summary of the root-cause diagnosis and fix applied. */
        fixDescription: string;
        /** Files modified by the debugger agent. */
        modifiedFiles: string[];
        /** Which retry attempt produced this fix (0 = first try). */
        retryAttempt: number;
      };
    }
  /** Output from the reporter node: human-readable session summary. */
  | {
      kind: 'report';
      data: {
        /** Prose summary of what was implemented in this session. */
        summary: string;
        /** Session ID this report belongs to. */
        sessionId: string;
        /** Wall-clock duration of the full coding session in milliseconds. */
        durationMs: number;
      };
    };

/** Extract the data payload from a DAGArtifact, returning undefined if the kind doesn't match. */
export function getArtifactData(artifact: DAGArtifact, kind: 'codebase-scan'): CodebaseScanOutput | undefined;
export function getArtifactData(artifact: DAGArtifact, kind: 'architecture-design'): ArchitectureDesignOutput | undefined;
export function getArtifactData(artifact: DAGArtifact, kind: 'implementer'): ImplementerOutput | undefined;
export function getArtifactData(artifact: DAGArtifact, kind: 'stitcher'): StitcherOutput | undefined;
export function getArtifactData(artifact: DAGArtifact, kind: 'validator'): ValidatorOutput | undefined;
export function getArtifactData(artifact: DAGArtifact, kind: 'review'): ReviewResult | undefined;
export function getArtifactData(artifact: DAGArtifact, kind: 'test-results'): TestResults | undefined;
export function getArtifactData(artifact: DAGArtifact, kind: 'debug'): Extract<DAGArtifact, { kind: 'debug' }>['data'] | undefined;
export function getArtifactData(artifact: DAGArtifact, kind: 'report'): Extract<DAGArtifact, { kind: 'report' }>['data'] | undefined;
export function getArtifactData(artifact: DAGArtifact, kind: DAGArtifact['kind']): unknown {
  if (artifact.kind === kind) return artifact.data;
  return undefined;
}

// ── ProjectFingerprint ────────────────────────────────────────────────────────

/**
 * Stable hash-based snapshot of a project's file tree.
 * Cached in `{workspaceDir}/.orion/fingerprint.json` between sessions.
 * Invalidated when git diff detects >10% file change, after 24 hours, or
 * on explicit `--reindex`.
 */
export interface ProjectFingerprint {
  /** Absolute path to the project workspace. */
  projectPath: string;
  /** HEAD commit hash at the time of last indexing. */
  gitCommitHash: string;
  /** Total file count in the workspace (excluding .gitignore'd paths). */
  fileCount: number;
  /** Total lines of code across all source files. */
  totalLinesOfCode: number;
  /** Primary programming language detected. */
  primaryLanguage: string;
  /** Framework detected (e.g. 'Next.js', 'Express', null). */
  framework: string | null;
  /** ISO-8601 timestamp of the last successful index build. */
  lastIndexed: string;
  /**
   * Per-file SHA-1 hashes for change detection.
   * Key: relative file path. Value: SHA-1 of file contents.
   */
  fileHashes: Record<string, string>;
  /** Whether the fingerprint is still valid (not expired / invalidated). */
  valid: boolean;
}

/**
 * Check whether a fingerprint is still valid given current conditions.
 * Returns true if:
 *  - not expired (< 24 hours old)
 *  - current HEAD commit matches the fingerprint's gitCommitHash
 */
export function isFingerprintValid(
  fp: ProjectFingerprint,
  currentCommitHash: string,
  nowMs: number = Date.now(),
): boolean {
  if (!fp.valid) return false;
  const ageMs = nowMs - new Date(fp.lastIndexed).getTime();
  const ttlMs = 24 * 60 * 60 * 1000; // 24 hours
  if (ageMs > ttlMs) return false;
  if (fp.gitCommitHash !== currentCommitHash) return false;
  return true;
}

// ── Level 1: Session Memory (ephemeral) ──────────────────────────────────────

/**
 * In-process ephemeral state for the currently running coding session.
 * Serialised to a checkpoint file for crash recovery; discarded on success.
 */
export interface SessionMemory {
  /** The coding orchestrator's session UUID. */
  sessionId: string;
  /** Current execution phase. */
  phase: string;
  /**
   * Artifacts produced by completed DAG nodes, keyed by node ID.
   * Used to pass typed context between agents without sharing raw conversation.
   */
  artifacts: Map<string, DAGArtifact>;
  /**
   * Serialisable snapshot of the FileLockManager state, written on each phase
   * boundary so sessions can resume after a crash.
   */
  lockState: FileLockRecord[];
  /** Path to the checkpoint JSON file on disk. */
  checkpointPath: string;
  /** ISO-8601 timestamp when this session memory was created. */
  startedAt: string;
  /** Git commit hash at session start (for rollback target). */
  preSessionCommit: string;
}

/** Serialisable checkpoint written to disk at each phase boundary. */
export interface SessionCheckpointFile {
  sessionId: string;
  phase: string;
  lockState: Array<{ holder: string; acquiredAt: string; files: string[] }>;
  artifactKeys: string[];   // which node IDs have completed artifacts
  preSessionCommit: string;
  savedAt: string;
}

/** Serialise a SessionMemory to the on-disk checkpoint format. */
export function serializeCheckpoint(mem: SessionMemory): SessionCheckpointFile {
  return {
    sessionId: mem.sessionId,
    phase: mem.phase,
    lockState: mem.lockState.map((r) => ({
      holder: r.holder,
      acquiredAt: r.acquiredAt,
      files: Array.from(r.files),
    })),
    artifactKeys: Array.from(mem.artifacts.keys()),
    preSessionCommit: mem.preSessionCommit,
    savedAt: new Date().toISOString(),
  };
}

// ── Level 2: Project Memory (persistent per project) ─────────────────────────

/**
 * Conventions inferred from 3+ successful coding sessions on a project.
 * Written to `{workspaceDir}/.orion/PROJECT_CONVENTIONS.md` for human
 * inspection and injected into architect system prompts.
 */
export interface ProjectConventions {
  namingConventions: {
    files: 'kebab-case' | 'camelCase' | 'PascalCase' | 'snake_case' | 'unknown';
    variables: 'camelCase' | 'snake_case' | 'unknown';
    classes: 'PascalCase' | 'snake_case' | 'unknown';
    functions: 'camelCase' | 'snake_case' | 'unknown';
  };
  errorHandlingPattern: 'try-catch' | 'result-type' | 'promise-rejection' | 'unknown';
  testPattern: 'describe-it' | 'test-flat' | 'spec-style' | 'unknown';
  importStyle: 'relative' | 'absolute' | 'barrel' | 'unknown';
  fileOrganization: 'by-feature' | 'by-layer' | 'unknown';
  /** ISO-8601 timestamp when these conventions were last regenerated. */
  generatedAt: string;
  /** How many coding sessions were analysed to derive these conventions. */
  sessionCount: number;
}

/** Lightweight session outcome record stored in project memory. */
export interface RecentSessionOutcome {
  sessionId: string;
  task: string;
  template: CodingDAGTemplate;
  completedAt: string;
  success: boolean;
  filesModified: number;
  totalCostUsd: number;
  validationIterations: number;
}

/**
 * All persistent project-scoped memory.
 * Stored at `{workspaceDir}/.orion/project-memory.json`.
 */
export interface ProjectMemory {
  /** Absolute path to the project workspace. */
  projectPath: string;
  /** Cached codebase fingerprint from the last successful index. */
  fingerprint?: ProjectFingerprint;
  /** Auto-learned coding conventions (populated after 3+ sessions). */
  conventions?: ProjectConventions;
  /** Last 10 session outcomes for telemetry and pattern reuse. */
  recentSessions: RecentSessionOutcome[];
  /** ISO-8601 timestamp of the last update. */
  lastUpdated: string;
}

// ── Level 3: Global Memory (long-lived, via the memory store) ─────────────────

/**
 * A single record held in the long-lived memory scope.
 * Used for cross-session learning: architecture decisions, failure patterns,
 * successful recovery strategies, and template effectiveness metrics.
 */
export interface GlobalMemoryEntry {
  /** Unique record ID (assigned by the memory store). */
  id: string;
  /** Memory scope name (e.g. 'infra', 'coding-sessions'). */
  scope: string;
  /**
   * Prose content of the record.
   * Max 1,500 characters — truncated before injection into architect context.
   */
  content: string;
  /** Categorical tags for retrieval (e.g. 'architecture', 'security', 'retry'). */
  tags: string[];
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Relevance score populated at query time (0–1), higher = more relevant. */
  relevanceScore?: number;
}

/**
 * Recall query parameters used by the coding subsystem.
 * Used in `CodingPlanner.plan()` to fetch prior architecture decisions.
 */
export interface MemoryRecallQuery {
  /** Free-text query, typically derived from the coding task description. */
  query: string;
  /** Scope to search (e.g. 'infra' for infrastructure decisions). */
  scope: string;
  /** Maximum tokens to include from recalled records. */
  maxTokens: number;
  /** Caller-side cost hint. The memory store does not read it — recall is
   *  lexical and involves no model call. */
  budget: 'low' | 'medium' | 'high';
}

/**
 * Result of a recall.
 * Entries are truncated to 1,500 chars each and injected into the architect's
 * system prompt under "## Prior Architecture Decisions".
 */
export interface MemoryRecallResult {
  scope: string;
  query: string;
  entries: GlobalMemoryEntry[];
  /** Total tokens consumed by all recalled entries (after truncation). */
  totalTokens: number;
}

// ── Memory level discriminator ────────────────────────────────────────────────

/** Identifies which memory tier a memory operation targets. */
export type MemoryLevel = 'session' | 'project' | 'global';

// ── Helper: format recalled memories for architect prompt ─────────────────────

/**
 * Format recall results for injection into an architect prompt.
 * Each entry is truncated to maxCharsPerEntry and separated by a divider.
 *
 * @param results  Array of recall results (one per scope queried).
 * @param maxCharsPerEntry  Max characters per entry. Default: 1500.
 * @returns Formatted string ready for prompt injection, or empty string if no entries.
 */
export function formatRecalledMemories(
  results: MemoryRecallResult[],
  maxCharsPerEntry = 1500,
): string {
  const entries: GlobalMemoryEntry[] = results.flatMap((r) => r.entries);
  if (entries.length === 0) return '';

  const lines: string[] = [
    '## Prior Architecture Decisions (recalled from memory)',
    'Consult these before designing — do not relitigate settled choices',
    'unless the new task explicitly requires it.',
    '',
  ];

  for (const entry of entries) {
    const content =
      entry.content.length > maxCharsPerEntry
        ? entry.content.slice(0, maxCharsPerEntry) + '…'
        : entry.content;
    lines.push(`### Memory: ${entry.scope} / ${entry.id}`);
    if (entry.tags.length > 0) lines.push(`Tags: ${entry.tags.join(', ')}`);
    lines.push(content);
    lines.push('');
  }

  return lines.join('\n');
}
