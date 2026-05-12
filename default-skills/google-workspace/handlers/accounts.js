#!/usr/bin/env node
/**
 * Accounts handler — list configured Google Workspace accounts and
 * change which one is active by default. Lets the agent discover
 * what's available and switch contexts without restarting.
 */
import { readParams, respond, fail, truncate } from './lib.js';
import { loadAccountsState, setActiveAccount, getSkillsDir } from '../hooks/_accounts.js';

function findAccount(accounts, needle) {
  if (!needle) return null;
  const n = String(needle).trim().toLowerCase();
  for (const a of Object.values(accounts)) {
    if (
      a.id?.toLowerCase() === n ||
      a.label?.toLowerCase() === n ||
      a.USER_GOOGLE_EMAIL?.toLowerCase() === n
    ) return a;
  }
  return null;
}

function summarize(a, isActive) {
  return {
    id: a.id,
    label: a.label || a.id,
    email: a.USER_GOOGLE_EMAIL || null,
    port: a.port ?? null,
    active: !!isActive,
  };
}

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required (list | get_active | set_active)');

  const skillsDir = getSkillsDir();
  const { accounts, activeAccountId } = loadAccountsState(skillsDir);
  const list = Object.values(accounts).map((a) => summarize(a, a.id === activeAccountId));

  if (p.action === 'list') {
    return respond({ result: truncate(JSON.stringify({ accounts: list, activeAccountId }, null, 2)) });
  }

  if (p.action === 'get_active') {
    const a = activeAccountId ? accounts[activeAccountId] : null;
    if (!a) return respond({ result: 'No active Google Workspace account configured.' });
    return respond({ result: truncate(JSON.stringify(summarize(a, true), null, 2)) });
  }

  if (p.action === 'set_active') {
    const target = p.account ?? p.account_id ?? p.accountId;
    if (!target) return respond({ error: 'set_active requires `account` (id, label, or email).' });
    const found = findAccount(accounts, target);
    if (!found) {
      return respond({
        error: `No account matches "${target}". Available: ${list.map((a) => a.id).join(', ') || '(none)'}`,
      });
    }
    setActiveAccount(skillsDir, found.id);
    return respond({
      result: `Active account set to "${found.id}" (${found.USER_GOOGLE_EMAIL || 'no email'}). Subsequent calls without an explicit \`account\` arg will use this one.`,
    });
  }

  return respond({ error: `Unknown action "${p.action}". Valid: list, get_active, set_active.` });
}

main();
