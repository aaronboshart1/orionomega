/**
 * @module orchestration/coding/__tests__/remote-resolver
 *
 * Task #237 — focused unit tests for the remote-URL resolver split out of
 * `coding-orchestrator.ts`. `getRemoteUrl` and `existsSync` are mocked so the
 * priority order and error path are exercised without touching git or disk.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const existsSyncMock = vi.fn();
const getRemoteUrlMock = vi.fn();

vi.mock('node:fs', () => ({ existsSync: (p: string) => existsSyncMock(p) }));
vi.mock('../repo-manager.js', () => ({ getRemoteUrl: (...a: unknown[]) => getRemoteUrlMock(...a) }));

import { resolveCodingRemote, RemoteResolutionError } from '../remote-resolver.js';

beforeEach(() => {
  existsSyncMock.mockReset();
  getRemoteUrlMock.mockReset();
});

describe('resolveCodingRemote priority order', () => {
  it('1) prefers a normalized repoHint above everything else', async () => {
    const url = await resolveCodingRemote({
      repoHint: 'owner/repo',
      sourceRepoDir: '/src',
      defaultRemote: 'https://default.example/x.git',
      cwdForFallback: '/cwd',
    });
    expect(url).toBe('https://github.com/owner/repo.git');
    expect(getRemoteUrlMock).not.toHaveBeenCalled();
  });

  it('2) falls back to sourceRepoDir origin when no hint', async () => {
    existsSyncMock.mockReturnValue(true);
    getRemoteUrlMock.mockResolvedValueOnce('https://src.example/o/p.git');
    const url = await resolveCodingRemote({ sourceRepoDir: '/src', defaultRemote: 'https://default.example/x.git' });
    expect(url).toBe('https://src.example/o/p.git');
    expect(getRemoteUrlMock).toHaveBeenCalledWith('/src', 'origin');
  });

  it('3) uses defaultRemote when hint and sourceRepoDir miss', async () => {
    existsSyncMock.mockReturnValue(true);
    getRemoteUrlMock.mockResolvedValueOnce(null); // sourceRepoDir has no origin
    const url = await resolveCodingRemote({
      sourceRepoDir: '/src',
      defaultRemote: '  https://default.example/x.git  ',
    });
    expect(url).toBe('https://default.example/x.git');
  });

  it('4) finally tries cwdForFallback origin', async () => {
    existsSyncMock.mockReturnValue(true);
    getRemoteUrlMock.mockResolvedValueOnce('https://cwd.example/o/p.git');
    const url = await resolveCodingRemote({ cwdForFallback: '/cwd' });
    expect(url).toBe('https://cwd.example/o/p.git');
    expect(getRemoteUrlMock).toHaveBeenCalledWith('/cwd', 'origin');
  });

  it('skips sourceRepoDir when the directory does not exist', async () => {
    existsSyncMock.mockReturnValue(false);
    const url = await resolveCodingRemote({ sourceRepoDir: '/gone', defaultRemote: 'https://d.example/x.git' });
    expect(url).toBe('https://d.example/x.git');
    expect(getRemoteUrlMock).not.toHaveBeenCalled();
  });

  it('throws RemoteResolutionError naming every recovery option when all sources miss', async () => {
    existsSyncMock.mockReturnValue(false);
    await expect(resolveCodingRemote({})).rejects.toBeInstanceOf(RemoteResolutionError);
    await expect(resolveCodingRemote({})).rejects.toThrow(/repo:<https-or-ssh-url>/);
  });
});
