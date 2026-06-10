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

// ── Hashing helpers (feature hashing & bloom) ──────────────────────────

/** 32-bit FNV-1a hash. Deterministic, fast, good distribution for short keys. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (FNV prime), kept in 32-bit space
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** 32-bit djb2 hash — used as a second independent hash for double hashing. */
function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

// ── Vector embeddings & hybrid recall ──────────────────────────────────

/**
 * Pluggable embedding backend. Inject a real provider (e.g. an Anthropic /
 * OpenAI embedding model, or a local sentence-transformer) to give recall a
 * genuine semantic channel that captures synonyms and paraphrase. When no
 * provider is supplied, recall falls back to the lexical (trigram + keyword)
 * score plus the deterministic {@link localEmbedding} as a cheap vector proxy.
 */
export interface EmbeddingProvider {
  /** Embed a batch of texts into fixed-dimension vectors (one per input). */
  embed(texts: string[]): Promise<number[][]>;
  /** Dimensionality of returned vectors (informational). */
  readonly dimensions?: number;
}

/** Default dimensionality for the local feature-hashed embedding. */
export const DEFAULT_EMBEDDING_DIMS = 256;

/**
 * Deterministic, dependency-free word-level embedding via signed feature
 * hashing. Each meaningful token is hashed to a bucket and added with a
 * sign derived from a second hash, then the vector is L2-normalised.
 *
 * This is a *lexical* vector (bag-of-words in disguise), not a semantic one —
 * it will not capture synonyms. Its value is (a) a fast, offline cosine
 * channel that is more robust to word order and structural noise than raw
 * trigrams, and (b) a drop-in fallback so the hybrid pipeline behaves
 * consistently whether or not a real {@link EmbeddingProvider} is wired up.
 */
export function localEmbedding(text: string, dims = DEFAULT_EMBEDDING_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const norm = normalize(text);
  if (norm.length === 0) return vec;
  const words = norm.split(' ').filter((w) => w.length > 1);
  for (const w of words) {
    const idx = fnv1a(w) % dims;
    const sign = (djb2(w) & 1) === 0 ? 1 : -1;
    vec[idx] += sign;
  }
  let mag = 0;
  for (const v of vec) mag += v * v;
  mag = Math.sqrt(mag);
  if (mag > 0) {
    for (let i = 0; i < dims; i++) vec[i] /= mag;
  }
  return vec;
}

/** Cosine similarity of two vectors. Returns 0 for empty / zero vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  if (ma === 0 || mb === 0) return 0;
  return dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

/**
 * Blend a lexical relevance score [0,1] with a vector cosine [-1,1].
 * Negative cosine is clamped to 0 (anti-correlation is treated as "no
 * signal", not as a penalty). When `vector` is undefined the lexical score
 * passes through unchanged, so callers don't need branchy code.
 *
 * @param vectorWeight - Fraction of the blend assigned to the vector channel
 *   (0 = lexical only, 1 = vector only). Default 0.5.
 */
export function combineRelevance(
  lexical: number,
  vector: number | undefined,
  vectorWeight = 0.5,
): number {
  if (vector === undefined || Number.isNaN(vector)) return clamp01(lexical);
  const vw = Math.max(0, Math.min(1, vectorWeight));
  const v = Math.max(0, vector);
  return clamp01(lexical * (1 - vw) + v * vw);
}

/**
 * Hybrid relevance: the existing lexical proxy ({@link computeClientRelevance})
 * augmented with a vector cosine when both query and content embeddings are
 * supplied. This is the entry point the client uses to fold semantic recall
 * into the all-zero-relevance fallback path.
 */
export function computeHybridRelevance(
  query: string,
  content: string,
  opts?: {
    queryEmbedding?: readonly number[];
    contentEmbedding?: readonly number[];
    vectorWeight?: number;
  },
): number {
  const lexical = computeClientRelevance(query, content);
  if (opts?.queryEmbedding && opts?.contentEmbedding) {
    const cos = cosineSimilarity(opts.queryEmbedding, opts.contentEmbedding);
    return combineRelevance(lexical, cos, opts.vectorWeight);
  }
  return lexical;
}

// ── Trigram profiles (shared precompute for dedup pre-filtering) ────────

/**
 * Precomputed trigram profile for a piece of content. Building this once and
 * reusing it across many comparisons is the key to fast dedup on large
 * ingests — `normalize` + `trigrams` are the per-pair cost we want to avoid
 * recomputing.
 */
interface TrigramProfile {
  raw: string;
  norm: string;
  tris: Set<string>;
}

function prepareTrigramProfile(content: string): TrigramProfile {
  const norm = normalize(content);
  const tris = norm.length >= 3 ? trigrams(norm) : new Set<string>();
  return { raw: content, norm, tris };
}

/**
 * Trigram similarity over precomputed profiles. Behaviourally identical to
 * {@link trigramSimilarity} but skips the normalise/trigram work.
 */
function trigramSimilarityPrepared(a: TrigramProfile, b: TrigramProfile): number {
  if (a.raw === b.raw) return 1;
  if (a.norm === b.norm) return 1;
  if (a.norm.length < 3 || b.norm.length < 3) return a.norm === b.norm ? 1 : 0;
  let intersection = 0;
  // Iterate the smaller set for fewer lookups.
  const [small, large] = a.tris.size <= b.tris.size ? [a.tris, b.tris] : [b.tris, a.tris];
  for (const t of small) {
    if (large.has(t)) intersection++;
  }
  return intersection / (a.tris.size + b.tris.size - intersection);
}

/**
 * Admissible size-ratio bound for Jaccard similarity. For two trigram sets of
 * sizes `sa`, `sb`, Jaccard `I/(sa+sb-I) ≤ min/max`. So if `min/max < threshold`
 * the pair *cannot* reach the threshold and can be skipped without computing
 * the full similarity — a sound pre-filter that never drops a true duplicate.
 *
 * Returns the inclusive integer band of candidate sizes worth comparing
 * against a set of size `size`.
 */
function admissibleSizeBand(size: number, threshold: number): { lo: number; hi: number } {
  if (threshold <= 0) return { lo: 1, hi: Number.MAX_SAFE_INTEGER };
  return { lo: Math.ceil(size * threshold), hi: Math.floor(size / threshold) };
}

// ── Deduplication ──────────────────────────────────────────────────────

/**
 * Deduplicate items by content similarity. Uses a fingerprint cache to
 * short-circuit exact matches, then a size-blocked trigram pre-filter so each
 * candidate is only compared against kept items whose trigram-set size could
 * plausibly clear the threshold (see {@link admissibleSizeBand}). The result
 * is byte-for-byte identical to the naive O(n²) all-pairs comparison — the
 * blocking only removes comparisons that are provably below threshold.
 *
 * Items should be pre-sorted by relevance (highest first) for best results.
 */
export function deduplicateByContent<T extends { content: string; relevance?: number }>(
  items: T[],
  threshold = 0.85,
): T[] {
  if (items.length <= 1) return items;

  const seenFingerprints = new Set<string>();
  const kept: T[] = [];
  const keptProfiles: TrigramProfile[] = [];
  // size → indices into keptProfiles, for the size-ratio pre-filter.
  const bySize = new Map<number, number[]>();
  // Profiles whose normalised form is too short to form trigrams. A sized
  // candidate can only match these if norms are equal (impossible across
  // different lengths), so they're only relevant to other zero-size items.
  const zeroSize: number[] = [];

  for (const item of items) {
    const fp = item.content.toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
    if (seenFingerprints.has(fp)) continue;

    const prof = prepareTrigramProfile(item.content);
    const size = prof.tris.size;
    let isDuplicate = false;

    if (size === 0) {
      for (const i of zeroSize) {
        if (trigramSimilarityPrepared(prof, keptProfiles[i]) >= threshold) {
          isDuplicate = true;
          break;
        }
      }
    } else {
      const { lo, hi } = admissibleSizeBand(size, threshold);
      for (let s = lo; s <= hi && !isDuplicate; s++) {
        const idxs = bySize.get(s);
        if (!idxs) continue;
        for (const i of idxs) {
          if (trigramSimilarityPrepared(prof, keptProfiles[i]) >= threshold) {
            isDuplicate = true;
            break;
          }
        }
      }
    }

    if (!isDuplicate) {
      const idx = keptProfiles.push(prof) - 1;
      kept.push(item);
      seenFingerprints.add(fp);
      if (size === 0) {
        zeroSize.push(idx);
      } else {
        const arr = bySize.get(size);
        if (arr) arr.push(idx);
        else bySize.set(size, [idx]);
      }
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
  const prof = prepareTrigramProfile(content);
  for (const item of existing) {
    if (trigramSimilarityPrepared(prof, prepareTrigramProfile(item.content)) >= threshold) {
      return true;
    }
  }
  return false;
}

// ── Bloom filter & streaming dedup index ───────────────────────────────

/**
 * Compact probabilistic set membership. Never reports a false negative (an
 * added key always reports `has === true`); may report a bounded rate of
 * false positives. Used by {@link DedupIndex} to short-circuit exact-content
 * repeats without an exact-fingerprint Set blowing up memory on huge ingests.
 */
export class BloomFilter {
  private readonly bits: Uint8Array;
  private readonly m: number;
  private readonly k: number;

  constructor(expectedItems: number, falsePositiveRate = 0.01) {
    const n = Math.max(1, Math.floor(expectedItems));
    const p = Math.min(0.5, Math.max(1e-6, falsePositiveRate));
    this.m = Math.max(8, Math.ceil(-(n * Math.log(p)) / (Math.LN2 * Math.LN2)));
    this.k = Math.max(1, Math.round((this.m / n) * Math.LN2));
    this.bits = new Uint8Array(Math.ceil(this.m / 8));
  }

  private indices(key: string): number[] {
    // Double hashing: g_i(x) = (h1 + i*h2) mod m. h2 forced odd for full period.
    const h1 = fnv1a(key);
    const h2 = djb2(key) | 1;
    const out = new Array<number>(this.k);
    for (let i = 0; i < this.k; i++) {
      out[i] = ((h1 + i * h2) >>> 0) % this.m;
    }
    return out;
  }

  add(key: string): void {
    for (const idx of this.indices(key)) {
      this.bits[idx >> 3] |= 1 << (idx & 7);
    }
  }

  has(key: string): boolean {
    for (const idx of this.indices(key)) {
      if ((this.bits[idx >> 3] & (1 << (idx & 7))) === 0) return false;
    }
    return true;
  }

  /** Number of bits in the filter. */
  get bitSize(): number { return this.m; }
  /** Number of hash functions. */
  get hashCount(): number { return this.k; }
}

/**
 * Streaming near-duplicate index for large ingests. Accumulates content and
 * answers "is this a near-duplicate of anything seen so far?" using the same
 * bloom + size-blocked trigram pre-filter as {@link deduplicateByContent}, so
 * its verdicts match a brute-force trigram scan exactly while doing far fewer
 * comparisons. Designed for `isDuplicateContent`-style hot loops that would
 * otherwise be O(n²) on big batches.
 */
export class DedupIndex {
  private readonly profiles: TrigramProfile[] = [];
  private readonly bySize = new Map<number, number[]>();
  private readonly zeroSize: number[] = [];
  private readonly bloom: BloomFilter;
  private readonly exactFps = new Set<string>();
  private readonly defaultThreshold: number;

  constructor(opts?: { expectedItems?: number; threshold?: number; falsePositiveRate?: number }) {
    this.defaultThreshold = opts?.threshold ?? 0.85;
    this.bloom = new BloomFilter(opts?.expectedItems ?? 4096, opts?.falsePositiveRate ?? 0.01);
  }

  private fingerprint(content: string): string {
    return content.toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
  }

  /** True if `content` is a near-duplicate of anything already added. */
  has(content: string, threshold = this.defaultThreshold): boolean {
    const fp = this.fingerprint(content);
    // Bloom-gated exact-repeat fast path (an exact fingerprint repeat is a
    // trigram similarity of 1, always ≥ threshold).
    if (this.bloom.has(fp) && this.exactFps.has(fp)) return true;

    const prof = prepareTrigramProfile(content);
    const size = prof.tris.size;
    if (size === 0) {
      for (const i of this.zeroSize) {
        if (trigramSimilarityPrepared(prof, this.profiles[i]) >= threshold) return true;
      }
      return false;
    }
    const { lo, hi } = admissibleSizeBand(size, threshold);
    for (let s = lo; s <= hi; s++) {
      const idxs = this.bySize.get(s);
      if (!idxs) continue;
      for (const i of idxs) {
        if (trigramSimilarityPrepared(prof, this.profiles[i]) >= threshold) return true;
      }
    }
    return false;
  }

  /** Add content to the index unconditionally. */
  add(content: string): void {
    const fp = this.fingerprint(content);
    this.bloom.add(fp);
    this.exactFps.add(fp);
    const prof = prepareTrigramProfile(content);
    const idx = this.profiles.push(prof) - 1;
    const size = prof.tris.size;
    if (size === 0) {
      this.zeroSize.push(idx);
    } else {
      const arr = this.bySize.get(size);
      if (arr) arr.push(idx);
      else this.bySize.set(size, [idx]);
    }
  }

  /** Add only if not already a near-duplicate. Returns true if added. */
  addIfNew(content: string, threshold = this.defaultThreshold): boolean {
    if (this.has(content, threshold)) return false;
    this.add(content);
    return true;
  }

  /** Number of items held. */
  get count(): number { return this.profiles.length; }
}
