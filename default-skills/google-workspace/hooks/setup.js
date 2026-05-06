#!/usr/bin/env node
/**
 * Post-setup validation hook for the google-workspace skill (multi-account).
 *
 * Reports overall configuration status based on the configured accounts.
 * Always exits 0; only the stdout JSON is consumed.
 */
import { listAccounts, getAccountCredentialsDir } from './_accounts.js';
import { existsSync, readdirSync } from 'node:fs';

async function readStdin() {
  const chunks = [];
  process.stdin.setEncoding('utf-8');
  return await new Promise((resolve) => {
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    setTimeout(() => resolve(chunks.join('')), 500);
  });
}

function tokenCount(credDir) {
  if (!existsSync(credDir)) return 0;
  try {
    return readdirSync(credDir).filter((n) => n.endsWith('.json')).length;
  } catch { return 0; }
}

async function main() {
  try { await readStdin(); } catch {}

  const { accounts, activeAccountId } = listAccounts();
  const result = { fields: {}, validated: false };

  if (accounts.length === 0) {
    result.fields.setup_instructions =
      'No accounts configured yet. In Settings → Skills → Google Workspace, click "+ Add account", then:\n' +
      '1. Visit https://console.cloud.google.com → APIs & Services → Credentials\n' +
      '2. Create an OAuth 2.0 Client ID (Application type: Web application)\n' +
      '3. Add an Authorized redirect URI matching the account\'s redirect URI\n' +
      '4. Paste the Client ID, Client Secret and your Google email into the account form\n' +
      '5. Click "Connect Google account" to complete the OAuth flow';
    process.stdout.write(JSON.stringify(result));
    return;
  }

  const ready = accounts.filter((a) =>
    a.GOOGLE_OAUTH_CLIENT_ID && a.GOOGLE_OAUTH_CLIENT_SECRET && tokenCount(getAccountCredentialsDir(a.id)) > 0,
  );
  result.fields.accounts_count = String(accounts.length);
  result.fields.active_account = activeAccountId || '(none)';
  result.fields.connected_accounts = ready.map((a) => `${a.label} (${a.USER_GOOGLE_EMAIL || a.id})`).join(', ') || '(none yet)';
  result.validated = ready.length > 0;
  result.fields.auth_status = result.validated
    ? `${ready.length}/${accounts.length} account(s) connected`
    : 'No accounts have completed the OAuth flow yet';

  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ fields: {}, validated: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
