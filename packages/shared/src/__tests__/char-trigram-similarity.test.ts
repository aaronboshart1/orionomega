/**
 * CHARACTERIZATION tests for `trigramSimilarity` (similarity.ts:139).
 *
 * These pin down what the function ACTUALLY does today — not what it ought to
 * do — so that moving similarity.ts verbatim to @orionomega/shared is provably
 * behaviour-preserving. `trigramSimilarity` is the reference oracle used by
 * dedup-prefilter.test.ts, so every number here is load-bearing for dedup.
 *
 * Every expected value in this file was obtained by running the real code.
 * Where the observed behaviour looks wrong, it is still asserted as-is and
 * flagged with a `NOTE(characterization):` comment.
 *
 * Shape of the function under test (verbatim, for reference while reading):
 *   if (a === b) return 1;
 *   na = normalize(a); nb = normalize(b);
 *   if (na === nb) return 1;
 *   if (na.length < 3 || nb.length < 3) return na === nb ? 1 : 0;
 *   -> Jaccard over character 3-grams of na / nb
 *
 * What normalize() strips (and, importantly, what it does NOT):
 *   - lowercases
 *   - leading `[user]` / `[assistant] ` / `[system] ` prefix
 *   - `Task:` / `Workers:` / `Decisions:` / `Findings:` / `Node:` / `Workflow:`
 *     / `Output:` / `Result:` / `Errors:` / `Outputs:` / `Artifacts:` labels
 *     (anywhere, global + case-insensitive)
 *   - every `[` and `]`
 *   - a `:` immediately preceded by a word character
 *   - collapses all whitespace runs to one space, then trims
 *   It does NOT strip apostrophes, hyphens, `!`, `?`, `.`, `,` or any other
 *   punctuation.
 */

import { describe, it, expect } from 'vitest';
import { trigramSimilarity, isDuplicateInBatch } from '../similarity.js';

/**
 * `trigramSimilarityPrepared` is module-private, but `isDuplicateInBatch` is a
 * thin public wrapper that returns `trigramSimilarityPrepared(a, b) >= threshold`
 * for a single-element batch. Bisecting the threshold recovers the prepared
 * similarity to ~2^-50, which is enough to prove equivalence with the
 * non-prepared path.
 */
function preparedSimilarity(a: string, b: string): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (isDuplicateInBatch(a, [{ content: b }], mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** A spread of inputs reused by the symmetry and equivalence suites. */
const SPREAD: Array<[string, string]> = [
  ['', ''],
  ['', 'hello'],
  ['   ', ''],
  ['ab', 'cd'],
  ['ab', 'abc'],
  ['abc', 'xyz'],
  ['abcd', 'abce'],
  ['abcde', 'abcdxy'],
  ['abcdef', 'abc'],
  ['hello', 'hello!'],
  ['hello', 'olleh'],
  ["don't", 'dont'],
  ['a-b-c', 'abc'],
  ['a : b', 'a b'],
  ['aaa', 'aaaa'],
  ['MiXeD CaSe', 'mixed case'],
  ['hello [world]', 'hello world'],
  ['[user] Task: deploy the gateway', 'deploy the gateway'],
  ['the gateway binds to port 8000', 'the gateway binds to port 8001'],
  ['configure the anthropic api key', 'configure the anthropic api token'],
  ['mental models refresh after every retention call', 'cross project lessons roll up'],
  ['trigram similarity uses a jaccard style overlap', 'trigram similarity uses jaccard overlap'],
];

describe('trigramSimilarity', () => {
  describe('identity', () => {
    it('returns exactly 1 for the same string instance', () => {
      expect(trigramSimilarity('the gateway binds to port 8000', 'the gateway binds to port 8000')).toBe(1);
    });

    it('returns exactly 1 for a one-character string compared with itself', () => {
      // Short-circuits on `a === b` before the <3-char rule can fire.
      expect(trigramSimilarity('a', 'a')).toBe(1);
    });

    it('returns exactly 1 for two empty strings', () => {
      expect(trigramSimilarity('', '')).toBe(1);
    });
  });

  describe('normalized identity — decoration stripped by normalize() still scores exactly 1', () => {
    it('ignores case', () => {
      expect(trigramSimilarity('Hello World', 'hello world')).toBe(1);
      expect(trigramSimilarity('MiXeD CaSe', 'mixed case')).toBe(1);
    });

    it('ignores square brackets anywhere in the text', () => {
      expect(trigramSimilarity('hello [world]', 'hello world')).toBe(1);
    });

    it('ignores a leading [user] speaker prefix', () => {
      expect(trigramSimilarity('[user] deploy the gateway', 'deploy the gateway')).toBe(1);
    });

    it('ignores structural labels such as Task: and Node: and Findings:', () => {
      expect(trigramSimilarity('[user] Task: deploy the gateway', 'deploy the gateway')).toBe(1);
      expect(trigramSimilarity('Node: alpha', 'alpha')).toBe(1);
      expect(trigramSimilarity('Findings: ok now', 'ok now')).toBe(1);
      // STRUCTURAL_LABEL_RE is global — the label need not be at the start.
      expect(trigramSimilarity('the Task: alpha beta', 'the alpha beta')).toBe(1);
    });

    it('ignores a colon fused to a word character', () => {
      expect(trigramSimilarity('context:', 'context')).toBe(1);
      // NOTE(characterization): the colon is removed, not replaced, so "a:b"
      // normalizes to "ab" — it silently fuses two distinct words together.
      expect(trigramSimilarity('a:b', 'ab')).toBe(1);
    });

    it('collapses whitespace runs, newlines and leading/trailing padding', () => {
      expect(trigramSimilarity('hello world', 'hello  world')).toBe(1);
      expect(trigramSimilarity('line one\nline two', 'line one line two')).toBe(1);
      expect(trigramSimilarity('  padded  text  ', 'padded text')).toBe(1);
    });

    it('scores whitespace-only content as identical to the empty string', () => {
      // NOTE(characterization): both normalize to '' so `na === nb` fires and
      // returns 1 BEFORE the <3-char guard. Under dedup this means any two
      // blank/whitespace-only memories are treated as duplicates of each other.
      expect(trigramSimilarity('   ', '')).toBe(1);
      expect(trigramSimilarity('   ', '\t\n ')).toBe(1);
    });

    it('scores bracket-only and bare-speaker-prefix content as identical to empty', () => {
      // NOTE(characterization): '[[[' and '[user]' both normalize away to ''.
      // Any pair of such strings therefore scores 1, i.e. "duplicate".
      expect(trigramSimilarity('[[[', '')).toBe(1);
      expect(trigramSimilarity('[user]', '')).toBe(1);
      expect(trigramSimilarity('[[[', '[user]')).toBe(1);
    });
  });

  describe('the short-string rule (normalized length < 3)', () => {
    it('returns 0 when one normalized form is shorter than 3 chars and they differ', () => {
      expect(trigramSimilarity('ab', 'cd')).toBe(0);
      expect(trigramSimilarity('', 'hello')).toBe(0);
      expect(trigramSimilarity('hello', '')).toBe(0);
    });

    it('returns 0 even when the short string is a strict prefix of the long one', () => {
      // NOTE(characterization): 'ab' is a prefix of 'abc' yet scores 0, because
      // the <3-char guard fires before any trigram work. There is no partial
      // credit at all below 3 normalized characters.
      expect(trigramSimilarity('ab', 'abc')).toBe(0);
      expect(trigramSimilarity('a', 'abcdef')).toBe(0);
    });

    it('returns 1 when both normalized forms are shorter than 3 chars AND equal', () => {
      // Reached via the earlier `na === nb` check, never via the guard's own
      // ternary.
      expect(trigramSimilarity('ab', 'ab')).toBe(1);
      expect(trigramSimilarity('ab', 'AB')).toBe(1);
      expect(trigramSimilarity('a:', 'a')).toBe(1);
    });

    it('never reaches the guard\'s own `na === nb ? 1 : 0` true-branch', () => {
      // NOTE(characterization): similarity.ts:145 reads `return na === nb ? 1 : 0`,
      // but line 143 already returned 1 for `na === nb`. The ternary's true
      // branch is therefore dead code — the guard is always equivalent to
      // `return 0`. Asserted here so the dead branch is preserved verbatim
      // through the move rather than "cleaned up" into a behaviour change.
      const shortPairs: Array<[string, string]> = [
        ['ab', 'cd'], ['a', 'b'], ['', 'x'], ['xy', 'zzzzzz'], ['[a]', 'q'],
      ];
      for (const [a, b] of shortPairs) {
        expect(trigramSimilarity(a, b)).toBe(0);
      }
    });
  });

  describe('exact Jaccard arithmetic over character 3-grams', () => {
    it('scores "abcde" vs "abcdxy" at exactly 2/5', () => {
      // trigrams('abcde')  = {abc, bcd, cde}            -> |A| = 3
      // trigrams('abcdxy') = {abc, bcd, cdx, dxy}       -> |B| = 4
      // A ∩ B = {abc, bcd}                              -> I   = 2
      // J = I / (|A| + |B| - I) = 2 / (3 + 4 - 2) = 2/5 = 0.4
      expect(trigramSimilarity('abcde', 'abcdxy')).toBe(2 / 5);
      expect(trigramSimilarity('abcde', 'abcdxy')).toBe(0.4);
    });

    it('scores "abcd" vs "abce" at exactly 1/3', () => {
      // trigrams('abcd') = {abc, bcd} -> |A| = 2
      // trigrams('abce') = {abc, bce} -> |B| = 2
      // I = |{abc}| = 1
      // J = 1 / (2 + 2 - 1) = 1/3
      expect(trigramSimilarity('abcd', 'abce')).toBe(1 / 3);
    });

    it('scores "abcdef" vs "abc" at exactly 1/4', () => {
      // trigrams('abcdef') = {abc, bcd, cde, def} -> |A| = 4
      // trigrams('abc')    = {abc}                -> |B| = 1
      // I = 1  ->  J = 1 / (4 + 1 - 1) = 1/4
      expect(trigramSimilarity('abcdef', 'abc')).toBe(0.25);
    });

    it('scores "hello" vs "hello!" at exactly 3/4 because "!" survives normalize()', () => {
      // NOTE(characterization): normalize() strips brackets and word-colons but
      // NOT general punctuation, so the trailing "!" creates a real extra
      // trigram and costs a quarter of the score.
      // trigrams('hello')  = {hel, ell, llo}      -> |A| = 3
      // trigrams('hello!') = {hel, ell, llo, lo!} -> |B| = 4
      // I = 3  ->  J = 3 / (3 + 4 - 3) = 3/4
      expect(trigramSimilarity('hello', 'hello!')).toBe(0.75);
    });

    it('returns 0 for an anagram with no shared 3-gram', () => {
      // trigrams('hello') = {hel, ell, llo}; trigrams('olleh') = {oll, lle, leh}
      expect(trigramSimilarity('hello', 'olleh')).toBe(0);
      expect(trigramSimilarity('abc', 'xyz')).toBe(0);
    });

    it('gives a near-1 but not-1 score to a one-character difference in a long string', () => {
      expect(trigramSimilarity('the gateway binds to port 8000', 'the gateway binds to port 8001'))
        .toBe(0.9310344827586207);
    });
  });

  describe('set semantics — repeated characters collapse', () => {
    it('scores runs of the same character as identical regardless of length', () => {
      // NOTE(characterization): trigrams() builds a Set, so 'aaa', 'aaaa' and
      // 'aaaaaaaaaa' all reduce to the single trigram {aaa} and score 1 against
      // each other. Under dedup at threshold 0.85, contents that differ only in
      // the length of a repeated-character run are treated as duplicates.
      expect(trigramSimilarity('aaa', 'aaaa')).toBe(1);
      expect(trigramSimilarity('tttt', 'ttttt')).toBe(1);
      expect(trigramSimilarity('x'.repeat(10), 'x'.repeat(20))).toBe(1);
    });
  });

  describe('punctuation that normalize() does NOT strip', () => {
    it('treats apostrophes as significant characters', () => {
      // trigrams("don't") = {don, on', n't}; trigrams('dont') = {don, ont}
      // I = 1 -> J = 1 / (3 + 2 - 1) = 1/4
      expect(trigramSimilarity("don't", 'dont')).toBe(0.25);
    });

    it('treats hyphens as significant characters', () => {
      expect(trigramSimilarity('a-b-c', 'abc')).toBe(0);
    });

    it('keeps a colon that is not preceded by a word character', () => {
      // NOTE(characterization): the colon-stripping rule is /(\w):/ so "a : b"
      // keeps its colon and shares no trigram with "a b" at all.
      expect(trigramSimilarity('a : b', 'a b')).toBe(0);
    });
  });

  describe('symmetry', () => {
    it('is symmetric across a spread of inputs', () => {
      for (const [a, b] of SPREAD) {
        expect(trigramSimilarity(a, b)).toBe(trigramSimilarity(b, a));
      }
    });

    it('is symmetric on randomised inputs', () => {
      let seed = 12345;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const alphabet = 'abcdefg :[]!\n';
      const randStr = () => {
        const n = Math.floor(rand() * 24);
        let s = '';
        for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
        return s;
      };
      for (let i = 0; i < 400; i++) {
        const a = randStr();
        const b = randStr();
        expect(trigramSimilarity(a, b)).toBe(trigramSimilarity(b, a));
      }
    });
  });

  describe('range', () => {
    it('always returns a finite number in [0, 1] across the spread', () => {
      for (const [a, b] of SPREAD) {
        const s = trigramSimilarity(a, b);
        expect(Number.isFinite(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('equivalence with the prepared/profile fast path used by dedup', () => {
    it('agrees bit-for-bit with trigramSimilarityPrepared across the spread', () => {
      // trigramSimilarityPrepared iterates the SMALLER trigram set for fewer
      // lookups; the intersection count is an integer so the final division is
      // identical. This asserts that optimisation is value-preserving.
      for (const [a, b] of SPREAD) {
        expect(preparedSimilarity(a, b)).toBeCloseTo(trigramSimilarity(a, b), 12);
      }
    });

    it('produces the same >= threshold verdict as isDuplicateInBatch', () => {
      const thresholds = [0, 0.1, 0.25, 1 / 3, 0.4, 0.5, 0.7, 0.75, 0.85, 0.93, 0.95, 1];
      for (const [a, b] of SPREAD) {
        const direct = trigramSimilarity(a, b);
        for (const t of thresholds) {
          expect(isDuplicateInBatch(a, [{ content: b }], t)).toBe(direct >= t);
          // and in the other argument order
          expect(isDuplicateInBatch(b, [{ content: a }], t)).toBe(direct >= t);
        }
      }
    });
  });
});
