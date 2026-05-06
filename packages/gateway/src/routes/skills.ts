import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
        const data = spawnAccountsHelper(
          ['update', accountId],
          { stdin: JSON.stringify({ fields: cleanFields }) },
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: data }));
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

export function handleListGoogleAccounts(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): void {
  if (!checkAuth(req, res, gatewayConfig)) return;
  try {
    const data = spawnAccountsHelper<{ accounts: unknown[]; activeAccountId: string | null }>(['list']);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
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
    const data = spawnAccountsHelper(['create'], { stdin: body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
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
    const data = spawnAccountsHelper(['update', accountId], { stdin: body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
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

/** Look up the workspace-mcp port for a given account id (falls back to base). */
function getAccountPort(accountId: string | null): number {
  if (!accountId) return WORKSPACE_MCP_BASE_PORT;
  try {
    const data = spawnAccountsHelper<{ accounts: Array<{ id: string; port: number }>; activeAccountId: string | null }>(['list']);
    const id = accountId || data.activeAccountId || '';
    const found = data.accounts.find((a) => a.id === id);
    return found?.port ?? WORKSPACE_MCP_BASE_PORT;
  } catch {
    return WORKSPACE_MCP_BASE_PORT;
  }
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
    const accountId = (typeof payload.accountId === 'string' && payload.accountId) ? payload.accountId : null;
    if (accountId && !VALID_ACCOUNT_ID.test(accountId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid accountId' }));
      return;
    }
    const port = getAccountPort(accountId);

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
        const target = new URL(`http://127.0.0.1:${port}/oauth2callback`);
        params.forEach((value, key) => target.searchParams.set(key, value));
        callbackUrl = target.toString();
        log.info('OAuth callback: replaying redirect params against workspace-mcp', {
          accountId, port,
          target: `http://127.0.0.1:${port}/oauth2callback`,
          hasState: params.has('state'),
        });
      } else if (raw && !raw.includes('=') && !raw.includes('?')) {
        // Looks like a bare authorization code (no = or ? characters)
        callbackUrl = `http://127.0.0.1:${port}/oauth2callback?code=${encodeURIComponent(raw)}`;
        log.info('OAuth callback: using bare code, assembled callback URL', { accountId, port });
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
      log.info('OAuth callback: using code field, assembled callback URL', { accountId, port });
    }

    if (!callbackUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No authorization code found. Paste the full redirect URL or just the code parameter.' }));
      return;
    }

    log.info('OAuth callback: fetching', { url: callbackUrl.replace(/code=[^&]+/, 'code=<REDACTED>') });

    // Replay the OAuth callback against workspace-mcp's local listener
    const proxyRes = await fetch(callbackUrl, {
      method: 'GET',
      redirect: 'manual',  // Don't follow redirects — workspace-mcp may redirect after success
      signal: AbortSignal.timeout(15000),
    });

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
