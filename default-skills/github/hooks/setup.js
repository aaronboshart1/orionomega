#!/usr/bin/env node
/**
 * GitHub skill setup handler.
 * 
 * When invoked as postInstall: checks if gh is already authenticated.
 * When invoked as setup handler: receives config on stdin, validates auth,
 * returns updated config fields.
 */
import { execFileSync } from 'node:child_process';

async function main() {
  // Read config from stdin (may be empty for postInstall)
  let config = {};
  try {
    let raw = '';
    process.stdin.setEncoding('utf-8');
    // Non-blocking read with timeout
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    await new Promise((resolve) => {
      process.stdin.on('end', resolve);
      setTimeout(resolve, 500); // Don't hang if no stdin
    });
    raw = chunks.join('');
    if (raw.trim()) config = JSON.parse(raw);
  } catch {}

  const result = { fields: {}, validated: false };

  // Check if gh is authenticated
  try {
    const status = execFileSync('gh', ['auth', 'status'], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    // Extract username
    const userMatch = status.match(/Logged in to \S+ account (\S+)/);
    if (userMatch) {
      result.fields.authenticated_user = userMatch[1];
    }

    // Extract token scopes
    const scopeMatch = status.match(/Token scopes: '([^']+)'/);
    if (scopeMatch) {
      result.fields.token_scopes = scopeMatch[1];
    }

    result.validated = true;
  } catch {
    // gh not authenticated — that's ok for postInstall, setup wizard will handle it
    result.validated = false;
  }

  // Check API rate limit
  if (result.validated) {
    try {
      const rate = execFileSync('gh', ['api', '/rate_limit', '--jq', '.rate.remaining'], {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
      result.fields.rate_limit_remaining = parseInt(rate, 10);
    } catch {}
  }

  process.stdout.write(JSON.stringify(result));
}

main();
