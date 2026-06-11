import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  isPathInside,
  resolveContainedPath,
  realpathContainedPath,
  resolveContainedPathInRoots,
} from './path-containment.js';

describe('isPathInside', () => {
  it('treats the root itself as inside', () => {
    expect(isPathInside('/workspace', '/workspace')).toBe(true);
  });

  it('accepts descendants', () => {
    expect(isPathInside('/workspace', '/workspace/sub/file.txt')).toBe(true);
  });

  it('rejects sibling prefixes (no trailing-separator false positive)', () => {
    expect(isPathInside('/workspace', '/workspace-evil/file.txt')).toBe(false);
  });

  it('rejects ancestors', () => {
    expect(isPathInside('/workspace', '/etc/passwd')).toBe(false);
  });
});

describe('resolveContainedPath', () => {
  const root = '/workspace';

  it('resolves a relative path under the root', () => {
    expect(resolveContainedPath(root, 'docs/spec.md')).toBe(resolve(root, 'docs/spec.md'));
  });

  it('rejects traversal escapes', () => {
    expect(resolveContainedPath(root, '../../etc/passwd')).toBeNull();
  });

  it('rejects absolute paths outside the root', () => {
    expect(resolveContainedPath(root, '/etc/passwd')).toBeNull();
  });

  it('accepts absolute paths inside the root', () => {
    expect(resolveContainedPath(root, '/workspace/a/b')).toBe(resolve('/workspace/a/b'));
  });
});

describe('resolveContainedPathInRoots', () => {
  it('returns the first root that contains the target', () => {
    const got = resolveContainedPathInRoots(['/checkout', '/workspace'], 'file.txt');
    expect(got).toBe(resolve('/checkout', 'file.txt'));
  });

  it('returns null when no root contains the target', () => {
    expect(resolveContainedPathInRoots(['/a', '/b'], '../../../etc/passwd')).toBeNull();
  });
});

describe('realpathContainedPath (symlink-aware)', () => {
  let dir: string;
  let root: string;
  let outside: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pc-test-'));
    root = join(dir, 'root');
    outside = join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(root, 'inside.txt'), 'ok');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    // Symlink inside the root pointing OUT of it.
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a real file inside the root', () => {
    const got = realpathContainedPath(root, 'inside.txt');
    expect(got).not.toBeNull();
    expect(got!.endsWith('inside.txt')).toBe(true);
  });

  it('rejects a symlink that escapes the root', () => {
    expect(realpathContainedPath(root, 'escape.txt')).toBeNull();
  });

  it('returns null for a non-existent path', () => {
    expect(realpathContainedPath(root, 'nope.txt')).toBeNull();
  });
});
