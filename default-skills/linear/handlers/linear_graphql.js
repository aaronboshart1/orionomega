#!/usr/bin/env node
/**
 * Linear GraphQL handler — raw escape hatch for any Linear API query or mutation.
 */
import { linear, readParams, respond, fail, truncate } from './lib.js';

async function main() {
  const p = await readParams();
  if (!p.query) fail('query (GraphQL string) is required');

  const res = await linear(p.query, p.variables ?? {});
  if (!res.ok) return respond({ error: res.error });

  return respond({ result: truncate(JSON.stringify(res.data, null, 2)) });
}

main();
