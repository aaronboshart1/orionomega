/**
 * @module agent/__tests__/spec-bare-filename
 *
 * Task #174 — Regression: bare-filename spec references resolve under
 * the cwd / sandbox roots. Covers the explicit acceptance bullet
 * "bare filename that resolves under cwd" — e.g. `SPEC` (shouty) or
 * `` `plan` `` (backticked) → resolved to `<root>/SPEC.md` /
 * `<root>/plan.md` by appending `.md`, `.txt`, `.spec` in priority
 * order. Non-existent bare candidates are silently dropped (best-effort
 * loading), and bare references aliasing an extension-bearing
 * reference don't double-load the same file.
 */

import { describe, it, expect } from 'vitest';
import {
  extractBareFilenameReferences,
  loadSpecReferences,
} from '../spec-loader.js';

describe('extractBareFilenameReferences', () => {
  it('captures shouty all-caps tokens like SPEC, README, DESIGN', () => {
    const refs = extractBareFilenameReferences('Implement the feature described in SPEC and follow README.');
    expect(refs).toContain('SPEC');
    expect(refs).toContain('README');
  });

  it('captures backtick / quoted tokens like `plan` or "design"', () => {
    const refs = extractBareFilenameReferences('Implement per `plan` and follow "design".');
    expect(refs).toContain('plan');
    expect(refs).toContain('design');
  });

  it('skips tokens that already carry .md / .txt / .spec', () => {
    const refs = extractBareFilenameReferences('See `notes.md` and `bug.spec`.');
    expect(refs).not.toContain('notes.md');
    expect(refs).not.toContain('bug.spec');
  });
});

describe('loadSpecReferences (bare-filename branch)', () => {
  it('resolves a bare SPEC token to <root>/SPEC.md', () => {
    const fakeFs: Record<string, string> = {
      '/cwd/SPEC.md': '# Spec\n\n## Phase 1\nA\n## Phase 2\nB\n## Phase 3\nC\n',
    };
    const refs = loadSpecReferences({
      task: 'Implement everything in SPEC.',
      roots: ['/cwd'],
      readFile: (p) => {
        if (fakeFs[p]) return fakeFs[p];
        throw new Error('ENOENT: ' + p);
      },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0].reference).toBe('SPEC');
    expect(refs[0].resolvedPath).toBe('/cwd/SPEC.md');
    expect(refs[0].phases).toHaveLength(3);
  });

  it('falls back to .txt then .spec when .md does not exist', () => {
    const fakeFs: Record<string, string> = {
      '/cwd/plan.spec': '## Phase 1\na\n## Phase 2\nb\n## Phase 3\nc\n',
    };
    const refs = loadSpecReferences({
      task: 'Follow `plan`.',
      roots: ['/cwd'],
      readFile: (p) => {
        if (fakeFs[p]) return fakeFs[p];
        throw new Error('ENOENT: ' + p);
      },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0].resolvedPath).toBe('/cwd/plan.spec');
  });

  it('drops bare candidates that do not exist under any root', () => {
    const refs = loadSpecReferences({
      task: 'See SPEC for details.',
      roots: ['/cwd'],
      readFile: () => { throw new Error('ENOENT'); },
    });
    expect(refs).toEqual([]);
  });

  it('does not double-load when a bare ref aliases an extension-bearing ref', () => {
    const fakeFs: Record<string, string> = {
      '/cwd/SPEC.md': '## Phase 1\na\n## Phase 2\nb\n## Phase 3\nc\n',
    };
    const refs = loadSpecReferences({
      task: 'See SPEC.md and SPEC for details.',
      roots: ['/cwd'],
      readFile: (p) => {
        if (fakeFs[p]) return fakeFs[p];
        throw new Error('ENOENT');
      },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0].resolvedPath).toBe('/cwd/SPEC.md');
  });

  it('still rejects path traversal in bare candidates (sandbox guard)', () => {
    const refs = loadSpecReferences({
      task: 'See `../etc/passwd`.',
      roots: ['/cwd'],
      readFile: () => { throw new Error('should not be reached'); },
    });
    expect(refs).toEqual([]);
  });
});
