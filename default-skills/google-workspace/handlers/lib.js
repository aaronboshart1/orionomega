/**
 * Shared utilities for Google Workspace skill handlers.
 *
 * Spawns `workspace-mcp` as an MCP server over stdio for each call and
 * speaks JSON-RPC 2.0 (initialize → notifications/initialized →
 * tools/call). The previous `--cli` one-shot mode does not exist in
 * upstream workspace-mcp; the documented contract is the MCP stdio
 * transport, so we use that.
 */

import { spawn } from 'node:child_process';
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
  const skillsDir = process.env.ORIONOMEGA_SKILLS_DIR
    || join(homedir(), '.orionomega', 'skills');
  const configPath = join(skillsDir, 'google-workspace', 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      return config.fields ?? {};
    } catch {}
  }
  return {};
}

/**
 * Build the env passed to workspace-mcp, injecting OAuth creds and
 * optional settings from skill config.
 */
function buildEnv() {
  const config = getConfig();
  const env = { ...process.env };
  const clientId = config.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = config.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (clientId) env.GOOGLE_OAUTH_CLIENT_ID = clientId;
  if (clientSecret) env.GOOGLE_OAUTH_CLIENT_SECRET = clientSecret;
  if (config.GOOGLE_PSE_API_KEY) env.GOOGLE_PSE_API_KEY = config.GOOGLE_PSE_API_KEY;
  if (config.GOOGLE_PSE_ENGINE_ID) env.GOOGLE_PSE_ENGINE_ID = config.GOOGLE_PSE_ENGINE_ID;
  if (config.USER_GOOGLE_EMAIL) env.USER_GOOGLE_EMAIL = config.USER_GOOGLE_EMAIL;
  return env;
}

/**
 * Invoke a workspace-mcp tool via MCP stdio JSON-RPC and return the result.
 *
 * @param {string} toolName - Exact workspace-mcp tool name (e.g. 'search_gmail_messages')
 * @param {object} args - Tool arguments (passed as the JSON-RPC `arguments` object)
 * @returns {Promise<{ ok: boolean, result?: string, error?: string }>}
 */
export function workspace(toolName, args = {}) {
  return new Promise((resolve) => {
    const env = buildEnv();

    const child = spawn(
      'uvx',
      ['workspace-mcp', '--single-user', '--transport', 'stdio'],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    const pending = new Map(); // id → resolver
    let nextId = 1;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Graceful shutdown: SIGTERM, escalate to SIGKILL after 1s if the
      // child (or any descendants spawned by uvx) ignores it. Without
      // escalation a stuck workspace-mcp under repeated timeouts would
      // leak processes.
      try {
        if (!child.killed && child.exitCode === null) {
          child.kill('SIGTERM');
          const killTimer = setTimeout(() => {
            try {
              if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
            } catch {}
          }, 1000);
          killTimer.unref?.();
        }
      } catch {}
      resolve(payload);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `workspace-mcp timed out after ${TIMEOUT / 1000}s` });
    }, TIMEOUT);

    child.on('error', (err) => {
      finish({ ok: false, error: `Failed to spawn workspace-mcp: ${err.message}` });
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      const stderr = stderrBuf.trim();
      finish({
        ok: false,
        error: stderr || `workspace-mcp exited (code=${code}, signal=${signal}) before responding`,
      });
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf-8');
    });

    // MCP framing over stdio is newline-delimited JSON (each JSON-RPC
    // message is one line on stdout).
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf-8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && typeof msg.id !== 'undefined' && pending.has(msg.id)) {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          cb(msg);
        }
      }
    });

    const send = (obj) => {
      try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch {}
    };
    const request = (method, params) => new Promise((res) => {
      const id = nextId++;
      pending.set(id, res);
      send({ jsonrpc: '2.0', id, method, params });
    });
    const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

    (async () => {
      try {
        const initRes = await request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'orionomega-google-workspace', version: '1.0.0' },
        });
        if (initRes.error) {
          finish({ ok: false, error: `initialize failed: ${initRes.error.message || JSON.stringify(initRes.error)}` });
          return;
        }
        notify('notifications/initialized', {});

        const callRes = await request('tools/call', {
          name: toolName,
          arguments: args,
        });

        if (callRes.error) {
          finish({ ok: false, error: callRes.error.message || JSON.stringify(callRes.error) });
          return;
        }

        const result = callRes.result;
        if (!result) {
          finish({ ok: true, result: '(no output)' });
          return;
        }

        if (result.isError) {
          const errText = Array.isArray(result.content)
            ? result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
            : 'Tool returned isError';
          finish({ ok: false, error: errText || 'Tool error' });
          return;
        }

        if (Array.isArray(result.content)) {
          const text = result.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n');
          finish({ ok: true, result: text || '(empty response)' });
          return;
        }

        finish({ ok: true, result: JSON.stringify(result, null, 2) });
      } catch (err) {
        finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
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
