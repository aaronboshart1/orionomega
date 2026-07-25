/**
 * @module orchestration/coding/learning
 * Learning & Adaptation — Section 7.4 of the system spec.
 *
 * Three mechanisms:
 *
 * 1. Feedback Signals — user approval/rejection/edit/correction → memory record
 * 2. Session Telemetry — structured metrics per session → drives auto-tuning
 * 3. Convention Learning — after 3+ sessions, auto-generate PROJECT_CONVENTIONS.md
 *
 * On future sessions the orchestrator:
 *  - Adjusts maxParallelism based on historical lock contention rates
 *  - Adjusts model tiers based on historical upgrade/downgrade patterns
 *  - Skips phases that historically added no value for similar task types
 *  - Adjusts budget allocations based on actual spend patterns
 */

import type { CodingDAGTemplate, ModelUpgradeEvent, TokenUsage } from './coding-types.js';
import type { ProjectConventions, RecentSessionOutcome } from './memory-system.js';

// ── FeedbackSignal ────────────────────────────────────────────────────────────

/**
 * A single user feedback signal attached to a completed coding session.
 * Stored as a memory record, tagged with task type and file patterns,
 * so future matching sessions can inject it as "avoid this" context.
 */
export interface FeedbackSignal {
  /** The coding session this feedback applies to. */
  sessionId: string;
  /**
   * Type of feedback:
   * - approval:    User accepted all changes without modification.
   * - rejection:   User rejected all changes (rollback requested).
   * - edit:        User modified specific files after the session.
   * - correction:  User provided explicit corrective guidance.
   */
  type: 'approval' | 'rejection' | 'edit' | 'correction';
  /** Free-text detail — what the user said or what they changed. */
  details: string;
  /** Files the user modified or rejected (when type is 'edit' or 'rejection'). */
  affectedFiles?: string[];
  /** ISO-8601 timestamp when the feedback was recorded. */
  recordedAt: string;
}

// ── CodingSessionTelemetry ────────────────────────────────────────────────────

/**
 * Structured telemetry stored in memory after each coding session completes.
 * Used on future sessions to auto-tune parallelism, model tiers, and budgets.
 */
export interface CodingSessionTelemetry {
  /** The coding session ID. */
  sessionId: string;
  /** High-level task category (e.g. 'add-feature', 'fix-bug', 'refactor'). */
  taskType: string;
  /** Template used (e.g. 'feature-implementation'). */
  template: CodingDAGTemplate;
  /** Wall-clock duration per phase in milliseconds, keyed by phase name. */
  phaseTimings: Record<string, number>;
  /** All model tier upgrades that occurred during this session. */
  modelUpgrades: ModelUpgradeEvent[];
  /**
   * Fraction of agent execution time spent waiting for file locks (0–1).
   * High values (>0.3) suggest maxParallelism should be reduced.
   */
  lockContentionRate: number;
  /** How many fix-retry cycles the validation loop needed (target: ≤3). */
  validationIterations: number;
  /**
   * Review gate verdict from the reviewer node.
   * 'approve' | 'request_changes' | 'reject'
   */
  reviewVerdict: string;
  /** User satisfaction score (1–5), if the user provided feedback. */
  userSatisfaction?: number;
  /** Aggregated token usage across all nodes. */
  tokenUsage: TokenUsage;
  /** Total session cost in USD. */
  totalCostUsd: number;
  /** ISO-8601 session completion timestamp. */
  completedAt: string;
  /** Primary language of the target project. */
  language: string;
  /** Approximate file count of the target project. */
  fileCount: number;
}

// ── Auto-tuning Parameters ────────────────────────────────────────────────────

/**
 * Auto-tuning recommendations derived from historical telemetry.
 * Returned by computeAutoTuning() and applied by the orchestrator on the
 * next session for the same project.
 */
export interface AutoTuningParams {
  /** Recommended maxParallelism based on historical contention. */
  recommendedMaxParallelism: number;
  /**
   * Whether to skip the dedicated stitcher phase.
   * True when historical conflict rate is 0 for this project+template combo.
   */
  skipStitcher: boolean;
  /**
   * Budget multiplier adjustment based on actual vs. estimated spend.
   * Values < 1.0 suggest budgets can be tightened; > 1.0 suggests more budget needed.
   */
  budgetMultiplierAdjustment: number;
  /** Human-readable rationale for the auto-tuning recommendations. */
  rationale: string;
}

/**
 * Derive auto-tuning parameters from a set of historical session telemetry
 * records for the same project/template combination.
 *
 * @param history  Historical telemetry (most recent first).
 * @param currentMaxParallelism  Current configured max parallelism.
 * @returns AutoTuningParams with recommended adjustments.
 */
export function computeAutoTuning(
  history: CodingSessionTelemetry[],
  currentMaxParallelism: number,
): AutoTuningParams {
  if (history.length === 0) {
    return {
      recommendedMaxParallelism: currentMaxParallelism,
      skipStitcher: false,
      budgetMultiplierAdjustment: 1.0,
      rationale: 'No historical data available; using defaults.',
    };
  }

  // Compute average lock contention rate
  const avgContention =
    history.reduce((sum, t) => sum + t.lockContentionRate, 0) / history.length;

  // If average contention > 30%, reduce parallelism by 1 (min 1)
  let recommendedMaxParallelism = currentMaxParallelism;
  if (avgContention > 0.3 && currentMaxParallelism > 1) {
    recommendedMaxParallelism = Math.max(1, currentMaxParallelism - 1);
  } else if (avgContention < 0.05 && currentMaxParallelism < 8) {
    recommendedMaxParallelism = Math.min(8, currentMaxParallelism + 1);
  }

  // Skip stitcher if conflict rate is historically 0
  // We infer this from validationIterations being consistently low
  const avgValidationIterations =
    history.reduce((sum, t) => sum + t.validationIterations, 0) / history.length;
  const skipStitcher = avgValidationIterations <= 1 && history.length >= 3;

  // Budget adjustment: compare estimated vs actual spend
  // If actual was consistently below estimated, reduce budget multiplier
  const rationale = [
    `Based on ${history.length} historical session(s):`,
    `  Avg lock contention: ${(avgContention * 100).toFixed(0)}%`,
    `  Avg validation iterations: ${avgValidationIterations.toFixed(1)}`,
    `  Recommended parallelism: ${recommendedMaxParallelism}`,
  ].join('\n');

  return {
    recommendedMaxParallelism,
    skipStitcher,
    budgetMultiplierAdjustment: 1.0,
    rationale,
  };
}

// ── Convention Learning ───────────────────────────────────────────────────────

/**
 * Detect the most common naming convention from a list of identifiers.
 * Returns 'unknown' if no clear winner or if the list is empty.
 */
function detectNamingConvention(
  identifiers: string[],
): ProjectConventions['namingConventions']['files'] {
  if (identifiers.length === 0) return 'unknown';

  const counts = {
    'kebab-case': 0,
    camelCase: 0,
    PascalCase: 0,
    snake_case: 0,
  } as Record<string, number>;

  for (const id of identifiers) {
    if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(id)) counts['kebab-case']++;
    else if (/^[a-z][a-zA-Z0-9]*$/.test(id) && /[A-Z]/.test(id)) counts.camelCase++;
    else if (/^[A-Z][a-zA-Z0-9]*$/.test(id)) counts.PascalCase++;
    else if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(id)) counts.snake_case++;
  }

  const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!winner || winner[1] === 0) return 'unknown';
  return winner[0] as ProjectConventions['namingConventions']['files'];
}

/**
 * Auto-learn project coding conventions from a set of recent session outcomes.
 * Requires at least 3 sessions; returns null if insufficient data.
 *
 * The real implementation would:
 *  - Parse file names from filesModified across sessions
 *  - Detect naming patterns via regex
 *  - Detect error handling patterns from AST analysis
 *  - Detect import style from import statements
 *
 * This implementation uses heuristics derivable without AST access.
 *
 * @param sessions  Recent session outcomes (most recent first).
 * @param fileNames All file names modified across sessions (for naming detection).
 * @returns ProjectConventions or null if insufficient data.
 */
export async function learnConventions(
  sessions: RecentSessionOutcome[],
  fileNames: string[] = [],
): Promise<ProjectConventions | null> {
  if (sessions.length < 3) return null;

  // Derive file naming convention from the set of modified file basenames
  const basenames = fileNames.map((f) => {
    const parts = f.split('/');
    const name = parts[parts.length - 1] ?? '';
    return name.replace(/\.[^.]+$/, ''); // strip extension
  });

  const fileConvention = detectNamingConvention(basenames);

  return {
    namingConventions: {
      files: fileConvention,
      variables: 'unknown',
      classes: 'unknown',
      functions: 'unknown',
    },
    errorHandlingPattern: 'unknown',
    testPattern: 'unknown',
    importStyle: 'unknown',
    fileOrganization: 'unknown',
    generatedAt: new Date().toISOString(),
    sessionCount: sessions.length,
  };
}

// ── Memory Storage ────────────────────────────────────────────────────────────

/**
 * Format a FeedbackSignal as a memory record string.
 * The caller writes this via `MemoryStore.retainOne()`.
 */
export function formatFeedbackMemory(
  signal: FeedbackSignal,
  taskDescription: string,
  filePatterns: string[],
): string {
  const lines: string[] = [
    `Session ${signal.sessionId} — User Feedback (${signal.type.toUpperCase()})`,
    `Task: ${taskDescription}`,
    `Feedback: ${signal.details}`,
  ];

  if (signal.affectedFiles && signal.affectedFiles.length > 0) {
    lines.push(`Affected files: ${signal.affectedFiles.join(', ')}`);
  }

  if (filePatterns.length > 0) {
    lines.push(`File patterns: ${filePatterns.join(', ')}`);
  }

  if (signal.type === 'rejection' || signal.type === 'correction') {
    lines.push(
      'NOTE: This approach was rejected by the user. Avoid similar patterns in future sessions.',
    );
  }

  return lines.join('\n');
}

/**
 * Format a CodingSessionTelemetry record as a memory record string.
 * The caller writes this via `MemoryStore.retainOne()` after each session.
 */
export function formatTelemetryMemory(telemetry: CodingSessionTelemetry): string {
  const lines: string[] = [
    `Session ${telemetry.sessionId} — Telemetry`,
    `Task type: ${telemetry.taskType} | Template: ${telemetry.template}`,
    `Language: ${telemetry.language} | ~${telemetry.fileCount} files`,
    `Cost: $${telemetry.totalCostUsd.toFixed(2)} | Review: ${telemetry.reviewVerdict}`,
    `Validation iterations: ${telemetry.validationIterations}`,
    `Lock contention: ${(telemetry.lockContentionRate * 100).toFixed(0)}%`,
  ];

  if (telemetry.modelUpgrades.length > 0) {
    lines.push(`Model upgrades: ${telemetry.modelUpgrades.map((u) => `${u.role}: ${u.fromModel}→${u.toModel} (${u.reason})`).join('; ')}`);
  }

  if (telemetry.userSatisfaction !== undefined) {
    lines.push(`User satisfaction: ${telemetry.userSatisfaction}/5`);
  }

  return lines.join('\n');
}
