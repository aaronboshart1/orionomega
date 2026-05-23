/**
 * @module orchestration/coding/git-insights
 * Git history analysis for co-change detection (Section 4.2 of spec).
 *
 * Analyses git log to extract:
 *   - Co-change clusters (files that frequently change together)
 *   - Hot files (most frequently modified in last 30 days)
 *   - Directory ownership (recent contributors per directory)
 *   - Active branches
 *
 * All git operations are read-only and do not affect the working tree.
 */

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../../logging/logger.js';

const execAsync = promisify(execCb);
const log = createLogger('git-insights');

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Aggregated insights from git history for use in relevance scoring
 * and planning decisions.
 */
export interface GitInsights {
  /**
   * Files that frequently change together (co-change coupling).
   * Key: file path, Value: array of files that changed in same commits.
   */
  cochangeClusters: Map<string, string[]>;

  /**
   * Files most frequently modified in the last 30 days, sorted by
   * modification frequency (most frequent first).
   */
  hotFiles: string[];

  /**
   * Recent contributors per directory prefix.
   * Key: directory path (e.g. 'src/components'), Value: author emails/names.
   */
  directoryOwnership: Map<string, string[]>;

  /**
   * Names of recently active branches (excluding current HEAD).
   */
  activeBranches: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Number of days to look back for co-change and hot file analysis. */
const ANALYSIS_WINDOW_DAYS = 30;

/** Minimum number of co-changes before recording as a cluster. */
const MIN_COCHANGE_COUNT = 2;

/** Maximum number of commits to analyse. */
const MAX_COMMITS = 500;

/** Maximum number of hot files to return. */
const MAX_HOT_FILES = 50;

/** Maximum number of branches to return. */
const MAX_BRANCHES = 20;

// ── Git helpers ───────────────────────────────────────────────────────────────

async function gitExec(cwd: string, args: string): Promise<string> {
  const { stdout } = await execAsync(`git ${args}`, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await gitExec(dir, 'rev-parse --git-dir');
    return true;
  } catch {
    return false;
  }
}

// ── Co-change analysis ────────────────────────────────────────────────────────

/**
 * Parse `git log --name-only` output into an array of commit file lists.
 */
function parseCommitFileLists(output: string): string[][] {
  const commits: string[][] = [];
  const blocks = output.split('\n\n').filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    // First line is the commit hash (from --format=%H), rest are file paths
    const files = lines.slice(1).filter((l) => l.length > 0 && !l.startsWith('commit '));
    if (files.length > 0) commits.push(files);
  }
  return commits;
}

/**
 * Build a co-change cluster map from commit file lists.
 * For each file, tracks which other files it co-changed with and the frequency.
 */
function buildCochangeClusters(commitFileLists: string[][]): Map<string, string[]> {
  const cochangeCount = new Map<string, Map<string, number>>();

  for (const files of commitFileLists) {
    if (files.length < 2) continue;
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i];
        const b = files[j];
        if (!cochangeCount.has(a)) cochangeCount.set(a, new Map());
        if (!cochangeCount.has(b)) cochangeCount.set(b, new Map());
        cochangeCount.get(a)!.set(b, (cochangeCount.get(a)!.get(b) ?? 0) + 1);
        cochangeCount.get(b)!.set(a, (cochangeCount.get(b)!.get(a) ?? 0) + 1);
      }
    }
  }

  const clusters = new Map<string, string[]>();
  for (const [file, coFiles] of cochangeCount.entries()) {
    const frequent = Array.from(coFiles.entries())
      .filter(([, count]) => count >= MIN_COCHANGE_COUNT)
      .sort((a, b) => b[1] - a[1])
      .map(([f]) => f);
    if (frequent.length > 0) {
      clusters.set(file, frequent);
    }
  }
  return clusters;
}

// ── Hot files analysis ────────────────────────────────────────────────────────

/**
 * Count how many times each file was modified in the analysis window.
 */
function computeHotFiles(commitFileLists: string[][]): string[] {
  const counts = new Map<string, number>();
  for (const files of commitFileLists) {
    for (const file of files) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f)
    .slice(0, MAX_HOT_FILES);
}

// ── Directory ownership ───────────────────────────────────────────────────────

/**
 * Parse `git log --format="%ae %H" -- <dir>` output to infer directory ownership.
 * Groups files by their top 2 directory components.
 */
async function computeDirectoryOwnership(
  cwd: string,
  commitFileLists: string[][],
  since: string,
): Promise<Map<string, string[]>> {
  const dirContributors = new Map<string, Map<string, number>>();

  // Use git shortlog to get per-directory contributor data
  try {
    const output = await gitExec(
      cwd,
      `log --since="${since}" --format="%ae" --name-only --diff-filter=AM`,
    );
    const sections = output.split('\n\n').filter(Boolean);
    for (const section of sections) {
      const lines = section.split('\n').filter(Boolean);
      if (lines.length < 2) continue;
      const author = lines[0].trim();
      const files = lines.slice(1);
      for (const file of files) {
        const parts = file.split('/');
        const dirKey = parts.length >= 2 ? parts.slice(0, 2).join('/') : parts[0];
        if (!dirContributors.has(dirKey)) dirContributors.set(dirKey, new Map());
        const existing = dirContributors.get(dirKey)!;
        existing.set(author, (existing.get(author) ?? 0) + 1);
      }
    }
  } catch {
    // Fall back to extracting from commitFileLists (no author info available)
    return new Map();
  }

  const result = new Map<string, string[]>();
  for (const [dir, contributors] of dirContributors.entries()) {
    const sorted = Array.from(contributors.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([email]) => email)
      .slice(0, 5);
    result.set(dir, sorted);
  }
  return result;
}

// ── Active branches ───────────────────────────────────────────────────────────

async function getActiveBranches(cwd: string): Promise<string[]> {
  try {
    const output = await gitExec(
      cwd,
      `branch --sort=-committerdate --format="%(refname:short)"`,
    );
    return output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l !== 'HEAD')
      .slice(0, MAX_BRANCHES);
  } catch {
    return [];
  }
}

// ── Main analysis function ────────────────────────────────────────────────────

/**
 * Analyse the git history of a workspace directory to extract change patterns.
 *
 * @param workspaceDir - Absolute path to the git repository root.
 * @returns GitInsights object with co-change clusters, hot files, etc.
 */
export async function analyzeGitHistory(workspaceDir: string): Promise<GitInsights> {
  const empty: GitInsights = {
    cochangeClusters: new Map(),
    hotFiles: [],
    directoryOwnership: new Map(),
    activeBranches: [],
  };

  if (!(await isGitRepo(workspaceDir))) {
    log.warn('Not a git repository, skipping git insights', { workspaceDir });
    return empty;
  }

  const since = `${ANALYSIS_WINDOW_DAYS} days ago`;

  try {
    // Fetch commit+file list for the analysis window
    const logOutput = await gitExec(
      workspaceDir,
      `log --since="${since}" --format="%H" --name-only --diff-filter=AM -n ${MAX_COMMITS}`,
    );

    const commitFileLists = parseCommitFileLists(logOutput);
    log.info(`Analysed ${commitFileLists.length} commits for git insights`);

    const cochangeClusters = buildCochangeClusters(commitFileLists);
    const hotFiles = computeHotFiles(commitFileLists);
    const directoryOwnership = await computeDirectoryOwnership(workspaceDir, commitFileLists, since);
    const activeBranches = await getActiveBranches(workspaceDir);

    return { cochangeClusters, hotFiles, directoryOwnership, activeBranches };
  } catch (err) {
    log.warn('Failed to analyse git history', { err });
    return empty;
  }
}

/**
 * Get the co-change frequency between a candidate file and a set of target files.
 * Returns a value in [0, 1].
 */
export function gitCochangeFrequency(
  file: string,
  targetFiles: string[],
  insights: GitInsights,
): number {
  if (targetFiles.length === 0) return 0;
  let count = 0;
  for (const target of targetFiles) {
    const cluster = insights.cochangeClusters.get(target) ?? [];
    if (cluster.includes(file)) count++;
  }
  return count / targetFiles.length;
}
