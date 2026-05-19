#!/usr/bin/env node
/**
 * Pipedream apps handler — search and browse the app catalog.
 * These endpoints are global (no project_id in path).
 */
import {
  apiCall, readParams, respond, fail, isFeatureEnabled,
} from './lib.js';

async function main() {
  if (!isFeatureEnabled('apps')) {
    fail('App catalog feature is not enabled. Go to Settings → Skills → Pipedream → Enable App Catalog.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  switch (p.action) {
    case 'list_apps': {
      const params = new URLSearchParams();
      if (p.query) params.set('q', p.query);
      if (p.limit) params.set('limit', String(p.limit));
      if (p.has_actions) params.set('has_actions', 'true');
      if (p.has_triggers) params.set('has_triggers', 'true');
      if (p.category_ids && Array.isArray(p.category_ids) && p.category_ids.length > 0) {
        params.set('category_ids', p.category_ids.join(','));
      }
      const qs = params.toString();

      const res = await apiCall('GET', `/connect/apps${qs ? '?' + qs : ''}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'get_app': {
      if (!p.app_id) fail('app_id is required for get_app');

      const res = await apiCall('GET', `/connect/apps/${encodeURIComponent(p.app_id)}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'list_categories': {
      const res = await apiCall('GET', '/connect/apps/categories');
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    default:
      fail(`Unknown action "${p.action}". Valid: list_apps, get_app, list_categories`);
  }
}

main();
