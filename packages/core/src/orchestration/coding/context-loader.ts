/**
 * @module orchestration/coding/context-loader
 * Tiered context window loading for agent prompts (Section 6.4 of spec).
 *
 * Four tiers (from spec):
 *   Tier 1 (~5K tokens):  System prompt + task + shared interfaces + conventions
 *   Tier 2 (~15K tokens): Target files the agent will modify (full content)
 *   Tier 3 (~15K tokens): Reference files (selective: signatures + relevant fns)
 *   Tier 4 (~5K tokens):  Ambient files scoring > 0.3 (path + purpose + exports)
 *
 * File selection budgets per agent role are enforced before assembling tiers.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CodingRole } from './coding-types.js';
import type { CodebaseIndex } from './codebase-indexer.js';
import type { ScoringTask } from './relevance-scorer.js';
import { rankFilesByRelevance } from './relevance-scorer.js';
import type { GitInsights } from './git-insights.js';

// ── Per-role budgets (from spec Section 6.4) ──────────────────────────────────

/** Maximum number of context files per agent role. */
export const FILE_BUDGET_PER_ROLE: Partial<Record<CodingRole, number>> & { default: number } = {
  architect: 50,
  implementer: 15,
  'test-writer': 10,
  reviewer: 20,
  stitcher: 30,
  validator: 5,
  'codebase-scanner': 50,
  reporter: 10,
  default: 15,
};

/** Maximum token budget for file content per agent role. */
export const TOKEN_BUDGET_PER_ROLE: Partial<Record<CodingRole, number>> & { default: number } = {
  architect: 80_000,
  implementer: 40_000,
  'test-writer': 30_000,
  reviewer: 50_000,
  stitcher: 60_000,
  validator: 10_000,
  'codebase-scanner': 20_000,
  reporter: 10_000,
  default: 40_000,
};

// ── Types ─────────────────────────────────────────────────────────────────────

/** Approximate token count (conservative: 1 token ≈ 4 chars). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A context entry with tier assignment. */
export interface ContextEntry {
  /** Relative file path. */
  path: string;
  /** Full or partial file content. */
  content: string;
  /** Tier this entry belongs to. */
  tier: 1 | 2 | 3 | 4;
  /** Relevance score 0–1. */
  relevanceScore: number;
  /** Estimated token count of content. */
  estimatedTokens: number;
}

/** The assembled tiered context for an agent. */
export interface TieredContext {
  /** Tier 1: always-included system context (passed separately, not in entries). */
  tier1Summary: string;
  /** All file-based context entries, sorted by tier then relevance. */
  entries: ContextEntry[];
  /** Total estimated token cost of all entries. */
  totalTokens: number;
  /** Number of files that were dropped due to budget constraints. */
  droppedFileCount: number;
}

// ── Extract signatures/headers from file content ──────────────────────────────

/**
 * Extract only the "skeleton" of a file: top-level declarations,
 * function signatures, class names — without bodies.
 * Used for Tier 3 context files to save tokens.
 */
export function extractFileSkeleton(content: string, language: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let depth = 0;
  let inDocComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track block depth
    if (language === 'typescript' || language === 'javascript') {
      if (trimmed.startsWith('/*')) inDocComment = true;
      if (inDocComment) {
        kept.push(line);
        if (trimmed.includes('*/')) inDocComment = false;
        continue;
      }

      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      const netChange = opens - closes;

      if (depth === 0) {
        // At top level: keep everything
        kept.push(line);
      } else if (depth === 1 && trimmed && !trimmed.startsWith('//')) {
        // One level deep: keep first line of methods (signature)
        if (opens > closes) {
          kept.push(line + ' /* ... */');
        }
      } else {
        // Deeper: skip
      }

      depth = Math.max(0, depth + netChange);
    } else {
      // For other languages: keep all lines with declarations (heuristic)
      if (
        trimmed.startsWith('def ') || trimmed.startsWith('class ') ||
        trimmed.startsWith('func ') || trimmed.startsWith('fn ') ||
        trimmed.startsWith('pub ') || trimmed.startsWith('import ') ||
        trimmed.startsWith('from ') || trimmed.startsWith('export ')
      ) {
        kept.push(line);
      }
    }
  }

  return kept.join('\n');
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Assemble tiered context for an agent.
 *
 * @param task       - The current coding task (provides target + context files).
 * @param role       - The agent role (determines file + token budget).
 * @param index      - The codebase index (for relevance scoring).
 * @param gitInsights - Optional git history for co-change scoring.
 * @returns Assembled tiered context ready for prompt injection.
 */
export function buildTieredContext(
  task: ScoringTask,
  role: CodingRole,
  index: CodebaseIndex,
  gitInsights?: GitInsights,
): TieredContext {
  const workspaceDir = index.workspaceDir;
  const maxFiles = FILE_BUDGET_PER_ROLE[role] ?? FILE_BUDGET_PER_ROLE.default;
  const tokenBudget = TOKEN_BUDGET_PER_ROLE[role] ?? TOKEN_BUDGET_PER_ROLE.default;

  const entries: ContextEntry[] = [];
  let totalTokens = 0;
  let droppedFileCount = 0;

  // ─ Tier 2: Target files (full content) ─────────────────────────────────────
  for (const relPath of task.targetFiles) {
    if (entries.length >= maxFiles) { droppedFileCount++; continue; }
    const absPath = join(workspaceDir, relPath);
    const content = safeRead(absPath);
    if (!content) continue;
    const tokens = estimateTokens(content);
    if (totalTokens + tokens > tokenBudget) { droppedFileCount++; continue; }
    totalTokens += tokens;
    entries.push({ path: relPath, content, tier: 2, relevanceScore: 1.0, estimatedTokens: tokens });
  }

  // ─ Tier 3: Context files (skeleton/partial) ─────────────────────────────────
  for (const relPath of task.contextFiles) {
    if (entries.some((e) => e.path === relPath)) continue;
    if (entries.length >= maxFiles) { droppedFileCount++; continue; }
    const absPath = join(workspaceDir, relPath);
    const raw = safeRead(absPath);
    if (!raw) continue;
    const record = index.files.get(relPath);
    const language = record?.language ?? 'unknown';
    const content = extractFileSkeleton(raw, language);
    const tokens = estimateTokens(content);
    if (totalTokens + tokens > tokenBudget) { droppedFileCount++; continue; }
    totalTokens += tokens;
    entries.push({ path: relPath, content, tier: 3, relevanceScore: 0.9, estimatedTokens: tokens });
  }

  // ─ Tier 4: Ambient files (score > 0.3, path + exports summary) ─────────────
  const ranked = rankFilesByRelevance(task, index, gitInsights, 0.3);
  for (const { path: relPath, score } of ranked) {
    if (entries.some((e) => e.path === relPath)) continue;
    if (entries.length >= maxFiles) { droppedFileCount++; continue; }
    const record = index.files.get(relPath);
    if (!record) continue;
    // Build a short summary: path + exported symbols
    const exports = record.symbols
      .filter((s) => s.exported)
      .map((s) => `  ${s.kind} ${s.name}`)
      .join('\n');
    const content = `// ${relPath}\n${exports || '  (no exports)'}`;
    const tokens = estimateTokens(content);
    if (totalTokens + tokens > tokenBudget) { droppedFileCount++; continue; }
    totalTokens += tokens;
    entries.push({ path: relPath, content, tier: 4, relevanceScore: score, estimatedTokens: tokens });
  }

  // Sort: tier ascending, then relevance descending
  entries.sort((a, b) => a.tier - b.tier || b.relevanceScore - a.relevanceScore);

  const tier1Summary = buildTier1Summary(task);

  return { tier1Summary, entries, totalTokens, droppedFileCount };
}

// ── Tier 1 summary ────────────────────────────────────────────────────────────

function buildTier1Summary(task: ScoringTask): string {
  const lines: string[] = ['## Task'];
  lines.push(task.description);
  lines.push('');
  if (task.targetFiles.length > 0) {
    lines.push('## Files to modify');
    for (const f of task.targetFiles) lines.push(`- ${f}`);
    lines.push('');
  }
  if (task.contextFiles.length > 0) {
    lines.push('## Reference files');
    for (const f of task.contextFiles) lines.push(`- ${f}`);
  }
  return lines.join('\n');
}

// ── Safe file reader ──────────────────────────────────────────────────────────

function safeRead(absPath: string, maxBytes = 200_000): string | null {
  if (!existsSync(absPath)) return null;
  try {
    const raw = readFileSync(absPath, 'utf-8');
    return raw.length > maxBytes ? raw.slice(0, maxBytes) + '\n// ... [truncated]' : raw;
  } catch {
    return null;
  }
}
