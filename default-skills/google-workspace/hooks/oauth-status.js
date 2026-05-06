#!/usr/bin/env node
/**
 * Report OAuth authentication status for a specific Google Workspace account.
 *
 * Account selection:
 *   - GOOGLE_WORKSPACE_ACCOUNT_ID env (set by the gateway), or
 *   - the active account from config.json.
 *
 * stdout JSON:
 *   { authenticated: boolean, accountId?, accountLabel?, email?, tokenAge?, reason? }
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAccount, getAccountCredentialsDir, getSkillsDir } from './_accounts.js';

function inspectFlatToken(filePath, fallbackEmail) {
  try {
    const token = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!token.token && !token.refresh_token && !token.access_token) return null;
    const stat = statSync(filePath);
    const ageHours = Math.round((Date.now() - stat.mtimeMs) / 3600000);
    return {
      email: fallbackEmail,
      hasRefreshToken: !!token.refresh_token,
      tokenAge: ageHours < 24 ? `${ageHours}h ago` : `${Math.round(ageHours / 24)}d ago`,
      lastModified: stat.mtime.toISOString(),
    };
  } catch { return null; }
}

function findToken(credDir, expectedEmail) {
  // Resolve the token for the account's *intended* email first to avoid
  // first-file-wins reporting the wrong status when multiple token
  // artifacts exist in the same per-account credentials dir (e.g. the
  // user re-authenticated under a different Google address).
  if (!existsSync(credDir)) return null;
  let entries;
  try { entries = readdirSync(credDir, { withFileTypes: true }); } catch { return null; }

  const wanted = (expectedEmail || '').toLowerCase();

  // Pass 1 (preferred): exact match for `<expectedEmail>.json` or
  // `<expectedEmail>/token.json`.
  if (wanted) {
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === `${wanted}.json`) {
        const info = inspectFlatToken(join(credDir, entry.name), entry.name.replace(/\.json$/, ''));
        if (info) return { ...info, matched: 'exact' };
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLowerCase() === wanted) {
        const tokenPath = join(credDir, entry.name, 'token.json');
        if (existsSync(tokenPath)) {
          const info = inspectFlatToken(tokenPath, entry.name);
          if (info) return { ...info, matched: 'exact' };
        }
      }
    }
  }

  // Pass 2 (fallback): any valid token in this account's dir. We mark
  // the result as `matched: 'fallback'` so callers can surface a
  // "connected as <other email>" hint instead of pretending it's the
  // expected account.
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const email = entry.name.replace(/\.json$/, '');
      const info = inspectFlatToken(join(credDir, entry.name), email);
      if (info) return { ...info, matched: 'fallback' };
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tokenPath = join(credDir, entry.name, 'token.json');
    if (existsSync(tokenPath)) {
      const info = inspectFlatToken(tokenPath, entry.name);
      if (info) return { ...info, matched: 'fallback' };
    }
  }
  return null;
}

function main() {
  const account = resolveAccount(getSkillsDir());
  if (!account) {
    process.stdout.write(JSON.stringify({ authenticated: false, reason: 'No Google Workspace account configured' }));
    return;
  }
  const credDir = getAccountCredentialsDir(account.id);
  const info = findToken(credDir, account.USER_GOOGLE_EMAIL);
  if (!info) {
    process.stdout.write(JSON.stringify({
      authenticated: false,
      accountId: account.id,
      accountLabel: account.label,
      expectedEmail: account.USER_GOOGLE_EMAIL || null,
      reason: 'No valid tokens found',
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    authenticated: true,
    accountId: account.id,
    accountLabel: account.label,
    email: info.email || account.USER_GOOGLE_EMAIL,
    expectedEmail: account.USER_GOOGLE_EMAIL || null,
    emailMatch: info.matched, // 'exact' | 'fallback'
    hasRefreshToken: info.hasRefreshToken,
    tokenAge: info.tokenAge,
    lastModified: info.lastModified,
  }));
}

main();
