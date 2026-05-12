#!/usr/bin/env node
/**
 * Cross-product Atlassian search handler — Rovo search, fetch, Teamwork Graph,
 * user info, and accessible resources.
 */
import { mcpCall, readParams, respond, fail, truncate, cleanArgs, isProductEnabled, getMaxResults, getCloudId } from './lib.js';

const ACTION_MAP = {
  search:          'searchAtlassian',
  fetch:           'fetchAtlassian',
  get_context:     'getTeamworkGraphContext',
  get_object:      'getTeamworkGraphObject',
  get_user_info:   'atlassianUserInfo',
  list_resources:  'getAccessibleAtlassianResources',
};

async function main() {
  if (!isProductEnabled('search')) {
    fail('Cross-product search is not enabled. Go to Settings → Skills → Atlassian → Enable Cross-Product Search.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown search action "${p.action}". Valid: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  const args = buildArgs(p);
  const res = await mcpCall(toolName, args);

  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

function buildArgs(p) {
  const cloudId = getCloudId(p.cloud_id);
  const maxResults = getMaxResults(p.max_results);

  switch (p.action) {
    case 'search':
      if (!p.query) fail('query is required for search');
      return cleanArgs({ query: p.query, maxResults, cloudId });

    case 'fetch':
      if (!p.ari) fail('ari is required for fetch');
      return cleanArgs({ ari: p.ari, cloudId });

    case 'get_context':
      if (!p.entity_ari) fail('entity_ari is required for get_context');
      return cleanArgs({ entityAri: p.entity_ari, cloudId });

    case 'get_object':
      if (!p.ari && !p.aris) fail('ari or aris is required for get_object');
      return cleanArgs({
        aris: p.aris || [p.ari],
        cloudId,
      });

    case 'get_user_info':
      return cleanArgs({ cloudId });

    case 'list_resources':
      return cleanArgs({});

    default:
      return cleanArgs({ cloudId });
  }
}

main();
