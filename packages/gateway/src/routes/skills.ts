import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import {
  SkillLoader,
  readSkillConfig,
  writeSkillConfig,
  getSettingsSchema,
  validateSettings,
  resolveSettings,
  maskSecrets,
} from '@orionomega/skills-sdk';
import type { SkillManifest } from '@orionomega/skills-sdk';
import type { SkillConfig, SkillSettingSchema } from '@orionomega/skills-sdk';
import { SkillSettingType } from '@orionomega/skills-sdk';
import { readConfig, createLogger } from '@orionomega/core';
import type { GatewayConfig } from '../types.js';
import { readBody } from './utils.js';
import { checkAuth } from './auth-utils.js';

const log = createLogger('routes/skills');

const MASK_SENTINEL = '[REDACTED]';

function getDefaultSkillsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = join(thisFile, '..', '..', '..', '..', '..');
  return join(repoRoot, 'default-skills');
}

function getConfiguredSkillsDir(): string {
  try {
    const cfg = readConfig();
    const dir = cfg.skills?.directory;
    if (dir) return dir;
  } catch (err) {
    log.warn('Failed to read skills directory from config', { error: err instanceof Error ? err.message : String(err) });
  }
  return join(getDefaultSkillsDir(), '..', '.orionomega', 'skills');
}

async function loadFromDir(
  dir: string,
  seen: Set<string>,
  manifests: SkillManifest[],
  allowOverride: boolean,
): Promise<void> {
  if (!existsSync(dir)) return;
  try {
    const loader = new SkillLoader(dir);
    for (const m of await loader.discoverAll()) {
      if (!seen.has(m.name)) {
        seen.add(m.name);
        manifests.push(m);
      } else if (allowOverride) {
        const idx = manifests.findIndex((existing) => existing.name === m.name);
        if (idx !== -1) manifests[idx] = m;
      }
    }
  } catch (err) {
    log.warn('Failed to load skills from directory', { dir, error: err instanceof Error ? err.message : String(err) });
  }
}

async function discoverAllSkills(): Promise<{ manifests: SkillManifest[]; configDir: string }> {
  const seen = new Set<string>();
  const manifests: SkillManifest[] = [];
  const configDir = getConfiguredSkillsDir();

  await loadFromDir(getDefaultSkillsDir(), seen, manifests, false);
  await loadFromDir(configDir, seen, manifests, true);

  return { manifests, configDir };
}

/**
 * Resolve a hook script for a skill, honoring the user's override directory
 * first and falling back to the shipped default-skills location. Returns the
 * absolute script path along with the directory the skill was resolved from
 * (the parent of `<skillName>/`), so handlers can pass it to child processes.
 */
function resolveSkillHook(
  skillName: string,
  relativeScript: string,
): { scriptPath: string; skillRoot: string } | null {
  const candidates = [getConfiguredSkillsDir(), getDefaultSkillsDir()];
  for (const root of candidates) {
    const p = join(root, skillName, relativeScript);
    if (existsSync(p)) return { scriptPath: p, skillRoot: root };
  }
  return null;
}

function isSecretField(prop: SkillSettingSchema): boolean {
  const types = Array.isArray(prop.type) ? prop.type : [prop.type];
  return types.includes(SkillSettingType.Password) || prop.widget === 'secret';
}

export function handleGetSkills(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;

  discoverAllSkills().then(({ manifests, configDir }) => {
    const results = manifests.map((manifest) => {
      const config = readSkillConfig(configDir, manifest.name);
      const schema = getSettingsSchema(manifest);
      const resolved = resolveSettings(manifest, config.fields);
      const masked = maskSecrets(resolved, manifest);

      return {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        icon: manifest.icon,
        enabled: config.enabled,
        configured: config.configured,
        schema: schema ?? undefined,
        settings: masked,
      };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ skills: results }));
  }).catch((err: unknown) => {
    log.error('Failed to list skills', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  });
}

export async function handlePutSkillConfig(
  req: IncomingMessage,
  res: ServerResponse,
  skillName: string,
  gatewayConfig: GatewayConfig,
): Promise<void> {
  if (!checkAuth(req, res, gatewayConfig)) return;

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body) as Partial<SkillConfig> & {
      settings?: Record<string, unknown>;
      accountId?: string;
    };

    // Account-aware compatibility path: when callers PUT
    // /api/skills/google-workspace/config?accountId=… (or include
    // `accountId` in the body), forward per-account fields to the
    // multi-account CLI instead of writing them into the shared
    // config.json (where they no longer live).
    const accountId = extractAccountId(req, body) || payload.accountId || null;
    if (skillName === 'google-workspace' && accountId) {
      if (!VALID_ACCOUNT_ID.test(accountId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid accountId' }));
        return;
      }
      const fields = (payload.settings ?? {}) as Record<string, unknown>;
      // Strip masked secrets so we don't overwrite real values with mask sentinels.
      const cleanFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v === MASK_SENTINEL) continue;
        if (typeof v === 'string' && v.startsWith('••••')) continue;
        cleanFields[k] = v;
      }
      try {
        const data = spawnAccountsHelper<{ ok: boolean; account: { GOOGLE_OAUTH_CLIENT_SECRET?: string } }>(
          ['update', accountId],
          { stdin: JSON.stringify({ fields: cleanFields }) },
        );
        // Flatten + mask: legacy callers expect `{ ok, account }`, not
        // `{ ok, account: { ok, account } }`.
        const account = data && data.account ? maskAccountSecret(data.account) : data;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to update account' }));
      }
      return;
    }

    const configDir = getConfiguredSkillsDir();
    const existing = readSkillConfig(configDir, skillName);

    if (payload.enabled !== undefined) {
      existing.enabled = payload.enabled;
    }

    if (payload.settings) {
      const discovered = await discoverAllSkills();
      const manifest = discovered.manifests.find((m) => m.name === skillName);

      const schema = manifest ? getSettingsSchema(manifest) : null;

      if (!manifest) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Skill "${skillName}" not found` }));
        return;
      }

      const cleanSettings: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(payload.settings)) {
        if (value === MASK_SENTINEL) {
          continue;
        }

        if (schema?.properties[key] && isSecretField(schema.properties[key]) && typeof value === 'string' && value.startsWith('••••')) {
          continue;
        }

        cleanSettings[key] = value;
      }

      {
        const merged = { ...existing.fields, ...cleanSettings };
        const resolved = resolveSettings(manifest, merged);
        const validation = validateSettings(manifest, resolved);

        if (!validation.valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Settings validation failed',
            details: validation.errors,
          }));
          return;
        }
      }

      for (const [key, value] of Object.entries(cleanSettings)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          existing.fields[key] = value;
        }
      }

      existing.configured = true;
    }

    existing.configuredAt = new Date().toISOString();
    writeSkillConfig(configDir, skillName, existing);

    const safeConfig = {
      name: existing.name,
      enabled: existing.enabled,
      configured: existing.configured,
      configuredAt: existing.configuredAt,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, config: safeConfig }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update skill config';
    log.error('Failed to update skill config', { skillName, error: message });
    const status = message.includes('exceeds limit') ? 413 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 413 ? 'Request body too large' : 'Failed to update skill configuration' }));
  }
}

/**
 * Read an optional `accountId` from either the URL query string or the
 * JSON body. The body wins when both are present.
 */
function extractAccountId(req: IncomingMessage, body?: string): string | null {
  try {
    const u = new URL(req.url || '', 'http://localhost');
    const fromQuery = u.searchParams.get('accountId');
    if (body) {
      try {
        const parsed = JSON.parse(body) as { accountId?: string };
        if (typeof parsed.accountId === 'string' && parsed.accountId) return parsed.accountId;
      } catch {}
    }
    return fromQuery && fromQuery.length > 0 ? fromQuery : null;
  } catch {
    return null;
  }
}

const VALID_ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function spawnAccountsHelper<T = unknown>(
  args: string[],
  options: { stdin?: string } = {},
): T {
  // Inline node script that exposes the _accounts.js helpers via argv.
  // This lets the gateway perform multi-account CRUD without duplicating
  // the migration / persistence logic in TypeScript.
  const resolvedAccounts = resolveSkillHook('google-workspace', 'hooks/_accounts.js');
  if (!resolvedAccounts) {
    throw new Error('google-workspace skill is not installed (hooks/_accounts.js missing)');
  }
  const helperPath = join(resolvedAccounts.skillRoot, 'google-workspace', 'hooks', '_accounts_cli.js');
  const result = spawnSync('node', [helperPath, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    input: options.stdin,
    env: { ...process.env, ORIONOMEGA_SKILLS_DIR: getConfiguredSkillsDir() },
  });
  const out = (result.stdout || '').trim();
  if (result.status !== 0) {
    const err = (result.stderr || '').trim() || out || 'Helper failed';
    throw new Error(err);
  }
  if (!out) return undefined as T;
  return JSON.parse(out) as T;
}

/** Mask the OAuth client secret in account records sent to the browser. */
function maskAccountSecret<T extends { GOOGLE_OAUTH_CLIENT_SECRET?: string }>(a: T): T {
  if (a && typeof a.GOOGLE_OAUTH_CLIENT_SECRET === 'string' && a.GOOGLE_OAUTH_CLIENT_SECRET.length > 0) {
    return { ...a, GOOGLE_OAUTH_CLIENT_SECRET: '••••' };
  }
  return a;
}

export function handleListGoogleAccounts(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;
  try {
    const data = spawnAccountsHelper<{ accounts: Array<{ GOOGLE_OAUTH_CLIENT_SECRET?: string }>; activeAccountId: string | null }>(['list']);
    const masked = { ...data, accounts: data.accounts.map(maskAccountSecret) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(masked));
  } catch (err) {
    log.error('List google accounts failed', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to list accounts' }));
  }
}

export async function handleCreateGoogleAccount(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): Promise<void> {
  if (!checkAuth(req, res, gatewayConfig)) return;
  try {
    const body = await readBody(req);
    const data = spawnAccountsHelper<{ ok: boolean; account: { GOOGLE_OAUTH_CLIENT_SECRET?: string } }>(['create'], { stdin: body });
    // Mask the secret on response for consistency with list/update so
    // the raw secret is never echoed back over the wire.
    const safe = data && data.account ? { ...data, account: maskAccountSecret(data.account) } : data;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to create account' }));
  }
}

export async function handleUpdateGoogleAccount(
  req: IncomingMessage,
  res: ServerResponse,
  accountId: string,
  gatewayConfig: GatewayConfig,
): Promise<void> {
  if (!checkAuth(req, res, gatewayConfig)) return;
  if (!VALID_ACCOUNT_ID.test(accountId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid accountId' }));
    return;
  }
  try {
    const body = await readBody(req);
    // Strip masked-secret sentinels before forwarding so we don't
    // overwrite the real secret with the mask string when the user
    // submits the form without changing the secret field.
    let stdin = body;
    try {
      const parsed = JSON.parse(body || '{}') as Record<string, unknown> & { fields?: Record<string, unknown> };
      const stripMasked = (obj: Record<string, unknown>) => {
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (v === MASK_SENTINEL) delete obj[k];
          else if (typeof v === 'string' && v.startsWith('••••')) delete obj[k];
        }
      };
      stripMasked(parsed);
      if (parsed.fields && typeof parsed.fields === 'object') stripMasked(parsed.fields as Record<string, unknown>);
      stdin = JSON.stringify(parsed);
    } catch {}
    const data = spawnAccountsHelper<{ ok: boolean; account: { GOOGLE_OAUTH_CLIENT_SECRET?: string } }>(['update', accountId], { stdin });
    const safe = data && data.account ? { ...data, account: maskAccountSecret(data.account) } : data;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to update account' }));
  }
}

export function handleDeleteGoogleAccount(
  req: IncomingMessage,
  res: ServerResponse,
  accountId: string,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;
  if (!VALID_ACCOUNT_ID.test(accountId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid accountId' }));
    return;
  }
  try {
    const data = spawnAccountsHelper(['delete', accountId]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to delete account' }));
  }
}

export function handleActivateGoogleAccount(
  req: IncomingMessage,
  res: ServerResponse,
  accountId: string,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;
  if (!VALID_ACCOUNT_ID.test(accountId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid accountId' }));
    return;
  }
  try {
    const data = spawnAccountsHelper(['activate', accountId]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to activate account' }));
  }
}

export async function handleGoogleOAuthStart(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): Promise<void> {
  if (!checkAuth(req, res, gatewayConfig)) return;

  const resolved = resolveSkillHook('google-workspace', join('hooks', 'oauth-start.js'));
  if (!resolved) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'OAuth start script not found' }));
    return;
  }

  let body = '';
  try { body = await readBody(req); } catch {}
  const accountId = extractAccountId(req, body) || '';
  if (accountId && !VALID_ACCOUNT_ID.test(accountId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid accountId' }));
    return;
  }

  const result = spawnSync('node', [resolved.scriptPath], {
    encoding: 'utf-8',
    timeout: 60000,
    env: {
      ...process.env,
      ORIONOMEGA_SKILLS_DIR: getConfiguredSkillsDir(),
      ...(accountId ? { GOOGLE_WORKSPACE_ACCOUNT_ID: accountId } : {}),
    },
  });
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (parsed.error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: parsed.error }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(parsed));
  } catch {
    const errMsg = result.stderr?.trim() || 'Failed to start OAuth flow';
    log.error('Google OAuth start error', { error: errMsg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: errMsg }));
  }
}

/** Default base port (multi-account: each account gets basePort + slot). */
const WORKSPACE_MCP_BASE_PORT = (() => {
  const raw = process.env.GOOGLE_WORKSPACE_MCP_BASE_PORT;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 && n < 65535 ? n : 9877;
})();

/**
 * Resolve a known account to its loopback port + label. Returns `null`
 * when the account id (or, if omitted, the active account) cannot be
 * resolved — callers MUST treat that as a hard 400 instead of falling
 * back to the wrong account or to the base port.
 */
function resolveAccountForPort(
  accountId: string | null,
): { id: string; port: number; label: string; redirectUri: string } | null {
  try {
    const data = spawnAccountsHelper<{
      accounts: Array<{ id: string; port: number; label?: string; GOOGLE_OAUTH_REDIRECT_URI?: string }>;
      activeAccountId: string | null;
    }>(['list']);
    const id = accountId || data.activeAccountId || '';
    if (!id) return null;
    const found = data.accounts.find((a) => a.id === id);
    if (!found) return null;
    return {
      id: found.id,
      port: found.port,
      label: found.label || found.id,
      redirectUri: found.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${found.port}`,
    };
  } catch {
    return null;
  }
}

/**
 * Extract host:port (port defaulted from scheme when missing) from any
 * URL-ish string the user might paste OR any account redirect URI we've
 * stored. Returns null when the value cannot be parsed.
 *
 * We use this to fail-fast on the most common multi-account misconfig:
 * Google Cloud Console has redirect URI X registered, but the account's
 * configured GOOGLE_OAUTH_REDIRECT_URI points at port Y. Google sends the
 * user back to X, workspace-mcp tries to exchange the code with redirect
 * URI Y → Google rejects → workspace-mcp surfaces it as the cryptic
 * "Invalid or expired OAuth state parameter" error.
 */
function extractHostPort(value: string): { host: string; port: number } | null {
  if (!value) return null;
  const raw = value.trim();
  for (const candidate of [raw, raw.startsWith('http') ? raw : `http://${raw}`]) {
    try {
      const u = new URL(candidate);
      const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
      if (!u.hostname || !Number.isFinite(port)) continue;
      return { host: u.hostname.toLowerCase(), port };
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Probe whether something is listening on `127.0.0.1:<port>` by attempting
 * a short TCP connect. Resolves quickly so the OAuth callback handler can
 * fail fast with a useful error instead of waiting for the HTTP timeout.
 */
function probeLocalListener(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/**
 * Proxy endpoint for manual OAuth callback.
 *
 * Remote users can't reach localhost on the VM, so they paste the redirect URL
 * (or just the auth code) into the web UI.  This handler replays the callback
 * against the workspace-mcp OAuth listener running on the VM.
 *
 * workspace-mcp serves its OAuth callback at /oauth2callback on the same port
 * as its MCP endpoint (default 9877).  The handler supports three input modes:
 *
 *  1. Full redirect URL — replayed as-is with hostname swapped to 127.0.0.1
 *     (preserves port, path, and ALL query params including state/scope/iss).
 *  2. Bare authorization code — assembled into a minimal callback URL.
 *  3. URL with just a code param — same as (1).
 */
export async function handleGoogleOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): Promise<void> {
  if (!checkAuth(req, res, gatewayConfig)) return;

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body) as { url?: string; code?: string; accountId?: string };
    // Accept accountId from EITHER ?accountId=… (consistent with
    // start/status) OR the JSON body (legacy callers). Body wins.
    const accountId = extractAccountId(req, body) || (typeof payload.accountId === 'string' && payload.accountId ? payload.accountId : null);
    if (accountId && !VALID_ACCOUNT_ID.test(accountId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid accountId' }));
      return;
    }
    const account = resolveAccountForPort(accountId);
    if (!account) {
      // Hard fail instead of silently replaying against the active account
      // or the base port — submitting against the wrong account would only
      // produce a confusing CSRF/state mismatch from workspace-mcp.
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: accountId
          ? `Unknown account "${accountId}". Refresh the page and pick an existing account.`
          : 'No account specified and no active account is configured.',
      }));
      return;
    }
    const port = account.port;

    // The per-account workspace-mcp child process holds the OAuth state
    // (CSRF token) that this callback is replaying. If the child isn't
    // currently running, replaying the callback can't possibly succeed —
    // return a clear, fast error instead of hanging on a 15s HTTP timeout.
    const listenerAlive = await probeLocalListener(port, 1500);
    if (!listenerAlive) {
      log.warn('OAuth callback: per-account workspace-mcp listener is not running', {
        accountId: account.id, port,
      });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `The local OAuth listener for account "${account.label}" is not running on port ${port}.`,
        detail: 'Click "Authenticate with Google" again to restart the local listener, then re-paste the redirect URL within a few minutes.',
      }));
      return;
    }

    let callbackUrl: string | null = null;

    if (payload.url) {
      // The pasted value points to the user's per-account configured
      // redirect URI (e.g. http://localhost:9877/?code=...&state=...) which
      // has no listener on the gateway host. Always replay against the
      // workspace-mcp instance bound to that account's loopback port —
      // actual local OAuth callback endpoint, preserving ALL query
      // parameters (code, state, scope, iss, authuser, ...). state is
      // required for workspace-mcp's CSRF validation, so we must extract
      // every param even from schemeless URLs and bare query strings.
      const raw = payload.url.trim();
      let params: URLSearchParams | null = null;

      // Try as absolute URL first
      try {
        params = new URL(raw).searchParams;
      } catch {
        // Try as schemeless URL (e.g. "localhost:9877/?code=...")
        try {
          params = new URL(`http://${raw}`).searchParams;
        } catch {
          // Try as bare query string (with or without leading '?')
          const qs = raw.startsWith('?') ? raw.slice(1) : raw;
          if (qs.includes('=')) {
            params = new URLSearchParams(qs);
          }
        }
      }

      if (params && params.get('code')) {
        // Pre-flight: the host:port in the pasted URL is what Google has
        // registered for this OAuth client. If it doesn't match the
        // account's configured GOOGLE_OAUTH_REDIRECT_URI, workspace-mcp
        // will send the WRONG redirect_uri to Google during code
        // exchange and Google will reject — surfacing as a cryptic
        // "Invalid or expired OAuth state parameter" error from
        // workspace-mcp. Catch it here with a clear, actionable error.
        const pastedHp = extractHostPort(raw);
        const configuredHp = extractHostPort(account.redirectUri);
        if (pastedHp && configuredHp && (pastedHp.host !== configuredHp.host || pastedHp.port !== configuredHp.port)) {
          log.warn('OAuth callback: host:port mismatch between pasted URL and account redirect URI', {
            accountId: account.id,
            pasted: `${pastedHp.host}:${pastedHp.port}`,
            configured: `${configuredHp.host}:${configuredHp.port}`,
          });
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `Redirect URI mismatch for account "${account.label}".`,
            detail:
              `Google redirected you to ${pastedHp.host}:${pastedHp.port}, but this account is configured ` +
              `with redirect URI ${account.redirectUri}. Google rejects the code exchange when these don't match. ` +
              `Fix it one of two ways: (a) update the Redirect URI field above to http://${pastedHp.host}:${pastedHp.port} and click Save, ` +
              `or (b) in Google Cloud Console add http://${configuredHp.host}:${configuredHp.port} as an Authorized redirect URI for this OAuth client. ` +
              `Then click "Authenticate with Google" again to start a fresh flow.`,
          }));
          return;
        }
        const target = new URL(`http://127.0.0.1:${port}/oauth2callback`);
        params.forEach((value, key) => target.searchParams.set(key, value));
        callbackUrl = target.toString();
        log.info('OAuth callback: replaying redirect params against workspace-mcp', {
          accountId: account.id, port,
          target: `http://127.0.0.1:${port}/oauth2callback`,
          hasState: params.has('state'),
        });
      } else if (raw && !raw.includes('=') && !raw.includes('?')) {
        // Looks like a bare authorization code (no = or ? characters)
        callbackUrl = `http://127.0.0.1:${port}/oauth2callback?code=${encodeURIComponent(raw)}`;
        log.info('OAuth callback: using bare code, assembled callback URL', { accountId: account.id, port });
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'The pasted value does not contain an authorization code. Copy the FULL URL from your browser address bar after Google sign-in (it should include both code= and state= parameters).',
        }));
        return;
      }
    } else if (payload.code) {
      const code = payload.code.trim();
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No authorization code found.' }));
        return;
      }
      callbackUrl = `http://127.0.0.1:${port}/oauth2callback?code=${encodeURIComponent(code)}`;
      log.info('OAuth callback: using code field, assembled callback URL', { accountId: account.id, port });
    }

    if (!callbackUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No authorization code found. Paste the full redirect URL or just the code parameter.' }));
      return;
    }

    log.info('OAuth callback: fetching', { url: callbackUrl.replace(/code=[^&]+/, 'code=<REDACTED>') });

    // Replay the OAuth callback against workspace-mcp's local listener.
    // Shorter timeout than before — the listener is on loopback and we
    // already probed it, so 8s is plenty and avoids hanging the UI.
    let proxyRes: Response;
    try {
      proxyRes = await fetch(callbackUrl, {
        method: 'GET',
        redirect: 'manual',  // Don't follow redirects — workspace-mcp may redirect after success
        signal: AbortSignal.timeout(8000),
      });
    } catch (fetchErr) {
      const isAbort = fetchErr instanceof Error && (fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError');
      const message = isAbort
        ? `Timed out waiting for workspace-mcp on port ${port} to process the callback.`
        : (fetchErr instanceof Error ? fetchErr.message : 'Failed to reach workspace-mcp');
      log.error('OAuth callback: replay request failed', {
        accountId: account.id, port, error: message,
      });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: message,
        detail: isAbort
          ? 'The local listener accepted the connection but did not respond in time. Click "Authenticate with Google" again to start a fresh OAuth flow.'
          : undefined,
      }));
      return;
    }

    // workspace-mcp returns 200 on success, or may redirect (3xx) after storing the token
    if (proxyRes.ok || (proxyRes.status >= 300 && proxyRes.status < 400)) {
      log.info('OAuth callback: workspace-mcp returned', { status: proxyRes.status });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Authorization code submitted successfully. Check OAuth status.' }));
    } else {
      const errText = await proxyRes.text().catch(() => '');
      log.error('OAuth callback: workspace-mcp returned', { status: proxyRes.status, body: errText.slice(0, 500) });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `workspace-mcp callback returned HTTP ${proxyRes.status}`,
        detail: errText.slice(0, 500),
      }));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to proxy OAuth callback';
    log.error('Google OAuth callback proxy error', { error: message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
}

/**
 * GET /api/skills/atlassian/oauth/callback
 *
 * Browser-facing OAuth 2.0 (3LO) callback for the Atlassian skill.
 * Atlassian redirects the user's browser here after authorization.
 * This handler exchanges the code for tokens and saves them to the skill
 * config, so the callback URL can point at the public server URL rather
 * than localhost — making OAuth work over Tailscale or any remote host.
 *
 * Register `http://<your-server>/api/gateway/skills/atlassian/oauth/callback`
 * as the "Callback URL" in your Atlassian Developer Console OAuth app.
 */
export async function handleAtlassianOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';

  // Extract code + state from query string
  let code: string | null = null;
  let errorParam: string | null = null;
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    code = url.searchParams.get('code');
    errorParam = url.searchParams.get('error');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<p>Bad request: could not parse callback URL.</p>');
    return;
  }

  if (errorParam) {
    const desc = (() => { try { return new URL(req.url ?? '', 'http://localhost').searchParams.get('error_description') ?? ''; } catch { return ''; } })();
    log.warn('Atlassian OAuth callback: authorization denied', { error: errorParam, description: desc });
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<p>Atlassian authorization denied: <strong>${errorParam}</strong>${desc ? ' — ' + desc : ''}.</p><p>Close this tab and try again.</p>`);
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<p>Missing <code>code</code> parameter in callback URL.</p>');
    return;
  }

  // Load stored Atlassian skill config to get client credentials
  const skillsDir = getConfiguredSkillsDir();
  const skillCfg = readSkillConfig(skillsDir, 'atlassian');
  const fields = (skillCfg.fields ?? {}) as Record<string, string>;
  const clientId = fields.oauth_client_id;
  const clientSecret = fields.oauth_client_secret;
  const callbackUrl = fields.oauth_callback_url;

  if (!clientId || !clientSecret) {
    log.error('Atlassian OAuth callback: OAuth client credentials not configured');
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<p>Atlassian OAuth client credentials are not configured. Open OrionOmega Settings → Atlassian and save your Client ID and Secret first.</p>');
    return;
  }
  if (!callbackUrl) {
    log.error('Atlassian OAuth callback: oauth_callback_url not set in skill config');
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<p>The Atlassian skill Callback URL is not configured. Open OrionOmega Settings → Atlassian, set the Callback URL, and save before authenticating.</p>');
    return;
  }

  // Exchange the authorization code for tokens
  let tokenData: Record<string, unknown>;
  try {
    const tokenRes = await fetch(ATLASSIAN_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await tokenRes.text();
    try { tokenData = JSON.parse(raw) as Record<string, unknown>; } catch { tokenData = {}; }
    if (!tokenRes.ok) {
      const msg = (tokenData.error_description as string) || (tokenData.error as string) || `HTTP ${tokenRes.status}`;
      log.error('Atlassian OAuth callback: token exchange failed', { status: tokenRes.status, message: msg });
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end(`<p>Failed to exchange authorization code with Atlassian: <strong>${msg}</strong>.</p><p>This may mean your Callback URL or client credentials are incorrect. Close this tab and check your Atlassian skill settings.</p>`);
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Atlassian OAuth callback: token exchange request failed', { error: msg });
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end(`<p>Could not reach Atlassian token endpoint: ${msg}</p>`);
    return;
  }

  // Persist tokens into the skill config
  const accessToken = tokenData.access_token as string | undefined;
  const refreshToken = tokenData.refresh_token as string | undefined;
  if (!accessToken) {
    log.error('Atlassian OAuth callback: no access_token in response', { keys: Object.keys(tokenData) });
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<p>Atlassian returned a success response but no access token was included. Close this tab and try again.</p>');
    return;
  }

  try {
    const updated: SkillConfig = {
      ...skillCfg,
      fields: {
        ...fields,
        oauth_access_token: accessToken,
        ...(refreshToken ? { oauth_refresh_token: refreshToken } : {}),
      },
    };
    writeSkillConfig(skillsDir, updated);
    log.info('Atlassian OAuth callback: tokens saved successfully');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Atlassian OAuth callback: failed to save tokens', { error: msg });
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<p>Authorized successfully, but failed to save tokens: ${msg}</p>`);
    return;
  }

  // Redirect to the web UI — user sees the updated token in Settings
  res.writeHead(302, { Location: '/?atlassian_oauth=success' });
  res.end();
}

export function handleGoogleOAuthStatus(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;

  const resolved = resolveSkillHook('google-workspace', join('hooks', 'oauth-status.js'));
  if (!resolved) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: false, reason: 'Status script not found' }));
    return;
  }

  const accountId = extractAccountId(req);
  if (accountId && !VALID_ACCOUNT_ID.test(accountId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid accountId' }));
    return;
  }
  const result = spawnSync('node', [resolved.scriptPath], {
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...process.env,
      ORIONOMEGA_SKILLS_DIR: getConfiguredSkillsDir(),
      ...(accountId ? { GOOGLE_WORKSPACE_ACCOUNT_ID: accountId } : {}),
    },
  });
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(parsed));
  } catch {
    const errMsg = result.stderr?.trim() || 'Failed to get OAuth status';
    log.error('Google OAuth status error', { error: errMsg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: errMsg }));
  }
}

/**
 * POST /api/skills/atlassian/oauth/exchange
 *
 * WebUI-facing endpoint for the Atlassian OAuth manual-paste flow.
 *
 * Because the Atlassian OAuth callback URL is typically `http://localhost:9876/callback`
 * (registered in the Atlassian Developer Console), and there is no local listener on that
 * port, the browser lands on a page that won't load after Atlassian redirects. The user
 * copies the full URL from their browser address bar and pastes it into the WebUI.
 *
 * This handler:
 *  1. Extracts the authorization code from the pasted URL (or accepts a bare code)
 *  2. Exchanges it for access + refresh tokens via the Atlassian token endpoint
 *  3. Saves the tokens into the Atlassian skill config
 *  4. Returns JSON { ok: true } on success
 *
 * Accepts JSON body: { url?: string, code?: string }
 *   - url: the full redirect URL from the browser address bar
 *   - code: a bare authorization code (if the user extracted it manually)
 */
export async function handleAtlassianOAuthExchange(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): Promise<void> {
  if (!checkAuth(req, res, gatewayConfig)) return;

  const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Could not read request body.' }));
    return;
  }

  let payload: { url?: string; code?: string };
  try {
    payload = JSON.parse(body) as { url?: string; code?: string };
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON in request body.' }));
    return;
  }

  // Extract the authorization code from the pasted URL or bare code
  let code: string | null = null;

  if (payload.url) {
    const raw = payload.url.trim();
    // Try to parse as a full URL
    for (const attempt of [raw, `http://${raw}`]) {
      try {
        const u = new URL(attempt);
        code = u.searchParams.get('code');
        if (code) break;
      } catch { /* try next */ }
    }
    // Try as bare query string
    if (!code) {
      const qs = raw.startsWith('?') ? raw.slice(1) : raw;
      if (qs.includes('code=')) {
        try {
          const params = new URLSearchParams(qs);
          code = params.get('code');
        } catch { /* ignore */ }
      }
    }
    // Maybe it's a bare code (no URL structure)
    if (!code && raw && !raw.includes('=') && !raw.includes('?') && !raw.includes('/')) {
      code = raw;
    }
  } else if (payload.code) {
    code = payload.code.trim();
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'No authorization code found.',
      detail: 'Paste the full URL from your browser address bar after Atlassian sign-in. It should contain a code= parameter.',
    }));
    return;
  }

  // Load Atlassian skill config for client credentials
  const skillsDir = getConfiguredSkillsDir();
  const skillCfg = readSkillConfig(skillsDir, 'atlassian');
  const fields = (skillCfg.fields ?? {}) as Record<string, string>;
  const clientId = fields.oauth_client_id;
  const clientSecret = fields.oauth_client_secret;
  const callbackUrl = fields.oauth_callback_url;

  if (!clientId || !clientSecret) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'OAuth client credentials not configured.',
      detail: 'Save your OAuth Client ID and Client Secret in the Atlassian skill settings first.',
    }));
    return;
  }
  if (!callbackUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'OAuth Callback URL not configured.',
      detail: 'Save a Callback URL in the Atlassian skill settings. This must match what is registered in the Atlassian Developer Console.',
    }));
    return;
  }

  // Exchange the authorization code for tokens
  log.info('Atlassian OAuth exchange: exchanging code for tokens');
  let tokenData: Record<string, unknown>;
  try {
    const tokenRes = await fetch(ATLASSIAN_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await tokenRes.text();
    try { tokenData = JSON.parse(raw) as Record<string, unknown>; } catch { tokenData = {}; }
    if (!tokenRes.ok) {
      const msg = (tokenData.error_description as string) || (tokenData.error as string) || `HTTP ${tokenRes.status}`;
      log.error('Atlassian OAuth exchange: token exchange failed', { status: tokenRes.status, message: msg });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Token exchange failed: ${msg}`,
        detail: 'This usually means the authorization code has expired (they last ~10 minutes), the Callback URL doesn\'t match what\'s registered in Atlassian, or the client credentials are incorrect. Try authorizing again.',
      }));
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Atlassian OAuth exchange: request failed', { error: msg });
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Could not reach Atlassian token endpoint: ${msg}` }));
    return;
  }

  const accessToken = tokenData.access_token as string | undefined;
  const refreshToken = tokenData.refresh_token as string | undefined;
  if (!accessToken) {
    log.error('Atlassian OAuth exchange: no access_token in response', { keys: Object.keys(tokenData) });
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Atlassian returned a success response but no access token was included.' }));
    return;
  }

  // Persist tokens into the skill config
  try {
    const updated: SkillConfig = {
      ...skillCfg,
      configured: true,
      configuredAt: new Date().toISOString(),
      fields: {
        ...fields,
        oauth_access_token: accessToken,
        ...(refreshToken ? { oauth_refresh_token: refreshToken } : {}),
      },
    };
    writeSkillConfig(skillsDir, 'atlassian', updated);
    log.info('Atlassian OAuth exchange: tokens saved successfully', {
      hasRefreshToken: !!refreshToken,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Atlassian OAuth exchange: failed to save tokens', { error: msg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Authorized successfully, but failed to save tokens: ${msg}` }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, hasRefreshToken: !!refreshToken }));
}
