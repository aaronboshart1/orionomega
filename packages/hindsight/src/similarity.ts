/**
 * @module similarity
 * Fast text similarity utilities for deduplication and relevance scoring
 * of recalled memories. Uses trigram overlap (Jaccard index) for short
 * text comparison.
 */

/**
 * Structural prefixes added during storage (e.g. `[user]`, `Task:`, `Node:`)
 * must be stripped before scoring so they don't pollute keyword matching.
 */
const STRUCTURAL_PREFIX_RE = /^\[(user|assistant|system)\]\s*/i;
const STRUCTURAL_LABEL_RE = /\b(Task|Workers|Decisions|Findings|Node|Workflow|Output|Result|Errors|Outputs|Artifacts):\s*/gi;
const BRACKET_NOISE_RE = /[\[\]]/g;

function normalize(text: string): string {
  let t = text.toLowerCase();
  // F1: Strip structural prefixes that pollute keyword matching
  t = t.replace(STRUCTURAL_PREFIX_RE, '');
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

export function deduplicateByContent<T extends { content: string; relevance?: number }>(
  items: T[],
  threshold = 0.85,
): T[] {
  if (items.length <= 1) return items;
  const kept: T[] = [];
  for (const item of items) {
    const isDuplicate = kept.some(
      (existing) => trigramSimilarity(existing.content, item.content) >= threshold,
    );
    if (!isDuplicate) {
      kept.push(item);
    }
  }
  return kept;
}
