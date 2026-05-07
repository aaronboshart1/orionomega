/**
 * @module routes/git
 *
 * REST endpoints behind the Git tab (Task #196).
 *
 *   GET    /api/git/repos                       — list known repos
 *   POST   /api/git/repos                       — register a repo (upsert by URL)
 *   PATCH  /api/git/repos/:id                   — rename / change default branch
 *   DELETE /api/git/repos/:id                   — forget a repo (clears any selections)
 *
 *   GET    /api/git/sessions/:sid/repo          — read this session's selection
 *   PUT    /api/git/sessions/:sid/repo          — pick a repo for this session
 *   DELETE /api/git/sessions/:sid/repo          — clear the selection
 *   POST   /api/git/sessions/:sid/repo/sync     — force a fetch+ff on the session clone
 *
 * All routes return JSON. Selection auto-allocates the local clone path
 * under `<workspaceDir>/repos/<sessionId>/<repoName>` and lazily clones on
 * first sync (or on the next code-mode message — whichever comes first).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve as resolvePath } from 'node:path';
import { ensureSessionClone, getRepoStatus, isValidGitRefName } from '@orionomega/core';
import type { RepoStatus } from '@orionomega/core';
import { getReposStore, type KnownRepo, type SelectedRepo } from '../repos-store.js';
import { createLogger } from '@orionomega/core';

const log = createLogger('routes/git');

const SESSION_ID_RE = /^[a-z0-9_-]{1,128}$/i;
const REPO_ID_RE = /^[a-z0-9_-]{1,128}$/i;
const REMOTE_URL_RE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/i;

function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function repoNameFromUrl(url: string): string {
  return url.replace(/\.git$/, '').split(/[/:]/).pop() || 'repo';
}

/** Default per-session clone path for a known repo. */
function defaultClonePath(workspaceDir: string, sessionId: string, repo: KnownRepo): string {
  return resolvePath(workspaceDir, 'repos', sessionId, repoNameFromUrl(repo.remoteUrl));
}

export interface GitRouteDeps {
  workspaceDir: string;
}

/**
 * Try to handle a Git-tab REST request. Returns `true` when the path /
 * method matched (and a response was written), `false` otherwise so the
 * caller can fall through to the next route.
 */
export async function handleGitRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  deps: GitRouteDeps,
): Promise<boolean> {
  if (!pathname.startsWith('/api/git/')) return false;
  const store = getReposStore();

  // ── Known repo CRUD ───────────────────────────────────────────────
  if (pathname === '/api/git/repos') {
    if (method === 'GET') {
      sendJson(res, 200, { repos: store.listKnownRepos() });
      return true;
    }
    if (method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { remoteUrl?: string; label?: string; defaultBranch?: string };
        if (!body.remoteUrl || typeof body.remoteUrl !== 'string') {
          sendErr(res, 400, 'remoteUrl is required');
          return true;
        }
        if (!REMOTE_URL_RE.test(body.remoteUrl) && !/^[\w.-]+\/[\w.-]+$/.test(body.remoteUrl)) {
          sendErr(res, 400, 'remoteUrl must be an https://, ssh://, git@, file://, or owner/repo URL');
          return true;
        }
        // Expand bare GitHub slugs.
        let url = body.remoteUrl.trim();
        if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}.git`;
        if (body.defaultBranch !== undefined && !isValidGitRefName(body.defaultBranch)) {
          sendErr(res, 400, 'defaultBranch must be a valid git ref name (letters, digits, _-./, no leading - or .)');
          return true;
        }
        const repo = store.upsertKnownRepo({
          remoteUrl: url,
          ...(body.label ? { label: body.label } : {}),
          ...(body.defaultBranch ? { defaultBranch: body.defaultBranch } : {}),
        });
        sendJson(res, 200, { repo });
      } catch (err) {
        sendErr(res, 400, err instanceof Error ? err.message : 'Invalid request');
      }
      return true;
    }
  }

  const repoIdMatch = pathname.match(/^\/api\/git\/repos\/([^/]+)$/);
  if (repoIdMatch) {
    const id = repoIdMatch[1]!;
    if (!REPO_ID_RE.test(id)) { sendErr(res, 400, 'Invalid repo id'); return true; }
    if (method === 'PATCH') {
      try {
        const body = (await readJsonBody(req)) as { label?: string; defaultBranch?: string };
        if (body.defaultBranch !== undefined && !isValidGitRefName(body.defaultBranch)) {
          sendErr(res, 400, 'defaultBranch must be a valid git ref name');
          return true;
        }
        const updated = store.updateKnownRepo(id, {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.defaultBranch !== undefined ? { defaultBranch: body.defaultBranch } : {}),
        });
        if (!updated) { sendErr(res, 404, 'Repo not found'); return true; }
        sendJson(res, 200, { repo: updated });
      } catch (err) {
        sendErr(res, 400, err instanceof Error ? err.message : 'Invalid request');
      }
      return true;
    }
    if (method === 'DELETE') {
      const ok = store.removeKnownRepo(id);
      if (!ok) { sendErr(res, 404, 'Repo not found'); return true; }
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  // ── Session selection ─────────────────────────────────────────────
  const sessionRepoMatch = pathname.match(/^\/api\/git\/sessions\/([^/]+)\/repo$/);
  if (sessionRepoMatch) {
    const sid = sessionRepoMatch[1]!;
    if (!SESSION_ID_RE.test(sid)) { sendErr(res, 400, 'Invalid session id'); return true; }
    if (method === 'GET') {
      const sel = store.getSessionRepo(sid);
      let status: RepoStatus | null = null;
      if (sel) {
        try { status = await getRepoStatus(sel.localPath); }
        catch (err) { log.warn('Repo status read failed', { sid, error: err instanceof Error ? err.message : String(err) }); }
      }
      sendJson(res, 200, { selection: sel, status });
      return true;
    }
    if (method === 'PUT') {
      try {
        const body = (await readJsonBody(req)) as { repoId?: string; branch?: string };
        if (!body.repoId) { sendErr(res, 400, 'repoId is required'); return true; }
        const repo = store.getKnownRepo(body.repoId);
        if (!repo) { sendErr(res, 404, 'Repo not found'); return true; }
        const branch = (body.branch || repo.defaultBranch || 'main').trim();
        if (!isValidGitRefName(branch)) {
          sendErr(res, 400, 'branch must be a valid git ref name (letters, digits, _-./, no leading - or .)');
          return true;
        }
        // Always allocate a per-session clone path. Sharing one localPath
        // across sessions defeats session isolation (parallel coding agents
        // in different sessions would collide on the working tree).
        const localPath = defaultClonePath(deps.workspaceDir, sid, repo);
        const selection: SelectedRepo = {
          repoId: repo.id,
          remoteUrl: repo.remoteUrl,
          branch,
          localPath,
          selectedAt: new Date().toISOString(),
        };
        store.setSessionRepo(sid, selection);
        sendJson(res, 200, { selection });
      } catch (err) {
        sendErr(res, 400, err instanceof Error ? err.message : 'Invalid request');
      }
      return true;
    }
    if (method === 'DELETE') {
      store.setSessionRepo(sid, null);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  const syncMatch = pathname.match(/^\/api\/git\/sessions\/([^/]+)\/repo\/sync$/);
  if (syncMatch && method === 'POST') {
    const sid = syncMatch[1]!;
    if (!SESSION_ID_RE.test(sid)) { sendErr(res, 400, 'Invalid session id'); return true; }
    const sel = store.getSessionRepo(sid);
    if (!sel) { sendErr(res, 404, 'No repo selected for this session'); return true; }
    try {
      const result = await ensureSessionClone(sel.remoteUrl, sel.localPath, sel.branch);
      let status: RepoStatus | null = null;
      try { status = await getRepoStatus(sel.localPath); }
      catch (err) { log.warn('Repo status read failed', { sid, error: err instanceof Error ? err.message : String(err) }); }
      sendJson(res, 200, { result, status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Session repo sync failed', { sid, error: msg });
      sendErr(res, 500, msg);
    }
    return true;
  }

  return false;
}
