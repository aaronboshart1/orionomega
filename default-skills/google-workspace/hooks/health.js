#!/usr/bin/env node
/**
 * Health check hook for the google-workspace skill (multi-account aware).
 *
 * Reports overall health = healthy IF at least one configured account has
 * OAuth credentials AND tokens. Per-account state is included in `checks`
 * so the UI can show which accounts are wired up.
 */
import { spawnSync } from 'node:child_process';
import { listAccounts, getAccountCredentialsDir } from './_accounts.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function emit(healthy, message, checks) {
  process.stdout.write(JSON.stringify({ healthy, message, checks }, null, 2));
  process.exit(0);
}

function hasToken(credDir) {
  if (!existsSync(credDir)) return false;
  try {
    for (const e of readdirSync(credDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.json')) {
        try {
          const t = JSON.parse(readFileSync(join(credDir, e.name), 'utf-8'));
          if (t.token || t.access_token || t.refresh_token) return true;
        } catch {}
      } else if (e.isDirectory()) {
        const p = join(credDir, e.name, 'token.json');
        if (existsSync(p)) {
          try {
            const t = JSON.parse(readFileSync(p, 'utf-8'));
            if (t.token || t.access_token || t.refresh_token) return true;
          } catch {}
        }
      }
    }
  } catch {}
  return false;
}

async function main() {
  const checks = [];

  const uvxCheck = spawnSync('uvx', ['--version'], { encoding: 'utf-8', timeout: 10_000 });
  if (uvxCheck.error || uvxCheck.status !== 0) {
    checks.push({ label: 'uvx installed', ok: false, detail: 'uvx not found on PATH. Install with: curl -LsSf https://astral.sh/uv/install.sh | sh' });
    return emit(false, 'uvx is required to run workspace-mcp.', checks);
  }
  checks.push({ label: 'uvx installed', ok: true, detail: uvxCheck.stdout?.trim() ?? 'ok' });

  const { accounts, activeAccountId } = listAccounts();
  if (accounts.length === 0) {
    checks.push({ label: 'Accounts configured', ok: false, detail: 'No Google Workspace accounts configured. Add one in Settings → Skills → Google Workspace.' });
    return emit(false, 'No Google Workspace accounts configured.', checks);
  }
  checks.push({ label: 'Accounts configured', ok: true, detail: `${accounts.length} account(s); active: ${activeAccountId || '(none)'}` });

  let anyHealthy = false;
  for (const a of accounts) {
    const credsOk = !!(a.GOOGLE_OAUTH_CLIENT_ID && a.GOOGLE_OAUTH_CLIENT_SECRET);
    const tokenOk = hasToken(getAccountCredentialsDir(a.id));
    const ok = credsOk && tokenOk;
    if (ok) anyHealthy = true;
    checks.push({
      label: `Account: ${a.label}`,
      ok,
      detail: !credsOk
        ? 'Missing OAuth client credentials'
        : !tokenOk
          ? 'Not yet authenticated (no OAuth tokens stored)'
          : `Connected (${a.USER_GOOGLE_EMAIL || 'email unknown'})`,
    });
  }

  return emit(anyHealthy,
    anyHealthy ? 'Google Workspace skill is healthy.' : 'No accounts are fully connected yet.',
    checks);
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({
    healthy: false,
    message: `Health check crashed: ${err instanceof Error ? err.message : String(err)}`,
    checks: [],
  }));
  process.exit(0);
});
