/**
 * CHARACTERIZATION tests for `compressMemoryContent` (src/similarity.ts).
 *
 * These pin down what the function ACTUALLY DOES TODAY, so that moving
 * similarity.ts verbatim into packages/shared is provably behaviour-preserving.
 * Every expectation here was obtained by executing the real implementation —
 * none were reasoned to. Where the observed behaviour looks wrong, the test
 * still asserts the observed value and carries a `NOTE(characterization):`
 * comment. Nothing here should be "fixed" without a deliberate decision.
 *
 * The pipeline, in order (similarity.ts:104-115):
 *   1. /\n{3,}/g          → '\n\n'      collapse blank-line runs
 *   2. /[ \t]{2,}/g       → ' '         collapse space/tab runs
 *   3. trailing-filler strip (anchored at end of string)
 *   4. /^(.+)$\n(?:\1$\n?)+/gm → '$1'   consecutive identical line dedup
 *   5. .trim()
 */

import { describe, it, expect } from 'vitest';
import { compressMemoryContent } from '../similarity.js';

describe('compressMemoryContent', () => {
  describe('blank-line and whitespace collapsing', () => {
    it('collapses a run of three newlines to exactly two', () => {
      expect(compressMemoryContent('a\n\n\nb')).toBe('a\n\nb');
    });

    it('collapses an arbitrarily long newline run to exactly two', () => {
      expect(compressMemoryContent('a\n\n\n\n\nb')).toBe('a\n\nb');
    });

    it('leaves a single blank line (two newlines) untouched', () => {
      expect(compressMemoryContent('a\n\nb')).toBe('a\n\nb');
    });

    it('collapses a run of spaces to a single space', () => {
      expect(compressMemoryContent('a    b')).toBe('a b');
    });

    it('collapses a run of two or more tabs to a single space', () => {
      expect(compressMemoryContent('a\t\tb')).toBe('a b');
    });

    it('collapses a mixed space/tab run to a single space', () => {
      expect(compressMemoryContent('a \t b')).toBe('a b');
    });

    // NOTE(characterization): the {2,} quantifier means a LONE tab survives,
    // so single-tab-indented or tab-separated content is not normalised at all
    // while double-tab content becomes a single SPACE. Inconsistent, but current.
    it('does NOT touch a lone tab (only runs of 2+ are collapsed)', () => {
      expect(compressMemoryContent('a\tb')).toBe('a\tb');
    });

    // NOTE(characterization): the class is [ \t] only — Unicode spaces such as
    // NO-BREAK SPACE (U+00A0) are never collapsed, even in runs.
    it('does NOT collapse non-breaking spaces', () => {
      expect(compressMemoryContent('a\u00a0\u00a0b')).toBe('a\u00a0\u00a0b');
    });

    it('never collapses whitespace across a line boundary', () => {
      // Space collapse turns line 1 into 'a b', which then makes it identical
      // to line 2 and therefore eligible for the consecutive-line dedup below.
      expect(compressMemoryContent('a  b\na b\nc')).toBe('a bc');
    });
  });

  describe('trailing filler-phrase strip', () => {
    // The regex is
    //   /\s*(let me know if you (?:need|have|want) (?:anything|any|more)
    //        |feel free to (?:ask|reach out)|hope this helps|happy to help)[.!]?\s*$/i
    // which expands to exactly 13 phrases. Each one is exercised below.

    const stripped: Array<[string, string]> = [
      ['let me know if you need anything', 'let me know if you need anything'],
      ['let me know if you need any', 'let me know if you need any'],
      ['let me know if you need more', 'let me know if you need more'],
      ['let me know if you have anything', 'let me know if you have anything'],
      ['let me know if you have any', 'let me know if you have any'],
      ['let me know if you have more', 'let me know if you have more'],
      ['let me know if you want anything', 'let me know if you want anything'],
      ['let me know if you want any', 'let me know if you want any'],
      ['let me know if you want more', 'let me know if you want more'],
      ['feel free to ask', 'feel free to ask'],
      ['feel free to reach out', 'feel free to reach out'],
      ['hope this helps', 'hope this helps'],
      ['happy to help', 'happy to help'],
    ];

    for (const [label, phrase] of stripped) {
      it(`strips the trailing phrase "${label}"`, () => {
        expect(compressMemoryContent(`Result done. ${phrase}`)).toBe('Result done.');
      });
    }

    it('strips a trailing filler phrase followed by a period', () => {
      expect(compressMemoryContent('Result done. Hope this helps.')).toBe('Result done.');
    });

    it('strips a trailing filler phrase followed by an exclamation mark', () => {
      expect(compressMemoryContent('Result done. Hope this helps!')).toBe('Result done.');
    });

    it('matches the filler phrase case-insensitively', () => {
      expect(compressMemoryContent('Result done. HAPPY TO HELP')).toBe('Result done.');
    });

    it('eats trailing whitespace and newlines after the filler phrase', () => {
      expect(compressMemoryContent('Result done. happy to help.   \n\n')).toBe('Result done.');
    });

    it('eats the newline separating the body from the filler phrase', () => {
      expect(compressMemoryContent('line one\nline two\n\nHope this helps!')).toBe('line one\nline two');
    });

    it('reduces content that is nothing but a filler phrase to the empty string', () => {
      expect(compressMemoryContent('hope this helps')).toBe('');
      expect(compressMemoryContent('happy to help!')).toBe('');
      expect(compressMemoryContent('  hope this helps  ')).toBe('');
      expect(compressMemoryContent('\n\nhappy to help\n\n')).toBe('');
    });

    it('does NOT strip a filler phrase that appears mid-string', () => {
      expect(compressMemoryContent('hope this helps but here is more')).toBe(
        'hope this helps but here is more',
      );
      expect(compressMemoryContent('happy to help. Also the port is 8000.')).toBe(
        'happy to help. Also the port is 8000.',
      );
    });

    // NOTE(characterization): `[.!]?` admits only '.' and '!', so the extremely
    // common "hope this helps?" variant is NOT stripped.
    it('does NOT strip when the phrase is terminated by a question mark', () => {
      expect(compressMemoryContent('Result done. hope this helps?')).toBe(
        'Result done. hope this helps?',
      );
    });

    // NOTE(characterization): the anchor is `\s*$` immediately after the phrase,
    // so the very common real-world "…anything else." form survives untouched.
    it('does NOT strip "let me know if you need anything else."', () => {
      expect(compressMemoryContent('let me know if you need anything else.')).toBe(
        'let me know if you need anything else.',
      );
    });

    it('does NOT strip truncated / near-miss variants of the phrases', () => {
      expect(compressMemoryContent('Result. let me know')).toBe('Result. let me know');
      expect(compressMemoryContent('Result. let me know if you need')).toBe(
        'Result. let me know if you need',
      );
      expect(compressMemoryContent('Result. feel free to reach')).toBe('Result. feel free to reach');
      expect(compressMemoryContent('Result. hope this help')).toBe('Result. hope this help');
    });

    // NOTE(characterization): the phrase alternatives are not word-anchored at
    // their left edge, so "I'm happy to help" loses everything but "I'm" —
    // the leading `\s*` swallows the space and the sentence is decapitated.
    it("mangles a sentence that merely ENDS with a filler phrase (\"I'm happy to help\" -> \"I'm\")", () => {
      expect(compressMemoryContent("I'm happy to help")).toBe("I'm");
    });
  });

  describe('consecutive-identical-line dedup', () => {
    // NOTE(characterization): THIS IS THE BIG ONE. The replacement is '$1' but
    // the match consumes the trailing newline of the LAST duplicate, so the
    // surviving line is GLUED to whatever line followed the duplicate block.
    // 'a\na\nb' becomes 'ab' — not 'a\nb'. Real memory content silently loses a
    // line break and two adjacent lines fuse into one. Asserted as-is.
    it('fuses the surviving line with the following line (newline is eaten)', () => {
      expect(compressMemoryContent('a\na\nb')).toBe('ab');
    });

    it('fuses regardless of how many duplicates there were', () => {
      expect(compressMemoryContent('a\na\na\na\nb')).toBe('ab');
    });

    it('does not fuse when the duplicate block ends the string', () => {
      expect(compressMemoryContent('a\na')).toBe('a');
      expect(compressMemoryContent('a\na\na')).toBe('a');
      expect(compressMemoryContent('a\na\n')).toBe('a');
    });

    it('dedups each duplicate block independently', () => {
      expect(compressMemoryContent('a\na\nb\nc\nc\nd')).toBe('ab\ncd');
    });

    it('collapses back-to-back duplicate blocks into a single fused line', () => {
      expect(compressMemoryContent('a\na\nb\nb\nc')).toBe('abc');
    });

    it('does NOT dedup non-consecutive duplicates', () => {
      expect(compressMemoryContent('a\nb\na')).toBe('a\nb\na');
      expect(compressMemoryContent('a\nb\na\nb')).toBe('a\nb\na\nb');
    });

    it('does NOT dedup duplicates separated by a blank line', () => {
      expect(compressMemoryContent('a\n\na')).toBe('a\n\na');
    });

    it('does NOT dedup lines that differ only in trailing whitespace', () => {
      // `.+` captures the trailing space, so 'a' and 'a ' are different lines.
      expect(compressMemoryContent('a\na \nb')).toBe('a\na \nb');
    });

    it('dedups lines whose leading indentation is identical', () => {
      expect(compressMemoryContent('  a\n  a\nb')).toBe('ab');
    });

    it('dedups realistic structured memory lines (and fuses the next one)', () => {
      expect(compressMemoryContent('Task: build\nTask: build\nDone')).toBe('Task: buildDone');
    });

    it('dedups lines containing an interior tab', () => {
      expect(compressMemoryContent('a\tb\na\tb\nc')).toBe('a\tbc');
    });

    it('never dedups blank lines (the pattern requires at least one character)', () => {
      expect(compressMemoryContent('\n\n')).toBe('');
    });

    // NOTE(characterization): `.` does not match '\r', and the pattern demands a
    // literal '\n' right after `$`. On CRLF content `^(.+)$\n` therefore never
    // matches, so Windows-line-ending memories are NEVER deduped.
    it('does NOT dedup CRLF-terminated duplicate lines', () => {
      expect(compressMemoryContent('a\r\na\r\nb')).toBe('a\r\na\r\nb');
    });

    it('does NOT dedup lone-CR-terminated duplicate lines', () => {
      expect(compressMemoryContent('a\ra\rb')).toBe('a\ra\rb');
    });
  });

  describe('CRLF line endings', () => {
    // NOTE(characterization): /\n{3,}/ cannot see across the interleaved '\r',
    // so blank-line collapsing is a no-op on CRLF content too. Combined with the
    // dedup miss above, CRLF memories get essentially no compression.
    it('does NOT collapse blank-line runs written as CRLF', () => {
      expect(compressMemoryContent('a\r\n\r\n\r\n\r\nb')).toBe('a\r\n\r\n\r\n\r\nb');
    });

    it('still applies the filler strip across a CRLF boundary', () => {
      expect(compressMemoryContent('Result.\r\nhope this helps')).toBe('Result.');
    });

    it('still trims a trailing CRLF', () => {
      expect(compressMemoryContent('a\r\n')).toBe('a');
    });

    it('leaves interior CRLF pairs intact', () => {
      expect(compressMemoryContent('a\r\nb')).toBe('a\r\nb');
    });
  });

  describe('final trim', () => {
    it('trims leading and trailing whitespace', () => {
      expect(compressMemoryContent('   \n\n\t  ')).toBe('');
      expect(compressMemoryContent('\n')).toBe('');
      expect(compressMemoryContent(' ')).toBe('');
    });
  });

  describe('edge cases', () => {
    it('returns the empty string for empty input', () => {
      expect(compressMemoryContent('')).toBe('');
    });

    it('returns whitespace-only input as the empty string', () => {
      expect(compressMemoryContent('   \n\n\t  ')).toBe('');
    });

    it('returns a single line unchanged', () => {
      expect(compressMemoryContent('hello world')).toBe('hello world');
    });

    it('returns the empty string when the content is entirely filler', () => {
      expect(compressMemoryContent('hope this helps')).toBe('');
    });

    it('handles a realistic mixed document', () => {
      const input =
        'Decision: use port 8000.\n\n\n\nDecision: use port 8000.\nDecision: use port 8000.\n\nHope this helps!';
      // Blank-run collapse -> filler strip -> the two now-adjacent duplicate
      // lines dedup into one; the earlier copy is kept because a blank line
      // separates it from the block.
      expect(compressMemoryContent(input)).toBe(
        'Decision: use port 8000.\n\nDecision: use port 8000.',
      );
    });
  });

  describe('idempotency — compress(compress(x)) vs compress(x)', () => {
    const idempotent = [
      '',
      '   \n\n\t  ',
      'hello world',
      'a\n\n\nb',
      'a    b',
      'a\na\nb',
      'a\na\nb\nc\nc\nd',
      'a\nb\na\nb',
      'Result done. hope this helps',
      'a\r\na\r\nb',
      'let me know if you need anything else.',
    ];

    for (const input of idempotent) {
      it(`is idempotent for ${JSON.stringify(input)}`, () => {
        const once = compressMemoryContent(input);
        expect(compressMemoryContent(once)).toBe(once);
      });
    }

    // NOTE(characterization): compressMemoryContent is NOT idempotent in
    // general. The three cases below each need a second pass to reach a fixed
    // point, and one of them changes MEANING between passes (the whole content
    // disappears). Callers that compress a value twice — e.g. on write and
    // again on a later rewrite — will get different stored content.

    it('is NOT idempotent when two filler phrases are stacked (second pass empties it)', () => {
      const once = compressMemoryContent('hope this helps happy to help');
      expect(once).toBe('hope this helps');
      expect(compressMemoryContent(once)).toBe('');
    });

    it('is NOT idempotent when the filler strip leaves a now-unique duplicate line', () => {
      const once = compressMemoryContent('x\nhope this helps\nhope this helps');
      expect(once).toBe('x\nhope this helps');
      expect(compressMemoryContent(once)).toBe('x');
    });

    it('is NOT idempotent when line fusion manufactures a brand-new duplicate line', () => {
      const once = compressMemoryContent('a\na\nb\nab');
      expect(once).toBe('ab\nab');
      expect(compressMemoryContent(once)).toBe('ab');
    });

    it('is NOT idempotent when a blank-separated block dedups only after fusion', () => {
      const once = compressMemoryContent('a\na\n\na\na');
      expect(once).toBe('a\na');
      expect(compressMemoryContent(once)).toBe('a');
    });
  });
});
