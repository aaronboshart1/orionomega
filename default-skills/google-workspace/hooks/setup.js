#!/usr/bin/env node
/**
 * Post-setup validation hook for the google-workspace skill.
 *
 * Runs after the user submits the skill settings form. Reads the
 * submitted config from stdin (the SDK passes `{ fields, ... }`),
 * validates that OAuth client credentials are present, and reports
 * whether the in-app OAuth flow has been completed (i.e. an access or
 * refresh token has been stored).
 *
 * The OAuth browser flow itself is driven by the gateway via
 * `hooks/oauth-start.js` and `hooks/oauth-status.js`, not by this
 * script — this script only validates the resulting state.
 */

async function readStdin() {
  const chunks = [];
  process.stdin.setEncoding('utf-8');
  return await new Promise((resolve) => {
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    // If stdin is not piped at all, resolve quickly with whatever we have.
    setTimeout(() => resolve(chunks.join('')), 500);
  });
}

async function main() {
  let config = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) config = JSON.parse(raw);
  } catch {
    // tolerate missing/invalid stdin — fall back to env vars
  }

  const fields = config.fields ?? {};
  const clientId = fields.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = fields.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const accessToken = fields.GOOGLE_ACCESS_TOKEN;
  const refreshToken = fields.GOOGLE_REFRESH_TOKEN;

  const result = { fields: {}, validated: false };

  if (!clientId || !clientSecret) {
    result.fields.setup_instructions =
      '1. Visit https://console.cloud.google.com → APIs & Services → Credentials\n' +
      '2. Create an OAuth 2.0 Client ID (Application type: Web application)\n' +
      '3. Add an Authorized redirect URI matching GOOGLE_OAUTH_REDIRECT_URI (default: http://localhost:4100)\n' +
      '4. Enable the APIs you want to use (Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, Tasks, People, Chat, Apps Script)\n' +
      '5. Paste the Client ID and Client Secret into the fields above and save\n' +
      '6. Then click "Connect Google account" to authorize access in your browser';
    process.stdout.write(JSON.stringify(result));
    return;
  }

  result.fields.client_id_prefix = String(clientId).slice(0, 20) + '…';
  result.fields.credentials_status = 'OAuth client credentials saved';

  if (accessToken || refreshToken) {
    result.validated = true;
    result.fields.auth_status = 'Connected — Google account authorized';
  } else {
    result.validated = false;
    result.fields.auth_status = 'Not connected yet';
    result.fields.next_step =
      'Click "Connect Google account" in Settings → Skills → Google Workspace to complete the OAuth flow.';
  }

  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({
    fields: {},
    validated: false,
    error: err instanceof Error ? err.message : String(err),
  }));
  process.exit(1);
});
