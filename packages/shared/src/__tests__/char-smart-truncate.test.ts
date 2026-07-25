/**
 * CHARACTERIZATION tests for `smartTruncate` (src/similarity.ts:51).
 *
 * These tests pin down what the function ACTUALLY DOES TODAY — including
 * behaviour that is wrong — so that moving similarity.ts verbatim into
 * `@orionomega/shared` is provably behaviour-preserving.
 *
 * Every expectation here was obtained by executing the current implementation,
 * not by reasoning about what it ought to produce. Where the observed output
 * looks like a defect it is still asserted as-is and annotated with a
 * `NOTE(characterization):` comment. Do not "fix" these expectations.
 */

import { describe, it, expect } from 'vitest';
import { smartTruncate, estimateTokens } from '../similarity.js';

// The sentence splitter used internally (similarity.ts:54). Mirrored here only
// so tests can *prove* how many sentences a fixture has rather than assume it.
const SENTENCE_SPLIT = /(?<=[.!?\n])\s+/;
const sentenceCount = (s: string) => s.split(SENTENCE_SPLIT).filter(Boolean).length;

// ── Fixtures ───────────────────────────────────────────────────────────

/**
 * Natural-language filler: deliberately contains none of CODE_INDICATORS
 * (similarity.ts:19) — no `{}();=<>` and none of the reserved words — so
 * estimateTokens uses the 4.0 chars/token ratio.
 */
const NATURAL_FILLER =
  'the quick brown fox jumps over a lazy dog and keeps running along the river bank without stopping at all ever again in any way whatsoever my friend ';
/** One "sentence" (no `[.!?\n]` followed by whitespace anywhere). */
const ONE_LONG_NATURAL_SENTENCE = NATURAL_FILLER.repeat(5).trim();

/**
 * Code-like content. Trips CODE_INDICATORS (braces, parens, semicolons, `=`,
 * `const`, `function`, `return`, `export`) so estimateTokens uses 3.2. It is
 * still ONE sentence: the only `.` characters sit inside `"127.0.0.1"` and
 * `res.end`, never followed by whitespace, so the splitter finds no boundary.
 */
const CODE_CHUNK =
  'const gateway = createServer({ port: 8000, host: "127.0.0.1" }); export function handle(req, res) { return res.end(JSON.stringify({ ok: true, id: req.id })); } const other = compute(a, b) + compute(c, d) - compute(e, f) * scale; ';
const ONE_LONG_CODE_SENTENCE = CODE_CHUNK.repeat(4);

// Five natural-language sentences. Only CHARLIE matches HIGH_SIGNAL_SENTENCE
// (similarity.ts:41) — via the word "decided".
const ALPHA = 'Alpha establishes the baseline narrative context.'; // first, 13 tokens
const BRAVO = 'Bravo mentions nothing memorable at all today.'; //    low signal, 12 tokens
const CHARLIE = 'Charlie says we decided to keep the schema stable.'; // HIGH signal, 13 tokens
const DELTA = 'Delta rambles about the weather and lunch plans.'; //   low signal, 12 tokens
const ZULU = 'Zulu wraps up the whole summary neatly.'; //             last, 10 tokens
const FIVE_SENTENCES = [ALPHA, BRAVO, CHARLIE, DELTA, ZULU].join(' ');

describe('smartTruncate — characterization', () => {
  describe('passthrough (content already within budget)', () => {
    it('returns short content completely unchanged', () => {
      const content = 'A short natural language memory that easily fits.';
      expect(estimateTokens(content)).toBe(13);
      expect(smartTruncate(content, 100)).toBe(content);
    });

    it('returns content unchanged when it measures exactly at the budget', () => {
      const content = 'hello world memory';
      expect(estimateTokens(content)).toBe(5);
      // `<=` at similarity.ts:52, so exactly-at-budget is a passthrough.
      expect(smartTruncate(content, 5)).toBe(content);
    });

    it('passes multi-sentence content through untouched at exactly its token count', () => {
      expect(estimateTokens(FIVE_SENTENCES)).toBe(59);
      expect(smartTruncate(FIVE_SENTENCES, 59)).toBe(FIVE_SENTENCES);
      // One token below the measured size and the sentence path engages.
      expect(smartTruncate(FIVE_SENTENCES, 58)).not.toBe(FIVE_SENTENCES);
    });

    it('returns empty content unchanged for every budget, including 0', () => {
      // estimateTokens('') === 0, so `0 <= 0` short-circuits at similarity.ts:52.
      expect(smartTruncate('', 0)).toBe('');
      expect(smartTruncate('', 1)).toBe('');
      expect(smartTruncate('', 100)).toBe('');
    });
  });

  describe('hard-truncate path (<= 2 sentences)', () => {
    it('cuts a single long sentence at exactly floor(maxTokens * 3.5) chars and appends U+2026', () => {
      expect(sentenceCount(ONE_LONG_NATURAL_SENTENCE)).toBe(1);
      expect(ONE_LONG_NATURAL_SENTENCE.length).toBe(739);

      const out = smartTruncate(ONE_LONG_NATURAL_SENTENCE, 20);

      const maxChars = Math.floor(20 * 3.5); // 70
      expect(maxChars).toBe(70);
      expect(out.length).toBe(maxChars + 1); // 71 — the ellipsis is a single char
      expect(out.slice(0, -1)).toBe(ONE_LONG_NATURAL_SENTENCE.slice(0, maxChars));
      expect(out.slice(-1)).toBe('…');
      expect(out).toBe('the quick brown fox jumps over a lazy dog and keeps running along the …');
    });

    it('cuts mid-word without any word-boundary awareness', () => {
      const out = smartTruncate(ONE_LONG_NATURAL_SENTENCE, 20);
      // NOTE(characterization): the slice lands inside "the river" leaving a
      // dangling "the " — the hard path is a raw character cut, it makes no
      // attempt to back off to a word boundary.
      expect(out.endsWith('the …')).toBe(true);
    });

    it('also hard-truncates when there are exactly 2 sentences, discarding the second entirely', () => {
      const two =
        'Alpha establishes the baseline narrative context and rambles onward for quite a while indeed. Zulu wraps up the whole summary neatly and also rambles onward at length here.';
      expect(sentenceCount(two)).toBe(2);
      expect(estimateTokens(two)).toBe(54);

      const out = smartTruncate(two, 10);
      // NOTE(characterization): `sentences.length <= 2` (similarity.ts:55) means
      // a 2-sentence input never gets the "keep first AND last" treatment the
      // doc comment promises — the last sentence is simply cut away.
      expect(out).toBe('Alpha establishes the baseline narr…');
      expect(out.length).toBe(Math.floor(10 * 3.5) + 1); // 36
    });

    it('never emits the "[N sentences truncated]" marker on the hard path', () => {
      const out = smartTruncate(ONE_LONG_NATURAL_SENTENCE, 20);
      expect(out).not.toContain('sentences truncated');
    });

    it('stays under budget for natural-language content (the 3.5 vs 4.0 case is safe)', () => {
      for (const maxTokens of [20, 50, 100]) {
        const out = smartTruncate(ONE_LONG_NATURAL_SENTENCE, maxTokens);
        expect(estimateTokens(out)).toBeLessThanOrEqual(maxTokens);
      }
      // Exact measured values, for regression pinning.
      expect(estimateTokens(smartTruncate(ONE_LONG_NATURAL_SENTENCE, 20))).toBe(18);
      expect(estimateTokens(smartTruncate(ONE_LONG_NATURAL_SENTENCE, 50))).toBe(44);
      expect(estimateTokens(smartTruncate(ONE_LONG_NATURAL_SENTENCE, 100))).toBe(88);
    });
  });

  describe('DEFECT: hard path overshoots the budget for code-like content', () => {
    // NOTE(characterization): this is a LIVE BUG, documented in
    // docs/memory-architecture-v2.md §6.2. The hard-truncate path divides the
    // budget by a hardcoded 3.5 chars/token (similarity.ts:57) while
    // estimateTokens uses 3.2 chars/token for anything matching CODE_INDICATORS
    // (similarity.ts:34). So for code-like input, smartTruncate's own output
    // re-measures ABOVE the budget it was asked to fit — the exact ratio is
    // 3.5 / 3.2 = 1.09375, which lands on 1.1 after estimateTokens' Math.ceil
    // at these sizes. Callers that trust smartTruncate to enforce a budget will
    // silently blow it by ~10% on every code memory. Asserted as-is; do not fix.
    it('produces output that re-measures OVER maxTokens for code-like content', () => {
      expect(sentenceCount(ONE_LONG_CODE_SENTENCE)).toBe(1);
      expect(ONE_LONG_CODE_SENTENCE.length).toBe(916);

      const out = smartTruncate(ONE_LONG_CODE_SENTENCE, 100);
      expect(out.length).toBe(Math.floor(100 * 3.5) + 1); // 351
      expect(estimateTokens(out)).toBe(110);
      expect(estimateTokens(out)).toBeGreaterThan(100);
    });

    it('overshoots by a stable 1.1x ratio across budgets', () => {
      for (const maxTokens of [50, 100, 200]) {
        const out = smartTruncate(ONE_LONG_CODE_SENTENCE, maxTokens);
        expect(estimateTokens(out) / maxTokens).toBeCloseTo(1.1, 10);
      }
      // The individual measured token counts behind that ratio.
      expect(estimateTokens(smartTruncate(ONE_LONG_CODE_SENTENCE, 50))).toBe(55);
      expect(estimateTokens(smartTruncate(ONE_LONG_CODE_SENTENCE, 100))).toBe(110);
      expect(estimateTokens(smartTruncate(ONE_LONG_CODE_SENTENCE, 200))).toBe(220);
    });

    it('the overshoot is not an artefact of whitespace collapsing', () => {
      // estimateTokens collapses ` +`/`\t+` runs before measuring; this fixture
      // has none, so the length it measures is the raw output length.
      const out = smartTruncate(ONE_LONG_CODE_SENTENCE, 100);
      expect(/[ \t]{2,}/.test(out)).toBe(false);
      expect(Math.ceil(out.length / 3.2)).toBe(estimateTokens(out));
    });
  });

  describe('sentence-scoring path (> 2 sentences)', () => {
    it('keeps first and last, and lets a high-signal middle sentence survive while low-signal ones are dropped', () => {
      expect(sentenceCount(FIVE_SENTENCES)).toBe(5);

      // budget = 42 - 13 (ALPHA) - 10 (ZULU) - 5 (marker reserve) = 14.
      // CHARLIE (13 tokens, signal 1) sorts first and fits; BRAVO and DELTA
      // (12 tokens each) then exceed the 1 remaining token.
      const out = smartTruncate(FIVE_SENTENCES, 42);
      expect(out).toBe(
        'Alpha establishes the baseline narrative context. Charlie says we decided to keep the schema stable. Zulu wraps up the whole summary neatly. [2 sentences truncated]',
      );
      expect(out).toContain(CHARLIE);
      expect(out).not.toContain(BRAVO);
      expect(out).not.toContain(DELTA);
    });

    it('restores original document order for the sentences it keeps', () => {
      // budget = 54 - 13 - 10 - 5 = 26. Scoring order is CHARLIE (signal) then
      // BRAVO then DELTA; CHARLIE + BRAVO fit (25), DELTA does not.
      const out = smartTruncate(FIVE_SENTENCES, 54);
      expect(out).toBe(
        'Alpha establishes the baseline narrative context. Bravo mentions nothing memorable at all today. Charlie says we decided to keep the schema stable. Zulu wraps up the whole summary neatly. [1 sentences truncated]',
      );
      // BRAVO precedes CHARLIE in the output even though CHARLIE was selected
      // first — the `kept.sort((a, b) => a.idx - b.idx)` at similarity.ts:85.
      expect(out.indexOf(BRAVO)).toBeLessThan(out.indexOf(CHARLIE));
    });

    it('drops both middles and keeps only first + last when the budget is tight', () => {
      // budget = 30 - 13 - 10 - 5 = 2 — nothing fits.
      const out = smartTruncate(FIVE_SENTENCES, 30);
      expect(out).toBe(
        'Alpha establishes the baseline narrative context. Zulu wraps up the whole summary neatly. [3 sentences truncated]',
      );
    });

    it('lets a LOW-signal sentence win when the high-signal one is one token too large', () => {
      // budget = 40 - 13 - 10 - 5 = 12. CHARLIE (13) sorts first but is skipped
      // with `continue` (similarity.ts:79) rather than ending the loop, so the
      // low-signal BRAVO (12) is admitted instead.
      const out = smartTruncate(FIVE_SENTENCES, 40);
      // NOTE(characterization): the high-signal preference is only a sort order,
      // not a reservation. A high-signal sentence that misses the budget by a
      // single token is silently replaced by a lower-signal, slightly smaller
      // one — the exact opposite of the documented "prefer high-signal" intent.
      expect(out).toBe(
        'Alpha establishes the baseline narrative context. Bravo mentions nothing memorable at all today. Zulu wraps up the whole summary neatly. [2 sentences truncated]',
      );
      expect(out).toContain(BRAVO);
      expect(out).not.toContain(CHARLIE);
    });

    it('splits on newlines as well as sentence punctuation', () => {
      const nl =
        'Alpha line about baseline context.\nBravo line with nothing special.\nCharlie line where we decided things.\nZulu line closing out.';
      expect(sentenceCount(nl)).toBe(4);
      const out = smartTruncate(nl, 15);
      // NOTE(characterization): the newlines are not preserved — parts are
      // rejoined with a single space (similarity.ts:92), so line structure in
      // the original content is destroyed even for the sentences that survive.
      expect(out).toBe('Alpha line about baseline context. Zulu line closing out. [2 sentences truncated]');
      expect(out).not.toContain('\n');
    });
  });

  describe('truncation marker format', () => {
    it('uses the literal "[N sentences truncated]" appended after the last sentence', () => {
      const out = smartTruncate(FIVE_SENTENCES, 30);
      expect(out.endsWith(' [3 sentences truncated]')).toBe(true);
      expect(/\[\d+ sentences truncated\]$/.test(out)).toBe(true);
    });

    it('reports N = total sentences minus sentences actually emitted', () => {
      // 5 sentences in. At budget 30 only ALPHA + ZULU survive -> N = 5 - 2 = 3.
      expect(smartTruncate(FIVE_SENTENCES, 30)).toContain('[3 sentences truncated]');
      // At budget 42, ALPHA + CHARLIE + ZULU survive -> N = 5 - 3 = 2.
      expect(smartTruncate(FIVE_SENTENCES, 42)).toContain('[2 sentences truncated]');
      // At budget 54, ALPHA + BRAVO + CHARLIE + ZULU survive -> N = 5 - 4 = 1.
      expect(smartTruncate(FIVE_SENTENCES, 54)).toContain('[1 sentences truncated]');
    });

    it('says "1 sentences" rather than "1 sentence" when exactly one is dropped', () => {
      const threeSentences = [ALPHA, CHARLIE, ZULU].join(' ');
      expect(sentenceCount(threeSentences)).toBe(3);
      expect(estimateTokens(threeSentences)).toBe(35);
      // NOTE(characterization): no pluralisation handling (similarity.ts:90).
      // The marker is grammatically wrong for N === 1. Pinned deliberately —
      // anything consuming/parsing this string depends on the exact format.
      expect(smartTruncate(threeSentences, 34)).toBe(
        'Alpha establishes the baseline narrative context. Zulu wraps up the whole summary neatly. [1 sentences truncated]',
      );
    });

    it('emits no marker at all when the content fits and the path is never entered', () => {
      const threeSentences = [ALPHA, CHARLIE, ZULU].join(' ');
      // 35 tokens <= 36 -> passthrough, so nothing is appended.
      expect(smartTruncate(threeSentences, 36)).toBe(threeSentences);
      expect(smartTruncate(threeSentences, 36)).not.toContain('truncated');
    });
  });

  describe('edge cases: degenerate budgets', () => {
    it('maxTokens 0 on a single long sentence yields the ellipsis alone', () => {
      // maxChars = floor(0 * 3.5) = 0, so slice(0, 0) + '…'.
      const out = smartTruncate(ONE_LONG_NATURAL_SENTENCE, 0);
      expect(out).toBe('…');
      expect(out.length).toBe(1);
    });

    it('maxTokens 1 on a single long sentence keeps exactly 3 characters plus the ellipsis', () => {
      const out = smartTruncate(ONE_LONG_NATURAL_SENTENCE, 1);
      expect(Math.floor(1 * 3.5)).toBe(3);
      expect(out).toBe('the…');
      expect(out.length).toBe(4);
    });

    it('maxTokens 0 and 1 on multi-sentence content still return first + last + marker, wildly over budget', () => {
      const at0 = smartTruncate(FIVE_SENTENCES, 0);
      const at1 = smartTruncate(FIVE_SENTENCES, 1);
      const expected =
        'Alpha establishes the baseline narrative context. Zulu wraps up the whole summary neatly. [3 sentences truncated]';
      expect(at0).toBe(expected);
      expect(at1).toBe(expected);
      // NOTE(characterization): the sentence path has NO floor. `first` and
      // `last` are unconditionally included (similarity.ts:62-63, 87) regardless
      // of the budget, so a request for 0 tokens returns 29. Callers cannot rely
      // on smartTruncate to honour a small budget on multi-sentence input.
      expect(estimateTokens(at0)).toBe(29);
      expect(estimateTokens(at0)).toBeGreaterThan(0);
    });

    it('a budget below the first+last+5 reserve produces a negative internal budget without throwing', () => {
      // budget = 1 - 13 - 10 - 5 = -27; every middle is skipped, no crash.
      expect(() => smartTruncate(FIVE_SENTENCES, 1)).not.toThrow();
      expect(smartTruncate(FIVE_SENTENCES, 1)).toContain('[3 sentences truncated]');
    });
  });
});
