/**
 * Shared utilities for Atlassian skill handlers.
 *
 * Communicates with the official Atlassian Rovo MCP Server at
 * https://mcp.atlassian.com/v1/mcp using the MCP protocol over
 * HTTP Streamable transport (JSON-RPC 2.0).
 *
 * Auth: OAuth 2.0 (3LO) bearer tokens or Basic auth (email:api_token).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_OUTPUT = 30_000; // chars
const TIMEOUT = 90_000;    // ms — Atlassian remote calls can be slow
const DEFAULT_MCP_ENDPOINT = 'https://mcp.atlassian.com/v1/mcp';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';

// ─── Config helpers ──────────────────────────────────────────────

/**
 * Locate the skills directory (mirrors convention from other skills).
 * @returns {string}
 */
function getSkillsDir() {
  return process.env.ORIONOMEGA_SKILLS_DIR
    || join(process.env.ORIONOMEGA_HOME || join(homedir(), '.orionomega'), 'skills');
}

/**
 * Get the config file path.
 * @returns {string}
 */
function getConfigPath() {
  return join(getSkillsDir(), 'atlassian', 'config.json');
}

/**
 * Read skill config from ~/.orionomega/skills/atlassian/config.json
 * @returns {object}
 */
export function getConfig() {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return raw.fields ?? raw ?? {};
    } catch { /* ignore parse errors */ }
  }
  return {};
}

/**
 * Persist updated config back to disk (e.g. after token refresh).
 * @param {object} updates - Key/value pairs to merge into config
 */
function updateConfig(updates) {
  const configPath = getConfigPath();
  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch { /* start fresh */ }
  }
  const fields = existing.fields ?? existing ?? {};
  Object.assign(fields, updates);
  writeFileSync(configPath, JSON.stringify({ fields }, null, 2), { mode: 0o600 });
}

/**
 * Attempt to refresh the OAuth access token using the refresh token.
 * @returns {Promise<string|null>} New access token, or null on failure
 */
async function refreshAccessToken() {
  const config = getConfig();
  const refreshToken = config.oauth_refresh_token || process.env.ATLASSIAN_REFRESH_TOKEN;
  const clientId = config.oauth_client_id || process.env.ATLASSIAN_CLIENT_ID;
  const clientSecret = config.oauth_client_secret || process.env.ATLASSIAN_CLIENT_SECRET;

  if (!refreshToken || !clientId || !clientSecret) {
    return null;
  }

  try {
    const res = await fetchWithTimeout(ATLASSIAN_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    }, 15_000);

    if (!res.ok) return null;

    const data = await res.json();
    if (data.access_token) {
      // Persist the new tokens
      const updates = { oauth_access_token: data.access_token };
      if (data.refresh_token) updates.oauth_refresh_token = data.refresh_token;
      updateConfig(updates);
      return data.access_token;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Build the Authorization header value from config/env.
 * Supports two modes:
 *   - oauth  → "Bearer <access_token>"  (with auto-refresh)
 *   - basic  → "Basic base64(email:token)"
 * @returns {Promise<string>}
 */
export async function getAuthHeader() {
  const config = getConfig();
  const method = config.auth_method || process.env.ATLASSIAN_AUTH_METHOD || 'oauth';

  if (method === 'oauth') {
    let token = config.oauth_access_token || process.env.ATLASSIAN_OAUTH_TOKEN || '';

    if (!token) {
      // Try to get a new token via refresh
      token = await refreshAccessToken();
    }

    if (!token) {
      throw new Error(
        'OAuth access token not configured. Go to Settings → Skills → Atlassian:\n' +
        '1. Enter your OAuth Client ID and Client Secret from developer.atlassian.com\n' +
        '2. Set the Callback URL (must match your Developer Console)\n' +
        '3. Complete the OAuth authorization flow'
      );
    }
    return `Bearer ${token}`;
  }

  if (method === 'basic') {
    const email = config.api_email || process.env.ATLASSIAN_EMAIL || '';
    const token = config.api_token || process.env.ATLASSIAN_API_TOKEN || '';
    if (!email || !token) {
      throw new Error(
        'API email and token required for Basic auth. Go to Settings → Skills → Atlassian:\n' +
        '1. Enter your Atlassian account email\n' +
        '2. Create an API token at id.atlassian.com/manage-profile/security/api-tokens\n' +
        '3. Paste the token in the API Token field'
      );
    }
    return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  }

  throw new Error(`Unknown auth_method "${method}". Valid: oauth, basic.`);
}

/**
 * Get the MCP server endpoint URL.
 * @returns {string}
 */
export function getEndpoint() {
  const config = getConfig();
  return config.mcp_endpoint || process.env.ATLASSIAN_MCP_ENDPOINT || DEFAULT_MCP_ENDPOINT;
}

/**
 * Check whether a specific product is enabled in settings.
 * @param {string} product - One of: jira, confluence, compass, jsm, bitbucket, search
 * @returns {boolean}
 */
export function isProductEnabled(product) {
  const config = getConfig();
  const key = `enable_${product}`;
  const defaults = { jira: true, confluence: true, compass: false, jsm: false, bitbucket: false, search: true };
  if (key in config) return !!config[key];
  return defaults[product] ?? false;
}

/**
 * Get the default max_results from settings.
 * @param {number|undefined} explicit - Explicitly passed value
 * @returns {number}
 */
export function getMaxResults(explicit) {
  if (explicit !== undefined && explicit !== null) return explicit;
  const config = getConfig();
  return config.max_results || 10;
}

/**
 * Get default cloud_id from settings.
 * @param {string|undefined} explicit
 * @returns {string|undefined}
 */
export function getCloudId(explicit) {
  if (explicit) return explicit;
  const config = getConfig();
  return config.default_cloud_id || process.env.ATLASSIAN_CLOUD_ID || undefined;
}

// ─── MCP Client ──────────────────────────────────────────────────

/**
 * Call a tool on the Atlassian Rovo MCP Server using the MCP protocol.
 *
 * Uses the Streamable HTTP transport: POST to the MCP endpoint with
 * JSON-RPC 2.0 messages. The server returns JSON-RPC responses.
 *
 * Includes automatic token refresh on 401 responses.
 *
 * @param {string} toolName - Exact Rovo MCP tool name (e.g. 'getJiraIssue')
 * @param {object} args - Tool arguments
 * @returns {Promise<{ ok: boolean, result?: string, error?: string }>}
 */
export async function mcpCall(toolName, args = {}) {
  const result = await _mcpCallInner(toolName, args);

  // If auth failed, try refreshing the token and retry once
  if (!result.ok && result.error && result.error.includes('401')) {
    const config = getConfig();
    if (config.auth_method === 'oauth' || !config.auth_method) {
      const newToken = await refreshAccessToken();
      if (newToken) {
        return _mcpCallInner(toolName, args);
      }
    }
  }

  return result;
}

async function _mcpCallInner(toolName, args = {}) {
  const endpoint = getEndpoint();
  let authHeader;
  try {
    authHeader = await getAuthHeader();
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Step 1: Initialize the MCP session
  let sessionId;
  try {
    const initRes = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'orionomega-atlassian', version: '1.1.0' },
        },
      }),
    }, TIMEOUT);

    if (!initRes.ok) {
      const errText = await initRes.text().catch(() => '');
      return { ok: false, error: `MCP initialize failed (HTTP ${initRes.status}): ${truncate(errText, 500)}` };
    }

    sessionId = initRes.headers.get('mcp-session-id') || null;

    const initBody = await parseResponse(initRes);
    if (initBody?.error) {
      return { ok: false, error: `MCP initialize error: ${initBody.error.message || JSON.stringify(initBody.error)}` };
    }
  } catch (err) {
    return { ok: false, error: `MCP initialize failed: ${err.message}` };
  }

  // Step 2: Send notifications/initialized
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }),
    }, 10_000);
  } catch { /* notifications may not return a response */ }

  // Step 3: Call the tool
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'Accept': 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const callRes = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    }, TIMEOUT);

    if (!callRes.ok) {
      const errText = await callRes.text().catch(() => '');
      return { ok: false, error: `MCP tools/call failed (HTTP ${callRes.status}): ${truncate(errText, 500)}` };
    }

    const callBody = await parseResponse(callRes);

    if (callBody?.error) {
      return { ok: false, error: callBody.error.message || JSON.stringify(callBody.error) };
    }

    const result = callBody?.result;
    if (!result) return { ok: true, result: '(no output)' };

    if (result.isError) {
      const errText = Array.isArray(result.content)
        ? result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
        : 'Tool returned isError';
      return { ok: false, error: errText || 'Tool error' };
    }

    if (Array.isArray(result.content)) {
      const text = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      return { ok: true, result: text || '(empty response)' };
    }

    return { ok: true, result: JSON.stringify(result, null, 2) };
  } catch (err) {
    return { ok: false, error: `MCP tools/call failed: ${err.message}` };
  }
}

/**
 * Parse an MCP HTTP response that may be JSON or SSE.
 */
async function parseResponse(res) {
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    return res.json();
  }

  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const lines = text.split('\n');
    let lastData = null;
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          lastData = JSON.parse(line.slice(6));
        } catch { /* skip */ }
      }
    }
    return lastData;
  }

  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * fetch() with a timeout using AbortController.
 */
async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Handler Protocol Helpers ────────────────────────────────────

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
 * Respond with an error. Does NOT exit — callers use return after.
 */
export function fail(message) {
  respond({ error: message });
  process.exit(0); // Always exit 0 — error is in JSON payload
}

/**
 * Truncate long text to avoid overwhelming the context window.
 */
export function truncate(text, max = MAX_OUTPUT) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + `\n\n... [truncated, ${text.length - max} chars omitted]`;
}

/**
 * Strip undefined/null values from an args object.
 */
export function cleanArgs(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null),
  );
}
