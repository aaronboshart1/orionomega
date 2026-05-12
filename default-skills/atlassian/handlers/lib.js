/**
 * Shared utilities for Atlassian skill handlers.
 *
 * Communicates with the official Atlassian Rovo MCP Server at
 * https://mcp.atlassian.com/v1/mcp using the MCP protocol over
 * HTTP Streamable transport (JSON-RPC 2.0).
 *
 * Auth: OAuth 2.1 bearer tokens or Basic auth (email:api_token).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_OUTPUT = 30_000; // chars
const TIMEOUT = 90_000;    // ms — Atlassian remote calls can be slow
const DEFAULT_MCP_ENDPOINT = 'https://mcp.atlassian.com/v1/mcp';

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
 * Read skill config from ~/.orionomega/skills/atlassian/config.json
 * @returns {object}
 */
export function getConfig() {
  const configPath = join(getSkillsDir(), 'atlassian', 'config.json');
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return raw.fields ?? raw ?? {};
    } catch { /* ignore parse errors */ }
  }
  return {};
}

/**
 * Build the Authorization header value from config/env.
 * Supports three modes:
 *   - oauth  → "Bearer <token>"
 *   - basic  → "Basic base64(email:token)"
 *   - bearer → "Bearer <api_key>"
 * @returns {string}
 */
export function getAuthHeader() {
  const config = getConfig();
  const method = config.auth_method || process.env.ATLASSIAN_AUTH_METHOD || 'oauth';

  if (method === 'oauth') {
    const token = config.oauth_token || process.env.ATLASSIAN_OAUTH_TOKEN || '';
    if (!token) throw new Error('OAuth token not configured. Go to Settings → Skills → Atlassian to set up authentication.');
    return `Bearer ${token}`;
  }

  if (method === 'basic') {
    const email = config.api_email || process.env.ATLASSIAN_EMAIL || '';
    const token = config.api_token || process.env.ATLASSIAN_API_TOKEN || '';
    if (!email || !token) throw new Error('API email and token required for Basic auth. Go to Settings → Skills → Atlassian.');
    return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  }

  if (method === 'bearer') {
    const token = config.api_token || process.env.ATLASSIAN_API_TOKEN || '';
    if (!token) throw new Error('API key not configured for Bearer auth. Go to Settings → Skills → Atlassian.');
    return `Bearer ${token}`;
  }

  throw new Error(`Unknown auth_method "${method}". Valid: oauth, basic, bearer.`);
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
  // Default: jira, confluence, search are on; compass, jsm, bitbucket are off
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
 * @param {string} toolName - Exact Rovo MCP tool name (e.g. 'getJiraIssue')
 * @param {object} args - Tool arguments
 * @returns {Promise<{ ok: boolean, result?: string, error?: string }>}
 */
export async function mcpCall(toolName, args = {}) {
  const endpoint = getEndpoint();
  let authHeader;
  try {
    authHeader = getAuthHeader();
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
          clientInfo: { name: 'orionomega-atlassian', version: '1.0.0' },
        },
      }),
    }, TIMEOUT);

    if (!initRes.ok) {
      const errText = await initRes.text().catch(() => '');
      return { ok: false, error: `MCP initialize failed (HTTP ${initRes.status}): ${truncate(errText, 500)}` };
    }

    sessionId = initRes.headers.get('mcp-session-id') || null;

    // Parse the init response (may be SSE or JSON)
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
 * @param {Response} res
 * @returns {Promise<object|null>}
 */
async function parseResponse(res) {
  const contentType = res.headers.get('content-type') || '';

  // Plain JSON response
  if (contentType.includes('application/json')) {
    return res.json();
  }

  // SSE response — extract JSON-RPC messages from event stream
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const lines = text.split('\n');
    let lastData = null;
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          lastData = JSON.parse(line.slice(6));
        } catch { /* skip non-JSON data lines */ }
      }
    }
    return lastData;
  }

  // Fallback: try JSON
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * fetch() with a timeout using AbortController.
 * @param {string} url
 * @param {object} opts
 * @param {number} ms
 * @returns {Promise<Response>}
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
 * @returns {Promise<object>}
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
 * @param {object} result
 */
export function respond(result) {
  process.stdout.write(JSON.stringify(result));
}

/**
 * Respond with an error. Does NOT exit — callers use return after.
 * @param {string} message
 */
export function fail(message) {
  respond({ error: message });
  process.exit(0); // Always exit 0 — error is in JSON payload
}

/**
 * Truncate long text to avoid overwhelming the context window.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max = MAX_OUTPUT) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + `\n\n... [truncated, ${text.length - max} chars omitted]`;
}

/**
 * Strip undefined/null values from an args object before passing to the MCP server.
 * @param {object} obj
 * @returns {object}
 */
export function cleanArgs(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null),
  );
}
