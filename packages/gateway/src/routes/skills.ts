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
import { readConfig } from '@orionomega/core';
import type { GatewayConfig } from '../types.js';
import { readBody } from './utils.js';
import { checkAuth } from './auth-utils.js';

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
    console.warn('[skills] Failed to read skills directory from config:', err instanceof Error ? err.message : String(err));
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
    console.warn('[skills] Failed to load skills from directory:', err instanceof Error ? err.message : String(err));
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
    console.error('[skills] Failed to list skills:', err instanceof Error ? err.message : String(err));
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
    const payload = JSON.parse(body) as Partial<SkillConfig> & { settings?: Record<string, unknown> };

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
    console.error('[skills] Failed to update skill config:', message);
    const status = message.includes('exceeds limit') ? 413 : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 413 ? 'Request body too large' : 'Failed to update skill configuration' }));
  }
}

export async function handleGoogleOAuthStart(
  req: IncomingMessage,
  res: ServerResponse,
  gatewayConfig: GatewayConfig,
): Promise<void> {
  if (!checkAuth(req, res, gatewayConfig)) return;

  const scriptPath = join(getConfiguredSkillsDir(), 'google-workspace', 'hooks', 'oauth-start.js');
  if (!existsSync(scriptPath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'OAuth start script not found' }));
    return;
  }

  const result = spawnSync('node', [scriptPath], { encoding: 'utf-8', timeout: 60000, env: { ...process.env } });
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
    console.error('[skills] Google OAuth start error:', errMsg);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: errMsg }));
  }
}

/** Default port that workspace-mcp listens on for both MCP and OAuth callbacks. */
const WORKSPACE_MCP_PORT = 9877;

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
    const payload = JSON.parse(body) as { url?: string; code?: string };

    let callbackUrl: string | null = null;

    if (payload.url) {
      try {
        const parsed = new URL(payload.url);

        // Validate that the URL contains an authorization code
        if (!parsed.searchParams.get('code')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'The pasted URL does not contain an authorization code. Make sure you copied the full URL from your browser after Google sign-in.',
          }));
          return;
        }

        // Replay the full URL against localhost, preserving port, path, and
        // ALL query parameters (state, code, scope, iss, authuser, etc.).
        // workspace-mcp needs these for CSRF validation and token exchange.
        parsed.hostname = '127.0.0.1';
        callbackUrl = parsed.toString();

        console.log('[skills] OAuth callback: replaying full redirect URL against localhost');
        console.log('[skills] OAuth callback target:', `http://127.0.0.1:${parsed.port || WORKSPACE_MCP_PORT}${parsed.pathname}`);
      } catch {
        // Not a valid URL — treat the whole string as a bare authorization code
        const code = payload.url.trim();
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No authorization code found.' }));
          return;
        }
        callbackUrl = `http://127.0.0.1:${WORKSPACE_MCP_PORT}/oauth2callback?code=${encodeURIComponent(code)}`;
        console.log('[skills] OAuth callback: using bare code, assembled callback URL');
      }
    } else if (payload.code) {
      const code = payload.code.trim();
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No authorization code found.' }));
        return;
      }
      callbackUrl = `http://127.0.0.1:${WORKSPACE_MCP_PORT}/oauth2callback?code=${encodeURIComponent(code)}`;
      console.log('[skills] OAuth callback: using code field, assembled callback URL');
    }

    if (!callbackUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No authorization code found. Paste the full redirect URL or just the code parameter.' }));
      return;
    }

    console.log('[skills] OAuth callback: fetching', callbackUrl.replace(/code=[^&]+/, 'code=<REDACTED>'));

    // Replay the OAuth callback against workspace-mcp's local listener
    const proxyRes = await fetch(callbackUrl, {
      method: 'GET',
      redirect: 'manual',  // Don't follow redirects — workspace-mcp may redirect after success
      signal: AbortSignal.timeout(15000),
    });

    // workspace-mcp returns 200 on success, or may redirect (3xx) after storing the token
    if (proxyRes.ok || (proxyRes.status >= 300 && proxyRes.status < 400)) {
      console.log('[skills] OAuth callback: workspace-mcp returned', proxyRes.status);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Authorization code submitted successfully. Check OAuth status.' }));
    } else {
      const errText = await proxyRes.text().catch(() => '');
      console.error('[skills] OAuth callback: workspace-mcp returned', proxyRes.status, errText.slice(0, 500));
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `workspace-mcp callback returned HTTP ${proxyRes.status}`,
        detail: errText.slice(0, 500),
      }));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to proxy OAuth callback';
    console.error('[skills] Google OAuth callback proxy error:', message);
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

  const scriptPath = join(getConfiguredSkillsDir(), 'google-workspace', 'hooks', 'oauth-status.js');
  if (!existsSync(scriptPath)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: false, reason: 'Status script not found' }));
    return;
  }

  const result = spawnSync('node', [scriptPath], { encoding: 'utf-8', timeout: 10000, env: { ...process.env } });
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(parsed));
  } catch {
    const errMsg = result.stderr?.trim() || 'Failed to get OAuth status';
    console.error('[skills] Google OAuth status error:', errMsg);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: errMsg }));
  }
}
