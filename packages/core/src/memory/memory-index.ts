/**
 * @module memory/memory-index
 * In-process scored index for memory recall.
 *
 * Part of the candidate/rank split (docs/memory-architecture-v2.md §6). The
 * index answers *which records clear the relevance threshold, and at what
 * score*; the layer above it sorts, dedups, filters by TTL, and fills the token
 * budget. Ranking policy lives above; scoring arithmetic lives here.
 *
 * ── WHY THE INDEX SCORES (rather than emitting raw candidates) ─────────────
 *
 * The first implementation returned unscored candidates for the caller to
 * rescore with `computeClientRelevance`. Measured, that was fatal: a realistic
 * 6 000-term Zipf corpus yields ~30 k candidates for a 6-word query at 50 k
 * documents, and rescoring 30 k documents costs **3.6 seconds** — on every
 * turn. See §8.1.
 *
 * The fix is that the index already holds every input the scorer needs:
 *
 *   keywordScore  = distinct query-word hits / |queryWords|   (word postings)
 *   trigramScore  = I / (|A| + |B| − I)                       (trigram postings)
 *   lengthPenalty = normalised content length < 20 ? 0.8 : 1  (per-doc metadata)
 *
 * So it computes `computeClientRelevance` EXACTLY, without the content, in the
 * same pass that finds the documents. Nothing is rescored downstream.
 *
 * ── THE CORRECTNESS PROPERTY ──────────────────────────────────────────────
 *
 *   ∀ d: search(q, θ) contains d  ⟺  computeClientRelevance(q, d) ≥ θ
 *   and the reported score equals computeClientRelevance(q, d) exactly.
 *
 * This is stronger than the superset property the design originally called
 * for — it is equality. Enforced differentially against the real scorer in
 * `__tests__/memory-index-superset.test.ts`, with negative controls proving
 * each retrieval path is load-bearing.
 *
 * ── THREE RETRIEVAL PATHS, ALL REQUIRED ───────────────────────────────────
 *
 *   1. WORD postings    — every document with keyword > 0.
 *   2. TRIGRAM postings — documents with keyword == 0 reachable on trigram
 *                         overlap alone. The scorer's trigram channel awards
 *                         non-zero score to documents sharing NO whole word,
 *                         so word postings alone silently lose them.
 *   3. EXACT short-form — documents whose normalised form is < 3 chars have an
 *                         EMPTY trigram set, yet score 1.0 via the scorer's
 *                         equality short-circuit. Normalised "ab" scores 0.32
 *                         against query "ab" — above a 0.15 threshold.
 *
 * ── MEMORY ────────────────────────────────────────────────────────────────
 *
 * Postings are plain packed `number[]` (V8 SMI arrays, ~8 bytes/element), NOT
 * `Set<number>` (~50 bytes/element). That single change is the difference
 * between ~1.1 GB and ~150 MB at 50 k documents. Do not "tidy" these back into
 * Sets.
 */

import { normalize, trigrams } from '@orionomega/shared/similarity';

/** Scored hit. `relevance` equals `computeClientRelevance(query, content)`. */
export interface ScoredHit {
  id: number;
  relevance: number;
}

/** Per-document data needed to score without re-reading content. */
interface DocEntry {
  /** Distinct trigram count of the normalised content (0 when < 3 chars). */
  trigramCount: number;
  /** Normalised content length — drives the scorer's length penalty. */
  normLength: number;
}

export class MemoryIndex {
  /** word (len > 2) → ids containing it */
  private readonly wordPostings = new Map<string, number[]>();
  /** character trigram → ids containing it */
  private readonly trigramPostings = new Map<string, number[]>();
  /** normalised form → ids, ONLY for docs whose normalised length < 3 */
  private readonly shortForms = new Map<string, number[]>();
  /** id → metadata */
  private readonly docs = new Map<number, DocEntry>();

  get size(): number {
    return this.docs.size;
  }

  has(id: number): boolean {
    return this.docs.has(id);
  }

  /**
   * How many indexed documents contain `term`.
   *
   * Exposed for Memory Map segment labelling: a label is the segment's most
   * *distinctive* terms, which needs document frequency across the whole
   * corpus, not just raw counts within the segment. Without it, every segment
   * in a codebase conversation would be labelled "the, and, file".
   *
   * Reading it costs a map lookup — the postings already exist.
   */
  docFrequency(term: string): number {
    return this.wordPostings.get(term)?.length ?? 0;
  }

  /** Index a record. Re-adding an existing id replaces its postings. */
  add(id: number, content: string): void {
    if (this.docs.has(id)) this.remove(id);

    const norm = normalize(content);
    const entry: DocEntry = { trigramCount: 0, normLength: norm.length };

    if (norm.length === 0) {
      // The scorer returns 0 for empty normalised content on either side, so
      // this document is unreachable. Tracked so `has()`/`size` stay honest.
      this.docs.set(id, entry);
      return;
    }

    // Distinct words only — the scorer counts DISTINCT hits, so a repeated
    // word must not inflate the count.
    for (const w of new Set(norm.split(' '))) {
      if (w.length > 2) push(this.wordPostings, w, id);
    }

    if (norm.length < 3) {
      push(this.shortForms, norm, id);
    } else {
      const tg = trigrams(norm);
      entry.trigramCount = tg.size;
      for (const t of tg) push(this.trigramPostings, t, id);
    }

    this.docs.set(id, entry);
  }

  /** Remove a record from every posting list. O(total postings); rare. */
  remove(id: number): void {
    if (!this.docs.delete(id)) return;
    pruneAll(this.wordPostings, id);
    pruneAll(this.trigramPostings, id);
    pruneAll(this.shortForms, id);
  }

  clear(): void {
    this.wordPostings.clear();
    this.trigramPostings.clear();
    this.shortForms.clear();
    this.docs.clear();
  }

  /**
   * Every record scoring at or above `minRelevance`, sorted by descending
   * relevance. Scores are exactly `computeClientRelevance(query, content)`.
   *
   * `limit` truncates AFTER sorting, so it drops only the lowest-scoring tail.
   */
  search(query: string, minRelevance: number, limit?: number): ScoredHit[] {
    const nq = normalize(query);
    if (nq.length === 0) return [];

    const qWords = new Set<string>();
    for (const w of nq.split(' ')) if (w.length > 2) qWords.add(w);

    // ── Short query: only the equality short-circuit can produce a score ────
    // A normalised query under 3 chars has no trigrams and no words > 2 chars,
    // so the scorer can only reach documents whose normalised form is identical.
    if (nq.length < 3) {
      const exact = this.shortForms.get(nq);
      if (!exact) return [];
      const out: ScoredHit[] = [];
      for (const id of exact) {
        const doc = this.docs.get(id);
        if (!doc) continue;
        const relevance = combine(0, 1, doc.normLength);
        if (relevance >= minRelevance) out.push({ id, relevance });
      }
      return finish(out, limit);
    }

    // ── Path 1: word postings → distinct keyword hits per document ─────────
    const hits = new Map<number, number>();
    for (const w of qWords) {
      const posting = this.wordPostings.get(w);
      if (!posting) continue;
      for (const id of posting) hits.set(id, (hits.get(id) ?? 0) + 1);
    }

    // ── Path 2: trigram postings → exact overlap per document ──────────────
    const qGrams = trigrams(nq);
    const qSize = qGrams.size;
    const overlap = new Map<number, number>();
    for (const t of qGrams) {
      const posting = this.trigramPostings.get(t);
      if (!posting) continue;
      for (const id of posting) overlap.set(id, (overlap.get(id) ?? 0) + 1);
    }

    // ── Score the union exactly ────────────────────────────────────────────
    const out: ScoredHit[] = [];
    const seen = new Set<number>();

    const scoreOne = (id: number): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const doc = this.docs.get(id);
      if (!doc || doc.normLength === 0) return;

      // Documents under 3 normalised chars are unreachable from a >= 3 char
      // query: the scorer short-circuits trigram similarity to 0, and they
      // cannot contain a word longer than 2 chars.
      if (doc.normLength < 3) return;

      const keyword = qWords.size === 0
        ? 0
        : Math.min(1, (hits.get(id) ?? 0) / qWords.size);

      const shared = overlap.get(id) ?? 0;
      const union = qSize + doc.trigramCount - shared;
      const trigram = union === 0 ? 0 : shared / union;

      const relevance = combine(keyword, trigram, doc.normLength);
      if (relevance >= minRelevance) out.push({ id, relevance });
    };

    for (const id of hits.keys()) scoreOne(id);
    for (const id of overlap.keys()) scoreOne(id);

    return finish(out, limit);
  }

  /**
   * Ids only, for callers that just need the candidate set.
   * Preserved because the design contract (§6.1) is expressed as a superset
   * property over ids; this implementation happens to achieve equality.
   */
  candidates(query: string, minRelevance: number, limit?: number): number[] {
    return this.search(query, minRelevance, limit).map((h) => h.id);
  }
}

/**
 * Scoring constants, exported so dependents derive bounds from them rather
 * than hard-coding copies.
 *
 * `RedisMemoryStore.isDuplicate` needs a provably-safe candidate floor below
 * which no true duplicate can hide. Hand-copying 0.4 and 0.8 into that file
 * would mean retuning these values silently breaks dedup — reintroducing the
 * exact false-negative bug they were fixed for, with no test failing.
 */
export const TRIGRAM_WEIGHT = 0.4;
export const KEYWORD_WEIGHT = 0.6;
export const SHORT_CONTENT_PENALTY = 0.8;
export const SHORT_CONTENT_CHARS = 20;

/**
 * Smallest index relevance a record can have while still being at least
 * `similarity` similar by pure trigram Jaccard.
 *
 * Worst case: the keyword channel contributes nothing and the short-content
 * penalty applies, so `relevance >= similarity × TRIGRAM_WEIGHT × PENALTY`.
 * Anything at or above this floor is guaranteed to still be considered.
 */
export function trigramCandidateFloor(similarity: number): number {
  return similarity * TRIGRAM_WEIGHT * SHORT_CONTENT_PENALTY;
}

/**
 * The scorer's final arithmetic, replicated EXACTLY.
 *
 * Mirrors `computeClientRelevance`:
 *   raw = (keyword * 0.6 + trigram * 0.4) * lengthPenalty, clamped to [0,1]
 * Operation order matters — do not refactor into a different association.
 */
function combine(keyword: number, trigram: number, normLength: number): number {
  const lengthPenalty = normLength < SHORT_CONTENT_CHARS ? SHORT_CONTENT_PENALTY : 1.0;
  const raw = (keyword * KEYWORD_WEIGHT + trigram * TRIGRAM_WEIGHT) * lengthPenalty;
  return Math.max(0, Math.min(1, raw));
}

function finish(hits: ScoredHit[], limit?: number): ScoredHit[] {
  hits.sort((a, b) => b.relevance - a.relevance || a.id - b.id);
  return limit !== undefined && hits.length > limit ? hits.slice(0, limit) : hits;
}

function push(map: Map<string, number[]>, key: string, id: number): void {
  const arr = map.get(key);
  if (arr) arr.push(id);
  else map.set(key, [id]);
}

function pruneAll(map: Map<string, number[]>, id: number): void {
  for (const [key, arr] of map) {
    const i = arr.indexOf(id);
    if (i === -1) continue;
    arr.splice(i, 1);
    if (arr.length === 0) map.delete(key);
  }
}
