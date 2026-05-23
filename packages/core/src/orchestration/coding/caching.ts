/**
 * @module orchestration/coding/caching
 * Intelligent Caching — Section 7.3 of the system spec.
 *
 * Two caching mechanisms:
 *
 * 1. Codebase Analysis Caching
 *    - ProjectFingerprint cached in `{workspaceDir}/.orion/fingerprint.json`
 *    - Invalidated on: >10% file change, 24-hour TTL, explicit --reindex
 *    - On subsequent sessions: ~10x faster scanner phase
 *
 * 2. DAG Pattern Reuse
 *    - Successful DAG patterns stored by TaskSignature
 *    - When a new task is similar to a prior one, the architect receives the
 *      previous FanOutDecision as a reference, reducing planning tokens
 */

import type { CodingDAGTemplate, FanOutDecision } from './coding-types.js';

// ── TaskSignature ─────────────────────────────────────────────────────────────

/**
 * A compact fingerprint that characterises a coding task for pattern matching.
 * Two tasks with matching signatures are candidates for pattern reuse.
 */
export interface TaskSignature {
  /** The DAG template that was (or will be) used for this task. */
  template: CodingDAGTemplate;
  /** Primary programming language of the target project. */
  language: string;
  /** Framework of the target project (null if none detected). */
  framework: string | null;
  /**
   * Approximate file count bucket for similarity matching.
   * Bucketed to avoid over-fitting to exact numbers:
   *  'tiny'   → 1–10 files
   *  'small'  → 11–50 files
   *  'medium' → 51–200 files
   *  'large'  → 201–1000 files
   *  'epic'   → 1000+ files
   */
  fileCountBucket: 'tiny' | 'small' | 'medium' | 'large' | 'epic';
  /**
   * Normalised keyword set extracted from the task description.
   * Stored as a sorted, deduplicated comma-separated string so it can be
   * compared with a simple string equality check.
   *
   * Keywords are lowercased, stop-words removed, and limited to ≤20 terms.
   */
  keywordHash: string;
}

/**
 * Bucket a raw file count into a TaskSignature fileCountBucket.
 */
export function bucketFileCount(
  count: number,
): TaskSignature['fileCountBucket'] {
  if (count <= 10) return 'tiny';
  if (count <= 50) return 'small';
  if (count <= 200) return 'medium';
  if (count <= 1000) return 'large';
  return 'epic';
}

/**
 * Derive a normalised keyword hash from a task description.
 * Strips stop-words, lowercases, deduplicates, sorts, and joins with commas.
 */
export function hashTaskKeywords(task: string, maxKeywords = 20): string {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
    'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were',
    'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
    'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall',
    'this', 'that', 'these', 'those', 'it', 'its',
  ]);

  const keywords = task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const unique = Array.from(new Set(keywords)).slice(0, maxKeywords).sort();
  return unique.join(',');
}

/**
 * Build a TaskSignature from task metadata.
 */
export function buildTaskSignature(
  template: CodingDAGTemplate,
  language: string,
  framework: string | null,
  fileCount: number,
  task: string,
): TaskSignature {
  return {
    template,
    language,
    framework,
    fileCountBucket: bucketFileCount(fileCount),
    keywordHash: hashTaskKeywords(task),
  };
}

// ── SessionOutcome ────────────────────────────────────────────────────────────

/**
 * Summary of a completed coding session, stored alongside the cached pattern.
 * Used for future pattern scoring — successful sessions with low cost and few
 * iterations are preferred as references.
 */
export interface SessionOutcome {
  /** Whether the session completed successfully with tests passing. */
  success: boolean;
  /** Number of validation fix-retry cycles needed. */
  validationIterations: number;
  /** Actual total cost in USD. */
  totalCostUsd: number;
  /** Number of files modified. */
  filesModified: number;
  /** Review gate verdict ('approve' | 'request_changes' | 'reject'). */
  reviewVerdict: string;
  /** ISO-8601 completion timestamp. */
  completedAt: string;
}

// ── CachedPattern ─────────────────────────────────────────────────────────────

/**
 * A single cached DAG pattern entry.
 * Stored by DAGPatternCache and retrieved for similar future tasks.
 */
export interface CachedPattern {
  /** Unique entry ID. */
  id: string;
  /** Characteristics of the original task. */
  signature: TaskSignature;
  /** Template used. */
  template: CodingDAGTemplate;
  /**
   * The FanOutDecision produced by the architect for this task.
   * Injected into future architects as a reference, reducing planning tokens.
   */
  fanOutDecision?: FanOutDecision;
  /** Outcome of the original session. */
  outcome: SessionOutcome;
  /** ISO-8601 timestamp when this pattern was stored. */
  storedAt: string;
  /**
   * Similarity score computed at query time (0–1).
   * Populated by findSimilar(), not stored.
   */
  similarity?: number;
}

// ── DAGPatternCache interface ─────────────────────────────────────────────────

/**
 * Interface for storing and retrieving successful DAG patterns.
 * Implementations may use in-memory Maps, SQLite, or an external store.
 */
export interface DAGPatternCache {
  /**
   * Store a successful DAG pattern keyed by task characteristics.
   *
   * @param taskSignature  Characteristics of the completed task.
   * @param dag            Template that was used.
   * @param outcome        Session outcome data.
   * @param fanOutDecision The architect's fan-out decision (optional but valuable).
   */
  store(
    taskSignature: TaskSignature,
    dag: CodingDAGTemplate,
    outcome: SessionOutcome,
    fanOutDecision?: FanOutDecision,
  ): void;

  /**
   * Retrieve similar patterns for a new task, ranked by similarity.
   * Returns at most `limit` patterns with similarity >= `minSimilarity`.
   *
   * @param taskSignature  Characteristics of the new task.
   * @param limit          Max patterns to return. Default: 3.
   * @param minSimilarity  Minimum similarity score (0–1). Default: 0.5.
   */
  findSimilar(
    taskSignature: TaskSignature,
    limit?: number,
    minSimilarity?: number,
  ): CachedPattern[];

  /** Return total number of stored patterns. */
  size(): number;

  /** Clear all stored patterns. */
  clear(): void;
}

// ── Similarity scoring ────────────────────────────────────────────────────────

/**
 * Compute a similarity score (0–1) between two TaskSignatures.
 *
 * Weights:
 *  - template:        0.30 (exact match required for reliable reuse)
 *  - language:        0.25 (same language → same patterns)
 *  - framework:       0.20 (same framework → same file layout)
 *  - fileCountBucket: 0.15 (similar size → similar parallelism)
 *  - keywordHash:     0.10 (keyword overlap → similar task type)
 */
export function computeSignatureSimilarity(
  a: TaskSignature,
  b: TaskSignature,
): number {
  let score = 0;

  if (a.template === b.template) score += 0.30;
  if (a.language === b.language) score += 0.25;
  if (a.framework === b.framework) score += 0.20;
  if (a.fileCountBucket === b.fileCountBucket) score += 0.15;

  // Keyword overlap: Jaccard similarity on the comma-split keyword sets
  const aKeywords = new Set(a.keywordHash.split(',').filter(Boolean));
  const bKeywords = new Set(b.keywordHash.split(',').filter(Boolean));
  if (aKeywords.size > 0 || bKeywords.size > 0) {
    const intersection = [...aKeywords].filter((k) => bKeywords.has(k));
    const union = new Set([...aKeywords, ...bKeywords]);
    const jaccard = intersection.length / union.size;
    score += 0.10 * jaccard;
  }

  return Math.min(1, score);
}

// ── In-memory implementation ──────────────────────────────────────────────────

/**
 * In-memory implementation of DAGPatternCache.
 * Suitable for single-process use. For persistence across restarts, use the
 * SQLite-backed implementation or serialise/restore via toJSON()/fromJSON().
 */
export class InMemoryDAGPatternCache implements DAGPatternCache {
  private readonly patterns: Map<string, CachedPattern> = new Map();
  private idCounter = 0;

  store(
    taskSignature: TaskSignature,
    dag: CodingDAGTemplate,
    outcome: SessionOutcome,
    fanOutDecision?: FanOutDecision,
  ): void {
    const id = `pattern-${++this.idCounter}`;
    const entry: CachedPattern = {
      id,
      signature: taskSignature,
      template: dag,
      fanOutDecision,
      outcome,
      storedAt: new Date().toISOString(),
    };
    this.patterns.set(id, entry);
  }

  findSimilar(
    taskSignature: TaskSignature,
    limit = 3,
    minSimilarity = 0.5,
  ): CachedPattern[] {
    const scored: Array<CachedPattern & { similarity: number }> = [];

    for (const pattern of this.patterns.values()) {
      // Only return patterns from successful sessions
      if (!pattern.outcome.success) continue;

      const similarity = computeSignatureSimilarity(taskSignature, pattern.signature);
      if (similarity >= minSimilarity) {
        scored.push({ ...pattern, similarity });
      }
    }

    return scored
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  size(): number {
    return this.patterns.size;
  }

  clear(): void {
    this.patterns.clear();
    this.idCounter = 0;
  }

  /** Serialise all patterns to a JSON-compatible array for persistence. */
  toJSON(): CachedPattern[] {
    return Array.from(this.patterns.values());
  }

  /**
   * Restore patterns from a JSON-compatible array (e.g. loaded from disk).
   * Existing patterns are preserved; duplicates by id are overwritten.
   */
  fromJSON(patterns: CachedPattern[]): void {
    for (const p of patterns) {
      this.patterns.set(p.id, p);
    }
  }
}

// ── Formatting helper for architect prompt injection ──────────────────────────

/**
 * Format a list of similar cached patterns for injection into the architect's
 * system prompt. Injects the top-N FanOutDecisions as references.
 *
 * @param patterns   Similar patterns returned by DAGPatternCache.findSimilar().
 * @param maxPatterns  Maximum number of patterns to include. Default: 2.
 * @returns Formatted string ready for prompt injection, or empty string if none.
 */
export function formatCachedPatternsForPrompt(
  patterns: CachedPattern[],
  maxPatterns = 2,
): string {
  const withFanOut = patterns
    .filter((p) => p.fanOutDecision !== undefined)
    .slice(0, maxPatterns);

  if (withFanOut.length === 0) return '';

  const lines: string[] = [
    '## Reference: Prior Similar Session Plans',
    'These FanOutDecisions are from prior successful sessions with similar tasks.',
    'Use them as a reference to speed up your planning — adapt, do not copy verbatim.',
    '',
  ];

  for (const p of withFanOut) {
    lines.push(`### Prior Pattern (similarity: ${((p.similarity ?? 0) * 100).toFixed(0)}%)`);
    lines.push(`Template: ${p.template} | Language: ${p.signature.language} | Files: ${p.signature.fileCountBucket}`);
    lines.push(`Outcome: ${p.outcome.reviewVerdict}, ${p.outcome.validationIterations} validation iterations, $${p.outcome.totalCostUsd.toFixed(2)}`);
    if (p.fanOutDecision) {
      lines.push('FanOutDecision:');
      lines.push('```json');
      lines.push(JSON.stringify(p.fanOutDecision, null, 2));
      lines.push('```');
    }
    lines.push('');
  }

  return lines.join('\n');
}
