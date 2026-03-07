#!/usr/bin/env node
/**
 * Health check: verifies Linear API key is set and can reach the API.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function check(label, fn) {
  try {
    const result = fn();
    return { label, ok: true, detail: result };
  } catch (err) {
    return { label, ok: false, detail: err.message ?? String(err) };
  }
}

async function main() {
  const checks = [];

  // Check API key
  let apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    const configPath = join(homedir(), '.orionomega', 'skills', 'linear', 'config.json');
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        apiKey = config.fields?.LINEAR_API_KEY;
      } catch {}
    }
  }

  if (apiKey) {
    checks.push({ label: 'API key configured', ok: true, detail: `${apiKey.slice(0, 8)}...` });
  } else {
    checks.push({ label: 'API key configured', ok: false, detail: 'No LINEAR_API_KEY found in env or skill config' });
    process.stdout.write(JSON.stringify({ healthy: false, checks }, null, 2));
    process.exit(1);
    return;
  }

  // Check API reachability
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query: '{ viewer { id name } }' }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();
    if (json.data?.viewer?.name) {
      checks.push({ label: 'API reachable', ok: true, detail: `Authenticated as ${json.data.viewer.name}` });
    } else if (json.errors) {
      checks.push({ label: 'API reachable', ok: false, detail: json.errors[0]?.message ?? 'Unknown error' });
    } else {
      checks.push({ label: 'API reachable', ok: false, detail: `HTTP ${res.status}` });
    }
  } catch (err) {
    checks.push({ label: 'API reachable', ok: false, detail: err.message ?? String(err) });
  }

  const allOk = checks.every(c => c.ok);
  process.stdout.write(JSON.stringify({ healthy: allOk, checks }, null, 2));
  process.exit(allOk ? 0 : 1);
}

main();
