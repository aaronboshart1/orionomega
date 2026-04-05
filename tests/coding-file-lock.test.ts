/**
 * Unit tests for FileLockManager.
 *
 * Tests all-or-nothing lock acquisition, release, serialization,
 * and state inspection methods.
 */

import {
  suite, section, assert, assertEq, assertDeepEq, printSummary,
} from './test-harness.js';
import { FileLockManager } from '../packages/core/src/orchestration/coding/file-lock-manager.js';

suite('FileLockManager Unit Tests');

// ── Section 1: Basic acquire ──────────────────────────────────────────────────

section('1. acquire() — basic cases');

{
  const mgr = new FileLockManager();

  const r1 = await mgr.acquire('worker-A', [], 5000);
  assertEq(r1.acquired, true, '1.1 empty file list → acquired immediately');
  assertEq(mgr.lockedFileCount, 0, '1.1 empty acquire does not hold locks');
}

{
  const mgr = new FileLockManager();

  const r1 = await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], 5000);
  assertEq(r1.acquired, true, '1.2 first acquire on free files → success');
  assertEq(mgr.lockedFileCount, 2, '1.2 two files locked after acquire');
}

{
  const mgr = new FileLockManager();
  await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], 5000);

  const r2 = await mgr.acquire('worker-B', ['src/a.ts'], 5000);
  assertEq(r2.acquired, false, '1.3 conflicting acquire → denied');
  assert(
    Array.isArray(r2.conflictingFiles) && r2.conflictingFiles.includes('src/a.ts'),
    '1.3 conflictingFiles contains the contested file',
  );
  assertEq(r2.conflictingWorker, 'worker-A', '1.3 conflictingWorker identifies holder');
}

{
  const mgr = new FileLockManager();
  await mgr.acquire('worker-A', ['src/a.ts'], 5000);

  // Same worker acquires again (re-entrant) — should succeed
  const r2 = await mgr.acquire('worker-A', ['src/a.ts'], 5000);
  assertEq(r2.acquired, true, '1.4 same worker re-acquiring own lock → success');
}

{
  const mgr = new FileLockManager();
  await mgr.acquire('worker-A', ['src/a.ts'], 5000);
  await mgr.acquire('worker-B', ['src/b.ts'], 5000);

  // Worker-C wants both — src/a.ts and src/b.ts are both locked
  const r3 = await mgr.acquire('worker-C', ['src/a.ts', 'src/b.ts', 'src/c.ts'], 5000);
  assertEq(r3.acquired, false, '1.5 multi-file acquire fails if any file is locked');
  assertEq(mgr.lockedFileCount, 2, '1.5 worker-C acquired no locks (all-or-nothing)');
}

// ── Section 2: release() ──────────────────────────────────────────────────────

section('2. release()');

{
  const mgr = new FileLockManager();
  await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], 5000);

  mgr.release('worker-A');
  assertEq(mgr.lockedFileCount, 0, '2.1 release clears all held locks');
}

{
  const mgr = new FileLockManager();
  await mgr.acquire('worker-A', ['src/a.ts'], 5000);
  await mgr.acquire('worker-B', ['src/b.ts'], 5000);

  mgr.release('worker-A');
  assertEq(mgr.lockedFileCount, 1, '2.2 selective release leaves other workers\' locks');

  // Now worker-C can acquire src/a.ts
  const r = await mgr.acquire('worker-C', ['src/a.ts'], 5000);
  assertEq(r.acquired, true, '2.2 file available after holder releases');
}

{
  const mgr = new FileLockManager();
  // release with no held locks is a no-op
  mgr.release('worker-X');
  assertEq(mgr.lockedFileCount, 0, '2.3 release with no locks is a no-op');

  // Double-release is also safe
  await mgr.acquire('worker-A', ['src/a.ts'], 5000);
  mgr.release('worker-A');
  mgr.release('worker-A');  // second release should not throw
  assertEq(mgr.lockedFileCount, 0, '2.3 double release is safe');
}

// ── Section 3: canAcquire() ───────────────────────────────────────────────────

section('3. canAcquire()');

{
  const mgr = new FileLockManager();

  assert(mgr.canAcquire([]), '3.1 empty file list → canAcquire true');
  assert(mgr.canAcquire(['src/a.ts']), '3.2 unlocked file → canAcquire true');

  await mgr.acquire('worker-A', ['src/a.ts'], 5000);
  assert(!mgr.canAcquire(['src/a.ts']), '3.3 locked file → canAcquire false');
  assert(mgr.canAcquire(['src/b.ts']), '3.4 different file still canAcquire true');
  assert(!mgr.canAcquire(['src/b.ts', 'src/a.ts']), '3.5 mixed → canAcquire false');

  mgr.release('worker-A');
  assert(mgr.canAcquire(['src/a.ts']), '3.6 canAcquire true after release');
}

// ── Section 4: getState() ─────────────────────────────────────────────────────

section('4. getState()');

{
  const mgr = new FileLockManager();
  await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], 5000);
  await mgr.acquire('worker-B', ['src/c.ts'], 5000);

  const state = mgr.getState();
  assertEq(state.size, 3, '4.1 getState has entry for each locked file');
  assertEq(state.get('src/a.ts')?.holder, 'worker-A', '4.1 correct holder for a.ts');
  assertEq(state.get('src/b.ts')?.holder, 'worker-A', '4.1 correct holder for b.ts');
  assertEq(state.get('src/c.ts')?.holder, 'worker-B', '4.1 correct holder for c.ts');
  assert(typeof state.get('src/a.ts')?.acquiredAt === 'string', '4.1 acquiredAt is a string');
}

// ── Section 5: serialize() / restore() ───────────────────────────────────────

section('5. serialize() / restore()');

{
  const mgr = new FileLockManager();
  await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], 5000);
  await mgr.acquire('worker-B', ['src/c.ts'], 5000);

  const snap = mgr.serialize();

  // Check serialized shape
  assert('worker-A' in snap, '5.1 serialize includes worker-A key');
  assert('worker-B' in snap, '5.1 serialize includes worker-B key');
  assert(
    snap['worker-A'].files.includes('src/a.ts') &&
    snap['worker-A'].files.includes('src/b.ts'),
    '5.1 worker-A files contain a.ts and b.ts',
  );
  assertEq(snap['worker-B'].files.length, 1, '5.1 worker-B has exactly 1 file');
  assertEq(snap['worker-B'].files[0], 'src/c.ts', '5.1 worker-B file is c.ts');

  // Restore into a new manager
  const mgr2 = new FileLockManager();
  mgr2.restore(snap);

  assertEq(mgr2.lockedFileCount, 3, '5.2 restored manager has 3 locked files');
  const restored = mgr2.getState();
  assertEq(restored.get('src/a.ts')?.holder, 'worker-A', '5.2 restored a.ts holder');
  assertEq(restored.get('src/c.ts')?.holder, 'worker-B', '5.2 restored c.ts holder');

  // New worker should not be able to acquire locked files
  const r = await mgr2.acquire('worker-C', ['src/a.ts'], 5000);
  assertEq(r.acquired, false, '5.2 restored locks block other workers');
}

// ── Section 6: releaseAll() ───────────────────────────────────────────────────

section('6. releaseAll()');

{
  const mgr = new FileLockManager();
  await mgr.acquire('worker-A', ['src/a.ts'], 5000);
  await mgr.acquire('worker-B', ['src/b.ts', 'src/c.ts'], 5000);

  mgr.releaseAll();
  assertEq(mgr.lockedFileCount, 0, '6.1 releaseAll clears all locks');

  const r = await mgr.acquire('worker-C', ['src/a.ts', 'src/b.ts', 'src/c.ts'], 5000);
  assertEq(r.acquired, true, '6.1 files available after releaseAll');
}

{
  const mgr = new FileLockManager();
  // releaseAll on empty state is a no-op
  mgr.releaseAll();
  assertEq(mgr.lockedFileCount, 0, '6.2 releaseAll on empty is safe');
}

// ── Section 7: Computed properties ────────────────────────────────────────────

section('7. lockedFileCount and activeWorkers');

{
  const mgr = new FileLockManager();
  assertEq(mgr.lockedFileCount, 0, '7.1 initial lockedFileCount is 0');
  assertEq(mgr.activeWorkers.size, 0, '7.1 initial activeWorkers is empty');

  await mgr.acquire('worker-A', ['src/a.ts', 'src/b.ts'], 5000);
  assertEq(mgr.lockedFileCount, 2, '7.2 lockedFileCount after single worker = 2');
  assertEq(mgr.activeWorkers.size, 1, '7.2 activeWorkers = 1 after single worker');
  assert(mgr.activeWorkers.has('worker-A'), '7.2 activeWorkers contains worker-A');

  await mgr.acquire('worker-B', ['src/c.ts'], 5000);
  assertEq(mgr.lockedFileCount, 3, '7.3 lockedFileCount after two workers = 3');
  assertEq(mgr.activeWorkers.size, 2, '7.3 activeWorkers = 2 after two workers');

  mgr.release('worker-A');
  assertEq(mgr.lockedFileCount, 1, '7.4 lockedFileCount after worker-A release = 1');
  assertEq(mgr.activeWorkers.size, 1, '7.4 activeWorkers = 1 after worker-A release');
  assert(!mgr.activeWorkers.has('worker-A'), '7.4 worker-A not in activeWorkers after release');
}

// ── Section 8: Concurrent acquire ordering ────────────────────────────────────

section('8. Sequential acquire after release');

{
  const mgr = new FileLockManager();

  // Simulate two workers sequentially:
  // worker-A acquires, then releases; worker-B then acquires the same files
  await mgr.acquire('worker-A', ['shared/utils.ts'], 5000);

  let r = await mgr.acquire('worker-B', ['shared/utils.ts'], 5000);
  assertEq(r.acquired, false, '8.1 worker-B blocked while worker-A holds lock');

  mgr.release('worker-A');

  r = await mgr.acquire('worker-B', ['shared/utils.ts'], 5000);
  assertEq(r.acquired, true, '8.1 worker-B acquires after worker-A releases');
  assertEq(mgr.lockedFileCount, 1, '8.1 one file locked by worker-B');
  assertEq(mgr.getState().get('shared/utils.ts')?.holder, 'worker-B', '8.1 holder is now worker-B');
}

// ── Summary ───────────────────────────────────────────────────────────────────

const ok = printSummary('FileLockManager');
if (!ok) process.exit(1);
