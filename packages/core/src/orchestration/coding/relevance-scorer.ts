/**
 * @module orchestration/coding/relevance-scorer
 * File relevance scoring for context selection (Section 4.2 of spec).
 *
 * Implements the five-factor model from the specification:
 *   1. Direct mention    — target/context file declared in the task
 *   2. Dep proximity     — shortest path in the dependency graph
 *   3. Co-change freq    — how often this file changes with the targets (git)
 *   4. Semantic sim      — embedding similarity (placeholder, 0 when unavailable)
 *   5. Recency bonus     — modified in the last 7 days
 *
 * Scores are normalised to [0.0, 1.0].
 */

import type { CodebaseIndex } from './codebase-indexer.js';
import { CodebaseQuery } from './codebase-query.js';
import type { GitInsights } from './git-insights.js';

// ── CodingTask (lightweight, for scoring only) ────────────────────────────────

/**
 * Minimal task descriptor used by the relevance scorer.
 * The full FanOutDecision adds more structure downstream.
 */
export interface ScoringTask {
  /** Files explicitly targeted for modification. */
  targetFiles: string[];
  /** Additional context files the architect or user called out. */
  contextFiles: string[];
  /** Natural-language description of the task (used for semantic scoring). */
  description: string;
}

// ── Factor weights ────────────────────────────────────────────────────────────

/** Weights for each factor. Must sum to ≤ 1 (rest is unscored ambient). */
const W_DEP_PROXIMITY = 0.7;  // max score at distance 0
const W_COCHANGE = 0.3;
const W_SEMANTIC = 0.2;
const W_RECENCY = 0.05;

/** Damping per hop in the dependency graph. */
const DEP_HOP_DAMPING = 0.15;

/** Recency threshold in days. */
const RECENCY_THRESHOLD_DAYS = 7;
const MS_PER_DAY = 86_400_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute the co-change frequency of `file` with any of `targetFiles`.
 * Uses the GitInsights.cochangeClusters map.
 *
 * Returns a score in [0, 1]:
 *   - 1.0 if file co-changes with all target files
 *   - 0.0 if it never co-changes with any of them
 */
function computeCochangeScore(
  file: string,
  targetFiles: string[],
  gitInsights: GitInsights | undefined,
): number {
  if (!gitInsights || targetFiles.length === 0) return 0;

  let matchCount = 0;
  for (const target of targetFiles) {
    const cluster = gitInsights.cochangeClusters.get(target) ?? [];
    if (cluster.includes(file)) matchCount++;
  }
  return matchCount / targetFiles.length;
}

/**
 * Recency bonus: +W_RECENCY if the file was modified within RECENCY_THRESHOLD_DAYS.
 * Uses the lastModified timestamp from the file record if available,
 * otherwise falls back to 0.
 */
function computeRecencyBonus(file: string, index: CodebaseIndex): number {
  const record = index.files.get(file);
  if (!record || record.lastModified === 0) return 0;
  const daysSince = (Date.now() - record.lastModified) / MS_PER_DAY;
  return daysSince < RECENCY_THRESHOLD_DAYS ? W_RECENCY : 0;
}

// ── Main scoring function ─────────────────────────────────────────────────────

/**
 * Compute a relevance score in [0.0, 1.0] for a candidate file relative
 * to the current coding task.
 *
 * Short-circuits at 1.0 for direct target mentions and 0.9 for context files,
 * which are the highest-confidence signals.
 *
 * @param file         - Relative path of the candidate file.
 * @param task         - The current coding task (target + context files + description).
 * @param index        - The codebase index (provides dep graph + file metadata).
 * @param gitInsights  - Optional git history insights for co-change scoring.
 * @returns Relevance score in [0.0, 1.0].
 */
export function computeRelevance(
  file: string,
  task: ScoringTask,
  index: CodebaseIndex,
  gitInsights?: GitInsights,
): number {
  // ─ Factor 1: Direct mention ────────────────────────────────────────────────
  if (task.targetFiles.includes(file)) return 1.0;
  if (task.contextFiles.includes(file)) return 0.9;

  const query = new CodebaseQuery(index);
  let score = 0;

  // ─ Factor 2: Dependency proximity ─────────────────────────────────────────
  // Find the shortest path distance from this file to any target file (in either direction)
  const depDistance = query.shortestDistance(file, task.targetFiles);
  if (depDistance !== Infinity) {
    // score = W_DEP_PROXIMITY - (distance * DEP_HOP_DAMPING), floor 0
    score += Math.max(0, W_DEP_PROXIMITY - depDistance * DEP_HOP_DAMPING);
  }

  // ─ Factor 3: Co-change frequency ──────────────────────────────────────────
  const cochangeScore = computeCochangeScore(file, task.targetFiles, gitInsights);
  score += cochangeScore * W_COCHANGE;

  // ─ Factor 4: Semantic similarity (placeholder) ────────────────────────────
  // Production implementation would call an embeddings API.
  // We return 0 here so the scoring function is structurally complete.
  const semanticScore = 0; // placeholder
  if (score < 0.3) {
    score += semanticScore * W_SEMANTIC;
  }

  // ─ Factor 5: Recency bonus ─────────────────────────────────────────────────
  score += computeRecencyBonus(file, index);

  return Math.min(Math.max(score, 0), 1.0);
}

/**
 * Score all files in the index and return them sorted by relevance (descending).
 *
 * @param task       - The current task.
 * @param index      - The codebase index.
 * @param gitInsights - Optional git insights.
 * @param minScore   - Minimum score threshold (default 0.0 = include all).
 */
export function rankFilesByRelevance(
  task: ScoringTask,
  index: CodebaseIndex,
  gitInsights?: GitInsights,
  minScore = 0.0,
): Array<{ path: string; score: number }> {
  const results: Array<{ path: string; score: number }> = [];

  for (const relPath of index.files.keys()) {
    const score = computeRelevance(relPath, task, index, gitInsights);
    if (score >= minScore) {
      results.push({ path: relPath, score });
    }
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return results;
}
