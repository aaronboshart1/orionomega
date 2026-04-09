#!/usr/bin/env node
/**
 * Google Custom Search handler — web and image search via Programmable Search Engine.
 */
import { workspace, readParams, respond, fail, truncate, cleanArgs } from './lib.js';

const ACTION_MAP = {
  search:          'search_custom',
  get_engine_info: 'get_search_engine_info',
};

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown action "${p.action}". Valid actions: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  if (p.action === 'search' && !p.q) fail('q (search query) is required for search action');

  const { action: _, ...rest } = p;
  const args = cleanArgs(rest);

  const res = workspace(toolName, args);
  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

main();
