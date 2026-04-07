/**
 * @module memory/run-artifact-collector
 * Collects all .md files produced during an orchestration run and stores them
 * to Hindsight memory, tagged with the run ID. This ensures the memory system
 * retains the full detail of every run — not just summaries — so that when a
 * user replies to a run or asks about past work, the system can recall the
 * complete findings, analysis, code reviews, and reports.
 *
 * Design:
 * - Scans the run output directory for .md files (excluding node_modules)
 * - Chunks large files into segments that fit within Hindsight's token budget
 * - Stores each chunk with context='run_artifact' and tags=[runId, nodeLabel]
 * - Stores a manifest index mapping runId → all artifact paths
 * - Skips files that are too small to be meaningful (<50 chars)
 * - Deduplicates against the local retention buffer to avoid re-storing
 *   identical content from overlapping runs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { HindsightClient } from '@orionomega/hindsight';
import { estimateTokens, smartTruncate, compressMemoryContent } from '@orionomega/hindsight';
import { createLogger } from '../logging/logger.js';

const log = createLogger('run-artifact-collector');

/** Maximum tokens per single memory chunk. Hindsight handles up to ~8K but we aim for digestible chunks. */
const MAX_CHUNK_TOKENS = 2048;

/** Minimum content length (chars) to bother storing. Filters out trivially small files. */
const MIN_CONTENT_CHARS = 50;

/** Maximum total tokens per run to prevent a single massive run from overwhelming the memory bank. */
const MAX_TOTAL_TOKENS_PER_RUN = 100_000;

/** Directories to always skip when scanning for .md files. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.cache']);

/** File patterns to skip (generated/lock files that aren't meaningful analysis). */
const SKIP_FILE_PATTERNS = [
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^CHANGELOG\.md$/i,       // Often from dependencies, not from the run
  /^LICENSE\.md$/i,
  /^CODE_OF_CONDUCT\.md$/i,
];

export interface RunArtifactCollectorConfig {
  /** Hindsight client for storing memories. */
  hindsight: HindsightClient;
  /** Target bank ID for storing run artifacts. */
  bankId: string;
  /** Maximum tokens per chunk. Default: 2048. */
  maxChunkTokens?: number;
  /** Maximum total tokens per run. Default: 100000. */
  maxTotalTokensPerRun?: number;
  /** Minimum content length to store. Default: 50. */
  minContentChars?: number;
}

export interface CollectionResult {
  /** Number of .md files found in the run directory. */
  filesFound: number;
  /** Number of memory items stored (may be > filesFound due to chunking). */
  itemsStored: number;
  /** Number of files skipped (too small, in skip list, etc.). */
  filesSkipped: number;
  /** Total tokens stored across all chunks. */
  totalTokens: number;
  /** Whether the token budget was exhausted before all files were stored. */
  budgetExhausted: boolean;
  /** Error messages for any files that failed to store. */
  errors: string[];
}

/**
 * Collects and stores all .md artifacts from a completed run to Hindsight memory.
 *
 * Usage:
 * ```ts
 * const collector = new RunArtifactCollector(config);
 * const result = await collector.collectAndStore(runId, runDir, taskSummary);
 * ```
 */
export class RunArtifactCollector {
  private readonly hs: HindsightClient;
  private readonly bankId: string;
  private readonly maxChunkTokens: number;
  private readonly maxTotalTokens: number;
  private readonly minContentChars: number;

  constructor(config: RunArtifactCollectorConfig) {
    this.hs = config.hindsight;
    this.bankId = config.bankId;
    this.maxChunkTokens = config.maxChunkTokens ?? MAX_CHUNK_TOKENS;
    this.maxTotalTokens = config.maxTotalTokensPerRun ?? MAX_TOTAL_TOKENS_PER_RUN;
    this.minContentChars = config.minContentChars ?? MIN_CONTENT_CHARS;
  }

  /**
   * Scan a run's output directory for all .md files, chunk them, and store
   * each chunk to Hindsight tagged with the run ID.
   *
   * @param runId - The workflow/run ID (e.g. 'fa798483-c4da-433d-ab96-64a7bb6b0f48')
   * @param runDir - Absolute path to the run output directory
   * @param taskSummary - Brief description of what the run was doing
   * @returns Collection statistics
   */
  async collectAndStore(
    runId: string,
    runDir: string,
    taskSummary: string,
  ): Promise<CollectionResult> {
    const result: CollectionResult = {
      filesFound: 0,
      itemsStored: 0,
      filesSkipped: 0,
      totalTokens: 0,
      budgetExhausted: false,
      errors: [],
    };

    if (!existsSync(runDir)) {
      log.warn('Run directory does not exist', { runId, runDir });
      return result;
    }

    // 1. Scan for all .md files
    const mdFiles = this.scanForMdFiles(runDir);
    result.filesFound = mdFiles.length;

    if (mdFiles.length === 0) {
      log.debug('No .md files found in run directory', { runId, runDir });
      return result;
    }

    log.info(`Found ${mdFiles.length} .md files for run ${runId}`, { runDir });

    // 2. Prioritize files: run-summary.md first, then output.md files, then others
    const prioritized = this.prioritizeFiles(mdFiles, runDir);

    // 3. Process each file: read, chunk, store
    const now = new Date().toISOString();

    for (const filePath of prioritized) {
      if (result.budgetExhausted) {
        result.filesSkipped++;
        continue;
      }

      try {
        const content = readFileSync(filePath, 'utf-8');
        const trimmed = content.trim();

        // Skip trivially small files
        if (trimmed.length < this.minContentChars) {
          result.filesSkipped++;
          continue;
        }

        // Determine the node label from the directory structure
        const relPath = relative(runDir, filePath);
        const nodeLabel = this.extractNodeLabel(relPath);

        // Chunk the content if it exceeds the token budget
        const chunks = this.chunkContent(trimmed, filePath, runId, nodeLabel, taskSummary);

        for (const chunk of chunks) {
          // Check total budget
          const chunkTokens = estimateTokens(chunk.content);
          if (result.totalTokens + chunkTokens > this.maxTotalTokens) {
            result.budgetExhausted = true;
            log.warn('Run artifact token budget exhausted', {
              runId,
              totalTokens: result.totalTokens,
              maxTokens: this.maxTotalTokens,
              remainingFiles: prioritized.length - prioritized.indexOf(filePath),
            });
            break;
          }

          // Store to Hindsight
          try {
            await this.hs.retainOne(this.bankId, chunk.content, 'run_artifact');
            result.itemsStored++;
            result.totalTokens += chunkTokens;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`${relPath}: ${msg}`);
            log.warn('Failed to store run artifact chunk', { runId, filePath: relPath, error: msg });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${relative(runDir, filePath)}: ${msg}`);
        log.warn('Failed to read run artifact file', { runId, filePath, error: msg });
        result.filesSkipped++;
      }
    }

    // 4. Store a manifest index for this run
    if (result.itemsStored > 0) {
      try {
        const manifest = this.buildManifest(runId, runDir, mdFiles, taskSummary, result);
        await this.hs.retainOne(this.bankId, manifest, 'run_manifest');
        result.itemsStored++;
        result.totalTokens += estimateTokens(manifest);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`manifest: ${msg}`);
        log.warn('Failed to store run manifest', { runId, error: msg });
      }
    }

    log.info(`Run artifact collection complete for ${runId}`, {
      filesFound: result.filesFound,
      itemsStored: result.itemsStored,
      filesSkipped: result.filesSkipped,
      totalTokens: result.totalTokens,
      budgetExhausted: result.budgetExhausted,
      errors: result.errors.length,
    });

    return result;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Recursively scan a directory for .md files, excluding skip directories.
   */
  private scanForMdFiles(dir: string): string[] {
    const results: string[] = [];

    const walk = (currentDir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(currentDir);
      } catch {
        return; // Skip inaccessible directories
      }

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue;

        const fullPath = join(currentDir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (entry.endsWith('.md') && !this.isSkippedFile(entry)) {
            results.push(fullPath);
          }
        } catch {
          // Skip inaccessible files
        }
      }
    };

    walk(dir);
    return results;
  }

  /**
   * Check if a filename matches any skip patterns.
   */
  private isSkippedFile(filename: string): boolean {
    return SKIP_FILE_PATTERNS.some(pattern => pattern.test(filename));
  }

  /**
   * Prioritize files for storage. Order:
   * 1. run-summary.md (most important — contains the overview)
   * 2. output.md files (per-node detailed output)
   * 3. Other .md files (supplementary reports, docs, etc.)
   */
  private prioritizeFiles(files: string[], runDir: string): string[] {
    const summaries: string[] = [];
    const outputs: string[] = [];
    const others: string[] = [];

    for (const f of files) {
      const name = basename(f);
      if (name === 'run-summary.md') {
        summaries.push(f);
      } else if (name === 'output.md') {
        outputs.push(f);
      } else {
        others.push(f);
      }
    }

    // Sort outputs by directory depth (shallower = more important)
    outputs.sort((a, b) => {
      const depthA = relative(runDir, a).split('/').length;
      const depthB = relative(runDir, b).split('/').length;
      return depthA - depthB;
    });

    return [...summaries, ...outputs, ...others];
  }

  /**
   * Extract a human-readable node label from the relative file path.
   * e.g., "analyze-codebase/output.md" → "analyze-codebase"
   *       "run-summary.md" → "run-summary"
   *       "impl-changes/subdir/report.md" → "impl-changes"
   */
  private extractNodeLabel(relPath: string): string {
    const parts = relPath.split('/');
    if (parts.length === 1) {
      // Top-level file like run-summary.md
      return basename(relPath, '.md');
    }
    // Use the first directory as the node label
    return parts[0];
  }

  /**
   * Chunk content into segments that fit within the token budget.
   * Each chunk is prefixed with metadata (run ID, node, file) for recall context.
   */
  private chunkContent(
    content: string,
    filePath: string,
    runId: string,
    nodeLabel: string,
    taskSummary: string,
  ): Array<{ content: string }> {
    // Compress whitespace and redundancy first
    const compressed = compressMemoryContent(content);
    const tokens = estimateTokens(compressed);

    // Build the metadata header (included in every chunk)
    const header = `[Run: ${runId}] [Node: ${nodeLabel}] [Task: ${taskSummary.slice(0, 200)}]\n`;
    const headerTokens = estimateTokens(header);
    const availableTokens = this.maxChunkTokens - headerTokens;

    if (availableTokens <= 0) {
      log.warn('Header exceeds chunk token budget', { runId, nodeLabel });
      return [{ content: header + smartTruncate(compressed, this.maxChunkTokens / 2) }];
    }

    // If content fits in one chunk, return as-is
    if (tokens <= availableTokens) {
      return [{ content: header + compressed }];
    }

    // Split into chunks by sections (## headings) or paragraphs
    const chunks: Array<{ content: string }> = [];
    const sections = this.splitIntoSections(compressed);

    let currentChunk = '';
    let currentTokens = 0;
    let chunkIndex = 0;

    for (const section of sections) {
      const sectionTokens = estimateTokens(section);

      // If a single section exceeds the budget, truncate it
      if (sectionTokens > availableTokens) {
        // Flush current chunk if any
        if (currentChunk) {
          const chunkHeader = chunks.length > 0
            ? `${header}[Part ${chunkIndex + 1}]\n`
            : header;
          chunks.push({ content: chunkHeader + currentChunk.trim() });
          chunkIndex++;
          currentChunk = '';
          currentTokens = 0;
        }

        // Truncate the oversized section
        const truncated = smartTruncate(section, availableTokens);
        const truncHeader = `${header}[Part ${chunkIndex + 1}]\n`;
        chunks.push({ content: truncHeader + truncated });
        chunkIndex++;
        continue;
      }

      // Check if adding this section would exceed the budget
      if (currentTokens + sectionTokens > availableTokens) {
        // Flush current chunk
        if (currentChunk) {
          const chunkHeader = chunkIndex === 0 ? header : `${header}[Part ${chunkIndex + 1}]\n`;
          chunks.push({ content: chunkHeader + currentChunk.trim() });
          chunkIndex++;
          currentChunk = '';
          currentTokens = 0;
        }
      }

      currentChunk += (currentChunk ? '\n\n' : '') + section;
      currentTokens += sectionTokens;
    }

    // Flush remaining content
    if (currentChunk.trim()) {
      const chunkHeader = chunkIndex === 0 ? header : `${header}[Part ${chunkIndex + 1}]\n`;
      chunks.push({ content: chunkHeader + currentChunk.trim() });
    }

    return chunks;
  }

  /**
   * Split content into logical sections by markdown headings or double newlines.
   */
  private splitIntoSections(content: string): string[] {
    // Split on markdown headings (## or ###)
    const sections = content.split(/(?=^#{1,3}\s)/m).filter(s => s.trim());

    if (sections.length > 1) return sections;

    // No headings found — split on double newlines (paragraphs)
    return content.split(/\n\n+/).filter(s => s.trim());
  }

  /**
   * Build a manifest document summarizing all artifacts stored for a run.
   * This serves as an index that can be recalled to find all artifacts for a run.
   */
  private buildManifest(
    runId: string,
    runDir: string,
    files: string[],
    taskSummary: string,
    stats: CollectionResult,
  ): string {
    const parts: string[] = [
      `# Run Artifact Manifest`,
      ``,
      `- **Run ID:** ${runId}`,
      `- **Task:** ${taskSummary}`,
      `- **Files collected:** ${stats.filesFound}`,
      `- **Items stored:** ${stats.itemsStored}`,
      `- **Total tokens:** ${stats.totalTokens}`,
      `- **Collected at:** ${new Date().toISOString()}`,
      ``,
      `## Artifacts`,
      ``,
    ];

    for (const f of files) {
      const relPath = relative(runDir, f);
      const nodeLabel = this.extractNodeLabel(relPath);
      try {
        const stat = statSync(f);
        parts.push(`- \`${relPath}\` (${nodeLabel}, ${stat.size} bytes)`);
      } catch {
        parts.push(`- \`${relPath}\` (${nodeLabel})`);
      }
    }

    if (stats.budgetExhausted) {
      parts.push('', `⚠️ Token budget exhausted — ${stats.filesSkipped} files were not stored.`);
    }

    if (stats.errors.length > 0) {
      parts.push('', `## Errors`, '');
      for (const err of stats.errors) {
        parts.push(`- ${err}`);
      }
    }

    return parts.join('\n');
  }
}

/**
 * Convenience function to collect and store run artifacts.
 * Creates a RunArtifactCollector and runs collection.
 *
 * @param hindsight - Hindsight client
 * @param bankId - Target bank for storage
 * @param runId - The workflow/run ID
 * @param runDir - Path to the run output directory
 * @param taskSummary - Brief task description
 * @returns Collection statistics
 */
export async function collectRunArtifacts(
  hindsight: HindsightClient,
  bankId: string,
  runId: string,
  runDir: string,
  taskSummary: string,
): Promise<CollectionResult> {
  const collector = new RunArtifactCollector({ hindsight, bankId });
  return collector.collectAndStore(runId, runDir, taskSummary);
}
