#!/usr/bin/env node
/**
 * Pipedream components handler — list, retrieve, configure, and reload component props.
 */
import {
  apiCall, readParams, respond, fail, isFeatureEnabled,
  getProjectId, getDefaultExternalUserId,
} from './lib.js';

async function main() {
  if (!isFeatureEnabled('components')) {
    fail('Components feature is not enabled. Go to Settings → Skills → Pipedream → Enable Components.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  const projId = getProjectId();
  if (!projId) fail('project_id is not configured. Go to Settings → Skills → Pipedream and enter your Project ID.');

  switch (p.action) {
    case 'list_components': {
      const params = new URLSearchParams();
      if (p.query) params.set('q', p.query);
      if (p.app) params.set('app', p.app);
      if (p.component_type) params.set('type', p.component_type);
      if (p.limit) params.set('limit', String(p.limit));
      const qs = params.toString();

      const res = await apiCall('GET', `/connect/${projId}/components${qs ? '?' + qs : ''}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'get_component': {
      if (!p.component_key) fail('component_key is required for get_component');

      const res = await apiCall('GET', `/connect/${projId}/components/${encodeURIComponent(p.component_key)}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'configure_prop': {
      if (!p.component_key) fail('component_key is required for configure_prop');
      if (!p.prop_name) fail('prop_name is required for configure_prop');

      const extUserId = getDefaultExternalUserId(p.external_user_id);
      if (!extUserId) fail('external_user_id is required for configure_prop');

      const body = {
        external_user_id: extUserId,
        id: p.component_key,
        prop_name: p.prop_name,
        configured_props: p.configured_props || {},
      };

      const res = await apiCall('POST', `/connect/${projId}/components/configure`, body);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'reload_props': {
      if (!p.component_key) fail('component_key is required for reload_props');

      const extUserId = getDefaultExternalUserId(p.external_user_id);
      if (!extUserId) fail('external_user_id is required for reload_props');

      const body = {
        external_user_id: extUserId,
        id: p.component_key,
        configured_props: p.configured_props || {},
      };

      const res = await apiCall('POST', `/connect/${projId}/components/props`, body);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    default:
      fail(`Unknown action "${p.action}". Valid: list_components, get_component, configure_prop, reload_props`);
  }
}

main();
