/**
 * @module utils/__tests__/install-dir
 *
 * Task #216 — verify the install-dir guard now also covers the live
 * OrionOmega monorepo source tree when running from a dev checkout.
 *
 * The test process IS running from the dev checkout (vitest forks under
 * `pnpm --filter @orionomega/core test`), so `getOrionOmegaSourceRoots()`
 * MUST resolve to a non-empty result and `detectInstallDirWrites` MUST
 * refuse a synthetic write at `<root>/packages/core/src/agent/foo.ts`.
 * Outside the monorepo, both helpers degrade to no-op.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import {
  getOrionOmegaSourceRoots,
  detectInstallDirWrites,
  _resetOrionOmegaSourceRootsCache,
} from '../install-dir.js';

describe('getOrionOmegaSourceRoots', () => {
  it('finds the live monorepo packages dir when running from a dev checkout', () => {
    _resetOrionOmegaSourceRootsCache();
    const roots = getOrionOmegaSourceRoots();
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) {
      expect(existsSync(r)).toBe(true);
      expect(existsSync(join(r, 'core'))).toBe(true); // packages/core
    }
  });

  it('caches results across calls', () => {
    _resetOrionOmegaSourceRootsCache();
    const a = getOrionOmegaSourceRoots();
    const b = getOrionOmegaSourceRoots();
    expect(b).toBe(a); // same array reference
  });
});

describe('detectInstallDirWrites — dev-checkout source-tree refusal (Task #216)', () => {
  it('refuses a write that lands inside packages/<pkg>/src of the running checkout', () => {
    _resetOrionOmegaSourceRootsCache();
    const roots = getOrionOmegaSourceRoots();
    expect(roots.length).toBeGreaterThan(0);
    const fakePath = resolvePath(roots[0]!, 'core', 'src', 'agent', 'fake-direct-mode-edit.ts');
    const offenders = detectInstallDirWrites([fakePath]);
    expect(offenders).toEqual([fakePath]);
  });

  it('allows a write that lands outside the OrionOmega tree (e.g. user repo checkout)', () => {
    _resetOrionOmegaSourceRootsCache();
    // Use /tmp/<rand>/README.md — guaranteed outside the dev checkout
    // and outside the install dir.
    const safePath = resolvePath('/tmp', 'orion216-test-' + Math.random().toString(36).slice(2), 'README.md');
    const offenders = detectInstallDirWrites([safePath]);
    expect(offenders).toEqual([]);
  });

  it('refuses an absolute path under ~/.orionomega/... regardless of dev checkout', () => {
    _resetOrionOmegaSourceRootsCache();
    const installPath = resolvePath(process.env.HOME ?? '/root', '.orionomega', 'src', 'leaked.txt');
    const offenders = detectInstallDirWrites([installPath]);
    expect(offenders).toEqual([installPath]);
  });
});
