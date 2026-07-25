/**
 * CHARACTERIZATION tests for `computeClientRelevance` (similarity.ts:192).
 *
 * These tests pin what the function DOES TODAY, not what it arguably should do.
 * Every expected value below was obtained by executing the real implementation
 * and transcribing the result — none were derived by reasoning alone.
 *
 * Purpose: `similarity.ts` lives in `packages/shared/src/`, and these tests are
 * the safety net that keeps its scoring behaviour frozen across moves and
 * refactors.
 *
 * `computeClientRelevance` is THE production ranking function: the in-process
 * `MemoryIndex` scores records exactly this way, so this lexical formula is the
 * sole thing that orders recalled records. There is no server-side ranking, no
 * embedding, and no LLM in the retrieval path.
 *
 * Behaviour under test (similarity.ts:192-211):
 *   nq = normalize(query); nc = normalize(content)
 *   if (nq.length === 0 || nc.length === 0) return 0
 *   raw = (keywordScore * 0.6 + trigramScore * 0.4) * (nc.length < 20 ? 0.8 : 1.0)
 *   return clamp(raw, 0, 1)
 *
 * Note that `trigramScore` is computed from the RAW query/content
 * (`trigramSimilarity` normalizes internally), while `keywordScore` and the
 * length penalty are computed from the already-normalized strings.
 */

import { describe, it, expect } from 'vitest';
import { computeClientRelevance, trigramSimilarity } from '../similarity.js';

describe('computeClientRelevance (characterization)', () => {
  describe('the 0.6 keyword / 0.4 trigram blend', () => {
    it('scores a keyword-free pair at exactly 0.4x the trigram similarity', () => {
      // No whole word is shared: {deployment, configuration} vs
      // {deploying, configurations} => keywordScore = 0.
      // Normalized content is 24 chars, so no length penalty.
      const q = 'deployment configuration';
      const c = 'deploying configurations';

      expect(trigramSimilarity(q, c)).toBe(0.5714285714285714);
      expect(computeClientRelevance(q, c)).toBe(0.22857142857142856);
      // Pins the trigram weight at exactly 0.4.
      expect(computeClientRelevance(q, c)).toBe(0.4 * 0.5714285714285714);
    });

    it('blends a half keyword score with a trigram score at 0.6/0.4', () => {
      // query words (len > 2): {deployment, strategy}
      // content words (len > 2): {our, deployment, plan, documented, here}
      //   ("is" is 2 chars and is excluded)
      // distinct hits = 1 of 2 => keywordScore = 0.5
      const q = 'deployment strategy';
      const c = 'our deployment plan is documented here';

      expect(trigramSimilarity(q, c)).toBe(0.21428571428571427);
      expect(computeClientRelevance(q, c)).toBe(0.3857142857142857);
      // Pins BOTH weights simultaneously: 0.6*0.5 + 0.4*0.21428571428571427
      expect(computeClientRelevance(q, c)).toBe(0.6 * 0.5 + 0.4 * 0.21428571428571427);
    });

    it('scores a full keyword hit against a barely-overlapping document at 0.6 + 0.4t', () => {
      // Single query word "fox" is present => keywordScore = 1.
      const q = 'fox';
      const c = 'the quick brown fox jumps over the lazy dog';

      expect(trigramSimilarity(q, c)).toBe(0.02564102564102564);
      expect(computeClientRelevance(q, c)).toBe(0.6102564102564102);
      expect(computeClientRelevance(q, c)).toBe(0.6 * 1 + 0.4 * 0.02564102564102564);
    });

    it('is asymmetric in query/content order', () => {
      // Swapping the arguments changes the keyword denominator (query word
      // count) even though the trigram channel is symmetric.
      const a = 'fox';
      const b = 'the quick brown fox jumps over the lazy dog';
      expect(computeClientRelevance(a, b)).toBe(0.6102564102564102);
      expect(computeClientRelevance(b, a)).toBe(0.06820512820512821);
      // Same trigram score on both sides — only the keyword channel flipped.
      expect(trigramSimilarity(a, b)).toBe(trigramSimilarity(b, a));
    });
  });

  describe('the <20 char length penalty', () => {
    // Both cases below are query === content, so trigramScore = 1 and
    // keywordScore = 1; the ONLY difference is the normalized content length.
    const at19 = 'abcdefghi jklmnopqr'; // 19 chars
    const at20 = 'abcdefghi jklmnopqrs'; // 20 chars

    it('applies the 0.8 multiplier at 19 normalized chars', () => {
      expect(at19.length).toBe(19);
      expect(computeClientRelevance(at19, at19)).toBe(0.8);
    });

    it('does not apply the penalty at 20 normalized chars (the exact boundary)', () => {
      expect(at20.length).toBe(20);
      expect(computeClientRelevance(at20, at20)).toBe(1);
    });

    it('measures the penalty against NORMALIZED length, not raw length', () => {
      // Raw content is 26 chars, but normalize() strips the "[user] " prefix
      // down to 19 chars, so the penalty still fires.
      const decorated = '[user] abcdefghi jklmnopqr';
      expect(decorated.length).toBe(26);
      expect(computeClientRelevance(at19, decorated)).toBe(0.8);

      // And the 20-char case still escapes the penalty after stripping.
      expect(computeClientRelevance(at20, '[user] abcdefghi jklmnopqrs')).toBe(1);
    });

    it('penalizes based on content length only — a long query does not rescue short content', () => {
      const q = 'the quick brown fox jumps over the lazy dog';
      // normalize('fox') is 3 chars => penalty applies.
      expect(computeClientRelevance(q, 'fox')).toBe(0.06820512820512821);
    });
  });

  describe('output range', () => {
    it('returns exactly 1 for a self-identical long string', () => {
      const s = 'migration rollback procedure for the primary database cluster';
      expect(computeClientRelevance(s, s)).toBe(1);
    });

    it('returns exactly 0 for a total mismatch', () => {
      expect(computeClientRelevance('aaaa aaaa aaaa aaaa aaaa', 'bbbb bbbb bbbb bbbb bbbb')).toBe(0);
      expect(computeClientRelevance('zz', 'the quick brown fox jumps over the lazy dog today')).toBe(0);
    });

    it('stays within [0,1] across a broad matrix of inputs', () => {
      const samples = [
        '', ' ', 'a', 'ab', 'abc', 'fox',
        '[user] Task: deploy the gateway',
        'Findings: the bloom filter has no false negatives',
        'migration rollback procedure for the primary database cluster',
        'the quick brown fox jumps over the lazy dog',
        '::::', '[[[]]]', 'Node: Result: Output:',
        'deployment configuration', 'deploying configurations',
      ];
      for (const q of samples) {
        for (const c of samples) {
          const r = computeClientRelevance(q, c);
          expect(Number.isFinite(r)).toBe(true);
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe('normalize() preprocessing — role prefixes', () => {
    const q = 'authentication timeout';
    const plain = 'the authentication timeout was increased';
    const BASELINE = 0.8162162162162162;

    it('scores undecorated content at the baseline', () => {
      expect(computeClientRelevance(q, plain)).toBe(BASELINE);
    });

    it('converges [user], [assistant] and [system] prefixes onto the baseline', () => {
      expect(computeClientRelevance(q, `[user] ${plain}`)).toBe(BASELINE);
      expect(computeClientRelevance(q, `[assistant] ${plain}`)).toBe(BASELINE);
      expect(computeClientRelevance(q, `[system] ${plain}`)).toBe(BASELINE);
    });

    it('strips only ONE leading role prefix; a second becomes a scored word', () => {
      // NOTE(characterization): STRUCTURAL_PREFIX_RE (similarity.ts:12) is
      // anchored with ^ and is not global, so it fires at most once. The
      // second "[assistant]" only loses its brackets (BRACKET_NOISE_RE) and
      // survives as the literal token "assistant", diluting the score.
      // Looks like an oversight for multi-turn concatenated content, but this
      // is current behaviour.
      expect(computeClientRelevance(q, `[user] [assistant] ${plain}`))
        .toBe(0.7702127659574468);
      expect(computeClientRelevance(q, `[user] [assistant] ${plain}`)).not.toBe(BASELINE);
    });

    it('does not strip a role marker that is not at the start', () => {
      // Mid-string "[user]" only loses its brackets, leaving the word "user" —
      // exactly as if the word had been typed without brackets.
      const bracketed = computeClientRelevance(q, `the [user] authentication timeout was increased`);
      const bare = computeClientRelevance(q, `the user authentication timeout was increased`);
      expect(bracketed).toBe(bare);
      expect(bracketed).toBe(0.7904761904761904);
      expect(bracketed).not.toBe(BASELINE);
    });
  });

  describe('normalize() preprocessing — structural labels', () => {
    const q = 'authentication timeout';
    const plain = 'the authentication timeout was increased';
    const BASELINE = 0.8162162162162162;

    const LABELS = [
      'Task', 'Workers', 'Decisions', 'Findings', 'Node', 'Workflow',
      'Output', 'Result', 'Errors', 'Outputs', 'Artifacts',
    ];

    for (const label of LABELS) {
      it(`converges a leading "${label}:" label onto the undecorated score`, () => {
        expect(computeClientRelevance(q, `${label}: ${plain}`)).toBe(BASELINE);
      });
    }

    it('strips the label with zero following whitespace', () => {
      // STRUCTURAL_LABEL_RE ends with \s* so the space is optional.
      expect(computeClientRelevance(q, `Task:${plain}`)).toBe(BASELINE);
    });

    it('is case-insensitive about the label', () => {
      expect(computeClientRelevance(q, `TASK: ${plain}`)).toBe(BASELINE);
      expect(computeClientRelevance(q, `task: ${plain}`)).toBe(BASELINE);
    });

    it('strips every label occurrence, not just the first (the regex is global)', () => {
      expect(computeClientRelevance(q, `Node: Task: ${plain}`)).toBe(BASELINE);
      expect(computeClientRelevance(q, `${plain} Task: `)).toBe(BASELINE);
    });

    it('does NOT treat a label glued to a preceding word as structural', () => {
      // NOTE(characterization): STRUCTURAL_LABEL_RE requires \b before the
      // label, and "subtask" has no word boundary before "task". So "subtask:"
      // survives the label pass; only the generic word-fused-colon rule fires,
      // leaving the token "subtask" to dilute the score. Same effect as an
      // arbitrary unknown word.
      const subtask = computeClientRelevance(q, `subtask: ${plain}`);
      const arbitrary = computeClientRelevance(q, `PREFACE ${plain}`);
      expect(subtask).toBe(arbitrary);
      expect(subtask).toBe(0.7777777777777778);
      expect(subtask).not.toBe(BASELINE);
    });
  });

  describe('normalize() preprocessing — bracket noise, fused colons, case, whitespace', () => {
    const q = 'authentication timeout';
    const plain = 'the authentication timeout was increased';
    const BASELINE = 0.8162162162162162;

    it('converges bracketed inline text onto the undecorated score', () => {
      expect(computeClientRelevance(q, 'the [authentication] timeout was increased')).toBe(BASELINE);
    });

    it('converges a word-fused colon onto the undecorated score', () => {
      expect(computeClientRelevance(q, 'the authentication: timeout was increased')).toBe(BASELINE);
    });

    it('converges collapsed whitespace and surrounding padding onto the undecorated score', () => {
      expect(computeClientRelevance(q, '  the   authentication    timeout  was   increased  ')).toBe(BASELINE);
    });

    it('is case-insensitive on both query and content', () => {
      const base = computeClientRelevance('deployment strategy', 'our deployment plan is documented here');
      expect(base).toBe(0.3857142857142857);
      expect(computeClientRelevance('DEPLOYMENT Strategy', 'our deployment plan is documented here')).toBe(base);
      expect(computeClientRelevance('deployment strategy', 'OUR DEPLOYMENT PLAN IS DOCUMENTED HERE')).toBe(base);
    });

    it('shows an unrecognised decoration does NOT converge (control for the tests above)', () => {
      // Guards against the convergence assertions passing vacuously because the
      // score is simply insensitive to leading tokens.
      expect(computeClientRelevance(q, `PREFACE ${plain}`)).not.toBe(BASELINE);
      expect(computeClientRelevance(q, `PREFACE ${plain}`)).toBe(0.7777777777777778);
    });
  });

  describe('the trigram-only channel (critical for the v2 candidate-generation design)', () => {
    it('scores above zero when query and content share NO whole word', () => {
      // NOTE(characterization): This is the load-bearing case for
      // docs/memory-architecture-v2.md §6.1. Neither "deployment" nor
      // "configuration" appears in "deploying configurations", so
      // computeKeywordScore returns exactly 0 — yet the overall relevance is
      // clearly non-zero, contributed entirely by the trigram channel.
      //
      // Consequence: candidate generation CANNOT be built on word postings
      // alone. A postings-only recall stage would never surface this document,
      // but the ranker scores it well above a genuine mismatch, so it would be
      // a silent recall loss.
      const q = 'deployment configuration';
      const c = 'deploying configurations';

      // Prove the keyword channel is dead here: no shared token of length > 2.
      const qWords = new Set(q.split(' '));
      const cWords = new Set(c.split(' '));
      for (const w of qWords) expect(cWords.has(w)).toBe(false);

      const score = computeClientRelevance(q, c);
      expect(score).toBeGreaterThan(0);
      expect(score).toBe(0.22857142857142856);
      // The entire score is the trigram channel.
      expect(score).toBe(0.4 * trigramSimilarity(q, c));
    });

    it('ranks a morphological variant well above an unrelated document', () => {
      // Again zero shared whole words in BOTH pairs, so the ordering here is
      // produced purely by trigrams.
      const q = 'authentication';
      const related = 'reauthenticated session handler';
      const unrelated = 'session handler for logging in';

      expect(computeClientRelevance(q, related)).toBe(0.12903225806451613);
      expect(computeClientRelevance(q, unrelated)).toBe(0.010256410256410256);
      expect(computeClientRelevance(q, related))
        .toBeGreaterThan(computeClientRelevance(q, unrelated));
      expect(computeClientRelevance(q, related)).toBe(0.4 * trigramSimilarity(q, related));
    });
  });

  describe('edge cases', () => {
    it('returns 0 for an empty query', () => {
      expect(computeClientRelevance('', 'hello world this is content')).toBe(0);
    });

    it('returns 0 for empty content', () => {
      expect(computeClientRelevance('hello world this is a query', '')).toBe(0);
    });

    it('returns 0 when both are empty', () => {
      // NOTE(characterization): trigramSimilarity('', '') returns 1 (the
      // a === b fast path), but computeClientRelevance short-circuits on the
      // zero-length normalized guard first and returns 0. Two empty strings are
      // therefore "identical" to one function and "irrelevant" to the other.
      expect(trigramSimilarity('', '')).toBe(1);
      expect(computeClientRelevance('', '')).toBe(0);
    });

    it('treats whitespace-only input as empty (normalize trims it to length 0)', () => {
      expect(computeClientRelevance('   ', 'hello world this is content')).toBe(0);
      expect(computeClientRelevance('hello world this is a query', '   ')).toBe(0);
    });

    it('scores a single-character identity at 0.32, not 1', () => {
      // NOTE(characterization): This is the most surprising behaviour in the
      // function. query === content, so the trigram channel returns 1, but:
      //   - computeKeywordScore only counts words of length > 2, so a 1-char
      //     query yields an EMPTY query-word set and returns 0 (similarity.ts:169)
      //   - the <20 char length penalty multiplies by 0.8
      // Result: (0*0.6 + 1*0.4) * 0.8 = 0.32. A perfect match scores 0.32.
      expect(computeClientRelevance('a', 'a')).toBe(0.32000000000000006);
      expect(trigramSimilarity('a', 'a')).toBe(1);
    });

    it('scores a two-character identity at 0.32 as well', () => {
      // Same cause: "ab" is 2 chars, still not > 2.
      expect(computeClientRelevance('ab', 'ab')).toBe(0.32000000000000006);
    });

    it('returns 0 for short non-identical inputs even when one contains the other', () => {
      // NOTE(characterization): normalize('ab') is 2 chars, below the 3-char
      // trigram floor, so trigramSimilarity returns 0 (not a partial match);
      // and "ab" is too short for the keyword channel. A user typing a 2-char
      // query gets a flat zero against every document that is not byte-identical.
      expect(computeClientRelevance('ab', 'abc')).toBe(0);
      expect(trigramSimilarity('ab', 'abc')).toBe(0);
    });

    it('handles a query longer than the content', () => {
      const q = 'the quick brown fox jumps over the lazy dog';
      // Duplicate "the" is collapsed by the Set: 8 distinct query words > 2 chars,
      // 1 hit ("fox") => keywordScore = 0.125; content is 3 chars => 0.8 penalty.
      expect(computeClientRelevance(q, 'fox')).toBe(0.06820512820512821);
      expect(computeClientRelevance(q, 'fox')).toBe((0.6 * 0.125 + 0.4 * (1 / 39)) * 0.8);
    });

    it('is deterministic — repeated calls return the identical value', () => {
      const q = '[user] Task: authentication timeout';
      const c = 'Findings: the authentication timeout was increased';
      const first = computeClientRelevance(q, c);
      for (let i = 0; i < 5; i++) {
        expect(computeClientRelevance(q, c)).toBe(first);
      }
    });
  });
});
