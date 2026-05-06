/**
 * Shared multi-account helpers for the google-workspace skill.
 *
 * Account model (lives inside `<skillsDir>/google-workspace/config.json`
 * under `fields.accounts`):
 *
 *   {
 *     id: string,                   // stable slug (e.g. "default", "work")
 *     label: string,                // human-friendly name shown in UI
 *     port: number,                 // workspace-mcp listener port (basePort + slot)
 *     GOOGLE_OAUTH_CLIENT_ID: string,
 *     GOOGLE_OAUTH_CLIENT_SECRET: string,
 *     GOOGLE_OAUTH_REDIRECT_URI: string,
 *     USER_GOOGLE_EMAIL: string,
 *     createdAt: string,
 *   }
 *
 * The active account id is stored at `fields.activeAccountId`.
 *
 * On first read, legacy single-account configs (top-level
 * GOOGLE_OAUTH_CLIENT_ID/etc.) are migrated into a synthetic "default"
 * account so existing setups keep working without manual intervention.
 *
 * Per-account credentials live at:
 *   <wmRoot>/<accountId>/.google_workspace_mcp/credentials/<email>.json
 * where <wmRoot> is set via the spawned process's HOME (workspace-mcp
 * always reads its credentials from `~/.google_workspace_mcp`).
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_BASE_PORT = 9877;
export const VALID_ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export function getBasePort() {
  const raw = process.env.GOOGLE_WORKSPACE_MCP_BASE_PORT;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 && n < 65535 ? n : DEFAULT_BASE_PORT;
}

export function getSkillsDir() {
  return process.env.ORIONOMEGA_SKILLS_DIR
    || join(homedir(), '.orionomega', 'skills');
}

export function getConfigPath(skillsDir = getSkillsDir()) {
  return join(skillsDir, 'google-workspace', 'config.json');
}

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

function emptyConfig() {
  return {
    name: 'google-workspace',
    enabled: true,
    configured: false,
    fields: {},
  };
}

function readRawConfig(skillsDir) {
  const p = getConfigPath(skillsDir);
  if (!existsSync(p)) return emptyConfig();
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return {
      name: parsed.name ?? 'google-workspace',
      enabled: parsed.enabled ?? true,
      configured: parsed.configured ?? false,
      fields: parsed.fields ?? {},
      authMethod: parsed.authMethod,
      configuredAt: parsed.configuredAt,
    };
  } catch {
    return emptyConfig();
  }
}

function writeRawConfig(skillsDir, config) {
  const dir = join(skillsDir, 'google-workspace');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Build an in-memory accounts map from raw config, performing a one-shot
 * migration of legacy top-level OAuth fields into a synthetic "default"
 * account when the config has none.
 *
 * Returns the (possibly modified) raw config plus a normalized
 * `accounts` array sorted by creation order, so callers can rely on
 * stable ordering for port assignment.
 */
export function loadAccountsState(skillsDir = getSkillsDir()) {
  const raw = readRawConfig(skillsDir);
  const fields = raw.fields ?? {};
  let accounts = fields.accounts && typeof fields.accounts === 'object' ? { ...fields.accounts } : null;
  let activeAccountId = typeof fields.activeAccountId === 'string' ? fields.activeAccountId : null;
  let migrated = false;

  if (!accounts || Object.keys(accounts).length === 0) {
    accounts = {};
    const legacyClientId = fields.GOOGLE_OAUTH_CLIENT_ID;
    const legacyClientSecret = fields.GOOGLE_OAUTH_CLIENT_SECRET;
    const legacyEmail = fields.USER_GOOGLE_EMAIL;
    const legacyRedirect = fields.GOOGLE_OAUTH_REDIRECT_URI;
    if (legacyClientId || legacyClientSecret || legacyEmail) {
      accounts.default = {
        id: 'default',
        label: 'Default',
        port: getBasePort(),
        GOOGLE_OAUTH_CLIENT_ID: legacyClientId || '',
        GOOGLE_OAUTH_CLIENT_SECRET: legacyClientSecret || '',
        GOOGLE_OAUTH_REDIRECT_URI: legacyRedirect || `http://localhost:${getBasePort()}`,
        USER_GOOGLE_EMAIL: legacyEmail || '',
        createdAt: new Date().toISOString(),
      };
      activeAccountId = 'default';
      migrated = true;
    }
  }

  if (activeAccountId && !accounts[activeAccountId]) {
    activeAccountId = null;
  }
  if (!activeAccountId) {
    const ids = Object.keys(accounts);
    if (ids.length > 0) activeAccountId = ids[0];
  }

  // Persist migration so subsequent reads are consistent.
  if (migrated) {
    raw.fields = { ...fields, accounts, activeAccountId };
    try { writeRawConfig(skillsDir, raw); } catch {}
  }

  return { raw, accounts, activeAccountId };
}

export function listAccounts(skillsDir = getSkillsDir()) {
  const { accounts, activeAccountId } = loadAccountsState(skillsDir);
  const out = Object.values(accounts)
    .map((a) => ({ ...a }))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return { accounts: out, activeAccountId };
}

export function getAccount(skillsDir, accountId) {
  const { accounts } = loadAccountsState(skillsDir);
  if (!accountId) return null;
  return accounts[accountId] || null;
}

export function getActiveAccount(skillsDir = getSkillsDir()) {
  const { accounts, activeAccountId } = loadAccountsState(skillsDir);
  if (!activeAccountId) return null;
  return accounts[activeAccountId] || null;
}

/**
 * Acquire an exclusive file-based lock to serialize read-modify-write of
 * config.json across the gateway and concurrently-spawned hooks. Uses
 * `O_EXCL` create on a sidecar `.lock` file with bounded retries +
 * stale-lock fallback (lock files older than 10s are reclaimed).
 */
function acquireConfigLock(skillsDir, timeoutMs = 5000) {
  const dir = join(skillsDir, 'google-workspace');
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, 'config.json.lock');
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      return () => { try { closeSync(fd); } catch {} try { unlinkSync(lockPath); } catch {} };
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
      // Stale lock detection: if older than 10s, force-reclaim.
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > 10_000) { try { unlinkSync(lockPath); } catch {} continue; }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        throw new Error('Could not acquire config.json lock (timeout)');
      }
      // Tight busy-wait is fine here — contention is rare and short-lived.
      const end = Date.now() + 25;
      while (Date.now() < end) { /* spin */ }
    }
  }
}

/** Mutate accounts (mutator receives accounts map) and persist atomically. */
function withAccounts(skillsDir, mutator) {
  const release = acquireConfigLock(skillsDir);
  try {
    const { raw, accounts, activeAccountId } = loadAccountsState(skillsDir);
    const next = { ...accounts };
    let nextActive = activeAccountId;
    const result = mutator(next, (id) => { nextActive = id; });
    raw.fields = { ...(raw.fields || {}), accounts: next, activeAccountId: nextActive };
    raw.configured = Object.values(next).some(
      (a) => a.GOOGLE_OAUTH_CLIENT_ID && a.GOOGLE_OAUTH_CLIENT_SECRET,
    );
    raw.configuredAt = new Date().toISOString();
    writeRawConfig(skillsDir, raw);
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
    const account = {
      id: finalId,
      label: String(label || finalId).slice(0, 64),
      port,
      GOOGLE_OAUTH_CLIENT_ID: String(fields.GOOGLE_OAUTH_CLIENT_ID || ''),
      GOOGLE_OAUTH_CLIENT_SECRET: String(fields.GOOGLE_OAUTH_CLIENT_SECRET || ''),
      GOOGLE_OAUTH_REDIRECT_URI: String(fields.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${port}`),
      USER_GOOGLE_EMAIL: String(fields.USER_GOOGLE_EMAIL || ''),
      createdAt: new Date().toISOString(),
    };
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
  return withAccounts(skillsDir, (accounts, setActive) => {
    if (!accounts[accountId]) throw new Error(`Account "${accountId}" not found`);
    delete accounts[accountId];
    const remaining = Object.keys(accounts);
    setActive(remaining[0] || null);
    return { ok: true, activeAccountId: remaining[0] || null };
  });
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
 *  3. activeAccountId from config
 */
export function resolveAccount(skillsDir = getSkillsDir(), explicitId = null) {
  const { accounts, activeAccountId } = loadAccountsState(skillsDir);
  const id = explicitId || process.env.GOOGLE_WORKSPACE_ACCOUNT_ID || activeAccountId;
  if (!id) return null;
  return accounts[id] || null;
}
