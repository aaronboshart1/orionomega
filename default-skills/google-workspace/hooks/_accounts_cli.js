#!/usr/bin/env node
/**
 * CLI shim around `_accounts.js` so the TypeScript gateway can perform
 * multi-account CRUD without duplicating the migration / persistence
 * logic. Reads stdin (JSON body where applicable) and writes one JSON
 * blob to stdout. Non-zero exit on error.
 *
 * Usage:
 *   _accounts_cli.js list
 *   _accounts_cli.js create        # stdin: { label, fields? }
 *   _accounts_cli.js update <id>   # stdin: { label?, fields...? }
 *   _accounts_cli.js delete <id>
 *   _accounts_cli.js activate <id>
 */
import {
  listAccounts, createAccount, updateAccount, deleteAccount, setActiveAccount, getSkillsDir,
} from './_accounts.js';

async function readStdinJson() {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function emit(obj) { process.stdout.write(JSON.stringify(obj)); }
function fail(msg) { process.stderr.write(String(msg)); process.exit(1); }

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const skillsDir = getSkillsDir();
  try {
    switch (cmd) {
      case 'list': {
        emit(listAccounts(skillsDir));
        return;
      }
      case 'create': {
        const body = await readStdinJson();
        const account = createAccount(skillsDir, {
          id: body.id,
          label: body.label,
          fields: body.fields || {},
        });
        emit({ ok: true, account });
        return;
      }
      case 'update': {
        if (!arg) return fail('update requires <id>');
        const body = await readStdinJson();
        const patch = {};
        if (typeof body.label === 'string') patch.label = body.label;
        const f = body.fields || body;
        for (const k of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI', 'USER_GOOGLE_EMAIL']) {
          if (typeof f[k] === 'string') patch[k] = f[k];
        }
        const account = updateAccount(skillsDir, arg, patch);
        emit({ ok: true, account });
        return;
      }
      case 'delete': {
        if (!arg) return fail('delete requires <id>');
        emit(deleteAccount(skillsDir, arg));
        return;
      }
      case 'activate': {
        if (!arg) return fail('activate requires <id>');
        emit(setActiveAccount(skillsDir, arg));
        return;
      }
      default:
        fail(`Unknown command: ${cmd}`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

main();
