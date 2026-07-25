/**
 * @module memory/memory-map
 * Renders the Memory Map — the table of contents injected every turn so the
 * agent knows context exists beyond the verbatim window
 * (docs/memory-architecture-v2.md §9).
 *
 * This is the design's actual differentiator. A memory tool the model never
 * reaches for is dead weight; the map is what makes reaching for it an informed
 * decision rather than a guess.
 *
 * ── PURE BY CONSTRUCTION ──────────────────────────────────────────────────
 *
 * Rendering takes plain data and returns a string. No Redis, no clock, no LLM.
 * That matters for three reasons:
 *
 *   1. It is injected on EVERY turn, so it must never add latency or cost.
 *   2. Determinism is testable — same input, same bytes, no fixtures.
 *   3. Segment labels stay frozen. They are computed once when a segment
 *      closes and are display-only here; the renderer never re-derives them.
 *
 * ── BOUNDED IN SESSION LENGTH ─────────────────────────────────────────────
 *
 * The map is a fixed tax on every request, so it must be O(1) in session
 * length. A naive list of every segment grows without bound. Past the budget,
 * older segments collapse into coarser super-segments while the most recent
 * stay individually addressable — recent context is what an agent asks about,
 * and old context stays reachable through the span the super-segment names.
 */

/** A closed (or open) span of records, as stored. */
export interface SegmentSummary {
  /** Opaque, stable identifier. Assigned once; never re-derived. */
  id: string;
  /** Monotonic ordinal within the scope. */
  n: number;
  from: number;
  to: number;
  count: number;
  /** Display-only. An async titler may overwrite it without breaking ids. */
  label: string;
  openedAt: string;
  closedAt?: string;
}

export interface MemoryMapInput {
  scope: string;
  /** Total records in the scope. */
  totalRecords: number;
  /** Seq bounds of the scope, if it holds anything. */
  bounds: { min: number; max: number } | null;
  segments: SegmentSummary[];
  /** Seq range currently in the verbatim window, if any. */
  verbatim?: { from: number; to: number; count: number } | null;
  /** Corpus-frequent terms, already ranked. */
  frequentTerms?: Array<{ term: string; count: number }>;
  pinnedCount?: number;
}

export interface MemoryMapOptions {
  /**
   * Hard ceiling. The map is charged on every turn, so exceeding it is a
   * per-request tax, not a one-off. Default 600.
   */
  maxTokens?: number;
  /** Segments always listed individually, newest first. Default 8. */
  detailedSegments?: number;
  /** Max frequent terms shown. Default 6. */
  maxTerms?: number;
}

const DEFAULT_MAX_TOKENS = 600;
const DEFAULT_DETAILED = 8;
const DEFAULT_MAX_TERMS = 6;

/** Cheap, dependency-free token estimate. Matches the 4 chars/token heuristic. */
function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function shortDate(iso: string): string {
  // Deterministic and locale-independent: 'YYYY-MM-DD' → 'Mon DD'.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mi = Number(m[2]) - 1;
  return `${months[mi] ?? '???'} ${String(Number(m[3]))}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Collapse the oldest segments into super-segments so the rendered list has at
 * most `detailed + 1` rows regardless of how many segments exist.
 */
function rollUp(segments: SegmentSummary[], detailed: number): {
  collapsed: { from: number; to: number; count: number; segments: number; openedAt: string } | null;
  recent: SegmentSummary[];
} {
  if (segments.length <= detailed) return { collapsed: null, recent: segments };
  const older = segments.slice(0, segments.length - detailed);
  const recent = segments.slice(segments.length - detailed);
  return {
    collapsed: {
      from: Math.min(...older.map((s) => s.from)),
      to: Math.max(...older.map((s) => s.to)),
      count: older.reduce((n, s) => n + s.count, 0),
      segments: older.length,
      openedAt: older[0]!.openedAt,
    },
    recent,
  };
}

/**
 * Render the map. Returns null when the scope holds nothing worth announcing —
 * an empty map is noise, and injecting it every turn would train the model to
 * ignore the block.
 */
export function renderMemoryMap(input: MemoryMapInput, opts: MemoryMapOptions = {}): string | null {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const detailed = Math.max(1, opts.detailedSegments ?? DEFAULT_DETAILED);
  const maxTerms = Math.max(0, opts.maxTerms ?? DEFAULT_MAX_TERMS);

  if (input.totalRecords === 0 || !input.bounds) return null;

  const lines: string[] = [];
  const since = input.segments.length > 0 ? shortDate(input.segments[0]!.openedAt) : '';
  lines.push(
    `[MEMORY MAP] scope ${input.scope} · ${input.totalRecords.toLocaleString('en-US')} records · ` +
      `seq ${input.bounds.min}–${input.bounds.max}${since ? ` · since ${since}` : ''}`,
  );

  if (input.verbatim && input.verbatim.count > 0) {
    lines.push(
      `Verbatim in context: ${input.verbatim.count} most recent ` +
        `(seq ${input.verbatim.from}–${input.verbatim.to}).`,
    );
  }

  if (input.segments.length > 0) {
    lines.push('Segments — use memory_read to expand, memory_search to query:');
    const { collapsed, recent } = rollUp(input.segments, detailed);

    if (collapsed) {
      lines.push(
        `  ${pad('…earlier', 16)} ${pad(`${collapsed.from}–${collapsed.to}`, 13)} ` +
          `${collapsed.segments} segments, ${collapsed.count} records`,
      );
    }
    for (const s of recent) {
      const range = `${s.from}–${s.to}`;
      const when = shortDate(s.openedAt);
      lines.push(`  ${pad(s.id, 16)} ${pad(range, 13)} ${pad(when, 7)} ${s.label}`);
    }
  }

  const terms = (input.frequentTerms ?? []).slice(0, maxTerms);
  if (terms.length > 0) {
    lines.push(`Frequent: ${terms.map((t) => `${t.term}(${t.count})`).join(' · ')}`);
  }

  if (input.pinnedCount && input.pinnedCount > 0) {
    lines.push(`Pinned: ${input.pinnedCount} fact${input.pinnedCount === 1 ? '' : 's'}`);
  }

  let out = lines.join('\n');

  // Enforce the ceiling by dropping the most expendable rows first: frequent
  // terms, then detail rows from the OLDEST end (recent context is what gets
  // asked about). The header and verbatim line are never dropped — without
  // them the block says nothing.
  if (estimate(out) > maxTokens) {
    const working = [...lines];
    const termIdx = working.findIndex((l) => l.startsWith('Frequent:'));
    if (termIdx >= 0) working.splice(termIdx, 1);
    out = working.join('\n');

    while (estimate(out) > maxTokens) {
      const first = working.findIndex((l) => l.startsWith('  '));
      if (first < 0) break;
      working.splice(first, 1);
      out = working.join('\n');
    }
  }

  return out;
}

/**
 * Function words that carry no topical signal.
 *
 * IDF alone is not enough. It only suppresses a term once the corpus is broad
 * enough for that term to appear everywhere — so the FIRST segment of a scope,
 * closed when the index holds only its own near-identical records, sees zero
 * IDF for every term and falls back to alphabetical order. That produced real
 * labels like "and, elaborating, for, keyspace". A small stopword list fixes
 * the cold-start case that IDF structurally cannot.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'not', 'but', 'with', 'from', 'this', 'that', 'these',
  'those', 'then', 'than', 'they', 'them', 'their', 'there', 'here', 'have',
  'has', 'had', 'was', 'were', 'been', 'being', 'are', 'its', 'his', 'her',
  'you', 'your', 'our', 'out', 'off', 'via', 'per', 'all', 'any', 'can',
  'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall',
  'about', 'into', 'onto', 'over', 'under', 'when', 'what', 'which', 'who',
  'how', 'why', 'each', 'some', 'such', 'only', 'also', 'more', 'most',
  'other', 'same', 'very', 'just', 'now', 'one', 'two', 'note', 'like',
]);

/**
 * Rank terms for a segment label or the "Frequent" line.
 *
 * TF-IDF rather than raw counts: a label built from raw frequency reads
 * "the, and, file" in every conversation. `docFrequency` supplies the
 * corpus-wide signal that makes a term distinctive rather than merely common.
 *
 * A term present in EVERY document scores 0 and sorts last, but is not
 * discarded — it can still fill a label when nothing more distinctive exists,
 * which beats rendering an empty one.
 *
 * Deterministic: ties break on the term itself, so identical input always
 * yields identical output. That is what lets a closed segment's label be
 * frozen and trusted across turns.
 */
export function rankTerms(
  termCounts: Map<string, number>,
  docFrequency: (term: string) => number,
  corpusSize: number,
  limit: number,
): Array<{ term: string; count: number }> {
  const n = Math.max(1, corpusSize);
  const scored: Array<{ term: string; count: number; score: number }> = [];

  for (const [term, count] of termCounts) {
    if (term.length <= 2) continue;
    if (STOP_WORDS.has(term)) continue;
    // Purely numeric tokens ("2024", "42") name nothing.
    if (/^\d+$/.test(term)) continue;
    const df = Math.max(1, docFrequency(term));
    const idf = Math.max(0, Math.log(n / df));
    scored.push({ term, count, score: count * idf });
  }

  scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  return scored.slice(0, limit).map(({ term, count }) => ({ term, count }));
}
