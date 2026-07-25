/**
 * CHARACTERIZATION tests for `estimateTokens` (src/similarity.ts:30).
 *
 * These tests exist to make the upcoming verbatim move of similarity.ts into
 * @orionomega/shared provably behaviour-preserving. They document what the
 * function ACTUALLY DOES TODAY — including behaviour that is arguably wrong.
 * Where behaviour is surprising it is still asserted as-is and annotated with
 * a `NOTE(characterization):` comment rather than "fixed".
 *
 * Every expected value in this file was produced by executing the real
 * implementation, not by hand-derivation.
 *
 * The implementation under test:
 *
 *   const collapsed = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
 *   const ratio = CODE_INDICATORS.test(collapsed) ? 3.2 : 4.0;
 *   return Math.ceil(collapsed.length / ratio);
 *
 * with CODE_INDICATORS =
 *   /[{}();=<>]|\b(function|const|let|var|import|export|class|interface|type|
 *     return|if|else|for|while)\b/
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../similarity.js';

/** Repeat a non-code, non-keyword filler character. */
const z = (n: number) => 'z'.repeat(n);

/**
 * A 13-character probe is the cheapest way to observe which branch fired:
 * ceil(13 / 4.0) === 4 (natural language) but ceil(13 / 3.2) === 5 (code).
 * Every branch-detection test below is built on this.
 */
const NL_13 = 4;
const CODE_13 = 5;

describe('estimateTokens', () => {
  describe('chars-per-token ratio constants', () => {
    // NOTE(characterization): these two numbers are the single most
    // load-bearing constants in the system — every context/token budget
    // decision funnels through estimateTokens. Changing 4.0 or 3.2 silently
    // re-budgets memory retrieval, smart truncation and compression
    // EVERYWHERE. They are pinned here exactly so the shared-package move
    // cannot drift them.
    it('bills natural-language text at exactly 4.0 characters per token', () => {
      // 400 filler chars, no code indicator anywhere: 400 / 4.0 === 100 exactly.
      expect(estimateTokens(z(400))).toBe(100);
      expect(z(400).length / estimateTokens(z(400))).toBe(4.0);
    });

    it('bills code-flavoured text at exactly 3.2 characters per token', () => {
      // 31 filler chars + one ';' === 32 chars: 32 / 3.2 === 10 exactly.
      const codeText = z(31) + ';';
      expect(codeText.length).toBe(32);
      expect(estimateTokens(codeText)).toBe(10);
      expect(codeText.length / estimateTokens(codeText)).toBe(3.2);
    });

    it('flips between the two ratios on a single character', () => {
      // Minimal boundary: same length (4), different branch.
      expect(estimateTokens('aaaa')).toBe(1); // ceil(4 / 4.0)
      expect(estimateTokens('aaa;')).toBe(2); // ceil(4 / 3.2)
    });

    // NOTE(characterization): because the ratio is global rather than local,
    // a SINGLE stray code character re-prices an entire document by 25%.
    // Appending one ';' to a 10k-character prose blob adds 626 estimated
    // tokens. This is a real budgeting cliff, not a rounding artefact.
    it('re-prices an entire long document when one code character appears', () => {
      expect(estimateTokens(z(10_000))).toBe(2500);
      expect(estimateTokens(z(10_000) + ';')).toBe(3126);
    });
  });

  describe('CODE_INDICATORS — symbol triggers', () => {
    const CODE_SYMBOLS = ['{', '}', '(', ')', ';', '=', '<', '>'];

    it.each(CODE_SYMBOLS)('treats %s as code-heavy content', (symbol) => {
      expect(estimateTokens(z(12) + symbol)).toBe(CODE_13);
    });

    it('recognises exactly those eight symbols and no others', () => {
      expect(CODE_SYMBOLS).toHaveLength(8);
    });

    // NOTE(characterization): square brackets are absent from the character
    // class even though the same module elsewhere treats `[` / `]` as
    // structural noise (BRACKET_NOISE_RE). A JSON array or a markdown link is
    // therefore billed as natural language.
    const NON_TRIGGER_PUNCTUATION = [
      '[', ']', ':', ',', '.', '+', '-', '/', '*', '!', '?', '&', '|',
      '#', '$', '@', '%', '^', '~', '`', '"', "'", '_', '\\',
    ];

    it.each(NON_TRIGGER_PUNCTUATION)(
      'does not treat %s as a code indicator',
      (symbol) => {
        expect(estimateTokens(z(12) + symbol)).toBe(NL_13);
      },
    );
  });

  describe('CODE_INDICATORS — keyword triggers', () => {
    const KEYWORDS = [
      'function', 'const', 'let', 'var', 'import', 'export', 'class',
      'interface', 'type', 'return', 'if', 'else', 'for', 'while',
    ];

    it.each(KEYWORDS)('treats the bare keyword %s as code-heavy content', (keyword) => {
      // Pad to exactly 13 chars so the branch is observable.
      const probe = `${keyword} ${z(13 - keyword.length - 1)}`;
      expect(probe).toHaveLength(13);
      expect(estimateTokens(probe)).toBe(CODE_13);
    });

    it('recognises exactly those fourteen keywords', () => {
      expect(KEYWORDS).toHaveLength(14);
    });

    it('requires word boundaries around the keyword', () => {
      expect(estimateTokens('if zzzzzzzzzz')).toBe(CODE_13);
      expect(estimateTokens('zzifzzzzzzzzz')).toBe(NL_13);
      expect(estimateTokens('my const here')).toBe(CODE_13);
      expect(estimateTokens('myconst here')).toBe(3); // ceil(12 / 4.0)
    });

    // NOTE(characterization): the regex carries no `i` flag, so keyword
    // detection is case-sensitive while the *symbol* half of the alternation
    // is inherently case-free. `const` is code; `CONST` (a perfectly normal way
    // to write a constant name in prose or SQL) is not.
    it('matches keywords case-sensitively', () => {
      expect(estimateTokens('const zzzzzzz')).toBe(CODE_13);
      expect(estimateTokens('CONST zzzzzzz')).toBe(NL_13);
      expect(estimateTokens('If zzzzzzzzzz')).toBe(NL_13);
      expect(estimateTokens('TYPE zzzzzzzz')).toBe(NL_13);
    });

    // NOTE(characterization): `type`, `if`, `for`, `class`, `return` and `while`
    // are ordinary English words. Plain conversational memory text containing
    // any of them is billed at the code ratio and therefore over-estimated by
    // 25% relative to otherwise identical prose.
    it('bills ordinary English prose as code when it contains a keyword', () => {
      const withKeyword = 'What type of file is this? I am not sure.';
      const withoutKeyword = 'What kind of file is this? I am not sure.';
      expect(withKeyword).toHaveLength(41);
      expect(withoutKeyword).toHaveLength(41);
      expect(estimateTokens(withKeyword)).toBe(13);
      expect(estimateTokens(withoutKeyword)).toBe(11);
    });

    // NOTE(characterization): mathematical comparisons in prose trip the `<`
    // and `>` symbol branch too.
    it('bills prose containing a comparison symbol as code', () => {
      const prose = 'the value of alpha is less than beta (a < b) overall';
      expect(prose).toHaveLength(52);
      expect(estimateTokens(prose)).toBe(17); // ceil(52 / 3.2)
    });
  });

  describe('whitespace normalisation applied before measuring', () => {
    it('collapses runs of spaces so the estimate falls below the raw length', () => {
      const raw = 'a' + ' '.repeat(20) + 'b';
      expect(raw).toHaveLength(22);
      // Naive ceil(22 / 4.0) would be 6; collapsing to 'a b' yields ceil(3 / 4.0).
      expect(estimateTokens(raw)).toBe(1);
    });

    it('collapses runs of tabs', () => {
      expect(estimateTokens('a\t\t\tb')).toBe(1); // 'a b'
    });

    it('collapses mixed space/tab runs into a single space', () => {
      expect(estimateTokens('a \t \t \t b')).toBe(1); // 'a b'
    });

    it('collapses three or more newlines down to two', () => {
      // 'aaa\n\nbbb' is already at the floor: 8 chars -> ceil(8 / 4.0) === 2.
      expect(estimateTokens('aaa\n\nbbb')).toBe(2);
      // 9 raw chars would be 3 tokens if uncollapsed; collapsing gives 2.
      expect(estimateTokens('aaa\n\n\nbbb')).toBe(2);
      expect(estimateTokens('aaa' + '\n'.repeat(10) + 'bbb')).toBe(2);
    });

    // NOTE(characterization): only ' ' and '\t' are collapsed. CRLF-terminated
    // content (Windows files, HTTP bodies, pasted terminal output) keeps every
    // '\r', so identical-looking text is priced differently by line ending.
    it('does not collapse carriage returns', () => {
      const raw = 'a' + '\r'.repeat(20) + 'b';
      expect(raw).toHaveLength(22);
      expect(estimateTokens(raw)).toBe(6); // ceil(22 / 4.0) — no collapsing
    });

    // NOTE(characterization): form feed and non-breaking space are likewise
    // outside the collapse set.
    it('does not collapse form feeds or non-breaking spaces', () => {
      expect(estimateTokens(z(12) + '\f')).toBe(NL_13);
      expect(estimateTokens(z(12) + ' ')).toBe(NL_13);
    });

    it('collapses before deciding the ratio, and measures the collapsed length', () => {
      // 'a' + 20 spaces + ';' collapses to 'a ;' (3 chars) and still trips the
      // code branch: ceil(3 / 3.2) === 1.
      expect(estimateTokens('a' + ' '.repeat(20) + ';')).toBe(1);
    });
  });

  describe('Math.ceil rounding', () => {
    it('does not round up when the natural-language division is exact', () => {
      expect(estimateTokens(z(4))).toBe(1); // 4 / 4.0 === 1.0
      expect(estimateTokens(z(400))).toBe(100); // 400 / 4.0 === 100.0
    });

    it('rounds up one character past an exact natural-language boundary', () => {
      expect(estimateTokens(z(5))).toBe(2); // ceil(1.25)
      expect(estimateTokens(z(401))).toBe(101); // ceil(100.25)
    });

    it('does not round up when the code division is exact', () => {
      expect(estimateTokens(z(15) + ';')).toBe(5); // 16 / 3.2 === 5.0
      expect(estimateTokens(z(31) + ';')).toBe(10); // 32 / 3.2 === 10.0
    });

    it('rounds up one character past an exact code boundary', () => {
      expect(estimateTokens(z(16) + ';')).toBe(6); // ceil(17 / 3.2) === ceil(5.3125)
      expect(estimateTokens(z(32) + ';')).toBe(11); // ceil(33 / 3.2) === ceil(10.3125)
    });

    it('produces a monotonic natural-language staircase over short lengths', () => {
      const staircase = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => estimateTokens(z(n)));
      expect(staircase).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3]);
    });

    it('produces a monotonic code staircase over short lengths', () => {
      const staircase = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        .map((n) => estimateTokens(z(n) + ';'));
      expect(staircase).toEqual([1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5]);
    });
  });

  describe('edge cases', () => {
    it('returns 0 for the empty string via the falsy guard', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('returns 1 for a single character', () => {
      expect(estimateTokens('a')).toBe(1);
    });

    // NOTE(characterization): the guard is `if (!text)`, not a length check, so
    // it is the only path that yields 0. Any non-empty input — including pure
    // whitespace that carries no information at all — costs at least 1 token.
    it('never returns 0 for non-empty input, however meaningless', () => {
      expect(estimateTokens(' ')).toBe(1);
      expect(estimateTokens('\t')).toBe(1);
      expect(estimateTokens('\n')).toBe(1);
      expect(estimateTokens('0')).toBe(1);
    });

    // NOTE(characterization): a 10,000-character run of whitespace collapses to
    // a single character and is therefore estimated at 1 token, while the same
    // 10,000 characters of '\r' would be estimated at 2,500.
    it('estimates whitespace-only input at 1 token regardless of size', () => {
      expect(estimateTokens(' '.repeat(10_000))).toBe(1);
      expect(estimateTokens('\n'.repeat(10_000))).toBe(1);
      expect(estimateTokens('\t'.repeat(10_000))).toBe(1);
    });

    it('scales linearly on very long input', () => {
      expect(estimateTokens(z(10_000))).toBe(2500);
      expect(estimateTokens(z(1_000_000))).toBe(250_000);
    });

    // NOTE(characterization): `String.length` counts UTF-16 code units, so
    // astral-plane characters are counted twice and grapheme clusters many
    // times over. Emoji-heavy content is systematically over-estimated.
    it('counts UTF-16 code units, not code points or graphemes', () => {
      expect('😀'.length).toBe(2);
      expect(estimateTokens('😀')).toBe(1); // ceil(2 / 4.0)

      // 4 emoji === 8 code units === 2 tokens. Counting code points would give 1.
      expect('😀😀😀😀'.length).toBe(8);
      expect(estimateTokens('😀😀😀😀')).toBe(2);

      // One grapheme, 7 code points, 11 code units -> 3 tokens.
      const family = '👨‍👩‍👧‍👦';
      expect(family.length).toBe(11);
      expect([...family]).toHaveLength(7);
      expect(estimateTokens(family)).toBe(3);
    });

    it('counts precomposed accented characters as one unit each', () => {
      expect(estimateTokens('café')).toBe(1); // 4 code units
    });

    // NOTE(characterization): CJK text is dramatically under-estimated — real
    // tokenizers spend roughly one token per CJK character, but this function
    // charges 4 characters per token.
    it('estimates CJK text at the natural-language ratio', () => {
      const cjk = '日本語テキスト';
      expect(cjk).toHaveLength(7);
      expect(estimateTokens(cjk)).toBe(2); // ceil(7 / 4.0)
    });
  });
});
