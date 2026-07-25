/**
 * @module __tests__/file-lock-manager
 * Unit tests for FileLockManager — all-or-nothing lock acquisition, release,
 * serialization, and state inspection.
 */

import { describe, it, expect } from 'vitest';
import { FileLockManager } from '../file-lock-manager.js';

const TIMEOUT = 5000;

describe('FileLockManager — acquire', () => {
  it('acquires immediately for an empty file list without holding locks', async () => {
    const mgr = new FileLockManager();

    const r = await mgr.acquire('worker-A', [], TIMEOUT);
    expect(r.acquired).toBe(true);
    expect(mgr.lockedFileCount).toBe(0);
  });

  it('acquires free files', async () => {
    const mgr = new FileLockManager();

    const r = await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], TIMEOUT);
    expect(r.acquired).toBe(true);
    expect(mgr.lockedFileCount).toBe(2);
  });

  it('denies a conflicting acquire and reports the contested file and holder', async () => {
    const mgr = new FileLockManager();
    await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], TIMEOUT);

    const r = await mgr.acquire('worker-B', ['src/a.ts'], TIMEOUT);
    expect(r.acquired).toBe(false);
    expect(r.conflictingFiles).toContain('src/a.ts');
    expect(r.conflictingWorker).toBe('worker-A');
  });

  it('lets the same worker re-acquire its own lock', async () => {
    const mgr = new FileLockManager();
    await mgr.acquire('worker-A', ['src/a.ts'], TIMEOUT);

    const r = await mgr.acquire('worker-A', ['src/a.ts'], TIMEOUT);
    expect(r.acquired).toBe(true);
  });

  it('is all-or-nothing — a multi-file acquire grabs nothing if any file is locked', async () => {
    const mgr = new FileLockManager();
    await mgr.acquire('worker-A', ['src/a.ts'], TIMEOUT);
    await mgr.acquire('worker-B', ['src/b.ts'], TIMEOUT);

    const r = await mgr.acquire('worker-C', ['src/a.ts', 'src/b.ts', 'src/c.ts'], TIMEOUT);
    expect(r.acquired).toBe(false);
    expect(mgr.lockedFileCount).toBe(2);
  });
});

describe('FileLockManager — release', () => {
  it('clears every lock held by the releasing worker', async () => {
    const mgr = new FileLockManager();
    await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], TIMEOUT);

    mgr.release('worker-A');
    expect(mgr.lockedFileCount).toBe(0);
  });

  it("leaves other workers' locks intact and frees the released file", async () => {
    const mgr = new FileLockManager();
    await mgr.acquire('worker-A', ['src/a.ts'], TIMEOUT);
    await mgr.acquire('worker-B', ['src/b.ts'], TIMEOUT);

    mgr.release('worker-A');
    expect(mgr.lockedFileCount).toBe(1);

    const r = await mgr.acquire('worker-C', ['src/a.ts'], TIMEOUT);
    expect(r.acquired).toBe(true);
  });

  it('is a safe no-op when the worker holds nothing, and on double release', async () => {
    const mgr = new FileLockManager();

    mgr.release('worker-X');
    expect(mgr.lockedFileCount).toBe(0);

    await mgr.acquire('worker-A', ['src/a.ts'], TIMEOUT);
    mgr.release('worker-A');
    mgr.release('worker-A');
    expect(mgr.lockedFileCount).toBe(0);
  });
});

describe('FileLockManager — canAcquire', () => {
  it('reflects lock state for empty, free, locked, and mixed file sets', async () => {
    const mgr = new FileLockManager();

    expect(mgr.canAcquire([])).toBe(true);
    expect(mgr.canAcquire(['src/a.ts'])).toBe(true);

    await mgr.acquire('worker-A', ['src/a.ts'], TIMEOUT);
    expect(mgr.canAcquire(['src/a.ts'])).toBe(false);
    expect(mgr.canAcquire(['src/b.ts'])).toBe(true);
    expect(mgr.canAcquire(['src/b.ts', 'src/a.ts'])).toBe(false);

    mgr.release('worker-A');
    expect(mgr.canAcquire(['src/a.ts'])).toBe(true);
  });
});

describe('FileLockManager — getState', () => {
  it('reports one entry per locked file with its holder and acquisition time', async () => {
    const mgr = new FileLockManager();
    await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], TIMEOUT);
    await mgr.acquire('worker-B', ['src/c.ts'], TIMEOUT);

    const state = mgr.getState();
    expect(state.size).toBe(3);
    expect(state.get('src/a.ts')?.holder).toBe('worker-A');
    expect(state.get('src/b.ts')?.holder).toBe('worker-A');
    expect(state.get('src/c.ts')?.holder).toBe('worker-B');
    expect(typeof state.get('src/a.ts')?.acquiredAt).toBe('string');
  });
});

describe('FileLockManager — serialize/restore', () => {
  it('serializes locks grouped by worker', async () => {
    const mgr = new FileLockManager();
    await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], TIMEOUT);
    await mgr.acquire('worker-B', ['src/c.ts'], TIMEOUT);

    const snap = mgr.serialize();
    expect(snap).toHaveProperty('worker-A');
    expect(snap).toHaveProperty('worker-B');
    expect(snap['worker-A'].files).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
    expect(snap['worker-B'].files).toEqual(['src/c.ts']);
  });

  it('restores locks into a fresh manager and keeps blocking other workers', async () => {
    const mgr = new FileLockManager();
    await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], TIMEOUT);
    await mgr.acquire('worker-B', ['src/c.ts'], TIMEOUT);

    const mgr2 = new FileLockManager();
    mgr2.restore(mgr.serialize());

    expect(mgr2.lockedFileCount).toBe(3);
    expect(mgr2.getState().get('src/a.ts')?.holder).toBe('worker-A');
    expect(mgr2.getState().get('src/c.ts')?.holder).toBe('worker-B');

    const r = await mgr2.acquire('worker-C', ['src/a.ts'], TIMEOUT);
    expect(r.acquired).toBe(false);
  });
});

describe('FileLockManager — releaseAll', () => {
  it('clears every lock and frees the files', async () => {
    const mgr = new FileLockManager();
    await mgr.acquire('worker-A', ['src/a.ts'], TIMEOUT);
    await mgr.acquire('worker-B', ['src/b.ts', 'src/c.ts'], TIMEOUT);

    mgr.releaseAll();
    expect(mgr.lockedFileCount).toBe(0);

    const r = await mgr.acquire('worker-C', ['src/a.ts', 'src/b.ts', 'src/c.ts'], TIMEOUT);
    expect(r.acquired).toBe(true);
  });

  it('is safe on an empty manager', () => {
    const mgr = new FileLockManager();
    mgr.releaseAll();
    expect(mgr.lockedFileCount).toBe(0);
  });
});

describe('FileLockManager — lockedFileCount and activeWorkers', () => {
  it('tracks counts as workers acquire and release', async () => {
    const mgr = new FileLockManager();
    expect(mgr.lockedFileCount).toBe(0);
    expect(mgr.activeWorkers.size).toBe(0);

    await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], TIMEOUT);
    expect(mgr.lockedFileCount).toBe(2);
    expect(mgr.activeWorkers.size).toBe(1);
    expect(mgr.activeWorkers.has('worker-A')).toBe(true);

    await mgr.acquire('worker-B', ['src/c.ts'], TIMEOUT);
    expect(mgr.lockedFileCount).toBe(3);
    expect(mgr.activeWorkers.size).toBe(2);

    mgr.release('worker-A');
    expect(mgr.lockedFileCount).toBe(1);
    expect(mgr.activeWorkers.size).toBe(1);
    expect(mgr.activeWorkers.has('worker-A')).toBe(false);
  });
});

describe('FileLockManager — sequential handoff', () => {
  it('blocks a second worker until the holder releases, then transfers the lock', async () => {
    const mgr = new FileLockManager();
    await mgr.acquire('worker-A', ['shared/utils.ts'], TIMEOUT);

    expect((await mgr.acquire('worker-B', ['shared/utils.ts'], TIMEOUT)).acquired).toBe(false);

    mgr.release('worker-A');

    expect((await mgr.acquire('worker-B', ['shared/utils.ts'], TIMEOUT)).acquired).toBe(true);
    expect(mgr.lockedFileCount).toBe(1);
    expect(mgr.getState().get('shared/utils.ts')?.holder).toBe('worker-B');
  });
});
