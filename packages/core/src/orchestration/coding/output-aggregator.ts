/**
 * @module orchestration/coding/output-aggregator
 * Merges parallel implementer worker outputs and detects file conflicts.
 *
 * After a parallel implementation layer completes, OutputAggregator collects
 * each worker's ImplementerOutput, identifies files that were modified by
 * multiple workers (conflicts), and builds a rich context string for the
 * stitcher node to resolve those conflicts.
 */

import type { WorkerResult } from '../worker.js';
import type {
  AggregatedOutput,
  FileConflict,
  ImplementerOutput,
} from './coding-types.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('output-aggregator');

export class OutputAggregator {
  /**
   * Merges the results from parallel implementer workers into a single
   * AggregatedOutput. Detects files modified by more than one worker.
   *
   * @param results - Array of WorkerResult from the parallel layer.
   * @returns AggregatedOutput with merged file lists and conflict data.
   */
  merge(results: WorkerResult[]): AggregatedOutput {
    const allFilesModifiedSet = new Set<string>();
    const allFilesCreatedSet = new Set<string>();
    const perWorkerSummaries: AggregatedOutput['perWorkerSummaries'] = [];

    // Track which workers touched each file (for conflict detection)
    const fileTouchedBy = new Map<string, string[]>();

    for (const result of results) {
      const impl = this.extractImplementerOutput(result);
      const filesModified = impl?.filesModified ?? result.outputPaths;
      const filesCreated = impl?.filesCreated ?? [];
      const summary = impl?.summary ?? (typeof result.output === 'string' ? result.output : '') ?? '';

      perWorkerSummaries.push({
        workerId: result.nodeId,
        summary,
        filesModified: [...filesModified],
      });

      for (const f of filesModified) {
        allFilesModifiedSet.add(f);
        const holders = fileTouchedBy.get(f) ?? [];
        holders.push(result.nodeId);
        fileTouchedBy.set(f, holders);
      }

      for (const f of filesCreated) {
        allFilesCreatedSet.add(f);
      }
    }

    const conflicts = this.detectConflictsFromMap(fileTouchedBy);

    log.debug(
      `Aggregated ${results.length} workers: ` +
      `${allFilesModifiedSet.size} modified, ` +
      `${allFilesCreatedSet.size} created, ` +
      `${conflicts.length} conflict(s)`,
    );

    return {
      allFilesModified: [...allFilesModifiedSet],
      allFilesCreated: [...allFilesCreatedSet],
      perWorkerSummaries,
      conflicts,
    };
  }

  /**
   * Detects files that were modified by multiple workers.
   * Returns an array of FileConflict objects with proposed resolutions.
   *
   * @param results - Array of WorkerResult from the parallel layer.
   * @returns Array of conflicts (empty if none).
   */
  detectConflicts(results: WorkerResult[]): FileConflict[] {
    const fileTouchedBy = new Map<string, string[]>();
    for (const result of results) {
      const impl = this.extractImplementerOutput(result);
      const files = impl?.filesModified ?? result.outputPaths;
      for (const f of files) {
        const holders = fileTouchedBy.get(f) ?? [];
        holders.push(result.nodeId);
        fileTouchedBy.set(f, holders);
      }
    }
    return this.detectConflictsFromMap(fileTouchedBy);
  }

  /**
   * Builds a rich context string for the stitcher node that includes:
   * - Per-worker summaries of what was implemented
   * - A list of conflicts requiring manual resolution
   * - Open questions from each worker
   *
   * @param aggregated - Output from merge().
   * @param conflicts - Conflicts from detectConflicts() or aggregated.conflicts.
   * @returns Markdown-formatted context string for the stitcher prompt.
   */
  buildStitcherContext(aggregated: AggregatedOutput, conflicts: FileConflict[]): string {
    const lines: string[] = [
      '# Implementation Aggregation Report',
      '',
      `**Parallel workers completed:** ${aggregated.perWorkerSummaries.length}`,
      `**Files modified:** ${aggregated.allFilesModified.length}`,
      `**Files created:** ${aggregated.allFilesCreated.length}`,
      `**Conflicts requiring resolution:** ${conflicts.length}`,
      '',
    ];

    // Per-worker summaries
    lines.push('## Worker Summaries');
    for (const ws of aggregated.perWorkerSummaries) {
      lines.push(`\n### Worker: ${ws.workerId}`);
      lines.push(`**Files modified:** ${ws.filesModified.join(', ') || 'none'}`);
      if (ws.summary) {
        lines.push(`**Summary:** ${ws.summary}`);
      }
    }

    // Conflict details
    if (conflicts.length > 0) {
      lines.push('\n## Conflicts to Resolve');
      for (const c of conflicts) {
        lines.push(`\n### File: \`${c.file}\``);
        lines.push(`- **Workers:** ${c.workers.join(', ')}`);
        lines.push(`- **Resolution strategy:** ${c.resolution}`);
        if (c.resolution === 'needs-stitcher') {
          lines.push(
            '- **Action required:** Read all worker versions of this file and produce ' +
            'a unified version that incorporates all changes.',
          );
        }
      }
    } else {
      lines.push('\n## Conflicts');
      lines.push('No conflicts detected. All workers operated on independent files.');
    }

    // All modified files
    lines.push('\n## All Modified Files');
    for (const f of aggregated.allFilesModified) {
      lines.push(`- \`${f}\``);
    }

    if (aggregated.allFilesCreated.length > 0) {
      lines.push('\n## All Created Files');
      for (const f of aggregated.allFilesCreated) {
        lines.push(`- \`${f}\``);
      }
    }

    return lines.join('\n');
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private detectConflictsFromMap(
    fileTouchedBy: Map<string, string[]>,
  ): FileConflict[] {
    const conflicts: FileConflict[] = [];
    for (const [file, workers] of fileTouchedBy) {
      if (workers.length > 1) {
        conflicts.push({
          file,
          workers,
          resolution: 'needs-stitcher',
        });
      }
    }
    return conflicts;
  }

  private extractImplementerOutput(result: WorkerResult): ImplementerOutput | null {
    if (result.output && typeof result.output === 'object') {
      const o = result.output as Record<string, unknown>;
      if (
        Array.isArray(o.filesModified) &&
        Array.isArray(o.filesCreated)
      ) {
        return {
          filesModified: o.filesModified.filter((x): x is string => typeof x === 'string'),
          filesCreated: o.filesCreated.filter((x): x is string => typeof x === 'string'),
          summary: typeof o.summary === 'string' ? o.summary : '',
          openQuestions: Array.isArray(o.openQuestions)
            ? o.openQuestions.filter((x): x is string => typeof x === 'string')
            : [],
        };
      }
    }
    return null;
  }
}
