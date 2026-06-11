/**
 * @module orchestration/artifact-collector
 *
 * Artifact-collection helpers for the graph executor (Task #237 split out of
 * `executor.ts`). Owns the deterministic filesystem concerns:
 *   - resolving the per-run / per-node output directories;
 *   - persisting a worker's text output when it produced no files of its own;
 *   - scanning an output directory for files the worker created but did not
 *     report (so they still surface in the run summary).
 *
 * These are pure filesystem operations with no dependency on executor state,
 * which makes them unit-testable in isolation and keeps the executor focused
 * on orchestration.
 */

import { writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

/**
 * Persist `text` into `outputDir/<filename>` ONLY when the directory exists
 * and is currently empty. Returns the written path, or `null` when nothing
 * was written (directory missing, already has files, or empty text).
 */
export function saveTextOutputIfEmpty(
  outputDir: string,
  text: string,
  filename: string = 'output.md',
): string | null {
  try {
    if (!existsSync(outputDir)) return null;
    const files = readdirSync(outputDir);
    if (files.length > 0) return null;
    if (!text || !text.trim()) return null;
    const filePath = join(outputDir, filename);
    writeFileSync(filePath, text.trim(), 'utf-8');
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Recursively walk `outputDir` and return every file path NOT already present
 * in `knownPaths` (compared by both resolved and raw path). Used to surface
 * files a worker created but didn't explicitly report.
 */
export function scanForUntrackedFiles(outputDir: string, knownPaths: string[]): string[] {
  try {
    if (!existsSync(outputDir)) return [];
    const knownSet = new Set(knownPaths.map(p => {
      try { return resolvePath(p); } catch { return p; }
    }));
    const newPaths: string[] = [];
    const walk = (dir: string) => {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          if (statSync(fullPath).isDirectory()) {
            walk(fullPath);
          } else {
            const resolved = resolvePath(fullPath);
            if (!knownSet.has(resolved) && !knownSet.has(fullPath)) {
              newPaths.push(fullPath);
            }
          }
        } catch { /* skip inaccessible entries */ }
      }
    };
    walk(outputDir);
    return newPaths;
  } catch {
    return [];
  }
}

/**
 * Resolves run-artifact directories for a single workflow run.
 *
 * Uses the dedicated `runsDir` when configured, otherwise falls back to the
 * legacy `{workspaceDir}/output` path. Keyed by the workflow's graph id.
 */
export class ArtifactCollector {
  constructor(
    private readonly opts: {
      workspaceDir: string;
      runsDir?: string;
      workflowId: string;
    },
  ) {}

  /** Base directory for this workflow run's artifacts. */
  getRunDir(): string {
    const base = this.opts.runsDir ?? `${this.opts.workspaceDir}/output`;
    return `${base}/${this.opts.workflowId}`;
  }

  /** Output directory for a specific node within this run. */
  getNodeOutputDir(nodeId: string): string {
    return `${this.getRunDir()}/${nodeId}`;
  }

  saveTextOutputIfEmpty(outputDir: string, text: string, filename: string = 'output.md'): string | null {
    return saveTextOutputIfEmpty(outputDir, text, filename);
  }

  scanForUntrackedFiles(outputDir: string, knownPaths: string[]): string[] {
    return scanForUntrackedFiles(outputDir, knownPaths);
  }
}
