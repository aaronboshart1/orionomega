/**
 * Shared utilities for Pipedream skill handlers.
 *
 * Handles OAuth token management, API calls, and handler protocol.
 * All communication is via the Pipedream REST API at
 * https://api.pipedream.com/v1
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const MAX_OUTPUT = 30_000;     // chars
const DEFAULT_TIMEOUT = 30_000; // ms
const DEFAULT_BASE_URL = 'https://api.pipedream.com/v1';
const TOKEN_URL = 'https://api.pipedream.com/v1/oauth/token';

// ─── Config Helpers ──────────────────────────────────────────────

function getSkillsDir() {
  return process.env.ORIONOMEGA_SKILLS_DIR
    || join(process.env.ORIONOMEGA_HOME || join(homedir(), '.orionomega'), 'skills');
}

function getConfigPath() {
  return join(getSkillsDir(), 'pipedream', 'config.json');
}

export function getConfig() {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return raw.fields ?? raw ?? {};
    } catch { /* ignore */ }
  }
  return {};
}

export function updateConfig(updates) {
  const configPath = getConfigPath();
  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch { /* start fresh */ }
  }
  const fields = existing.fields ?? existing ?? {};
  Object.assign(fields, updates);
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ fields }, null, 2), { mode: 0o600 });
}

// ─── Auth ────────────────────────────────────────────────────────

/**
 * Get a valid access token. Auto-refreshes OAuth tokens.
 * @returns {Promise<string>}
 */
export async function getAccessToken() {
  const config = getConfig();
  const method = config.auth_method || process.env.PIPEDREAM_AUTH_METHOD || 'oauth';

  if (method === 'api_key') {
    const key = config.api_key || process.env.PIPEDREAM_API_KEY;
    if (!key) {
      throw new Error(
        'API key not configured. Go to Settings → Skills → Pipedream and enter your API key.'
      );
    }
    return key;
  }

  // OAuth flow
  const expiresAt = config.oauth_token_expires_at;
  const cachedToken = config.oauth_access_token || process.env.PIPEDREAM_ACCESS_TOKEN;

  // Return cached token if still valid (60s buffer)
  if (cachedToken && expiresAt) {
    const expiryMs = new Date(expiresAt).getTime();
    if (Date.now() < expiryMs - 60_000) {
      return cachedToken;
    }
  }

  // Exchange credentials for new token
  return refreshToken();
}

/**
 * Force-refresh the OAuth token.
 * @returns {Promise<string>}
 */
export async function refreshToken() {
  const config = getConfig();
  const clientId = config.oauth_client_id || process.env.PIPEDREAM_CLIENT_ID;
  const clientSecret = config.oauth_client_secret || process.env.PIPEDREAM_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'OAuth client credentials not configured. Go to Settings → Skills → Pipedream:\n' +
      '1. Create an OAuth client at pipedream.com/settings/api\n' +
      '2. Enter the Client ID and Client Secret'
    );
  }

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  }, 15_000);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  updateConfig({
    oauth_access_token: data.access_token,
    oauth_token_expires_at: newExpiresAt,
  });

  return data.access_token;
}

// ─── API Client ──────────────────────────────────────────────────

/**
 * Get the API base URL.
 * @returns {string}
 */
export function getBaseUrl() {
  const config = getConfig();
  return config.api_base_url || process.env.PIPEDREAM_BASE_URL || DEFAULT_BASE_URL;
}

/**
 * Get the project ID.
 * @returns {string|undefined}
 */
export function getProjectId() {
  const config = getConfig();
  return config.project_id || process.env.PIPEDREAM_PROJECT_ID;
}

/**
 * Get the environment.
 * @returns {string}
 */
export function getEnvironment() {
  const config = getConfig();
  return config.environment || process.env.PIPEDREAM_ENVIRONMENT || 'development';
}

/**
 * Get default external user ID.
 * @param {string|undefined} explicit
 * @returns {string|undefined}
 */
export function getDefaultExternalUserId(explicit) {
  if (explicit) return explicit;
  const config = getConfig();
  return config.default_external_user_id || process.env.PIPEDREAM_EXTERNAL_USER_ID;
}

/**
 * Get default max results.
 * @param {number|undefined} explicit
 * @returns {number}
 */
export function getMaxResults(explicit) {
  if (explicit !== undefined && explicit !== null) return explicit;
  const config = getConfig();
  return config.max_results || 20;
}

/**
 * Check if a feature is enabled.
 * @param {string} feature
 * @returns {boolean}
 */
export function isFeatureEnabled(feature) {
  const config = getConfig();
  const key = `enable_${feature}`;
  const defaults = {
    apps: true, components: true, actions: true, triggers: true,
    accounts: true, users: true, workflows: true, proxy: false,
  };
  if (key in config) return !!config[key];
  return defaults[feature] ?? false;
}

/**
 * Make an API call with automatic auth and retry on 401.
 *
 * @param {string} method - HTTP method
 * @param {string} path - URL path (relative to base URL)
 * @param {object|null} body - Request body
 * @param {object} opts - Additional options
 * @param {number} opts.timeout - Timeout in ms
 * @param {boolean} opts.skipEnvironment - Don't send X-PD-Environment
 * @param {object} opts.extraHeaders - Additional headers
 * @returns {Promise<{ ok: boolean, data?: any, error?: string }>}
 */
export async function apiCall(method, path, body = null, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT, skipEnvironment = false, extraHeaders = {} } = opts;

  try {
    let token = await getAccessToken();
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}${path}`;

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...extraHeaders,
    };

    if (!skipEnvironment) {
      headers['X-PD-Environment'] = getEnvironment();
    }

    const fetchOpts = { method, headers };
    if (body) fetchOpts.body = JSON.stringify(body);

    let res = await fetchWithTimeout(url, fetchOpts, timeout);

    // Auto-retry on 401
    if (res.status === 401) {
      const config = getConfig();
      if ((config.auth_method || 'oauth') === 'oauth') {
        try {
          token = await refreshToken();
          headers.Authorization = `Bearer ${token}`;
          res = await fetchWithTimeout(url, { method, headers, body: fetchOpts.body }, timeout);
        } catch {
          return { ok: false, error: 'Authentication failed after token refresh' };
        }
      }
    }

    // Rate limited
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After') || '60';
      return {
        ok: false,
        error: `Rate limited — retry after ${retryAfter}s. ` +
               `Limit: ${res.headers.get('X-RateLimit-Limit') || 'unknown'}, ` +
               `Remaining: ${res.headers.get('X-RateLimit-Remaining') || '0'}`,
      };
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${truncate(errText, 500)}` };
    }

    // 204 No Content
    if (res.status === 204) return { ok: true, data: null };

    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, error: `Request timed out after ${timeout}ms` };
    }
    return { ok: false, error: `Request failed: ${err.message}` };
  }
}

// ─── Handler Protocol ────────────────────────────────────────────

/**
 * Read JSON params from stdin (handler protocol).
 */
export async function readParams() {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Write result to stdout.
 */
export function respond(result) {
  process.stdout.write(JSON.stringify(result));
}

/**
 * Respond with an error. Always exit 0 — error is in JSON payload.
 */
export function fail(message) {
  respond({ error: message });
  process.exit(0);
}

/**
 * Truncate long text.
 */
export function truncate(text, max = MAX_OUTPUT) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + `\n\n... [truncated, ${text.length - max} chars omitted]`;
}

/**
 * Strip undefined/null values from an object.
 */
export function cleanArgs(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null),
  );
}

// ─── Utilities ───────────────────────────────────────────────────

/**
 * fetch() with a timeout using AbortController.
 */
export async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
