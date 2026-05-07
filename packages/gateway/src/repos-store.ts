/**
 * @module repos-store
 *
 * Persistent JSON-backed store for the Git tab.
 *
 * Stores two kinds of state, both at `~/.orionomega/repos.json`:
 *
 *   1. `knownRepos` — the union of all repositories the user has added via
 *      the Git tab across every session. Each entry carries `remoteUrl`,
 *      a friendly label, the default branch, and (once cloned) the
 *      session-clone local path. Listed in the Git tab's "Add existing"
 *      dropdown so a user doesn't have to re-paste the URL on every
 *      session.
 *
 *   2. `sessionRepos` — `{ [sessionId]: SelectedRepo | null }`, the repo
 *      currently selected for each gateway session. The coding-dispatch
 *      pipeline reads this on every code-mode message so the Git tab's
 *      selection is the single source of truth (no more
 *      "Could not resolve a git remote" failures for sessions whose user
 *      already picked a repo in the UI).
 *
 * Writes are debounced (200 ms) to coalesce rapid Add/Select clicks. The
 * file is written atomically via rename-from-tmp.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@orionomega/core';

const log = createLogger('repos-store');

const STORE_DIR = join(homedir(), '.orionomega');
const STORE_PATH = join(STORE_DIR, 'repos.json');
const WRITE_DEBOUNCE_MS = 200;
// Defense-in-depth: even though routes/git.ts already validates session and
// repo ids before any store call, re-validate at the persistence boundary so
// a future caller (or test) can't pollute the JSON with traversal-y keys.
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/** A repository the user has registered for use across sessions. */
export interface KnownRepo {
  /** Stable identifier — derived from the remote URL on first add. */
  id: string;
  /** Human-friendly label shown in the Git tab. Defaults to the repo name. */
  label: string;
  /** Full clone URL (HTTPS or SSH). */
  remoteUrl: string;
  /** Default branch name (e.g. `main`). */
  defaultBranch: string;
  /** Absolute path to the session-shared local clone. Allocated on first selection. */
  localPath?: string;
  /** ISO timestamp when this repo was registered. */
  addedAt: string;
}

/**
 * Snapshot of a repo selection bound to a specific gateway session. Cached
 * inline so the dispatch path can read it synchronously without joining
 * across two structures.
 */
export interface SelectedRepo {
  /** ID of the matching {@link KnownRepo}. */
  repoId: string;
  /** Full clone URL (HTTPS or SSH). */
  remoteUrl: string;
  /** Branch the session is working against. */
  branch: string;
  /** Absolute path to the session-shared local clone. */
  localPath: string;
  /** ISO timestamp when this selection was last updated. */
  selectedAt: string;
}

interface ReposFile {
  version: 1;
  knownRepos: KnownRepo[];
  sessionRepos: Record<string, SelectedRepo | null>;
}

const EMPTY_FILE: ReposFile = { version: 1, knownRepos: [], sessionRepos: {} };

/**
 * Persistent store for repo metadata + per-session selections.
 *
 * Single instance per gateway process. Loaded synchronously at startup so
 * downstream callers can read selections without an awaitable boot phase.
 */
export class ReposStore {
  private state: ReposFile = { ...EMPTY_FILE };
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(STORE_PATH)) return;
      const raw = readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ReposFile>;
      this.state = {
        version: 1,
        knownRepos: Array.isArray(parsed.knownRepos) ? parsed.knownRepos : [],
        sessionRepos: parsed.sessionRepos && typeof parsed.sessionRepos === 'object'
          ? parsed.sessionRepos
          : {},
      };
      log.info('ReposStore loaded', {
        path: STORE_PATH,
        knownCount: this.state.knownRepos.length,
        sessionCount: Object.keys(this.state.sessionRepos).length,
      });
    } catch (err) {
      log.warn('ReposStore load failed (starting empty)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private schedulePersist(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persistSync();
    }, WRITE_DEBOUNCE_MS);
  }

  /** Force an immediate write (used during shutdown). */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.persistSync();
  }

  private persistSync(): void {
    try {
      if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
      const tmp = `${STORE_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf-8', mode: 0o600 });
      renameSync(tmp, STORE_PATH);
    } catch (err) {
      log.error('ReposStore persist failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Known repo CRUD ─────────────────────────────────────────────

  listKnownRepos(): KnownRepo[] {
    return [...this.state.knownRepos];
  }

  getKnownRepo(id: string): KnownRepo | undefined {
    return this.state.knownRepos.find((r) => r.id === id);
  }

  /**
   * Add a repo to the known list, or return the existing entry when an
   * entry with the same `remoteUrl` already exists. Idempotent: callers
   * can safely call this on every Add click without worrying about dupes.
   */
  upsertKnownRepo(input: { remoteUrl: string; label?: string; defaultBranch?: string }): KnownRepo {
    const existing = this.state.knownRepos.find((r) => r.remoteUrl === input.remoteUrl);
    if (existing) {
      if (input.label && input.label !== existing.label) existing.label = input.label;
      if (input.defaultBranch && input.defaultBranch !== existing.defaultBranch) {
        existing.defaultBranch = input.defaultBranch;
      }
      this.schedulePersist();
      return existing;
    }
    const id = `repo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const repoName = input.remoteUrl
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .pop() || 'repo';
    const repo: KnownRepo = {
      id,
      label: input.label?.trim() || repoName,
      remoteUrl: input.remoteUrl,
      defaultBranch: input.defaultBranch?.trim() || 'main',
      addedAt: new Date().toISOString(),
    };
    this.state.knownRepos.push(repo);
    this.schedulePersist();
    return repo;
  }

  /** Update mutable fields on a known repo. Returns the updated record or undefined. */
  updateKnownRepo(id: string, patch: Partial<Pick<KnownRepo, 'label' | 'defaultBranch' | 'localPath'>>): KnownRepo | undefined {
    const repo = this.state.knownRepos.find((r) => r.id === id);
    if (!repo) return undefined;
    if (patch.label !== undefined) repo.label = patch.label;
    if (patch.defaultBranch !== undefined) repo.defaultBranch = patch.defaultBranch;
    if (patch.localPath !== undefined) repo.localPath = patch.localPath;
    this.schedulePersist();
    return repo;
  }

  /** Remove a known repo and clear any session selections that referenced it. */
  removeKnownRepo(id: string): boolean {
    if (!SAFE_ID_RE.test(id)) return false;
    const before = this.state.knownRepos.length;
    this.state.knownRepos = this.state.knownRepos.filter((r) => r.id !== id);
    if (this.state.knownRepos.length === before) return false;
    for (const [sid, sel] of Object.entries(this.state.sessionRepos)) {
      if (sel && sel.repoId === id) this.state.sessionRepos[sid] = null;
    }
    this.schedulePersist();
    return true;
  }

  // ── Session selection ──────────────────────────────────────────

  getSessionRepo(sessionId: string): SelectedRepo | null {
    if (!SAFE_ID_RE.test(sessionId)) return null;
    return this.state.sessionRepos[sessionId] ?? null;
  }

  setSessionRepo(sessionId: string, selection: SelectedRepo | null): void {
    if (!SAFE_ID_RE.test(sessionId)) {
      log.warn('Rejected setSessionRepo: invalid sessionId', { sessionId });
      return;
    }
    if (selection && !SAFE_ID_RE.test(selection.repoId)) {
      log.warn('Rejected setSessionRepo: invalid repoId', { repoId: selection.repoId });
      return;
    }
    this.state.sessionRepos[sessionId] = selection;
    this.schedulePersist();
  }
}

/** Singleton accessor — kept lazy so tests can swap the constructor. */
let _instance: ReposStore | null = null;
export function getReposStore(): ReposStore {
  if (!_instance) _instance = new ReposStore();
  return _instance;
}
