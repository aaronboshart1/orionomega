#!/usr/bin/env node
/**
 * Health check hook for the google-workspace skill.
 *
 * Writes a JSON object to stdout describing skill health:
 *   { healthy: boolean, message: string, checks: [{label, ok, detail}] }
 *
 * Per the Skills SDK, healthCheck hooks should always exit 0 — only the
 * stdout JSON is consumed.
 *
 * Verifies, in order:
 *   1. `uvx` is on PATH (required to spawn workspace-mcp)
 *   2. OAuth client credentials are configured in the skill config
 *   3. OAuth tokens are present (obtained via the in-app OAuth flow)
 *   4. The MCP server can be initialized over stdio
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readConfig() {
  const skillsDir = process.env.ORIONOMEGA_SKILLS_DIR
    || join(homedir(), '.orionomega', 'skills');
  const configPath = join(skillsDir, 'google-workspace', 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')).fields ?? {};
  } catch {
    return {};
  }
}

function emit(healthy, message, checks) {
  process.stdout.write(JSON.stringify({ healthy, message, checks }, null, 2));
  process.exit(0);
}

async function main() {
  const checks = [];

  // 1. uvx on PATH
  const uvxCheck = spawnSync('uvx', ['--version'], { encoding: 'utf-8', timeout: 10_000 });
  if (uvxCheck.error || uvxCheck.status !== 0) {
    checks.push({
      label: 'uvx installed',
      ok: false,
      detail: 'uvx not found on PATH. Install with: curl -LsSf https://astral.sh/uv/install.sh | sh',
    });
    return emit(false, 'uvx is required to run workspace-mcp.', checks);
  }
  checks.push({ label: 'uvx installed', ok: true, detail: uvxCheck.stdout?.trim() ?? 'ok' });

  // 2. OAuth client credentials
  const cfg = readConfig();
  const clientId = cfg.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = cfg.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    checks.push({
      label: 'OAuth credentials configured',
      ok: false,
      detail: 'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are not set. Open Settings → Skills → Google Workspace and enter your OAuth client credentials.',
    });
    return emit(false, 'Google OAuth client credentials are not configured.', checks);
  }
  checks.push({
    label: 'OAuth credentials configured',
    ok: true,
    detail: `Client ID: ${String(clientId).slice(0, 20)}…`,
  });

  // 3. OAuth tokens present. Tokens may live in either:
  //    a) the skill's config.json fields (GOOGLE_ACCESS_TOKEN /
  //       GOOGLE_REFRESH_TOKEN), populated by the gateway OAuth callback
  //    b) workspace-mcp's own credentials dir at
  //       ~/.google_workspace_mcp/credentials/<email>.json (also read by
  //       hooks/oauth-status.js)
  //    Either source counts as "authenticated" so the health check can't
  //    drift away from the OAuth status hook.
  const accessToken = cfg.GOOGLE_ACCESS_TOKEN;
  const refreshToken = cfg.GOOGLE_REFRESH_TOKEN;
  let tokenSource = '';
  if (accessToken || refreshToken) {
    tokenSource = refreshToken ? 'config.json (refresh token)' : 'config.json (access token)';
  } else {
    const credDir = join(homedir(), '.google_workspace_mcp', 'credentials');
    if (existsSync(credDir)) {
      try {
        for (const entry of readdirSync(credDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.json')) {
            const tok = JSON.parse(readFileSync(join(credDir, entry.name), 'utf-8'));
            if (tok.token || tok.access_token || tok.refresh_token) {
              tokenSource = `workspace-mcp credentials (${entry.name.replace(/\.json$/, '')})`;
              break;
            }
          } else if (entry.isDirectory()) {
            const tokPath = join(credDir, entry.name, 'token.json');
            if (existsSync(tokPath)) {
              const tok = JSON.parse(readFileSync(tokPath, 'utf-8'));
              if (tok.token || tok.access_token || tok.refresh_token) {
                tokenSource = `workspace-mcp credentials (${entry.name})`;
                break;
              }
            }
          }
        }
      } catch {}
    }
  }
  if (!tokenSource) {
    checks.push({
      label: 'OAuth tokens present',
      ok: false,
      detail: 'No access or refresh token. Open Settings → Skills → Google Workspace and click "Connect Google account" to complete the OAuth flow.',
    });
    return emit(false, 'OAuth tokens missing — sign in via Settings → Skills → Google Workspace.', checks);
  }
  checks.push({
    label: 'OAuth tokens present',
    ok: true,
    detail: tokenSource,
  });

  // 4. MCP server reachable — initialize over stdio. We use the same
  //    transport the handlers use, but only perform `initialize` (no
  //    tool call) so we don't make any Google API requests.
  const { workspace } = await import(join(__dirname, '..', 'handlers', 'lib.js'));
  // workspace() always does initialize → tools/call. To keep this
  // health check cheap we call a known no-op tool with a tiny argument
  // and tolerate a benign error response (we only care that the server
  // started, initialized, and replied at all).
  const probe = await Promise.race([
    workspace('list_gmail_labels', {}),
    new Promise((r) => setTimeout(() => r({ ok: false, error: 'probe timeout' }), 30_000)),
  ]);

  if (probe.ok || (probe.error && !/Failed to spawn|exited.*before responding|timed out/.test(probe.error))) {
    checks.push({
      label: 'workspace-mcp reachable',
      ok: true,
      detail: probe.ok ? 'Initialized and tool call returned data' : `Initialized (tool reported: ${probe.error.slice(0, 120)})`,
    });
    return emit(true, 'Google Workspace skill is healthy.', checks);
  }

  checks.push({
    label: 'workspace-mcp reachable',
    ok: false,
    detail: probe.error || 'Unknown error',
  });
  return emit(false, 'Could not reach workspace-mcp over stdio.', checks);
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({
    healthy: false,
    message: `Health check crashed: ${err instanceof Error ? err.message : String(err)}`,
    checks: [],
  }));
  process.exit(0);
});
