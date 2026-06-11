/**
 * @module orchestration/commit-safety-gate
 *
 * Executor-side commit-safety preflight (Task #237 split out of `executor.ts`,
 * implements the Task #209 round-5 gate).
 *
 * After a coding-mode workflow completes, this gate walks the commits the
 * agent introduced under the checkout (`baseHeadCommit..HEAD`) and refuses
 * the run if any blob trips the safe-commit deny-list — INDEPENDENTLY of the
 * runtime git hooks. Hooks are bypassable (`git push --no-verify`); this scan
 * is not.
 *
 * The gate is intentionally side-effect-free: it returns the updated
 * {@link CommitSafetyReport} plus an optional error entry to push. The executor
 * applies those mutations, keeping all run-state ownership in one place.
 */

import { createLogger } from '../logging/logger.js';
import type { CommitSafetyReport } from './types.js';

const log = createLogger('commit-safety-gate');

/** An error entry the executor should record when the preflight refuses a run. */
export interface CommitSafetyError {
  worker: string;
  message: string;
  resolution?: string;
}

/** Outcome of {@link runCommitSafetyPreflight}. */
export interface CommitSafetyPreflightResult {
  /** The report with `preflightStatus`/`preflightReason`/`refusedFiles` updated. */
  report: CommitSafetyReport;
  /** Present only when the run must be escalated to `error`. */
  error?: CommitSafetyError;
}

/**
 * Run the post-execution commit-safety preflight for `report`.
 *
 * Returns the updated report and, when refused files are found, an error entry
 * the caller should push so the run reports `status: 'error'`. Wrapped in a
 * try/catch so a misbehaving `git` binary never crashes a run that succeeded
 * on its merits — it degrades to `preflightStatus: 'skipped'` instead.
 *
 * The `findUnsafeCommittedFiles` dependency is injected for testability; it
 * defaults to the real implementation from `./coding/safe-commit.js`.
 */
export function runCommitSafetyPreflight(
  report: CommitSafetyReport,
  findUnsafeCommittedFiles?: (
    checkoutPath: string,
    baseHeadCommit: string | null,
  ) => { refused: CommitSafetyReport['refusedFiles']; skippedReason: string | null },
): CommitSafetyPreflightResult {
  try {
    const finder = findUnsafeCommittedFiles
      ?? (require('./coding/safe-commit.js') as typeof import('./coding/safe-commit.js')).findUnsafeCommittedFiles;
    const { refused, skippedReason } = finder(report.checkoutPath, report.baseHeadCommit);

    if (skippedReason !== null) {
      return {
        report: { ...report, preflightStatus: 'skipped', preflightReason: skippedReason, refusedFiles: [] },
      };
    }

    if (refused.length === 0) {
      return {
        report: { ...report, preflightStatus: 'clean', preflightReason: undefined, refusedFiles: [] },
      };
    }

    const updated: CommitSafetyReport = {
      ...report,
      preflightStatus: 'refused',
      preflightReason: undefined,
      refusedFiles: refused,
    };
    const sample = refused
      .slice(0, 5)
      .map((r) => `${r.path} (${r.reason}, ${r.bytes} B, in ${r.commit.slice(0, 7)})`)
      .join('; ');
    const more = refused.length > 5 ? ` (+${refused.length - 5} more — see Commit Safety section)` : '';
    log.error('Commit safety preflight refused the run (Task #209)', {
      checkoutPath: report.checkoutPath,
      baseHeadCommit: report.baseHeadCommit,
      refusedCount: refused.length,
    });
    return {
      report: updated,
      error: {
        worker: 'commit-safety-preflight',
        message:
          `Refusing run: post-execution preflight found ${refused.length} ` +
          `committed file(s) on ${report.baseHeadCommit ? 'commits the agent added' : 'all reachable history'} ` +
          `that trip the safe-commit deny-list (oversize / secret / build-artefact / control-bytes): ${sample}${more}.`,
        resolution:
          'Remove the offending blobs (e.g. `git filter-repo --invert-paths`), ' +
          'add the appropriate `.gitignore` patterns, then re-dispatch.',
      },
    };
  } catch (err) {
    return {
      report: {
        ...report,
        preflightStatus: 'skipped',
        preflightReason: `preflight crashed: ${err instanceof Error ? err.message : String(err)}`,
        refusedFiles: [],
      },
    };
  }
}

/**
 * Collaborator wrapper so the executor can hold a single gate instance.
 * Stateless — delegates to {@link runCommitSafetyPreflight}.
 */
export class CommitSafetyGate {
  runPreflight(
    report: CommitSafetyReport,
    findUnsafeCommittedFiles?: Parameters<typeof runCommitSafetyPreflight>[1],
  ): CommitSafetyPreflightResult {
    return runCommitSafetyPreflight(report, findUnsafeCommittedFiles);
  }
}
