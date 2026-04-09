#!/usr/bin/env node
/**
 * Health check: verifies uvx is available, credentials are configured,
 * and the workspace-mcp server can be invoked.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

async function main() {
  const checks = [];

  // 1. Check uvx is available
  const uvxCheck = spawnSync('uvx', ['--version'], { encoding: 'utf-8', timeout: 10000 });
  if (uvxCheck.error || uvxCheck.status !== 0) {
    checks.push({
      label: 'uvx installed',
      ok: false,
      detail: 'uvx not found. Install with: curl -LsSf https://astral.sh/uv/install.sh | sh',
    });
    process.stdout.write(JSON.stringify({ healthy: false, checks }, null, 2));
    process.exit(1);
    return;
  }
  checks.push({ label: 'uvx installed', ok: true, detail: uvxCheck.stdout?.trim() ?? 'ok' });

  // 2. Check OAuth credentials
  let clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  let clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const configPath = join(homedir(), '.orionomega', 'skills', 'google-workspace', 'config.json');
    if (existsSync(configPath)) {
      try {
        const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        clientId = clientId || cfg.fields?.GOOGLE_OAUTH_CLIENT_ID;
        clientSecret = clientSecret || cfg.fields?.GOOGLE_OAUTH_CLIENT_SECRET;
      } catch {}
    }
  }

  if (clientId && clientSecret) {
    checks.push({
      label: 'OAuth credentials configured',
      ok: true,
      detail: `Client ID: ${clientId.slice(0, 20)}...`,
    });
  } else {
    checks.push({
      label: 'OAuth credentials configured',
      ok: false,
      detail: 'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET not set. Run skill setup.',
    });
    process.stdout.write(JSON.stringify({ healthy: false, checks }, null, 2));
    process.exit(1);
    return;
  }

  // 3. Check for auth tokens
  const tokenLocations = [
    join(homedir(), '.workspace-mcp', 'token.json'),
    join(homedir(), '.workspace-mcp', 'credentials.json'),
    join(homedir(), '.config', 'workspace-mcp', 'token.json'),
  ];
  const foundToken = tokenLocations.find(p => existsSync(p));
  if (foundToken) {
    checks.push({ label: 'Auth tokens present', ok: true, detail: foundToken });
  } else {
    checks.push({
      label: 'Auth tokens present',
      ok: false,
      detail: 'No token found in ~/.workspace-mcp/. Run: uvx workspace-mcp --single-user',
    });
    process.stdout.write(JSON.stringify({ healthy: false, checks }, null, 2));
    process.exit(1);
    return;
  }

  // 4. Smoke test workspace-mcp CLI (list Gmail labels — lightweight read-only call)
  const env = { ...process.env };
  if (clientId) env.GOOGLE_OAUTH_CLIENT_ID = clientId;
  if (clientSecret) env.GOOGLE_OAUTH_CLIENT_SECRET = clientSecret;

  const smokeTest = spawnSync(
    'uvx',
    ['workspace-mcp', '--cli', 'list_gmail_labels', '--args', '{}'],
    { env, encoding: 'utf-8', timeout: 30000 }
  );

  if (smokeTest.error || smokeTest.status !== 0) {
    const detail = smokeTest.stderr?.trim() || smokeTest.error?.message || `Exit code ${smokeTest.status}`;
    checks.push({ label: 'workspace-mcp reachable', ok: false, detail });
  } else {
    checks.push({ label: 'workspace-mcp reachable', ok: true, detail: 'Gmail API call succeeded' });
  }

  const allOk = checks.every(c => c.ok);
  process.stdout.write(JSON.stringify({ healthy: allOk, checks }, null, 2));
  process.exit(allOk ? 0 : 1);
}

main();
