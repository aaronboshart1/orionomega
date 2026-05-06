/**
 * Shared multi-account helpers for the google-workspace skill.
 *
 * On-disk layout (under `<skillsDir>/google-workspace/`):
 *
 *   config.json                 # only shared fields (Programmable Search keys, PSE)
 *   accounts/
 *     index.json                # { version: 1, activeAccountId: string|null }
 *     <accountId>.json          # one file per account, full record:
 *                               # { id, label, port, GOOGLE_OAUTH_CLIENT_ID,
 *                               #   GOOGLE_OAUTH_CLIENT_SECRET,
 *                               #   GOOGLE_OAUTH_REDIRECT_URI,
 *                               #   USER_GOOGLE_EMAIL, createdAt }
 *
 * Migration: on first read, if `accounts/` is empty we look at the legacy
 * `config.json` shapes and migrate:
 *   - embedded `fields.accounts` map (interim shape) → split out into files
 *   - top-level single-account fields (oldest shape) → one "default" account
 * After migration, embedded account fields are removed from `config.json`
 * so the per-file layout is the single source of truth.
 *
 * Per-account workspace-mcp credentials live at:
 *   ~/.google_workspace_mcp_accounts/<accountId>/.google_workspace_mcp/credentials/<email>.json
 * (We override `HOME` for the spawned `workspace-mcp` so its hardcoded
 * `~/.google_workspace_mcp/...` path is per-account.)
 */

import {
  readFileSync, existsSync, mkdirSync, writeFileSync, openSync, closeSync,
  unlinkSync, statSync, readdirSync, renameSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_BASE_PORT = 9877;
export const VALID_ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const INDEX_VERSION = 1;

export function getBasePort() {
  const raw = process.env.GOOGLE_WORKSPACE_MCP_BASE_PORT;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 && n < 65535 ? n : DEFAULT_BASE_PORT;
}

export function getSkillsDir() {
  return process.env.ORIONOMEGA_SKILLS_DIR
    || join(homedir(), '.orionomega', 'skills');
}

export function getSkillRoot(skillsDir = getSkillsDir()) {
  return join(skillsDir, 'google-workspace');
}

export function getConfigPath(skillsDir = getSkillsDir()) {
  return join(getSkillRoot(skillsDir), 'config.json');
}

export function getAccountsDir(skillsDir = getSkillsDir()) {
  return join(getSkillRoot(skillsDir), 'accounts');
}

function getIndexPath(skillsDir) { return join(getAccountsDir(skillsDir), 'index.json'); }
function getAccountFilePath(skillsDir, id) { return join(getAccountsDir(skillsDir), `${id}.json`); }

/** Root directory under which each account gets an isolated $HOME. */
export function getAccountsRoot() {
  return join(homedir(), '.google_workspace_mcp_accounts');
}
/** Per-account isolated $HOME (so workspace-mcp's `~/.google_workspace_mcp/...` is unique). */
export function getAccountHome(accountId) {
  return join(getAccountsRoot(), accountId);
}
/** Per-account credentials directory (where workspace-mcp writes `<email>.json`). */
export function getAccountCredentialsDir(accountId) {
  return join(getAccountHome(accountId), '.google_workspace_mcp', 'credentials');
}
/** Per-account state file storing the running OAuth server PID + port. */
export function getAccountStateFile(accountId) {
  return join(getAccountHome(accountId), '.oauth_server_pid');
}
/** Per-account log file for the workspace-mcp child process. */
export function getAccountLogFile(accountId) {
  return join(getAccountHome(accountId), 'oauth-server.log');
}

function safeReadJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  renameSync(tmp, path);
}

function readConfigJson(skillsDir) {
  const p = getConfigPath(skillsDir);
  const parsed = safeReadJson(p);
  if (!parsed) return { name: 'google-workspace', enabled: true, configured: false, fields: {} };
  return {
    name: parsed.name ?? 'google-workspace',
    enabled: parsed.enabled ?? true,
    configured: parsed.configured ?? false,
    fields: parsed.fields ?? {},
    authMethod: parsed.authMethod,
    configuredAt: parsed.configuredAt,
  };
}

function writeConfigJson(skillsDir, config) {
  mkdirSync(getSkillRoot(skillsDir), { recursive: true });
  writeJsonAtomic(getConfigPath(skillsDir), config);
}

function readIndex(skillsDir) {
  const idx = safeReadJson(getIndexPath(skillsDir));
  if (idx && typeof idx === 'object') {
    return {
      version: idx.version ?? INDEX_VERSION,
      activeAccountId: typeof idx.activeAccountId === 'string' ? idx.activeAccountId : null,
    };
  }
  return { version: INDEX_VERSION, activeAccountId: null };
}

function writeIndex(skillsDir, activeAccountId) {
  mkdirSync(getAccountsDir(skillsDir), { recursive: true });
  writeJsonAtomic(getIndexPath(skillsDir), { version: INDEX_VERSION, activeAccountId });
}

function readAccountFiles(skillsDir) {
  const dir = getAccountsDir(skillsDir);
  if (!existsSync(dir)) return {};
  const out = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name === 'index.json') continue;
    const id = name.slice(0, -5);
    if (!VALID_ACCOUNT_ID.test(id)) continue;
    const a = safeReadJson(join(dir, name));
    if (a && typeof a === 'object' && a.id === id) out[id] = a;
  }
  return out;
}

function writeAccountFile(skillsDir, account) {
  mkdirSync(getAccountsDir(skillsDir), { recursive: true });
  writeJsonAtomic(getAccountFilePath(skillsDir, account.id), account);
}

function deleteAccountFile(skillsDir, id) {
  const p = getAccountFilePath(skillsDir, id);
  try { unlinkSync(p); } catch {}
}

/** Remove per-account fields that should never live at the top of config.json. */
function stripAccountFields(fields) {
  const out = { ...(fields || {}) };
  for (const k of [
    'accounts',
    'activeAccountId',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REDIRECT_URI',
    'USER_GOOGLE_EMAIL',
  ]) delete out[k];
  return out;
}

function buildAccountRecord({ id, label, port, fields = {}, createdAt }) {
  return {
    id,
    label: String(label || id).slice(0, 64),
    port,
    GOOGLE_OAUTH_CLIENT_ID: String(fields.GOOGLE_OAUTH_CLIENT_ID || ''),
    GOOGLE_OAUTH_CLIENT_SECRET: String(fields.GOOGLE_OAUTH_CLIENT_SECRET || ''),
    GOOGLE_OAUTH_REDIRECT_URI: String(fields.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${port}`),
    USER_GOOGLE_EMAIL: String(fields.USER_GOOGLE_EMAIL || ''),
    createdAt: createdAt || new Date().toISOString(),
  };
}

/**
 * One-shot migration from legacy `config.json` shapes into the per-file
 * layout. Idempotent: a no-op once `accounts/` has at least one record.
 * Returns true if anything was migrated.
 */
function migrateLegacyIfNeeded(skillsDir) {
  const existing = readAccountFiles(skillsDir);
  if (Object.keys(existing).length > 0) return false;

  const cfg = readConfigJson(skillsDir);
  const f = cfg.fields || {};
  let migrated = false;
  let activeId = null;

  // Shape A: interim `fields.accounts` map written by an earlier version
  // of this task. Split each into its own file.
  if (f.accounts && typeof f.accounts === 'object' && Object.keys(f.accounts).length > 0) {
    for (const [id, a] of Object.entries(f.accounts)) {
      if (!VALID_ACCOUNT_ID.test(id)) continue;
      const port = Number.isFinite(a.port) ? a.port : getBasePort();
      writeAccountFile(skillsDir, buildAccountRecord({
        id,
        label: a.label,
        port,
        fields: a,
        createdAt: a.createdAt,
      }));
      migrated = true;
    }
    activeId = typeof f.activeAccountId === 'string' && f.accounts[f.activeAccountId]
      ? f.activeAccountId
      : Object.keys(f.accounts)[0] || null;
  } else if (f.GOOGLE_OAUTH_CLIENT_ID || f.GOOGLE_OAUTH_CLIENT_SECRET || f.USER_GOOGLE_EMAIL) {
    // Shape B: original single-account top-level fields. Wrap as "default".
    const port = getBasePort();
    writeAccountFile(skillsDir, buildAccountRecord({
      id: 'default',
      label: 'Default',
      port,
      fields: f,
    }));
    activeId = 'default';
    migrated = true;
  }

  if (migrated) {
    writeIndex(skillsDir, activeId);
    // Strip migrated fields from config.json so the per-file layout is
    // the single source of truth. Shared PSE keys stay.
    cfg.fields = stripAccountFields(f);
    writeConfigJson(skillsDir, cfg);
  }
  return migrated;
}

/**
 * Acquire an exclusive file-based lock (O_EXCL) to serialize all
 * account-mutating operations across the gateway and concurrently
 * spawned hooks. Stale locks (>10s old) are reclaimed.
 */
function acquireAccountsLock(skillsDir, timeoutMs = 5000) {
  mkdirSync(getAccountsDir(skillsDir), { recursive: true });
  const lockPath = join(getAccountsDir(skillsDir), '.lock');
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      return () => { try { closeSync(fd); } catch {} try { unlinkSync(lockPath); } catch {} };
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > 10_000) { try { unlinkSync(lockPath); } catch {} continue; }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        throw new Error('Could not acquire accounts lock (timeout)');
      }
      const end = Date.now() + 25;
      while (Date.now() < end) { /* spin */ }
    }
  }
}

export function loadAccountsState(skillsDir = getSkillsDir()) {
  migrateLegacyIfNeeded(skillsDir);
  const accounts = readAccountFiles(skillsDir);
  const idx = readIndex(skillsDir);
  let activeAccountId = idx.activeAccountId;
  if (activeAccountId && !accounts[activeAccountId]) activeAccountId = null;
  if (!activeAccountId) {
    const ids = Object.keys(accounts);
    if (ids.length > 0) activeAccountId = ids[0];
  }
  return { accounts, activeAccountId };
}

export function listAccounts(skillsDir = getSkillsDir()) {
  const { accounts, activeAccountId } = loadAccountsState(skillsDir);
  const out = Object.values(accounts)
    .map((a) => ({ ...a }))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return { accounts: out, activeAccountId };
}

export function getAccount(skillsDir, accountId) {
  if (!accountId) return null;
  const { accounts } = loadAccountsState(skillsDir);
  return accounts[accountId] || null;
}

export function getActiveAccount(skillsDir = getSkillsDir()) {
  const { accounts, activeAccountId } = loadAccountsState(skillsDir);
  if (!activeAccountId) return null;
  return accounts[activeAccountId] || null;
}

/** Mutate accounts under the lock and persist as files + index. */
function withAccounts(skillsDir, mutator) {
  const release = acquireAccountsLock(skillsDir);
  try {
    const { accounts, activeAccountId } = loadAccountsState(skillsDir);
    const next = { ...accounts };
    let nextActive = activeAccountId;
    let toDelete = [];
    const result = mutator(next, (id) => { nextActive = id; }, (id) => { toDelete.push(id); });
    // Persist any added/updated account files.
    for (const a of Object.values(next)) writeAccountFile(skillsDir, a);
    // Remove deleted ones from disk.
    for (const id of toDelete) deleteAccountFile(skillsDir, id);
    // Persist index.
    if (nextActive && !next[nextActive]) nextActive = Object.keys(next)[0] || null;
    writeIndex(skillsDir, nextActive);
    // Reflect aggregate "configured" flag in config.json (shared metadata)
    // and strip any leftover embedded account fields from earlier shapes.
    try {
      const cfg = readConfigJson(skillsDir);
      cfg.fields = stripAccountFields(cfg.fields);
      cfg.configured = Object.values(next).some(
        (a) => a.GOOGLE_OAUTH_CLIENT_ID && a.GOOGLE_OAUTH_CLIENT_SECRET,
      );
      cfg.configuredAt = new Date().toISOString();
      writeConfigJson(skillsDir, cfg);
    } catch {}
    return result;
  } finally {
    release();
  }
}

function nextFreePort(accounts) {
  const base = getBasePort();
  const used = new Set(Object.values(accounts).map((a) => a.port).filter((p) => Number.isFinite(p)));
  let p = base;
  while (used.has(p)) p++;
  return p;
}

function slugify(input, fallback = 'account') {
  const s = String(input || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

export function createAccount(skillsDir, { id, label, fields = {} } = {}) {
  return withAccounts(skillsDir, (accounts, setActive) => {
    let baseId = id ? slugify(id) : slugify(label || 'account');
    if (!VALID_ACCOUNT_ID.test(baseId)) baseId = 'account';
    let finalId = baseId;
    let n = 2;
    while (accounts[finalId]) finalId = `${baseId}-${n++}`;
    const port = nextFreePort(accounts);
    const account = buildAccountRecord({ id: finalId, label, port, fields });
    accounts[finalId] = account;
    if (Object.keys(accounts).length === 1) setActive(finalId);
    return account;
  });
}

export function updateAccount(skillsDir, accountId, patch) {
  return withAccounts(skillsDir, (accounts) => {
    const existing = accounts[accountId];
    if (!existing) throw new Error(`Account "${accountId}" not found`);
    const allowed = ['label', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI', 'USER_GOOGLE_EMAIL'];
    const next = { ...existing };
    for (const k of allowed) {
      if (patch[k] !== undefined) next[k] = String(patch[k]);
    }
    accounts[accountId] = next;
    return next;
  });
}

export function deleteAccount(skillsDir, accountId) {
  const result = withAccounts(skillsDir, (accounts, setActive, markDelete) => {
    if (!accounts[accountId]) throw new Error(`Account "${accountId}" not found`);
    delete accounts[accountId];
    markDelete(accountId);
    const remaining = Object.keys(accounts);
    setActive(remaining[0] || null);
    return { ok: true, activeAccountId: remaining[0] || null };
  });
  // Best-effort terminate any still-running per-account workspace-mcp
  // OAuth listener so deleting an account doesn't leave an orphan
  // server bound to its loopback port. The PID was persisted to the
  // account state file by oauth-start.js when it spawned the child.
  try {
    const stateFile = getAccountStateFile(accountId);
    if (existsSync(stateFile)) {
      const pid = parseInt(readFileSync(stateFile, 'utf-8').trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
  } catch {}
  // Securely scrub the per-account isolated $HOME so OAuth tokens, the
  // workspace-mcp credentials directory, and the per-account log/state
  // files do not linger after deletion (and cannot be reused if the
  // same account id is recreated later).
  try {
    const home = getAccountHome(accountId);
    rmSync(home, { recursive: true, force: true });
  } catch {}
  return result;
}

export function setActiveAccount(skillsDir, accountId) {
  return withAccounts(skillsDir, (accounts, setActive) => {
    if (!accounts[accountId]) throw new Error(`Account "${accountId}" not found`);
    setActive(accountId);
    return { ok: true, activeAccountId: accountId };
  });
}

/**
 * Resolve the account to use for a hook invocation.
 *  1. explicit `accountId` arg (e.g. from CLI flag)
 *  2. GOOGLE_WORKSPACE_ACCOUNT_ID env (set by the gateway)
 *  3. activeAccountId from index
 */
export function resolveAccount(skillsDir = getSkillsDir(), explicitId = null) {
  const { accounts, activeAccountId } = loadAccountsState(skillsDir);
  const id = explicitId || process.env.GOOGLE_WORKSPACE_ACCOUNT_ID || activeAccountId;
  if (!id) return null;
  return accounts[id] || null;
}
