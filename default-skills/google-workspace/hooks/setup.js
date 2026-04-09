#!/usr/bin/env node
/**
 * Google Workspace skill setup handler.
 * Validates OAuth credentials and checks for existing auth tokens.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

async function main() {
  let config = {};
  try {
    let raw = '';
    process.stdin.setEncoding('utf-8');
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    await new Promise((resolve) => {
      process.stdin.on('end', resolve);
      setTimeout(resolve, 500);
    });
    raw = chunks.join('');
    if (raw.trim()) config = JSON.parse(raw);
  } catch {}

  const result = { fields: {}, validated: false };

  const clientId = config.fields?.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = config.fields?.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    result.fields.setup_instructions =
      '1. Go to console.cloud.google.com → APIs & Services → Credentials\n' +
      '2. Create an OAuth 2.0 Client ID (Desktop Application)\n' +
      '3. Enable: Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, Tasks, People, Chat, Apps Script APIs\n' +
      '4. Enter your Client ID and Client Secret above\n' +
      '5. After saving, run: uvx workspace-mcp --single-user  (opens browser for OAuth flow)';
    process.stdout.write(JSON.stringify(result));
    return;
  }

  // Check for existing auth tokens from workspace-mcp
  const tokenLocations = [
    join(homedir(), '.workspace-mcp', 'token.json'),
    join(homedir(), '.workspace-mcp', 'credentials.json'),
    join(homedir(), '.config', 'workspace-mcp', 'token.json'),
  ];

  const tokenExists = tokenLocations.some(p => existsSync(p));

  if (tokenExists) {
    result.validated = true;
    result.fields.credentials_status = 'OAuth credentials configured';
    result.fields.auth_status = 'Auth tokens found — ready to use';
    result.fields.client_id_prefix = clientId.slice(0, 20) + '...';
  } else {
    result.validated = false;
    result.fields.credentials_status = 'OAuth credentials configured';
    result.fields.auth_status = 'Auth tokens not found — complete setup by running: uvx workspace-mcp --single-user';
    result.fields.client_id_prefix = clientId.slice(0, 20) + '...';
    result.fields.next_step =
      'Run `uvx workspace-mcp --single-user` to open the Google OAuth browser flow and authorize access. ' +
      'This only needs to be done once. Tokens are stored in ~/.workspace-mcp/';
  }

  process.stdout.write(JSON.stringify(result));
}

main();
