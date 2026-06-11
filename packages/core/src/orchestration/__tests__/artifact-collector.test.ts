/**
 * @module orchestration/__tests__/artifact-collector
 *
 * Task #237 — focused unit tests for the ArtifactCollector collaborator
 * extracted from `executor.ts`. Covers run-dir resolution (runsDir vs legacy
 * output path), the empty-dir text-fallback writer, and the recursive
 * untracked-file scanner.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { ArtifactCollector, saveTextOutputIfEmpty, scanForUntrackedFiles } from '../artifact-collector.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'artifact-collector-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('ArtifactCollector run-dir resolution', () => {
  it('uses runsDir when configured, keyed by workflow id', () => {
    const c = new ArtifactCollector({ workspaceDir: '/ws', runsDir: '/runs', workflowId: 'wf1' });
    expect(c.getRunDir()).toBe('/runs/wf1');
    expect(c.getNodeOutputDir('nodeA')).toBe('/runs/wf1/nodeA');
  });

  it('falls back to the legacy {workspaceDir}/output path when runsDir is absent', () => {
    const c = new ArtifactCollector({ workspaceDir: '/ws', workflowId: 'wf2' });
    expect(c.getRunDir()).toBe('/ws/output/wf2');
    expect(c.getNodeOutputDir('n')).toBe('/ws/output/wf2/n');
  });
});

describe('saveTextOutputIfEmpty', () => {
  it('writes trimmed text into an existing empty directory and returns the path', () => {
    const p = saveTextOutputIfEmpty(dir, '  hello world  ');
    expect(p).toBe(join(dir, 'output.md'));
    expect(readFileSync(p!, 'utf-8')).toBe('hello world');
  });

  it('honours a custom filename', () => {
    const p = saveTextOutputIfEmpty(dir, 'x', 'summary.txt');
    expect(p).toBe(join(dir, 'summary.txt'));
  });

  it('returns null and writes nothing when the directory is non-empty', () => {
    writeFileSync(join(dir, 'existing.txt'), 'pre');
    expect(saveTextOutputIfEmpty(dir, 'new text')).toBeNull();
    expect(existsSync(join(dir, 'output.md'))).toBe(false);
  });

  it('returns null for a missing directory or blank text', () => {
    expect(saveTextOutputIfEmpty(join(dir, 'does-not-exist'), 'x')).toBeNull();
    expect(saveTextOutputIfEmpty(dir, '   ')).toBeNull();
    expect(saveTextOutputIfEmpty(dir, '')).toBeNull();
  });
});

describe('scanForUntrackedFiles', () => {
  it('returns files not present in knownPaths, recursing into subdirectories', () => {
    writeFileSync(join(dir, 'known.txt'), 'k');
    writeFileSync(join(dir, 'new.txt'), 'n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'deep.txt'), 'd');

    const found = scanForUntrackedFiles(dir, [resolvePath(join(dir, 'known.txt'))]);
    expect(found.sort()).toEqual([join(dir, 'new.txt'), join(dir, 'sub', 'deep.txt')].sort());
  });

  it('matches known paths by both resolved and raw form', () => {
    writeFileSync(join(dir, 'a.txt'), 'a');
    // Pass the raw (unresolved) path — should still be excluded.
    expect(scanForUntrackedFiles(dir, [join(dir, 'a.txt')])).toEqual([]);
  });

  it('returns [] for a missing directory', () => {
    expect(scanForUntrackedFiles(join(dir, 'nope'), [])).toEqual([]);
  });
});
