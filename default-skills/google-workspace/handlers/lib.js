/**
 * Shared utilities for Google Workspace skill handlers.
 * Wraps the workspace-mcp CLI tool for invoking Google Workspace APIs.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_OUTPUT = 30_000; // chars
const TIMEOUT = 90_000; // ms — some Workspace ops are slow

/**
 * Read skill config from ~/.orionomega/skills/google-workspace/config.json
 * @returns {object}
 */
export function getConfig() {
  // 1. Try skill config file
  const configPath = join(homedir(), '.orionomega', 'skills', 'google-workspace', 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      return config.fields ?? {};
    } catch {}
  }
  return {};
}

/**
 * Invoke a workspace-mcp CLI tool and return the result.
 * Uses `uvx workspace-mcp --cli <toolName> --args <json>` mode.
 *
 * @param {string} toolName - The exact workspace-mcp tool name (e.g. 'search_gmail_messages')
 * @param {object} args - Tool arguments (passed as JSON to --args)
 * @returns {{ ok: boolean, result?: string, error?: string }}
 */
export function workspace(toolName, args = {}) {
  const config = getConfig();

  const env = { ...process.env };

  // Inject OAuth credentials from skill config or environment
  const clientId = config.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = config.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (clientId) env.GOOGLE_OAUTH_CLIENT_ID = clientId;
  if (clientSecret) env.GOOGLE_OAUTH_CLIENT_SECRET = clientSecret;

  // Inject optional settings
  if (config.GOOGLE_PSE_API_KEY) env.GOOGLE_PSE_API_KEY = config.GOOGLE_PSE_API_KEY;
  if (config.GOOGLE_PSE_ENGINE_ID) env.GOOGLE_PSE_ENGINE_ID = config.GOOGLE_PSE_ENGINE_ID;
  if (config.USER_GOOGLE_EMAIL) env.USER_GOOGLE_EMAIL = config.USER_GOOGLE_EMAIL;

  const argsJson = JSON.stringify(args);

  const result = spawnSync(
    'uvx',
    ['workspace-mcp', '--cli', toolName, '--args', argsJson],
    {
      env,
      timeout: TIMEOUT,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    }
  );

  if (result.error) {
    const msg = result.error.code === 'ETIMEDOUT'
      ? `workspace-mcp timed out after ${TIMEOUT / 1000}s`
      : result.error.message;
    return { ok: false, error: msg };
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? '';
    const stdout = result.stdout?.trim() ?? '';
    // workspace-mcp may write errors to stdout as JSON
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) return { ok: false, error: parsed.error };
      } catch {}
    }
    return { ok: false, error: stderr || `Process exited with code ${result.status}` };
  }

  const stdout = result.stdout?.trim() ?? '';
  if (!stdout) return { ok: true, result: '(no output)' };

  // Parse MCP tool result format: { content: [{ type: 'text', text: '...' }] }
  try {
    const parsed = JSON.parse(stdout);

    if (parsed.isError) {
      const errText = parsed.content
        ?.filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n') ?? 'Unknown error';
      return { ok: false, error: errText };
    }

    if (Array.isArray(parsed.content)) {
      const text = parsed.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      return { ok: true, result: text || '(empty response)' };
    }

    // Fallback: return raw JSON as text
    return { ok: true, result: JSON.stringify(parsed, null, 2) };
  } catch {
    // Not JSON — return as-is (already a text response)
    return { ok: true, result: stdout };
  }
}

/**
 * Read JSON parameters from stdin (handler protocol).
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
 * Respond with an error and exit with code 1.
 * @param {string} message
 */
export function fail(message) {
  respond({ error: message });
  process.exit(1);
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
 * Strip undefined/null values from an args object before passing to workspace-mcp.
 * @param {object} obj
 * @returns {object}
 */
export function cleanArgs(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)
  );
}
