#!/usr/bin/env node
/**
 * Pipedream skill setup hook.
 * Validates credentials and obtains initial access token.
 */

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
  } catch { /* ignore */ }

  const result = { fields: {}, validated: false };
  const authMethod = config.auth_method || 'oauth';

  if (authMethod === 'oauth') {
    const clientId = config.oauth_client_id;
    const clientSecret = config.oauth_client_secret;

    if (clientId && clientSecret) {
      try {
        const res = await fetch('https://api.pipedream.com/v1/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          result.validated = true;
          result.fields.oauth_access_token = data.access_token;
          result.fields.oauth_token_expires_at = new Date(
            Date.now() + data.expires_in * 1000
          ).toISOString();
          result.fields.status = 'connected';
        } else {
          result.fields.status = `OAuth token exchange failed: HTTP ${res.status}`;
        }
      } catch (err) {
        result.fields.status = `Connection error: ${err.message}`;
      }
    } else {
      result.fields.status = 'OAuth credentials not configured';
      result.fields.setup_instructions =
        'Enter your OAuth Client ID and Secret from pipedream.com/settings/api';
    }
  } else if (authMethod === 'api_key') {
    const key = config.api_key;
    if (key) {
      try {
        const res = await fetch('https://api.pipedream.com/v1/users/me', {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (res.ok) {
          result.validated = true;
          result.fields.status = 'API key validated';
        } else {
          result.fields.status = `API key invalid: HTTP ${res.status}`;
        }
      } catch (err) {
        result.fields.status = `Connection error: ${err.message}`;
      }
    } else {
      result.fields.status = 'API key not configured';
    }
  }

  process.stdout.write(JSON.stringify(result));
}

main();
