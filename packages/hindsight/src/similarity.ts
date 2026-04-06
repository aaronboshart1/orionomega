/**
 * @module similarity
 * Fast text similarity utilities for deduplication, relevance scoring,
 * and token-efficient memory management. Provides shared token estimation,
 * smart truncation, and content compression used across the memory subsystem.
 */

/**
 * Structural prefixes added during storage (e.g. `[user]`, `Task:`, `Node:`)
 * must be stripped before scoring so they don't pollute keyword matching.
 */
const STRUCTURAL_PREFIX_RE = /^\[(user|assistant|system)\]\s*/i;
const STRUCTURAL_LABEL_RE = /\b(Task|Workers|Decisions|Findings|Node|Workflow|Output|Result|Errors|Outputs|Artifacts):\s*/gi;
const BRACKET_NOISE_RE = /[[\]]/g;

// ── Token Estimation ───────────────────────────────────────────────────

// Patterns that indicate code-heavy content (lower chars-per-token ratio)
const CODE_INDICATORS = /[{}();=<>]|\b(function|const|let|var|import|export|class|interface|type|return|if|else|for|while)\b/;

/**
 * Estimate token count for text content. More accurate than naive `length/4`
 * by accounting for content type:
 * - Code/structured text: ~3.2 chars per token (more symbols, short identifiers)
 * - Natural language: ~4.0 chars per token
 * - Whitespace-heavy: compressed by tokenizer, so pre-collapse before counting
 *
 * Shared across the memory subsystem to ensure consistent budgeting.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Collapse whitespace runs — tokenizers compress these
  const collapsed = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  const ratio = CODE_INDICATORS.test(collapsed) ? 3.2 : 4.0;
  return Math.ceil(collapsed.length / ratio);
}

// ── Smart Truncation ───────────────────────────────────────────────────

// High-signal sentence patterns worth preserving during truncation
const HIGH_SIGNAL_SENTENCE = /\b(decided|decision|chose|because|blocked|error|fix|prefer|requirement|architecture|deploy|migration|config)\b/i;

/**
 * Truncate content to fit within a token budget while preserving the most
 * important information. Strategy:
 * 1. If content fits, return as-is
 * 2. Always keep first sentence (establishes context) and last sentence (recency)
 * 3. From the middle, prefer sentences with high-signal keywords
 * 4. Append truncation marker so consumers know content was shortened
 */
export function smartTruncate(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) return content;

  const sentences = content.split(/(?<=[.!?\n])\s+/).filter(Boolean);
  if (sentences.length <= 2) {
    // Can't split further — hard truncate by character
    const maxChars = Math.floor(maxTokens * 3.5);
    return content.slice(0, maxChars) + '…';
  }

  // Always include first and last sentence
  const first = sentences[0];
  const last = sentences[sentences.length - 1];
  let budget = maxTokens - estimateTokens(first) - estimateTokens(last) - 5; // 5 tokens for marker

  // Score middle sentences by signal keywords
  const middle = sentences.slice(1, -1).map((s, idx) => ({
    text: s,
    idx,
    signal: HIGH_SIGNAL_SENTENCE.test(s) ? 1 : 0,
    tokens: estimateTokens(s),
  }));

  // Sort by signal (high first), then by original order for stability
  middle.sort((a, b) => b.signal - a.signal || a.idx - b.idx);

  const kept: Array<{ text: string; idx: number }> = [];
  for (const s of middle) {
    if (budget < s.tokens) continue;
    budget -= s.tokens;
    kept.push({ text: s.text, idx: s.idx });
  }

  // Restore original order
  kept.sort((a, b) => a.idx - b.idx);

  const parts = [first, ...kept.map((k) => k.text), last];
  const truncatedCount = sentences.length - parts.length;
  if (truncatedCount > 0) {
    parts.push(`[${truncatedCount} sentences truncated]`);
  }
  return parts.join(' ');
}

// ── Content Compression ────────────────────────────────────────────────

/**
 * Compress memory content to reduce token overhead before storage.
 * Applies transformations that preserve meaning:
 * - Collapse excessive whitespace and blank lines
 * - Deduplicate consecutive identical lines
 * - Strip trailing filler phrases
 */
export function compressMemoryContent(content: string): string {
  let c = content;
  // Collapse multiple blank lines to single
  c = c.replace(/\n{3,}/g, '\n\n');
  // Collapse whitespace runs
  c = c.replace(/[ \t]{2,}/g, ' ');
  // Strip trailing filler phrases
  c = c.replace(/\s*(let me know if you (?:need|have|want) (?:anything|any|more)|feel free to (?:ask|reach out)|hope this helps|happy to help)[.!]?\s*$/i, '');
  // Deduplicate consecutive identical lines
  c = c.replace(/^(.+)$\n(?:\1$\n?)+/gm, '$1');
  return c.trim();
}

// ── Normalization & Trigrams ───────────────────────────────────────────

function normalize(text: string): string {
  let t = text.toLowerCase();
  // F1: Strip structural prefixes that pollute keyword matching
  t = t.replace(STRUCTURAL_PREFIX_RE, '');
  // F1: Strip structural labels entirely (Task:, Node:, etc.)
  t = t.replace(STRUCTURAL_LABEL_RE, '');
  t = t.replace(BRACKET_NOISE_RE, '');
  // Strip colons fused to any word (e.g. "context:" → "context", "mentioned_at:" → "mentioned_at")
  t = t.replace(/(\w):/g, '$1');
  return t.replace(/\s+/g, ' ').trim();
}

function trigrams(normalized: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    set.add(normalized.slice(i, i + 3));
  }
  return set;
}

export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length < 3 || nb.length < 3) {
    return na === nb ? 1 : 0;
  }
  const ta = trigrams(na);
  const tb = trigrams(nb);
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  return intersection / (ta.size + tb.size - intersection);
}

/**
 * Keyword overlap score: fraction of meaningful query words (>2 chars)
 * that appear in the content. Uses distinct-match counting via Set
 * intersection to avoid frequency bias.
 *
 * F2: Lowered from >3 to >2 to include 3-char technical terms
 *     (fix, bug, sql, api, git, npm, cli, css, env, etc.)
 * F3: Count distinct matches instead of frequency-based hits to prevent
 *     content repeating one word from outscoring content matching multiple
 *     query words.
 */
function computeKeywordScore(nQuery: string, nContent: string): number {
  const queryWords = new Set(nQuery.split(' ').filter((w) => w.length > 2));
  if (queryWords.size === 0) return 0;
  const contentWordSet = new Set(nContent.split(' ').filter((w) => w.length > 2));
  let distinctHits = 0;
  for (const w of queryWords) {
    if (contentWordSet.has(w)) distinctHits++;
  }
  return Math.min(1, distinctHits / queryWords.size);
}

/**
 * Compute a client-side relevance proxy for a memory item against a query.
 *
 * Uses a combination of:
 * 1. Trigram similarity (structural overlap)
 * 2. Keyword overlap (semantic signal from shared meaningful words)
 * 3. Length penalty (very short memories get a small penalty)
 *
 * This is used as a fallback when the API returns relevance=0 for all results.
 *
 * @param query - The search query.
 * @param content - The memory content to score.
 * @returns A relevance score between 0 and 1.
 */
export function computeClientRelevance(query: string, content: string): number {
  const nq = normalize(query);
  const nc = normalize(content);

  if (nq.length === 0 || nc.length === 0) return 0;

  // Component 1: Trigram similarity (structural overlap)
  const trigramScore = trigramSimilarity(query, content);

  // Component 2: Keyword overlap (semantic signal)
  const keywordScore = computeKeywordScore(nq, nc);

  // Component 3: Length signal — very short content (<20 chars) is likely low-value
  const lengthPenalty = nc.length < 20 ? 0.8 : 1.0;

  // Weighted combination: keywords 0.6, trigrams 0.4, then apply length penalty
  const raw = (keywordScore * 0.6 + trigramScore * 0.4) * lengthPenalty;

  return Math.max(0, Math.min(1, raw));
}

// ── Deduplication ──────────────────────────────────────────────────────

/**
 * Deduplicate items by content similarity. Uses a fingerprint cache to
 * short-circuit exact matches before falling through to trigram comparison.
 * Items should be pre-sorted by relevance (highest first) for best results.
 */
export function deduplicateByContent<T extends { content: string; relevance?: number }>(
  items: T[],
  threshold = 0.85,
): T[] {
  if (items.length <= 1) return items;

  // Fast path: exact-match fingerprint check before expensive trigram comparison
  const seenFingerprints = new Set<string>();
  const kept: T[] = [];

  for (const item of items) {
    // Fingerprint: first 100 chars normalized (catches exact and near-exact dupes cheaply)
    const fp = item.content.toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
    if (seenFingerprints.has(fp)) continue;

    const isDuplicate = kept.some(
      (existing) => trigramSimilarity(existing.content, item.content) >= threshold,
    );
    if (!isDuplicate) {
      kept.push(item);
      seenFingerprints.add(fp);
    }
  }
  return kept;
}

// ── Batch Deduplication ────────────────────────────────────────────────

/**
 * Check if a new content string is a duplicate of any item in a batch.
 * More efficient than isDuplicateContent for checking against a local set.
 */
export function isDuplicateInBatch(
  content: string,
  existing: Array<{ content: string }>,
  threshold = 0.85,
): boolean {
  for (const item of existing) {
    if (trigramSimilarity(content, item.content) >= threshold) return true;
  }
  return false;
}
