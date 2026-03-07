#!/usr/bin/env node
/**
 * GitHub API handler — raw REST and GraphQL requests.
 * Escape hatch for anything not covered by the specialized handlers.
 */
import { gh, readParams, respond, fail, truncate } from './lib.js';

async function main() {
  const p = await readParams();
  if (!p.endpoint) fail('endpoint is required');

  if (p.endpoint === 'graphql') {
    // GraphQL request
    if (!p.query) fail('query is required for GraphQL');
    const args = ['api', 'graphql'];
    args.push('--field', `query=${p.query}`);
    if (p.variables && typeof p.variables === 'object') {
      for (const [k, v] of Object.entries(p.variables)) {
        args.push('--field', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
      }
    }
    if (p.jq) args.push('--jq', p.jq);
    const res = gh(args);
    if (!res.ok) return respond({ error: res.error });
    // Try to parse as JSON for cleaner output
    const text = res.text ?? '';
    try {
      return respond({ result: JSON.stringify(JSON.parse(text), null, 2) });
    } catch {
      return respond({ result: truncate(text) });
    }
  }

  // REST request
  const method = (p.method ?? 'GET').toUpperCase();
  const args = ['api', p.endpoint, '--method', method];

  if (p.body && typeof p.body === 'object' && ['POST', 'PUT', 'PATCH'].includes(method)) {
    for (const [k, v] of Object.entries(p.body)) {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      args.push('--field', `${k}=${val}`);
    }
  }

  if (p.jq) args.push('--jq', p.jq);
  if (p.paginate) args.push('--paginate');

  const res = gh(args);
  if (!res.ok) return respond({ error: res.error });

  const text = res.text ?? '';
  try {
    const parsed = JSON.parse(text);
    return respond({ result: truncate(JSON.stringify(parsed, null, 2)) });
  } catch {
    return respond({ result: truncate(text) });
  }
}

main();
