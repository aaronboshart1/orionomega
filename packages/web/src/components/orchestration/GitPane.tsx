'use client';

/**
 * @module GitPane
 *
 * Git tab for the orchestration pane (Task #196).
 *
 * Lets the user:
 *   - Add a repo (URL or `owner/repo` slug) to a known-repos registry.
 *   - Pick which known repo the current session operates against.
 *   - Trigger a fetch + fast-forward of the session's persistent clone.
 *
 * The selection is the single source of truth the gateway reads on every
 * code-mode message — no more "Could not resolve a git remote" failures
 * when a repo has been picked here.
 */

import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Plus, Trash2, RefreshCw, Check, AlertCircle, Loader2, Folder } from 'lucide-react';
import { useConnectionStore } from '@/stores/connection';

interface KnownRepo {
  id: string;
  label: string;
  remoteUrl: string;
  defaultBranch: string;
  localPath?: string;
  addedAt: string;
}

interface SelectedRepo {
  repoId: string;
  remoteUrl: string;
  branch: string;
  localPath: string;
  selectedAt: string;
}

interface RepoStatus {
  branch: string;
  remoteUrl: string | null;
  isClean: boolean;
  stagedFiles: string[];
  modifiedFiles: string[];
  untrackedFiles: string[];
  commitsAhead: number;
  commitsBehind: number;
  lastCommit?: { sha: string; shortSha: string; subject: string; author: string; date: string } | null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!res.ok) {
    const err = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(err);
  }
  return body as T;
}

export function GitPane() {
  const sessionId = useConnectionStore((s) => s.sessionId);

  const [repos, setRepos] = useState<KnownRepo[]>([]);
  const [selection, setSelection] = useState<SelectedRepo | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [newUrl, setNewUrl] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newBranch, setNewBranch] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api<{ repos: KnownRepo[] }>('/api/git/repos');
      setRepos(list.repos);
      if (sessionId) {
        const sel = await api<{ selection: SelectedRepo | null; status: RepoStatus | null }>(`/api/git/sessions/${encodeURIComponent(sessionId)}/repo`);
        setSelection(sel.selection);
        setStatus(sel.status ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const handleAdd = async () => {
    if (!newUrl.trim()) return;
    setBusy('add');
    setError(null);
    try {
      const body: Record<string, string> = { remoteUrl: newUrl.trim() };
      if (newLabel.trim()) body.label = newLabel.trim();
      if (newBranch.trim()) body.defaultBranch = newBranch.trim();
      await api('/api/git/repos', { method: 'POST', body: JSON.stringify(body) });
      setNewUrl(''); setNewLabel(''); setNewBranch('');
      await loadAll();
      setInfo('Repository added.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add repo');
    } finally {
      setBusy(null);
    }
  };

  const handleSelect = async (repoId: string, branch?: string) => {
    if (!sessionId) { setError('No active session'); return; }
    setBusy(`select:${repoId}`);
    setError(null);
    try {
      const body: Record<string, string> = { repoId };
      if (branch) body.branch = branch;
      const r = await api<{ selection: SelectedRepo }>(`/api/git/sessions/${encodeURIComponent(sessionId)}/repo`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setSelection(r.selection);
      setInfo('Selected for this session. Next code-mode message will use this repo.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select repo');
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async () => {
    if (!sessionId) return;
    setBusy('clear');
    setError(null);
    try {
      await api(`/api/git/sessions/${encodeURIComponent(sessionId)}/repo`, { method: 'DELETE' });
      setSelection(null);
      setStatus(null);
      setInfo('Selection cleared.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear');
    } finally {
      setBusy(null);
    }
  };

  const handleSync = async () => {
    if (!sessionId) return;
    setBusy('sync');
    setError(null);
    setInfo(null);
    try {
      const r = await api<{ result: { cloned: boolean; fetched: boolean; fastForwarded: boolean; headCommit: string | null }; status: RepoStatus | null }>(
        `/api/git/sessions/${encodeURIComponent(sessionId)}/repo/sync`,
        { method: 'POST' },
      );
      const head = r.result.headCommit ? r.result.headCommit.slice(0, 8) : 'unknown';
      const parts = [
        r.result.cloned ? 'cloned' : null,
        r.result.fetched ? 'fetched' : null,
        r.result.fastForwarded ? 'fast-forwarded' : null,
      ].filter(Boolean);
      setStatus(r.status ?? null);
      setInfo(`Synced (${parts.join(', ') || 'no changes'}). HEAD ${head}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (repoId: string) => {
    if (!confirm('Forget this repository? Sessions using it will lose their selection.')) return;
    setBusy(`del:${repoId}`);
    setError(null);
    try {
      await api(`/api/git/repos/${encodeURIComponent(repoId)}`, { method: 'DELETE' });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[var(--background)] text-zinc-300">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <GitBranch size={14} className="text-orange-400" />
          Git
        </div>
        <button
          type="button"
          onClick={() => void loadAll()}
          disabled={loading}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
          title="Reload"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Banner: current selection */}
        <div className="border-b border-zinc-800 bg-zinc-900/40 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-1">
            Active for this session
          </div>
          {selection ? (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-orange-300">{selection.remoteUrl}</div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                  <span>branch: <span className="text-zinc-300">{status?.branch || selection.branch}</span></span>
                  <span className="text-zinc-700">•</span>
                  <Folder size={10} />
                  <span className="truncate" title={selection.localPath}>{selection.localPath}</span>
                </div>
                {status && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
                    <span className={status.commitsAhead > 0 ? 'text-emerald-400' : 'text-zinc-600'}>
                      ↑ {status.commitsAhead} ahead
                    </span>
                    <span className={status.commitsBehind > 0 ? 'text-amber-400' : 'text-zinc-600'}>
                      ↓ {status.commitsBehind} behind
                    </span>
                    <span className={!status.isClean ? 'text-orange-400' : 'text-emerald-500'}>
                      {!status.isClean ? '● dirty' : '✓ clean'}
                    </span>
                  </div>
                )}
                {status?.lastCommit && (
                  <div className="mt-1 truncate text-[10px] text-zinc-600" title={`${status.lastCommit.sha} — ${status.lastCommit.author} @ ${status.lastCommit.date}`}>
                    <span className="font-mono text-zinc-500">{status.lastCommit.shortSha}</span>{' '}
                    <span className="text-zinc-400">{status.lastCommit.subject}</span>
                    {status.lastCommit.author && <span className="text-zinc-600"> · {status.lastCommit.author}</span>}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => void handleSync()}
                  disabled={busy === 'sync'}
                  className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                  title="Fetch + fast-forward the session clone now"
                >
                  {busy === 'sync' ? <Loader2 size={10} className="animate-spin" /> : 'Sync'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleClear()}
                  disabled={busy === 'clear'}
                  className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-50"
                >
                  Clear
                </button>
              </div>
            </div>
          ) : (
            <div className="text-xs text-zinc-500">
              No repository selected. Pick one below to use it for code-mode messages.
            </div>
          )}
        </div>

        {/* Add new */}
        <div className="border-b border-zinc-800 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-2">
            Add a repository
          </div>
          <div className="space-y-2">
            <input
              type="text"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://github.com/owner/repo.git  or  owner/repo"
              className="w-full rounded bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-orange-500/40"
            />
            <div className="flex gap-2">
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Label (optional)"
                className="flex-1 rounded bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-orange-500/40"
              />
              <input
                type="text"
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder="Branch (default: main)"
                className="w-40 rounded bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-orange-500/40"
              />
              <button
                type="button"
                onClick={() => void handleAdd()}
                disabled={!newUrl.trim() || busy === 'add'}
                className="flex items-center gap-1 rounded bg-orange-500/20 px-3 py-1.5 text-xs font-medium text-orange-300 ring-1 ring-orange-500/40 hover:bg-orange-500/30 disabled:opacity-50"
              >
                {busy === 'add' ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                Add
              </button>
            </div>
          </div>
        </div>

        {/* Status messages */}
        {(error || info) && (
          <div className="px-4 py-2">
            {error && (
              <div className="flex items-start gap-2 rounded bg-red-500/10 px-2 py-1.5 text-xs text-red-300 ring-1 ring-red-500/30">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {info && !error && (
              <div className="flex items-start gap-2 rounded bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-300 ring-1 ring-emerald-500/30">
                <Check size={12} className="mt-0.5 shrink-0" />
                <span>{info}</span>
              </div>
            )}
          </div>
        )}

        {/* Repo list */}
        <div className="px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-2">
            Known repositories ({repos.length})
          </div>
          {repos.length === 0 ? (
            <div className="rounded border border-dashed border-zinc-800 px-4 py-6 text-center text-xs text-zinc-600">
              No repositories yet. Add one above to get started.
            </div>
          ) : (
            <div className="space-y-1.5">
              {repos.map((r) => {
                const active = selection?.repoId === r.id;
                return (
                  <div
                    key={r.id}
                    className={`flex items-start justify-between gap-3 rounded border px-3 py-2 ${
                      active
                        ? 'border-orange-500/40 bg-orange-500/5'
                        : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-200">{r.label}</span>
                        {active && (
                          <span className="rounded bg-orange-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-orange-300 ring-1 ring-orange-500/40">
                            Active
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-zinc-500" title={r.remoteUrl}>
                        {r.remoteUrl}
                      </div>
                      <div className="mt-0.5 text-[10px] text-zinc-600">
                        branch: {r.defaultBranch}
                        {r.localPath && <> · clone: <span className="text-zinc-500" title={r.localPath}>{r.localPath.split('/').slice(-2).join('/')}</span></>}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {!active && (
                        <button
                          type="button"
                          onClick={() => void handleSelect(r.id)}
                          disabled={busy === `select:${r.id}` || !sessionId}
                          className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                          title={sessionId ? 'Use this repo for the current session' : 'No active session'}
                        >
                          {busy === `select:${r.id}` ? <Loader2 size={10} className="animate-spin" /> : 'Select'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDelete(r.id)}
                        disabled={busy === `del:${r.id}`}
                        className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50"
                        title="Forget repository"
                      >
                        {busy === `del:${r.id}` ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={12} />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-4 py-3 text-[10px] text-zinc-600">
          The selected repository is cloned once per session into{' '}
          <code className="text-zinc-500">&lt;workspace&gt;/repos/&lt;sessionId&gt;/&lt;repo&gt;</code> and
          re-used across every code-mode message — no more re-cloning per turn.
        </div>
      </div>
    </div>
  );
}
