#!/usr/bin/env node
/**
 * Linear skill setup handler.
 * Validates the API key and returns workspace info.
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
  } catch {}

  const result = { fields: {}, validated: false };

  const apiKey = config.fields?.LINEAR_API_KEY || process.env.LINEAR_API_KEY;
  if (!apiKey) {
    process.stdout.write(JSON.stringify(result));
    return;
  }

  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query: '{ viewer { id name email } organization { name urlKey } }' }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();
    if (json.data?.viewer) {
      result.validated = true;
      result.fields.authenticated_user = json.data.viewer.name;
      result.fields.user_email = json.data.viewer.email;
      if (json.data.organization) {
        result.fields.organization = json.data.organization.name;
        result.fields.workspace_slug = json.data.organization.urlKey;
      }
    }
  } catch {}

  process.stdout.write(JSON.stringify(result));
}

main();
