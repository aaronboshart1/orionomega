#!/usr/bin/env node
/**
 * Pipedream actions handler — list, configure, and run action components.
 * Executes any of 10,000+ pre-built API operations on behalf of connected users.
 */
import {
  apiCall, readParams, respond, fail, truncate,
  getProjectId, getDefaultExternalUserId, isFeatureEnabled,
} from './lib.js';

async function main() {
  if (!isFeatureEnabled('actions')) {
    fail('Actions feature is not enabled. Go to Settings → Skills → Pipedream → Enable Actions.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  const projId = getProjectId();
  if (!projId) fail('project_id is not configured. Go to Settings → Skills → Pipedream and enter your Project ID.');

  switch (p.action) {
    case 'list_actions': {
      const params = new URLSearchParams();
      if (p.query) params.set('q', p.query);
      if (p.app) params.set('app', p.app);
      if (p.limit) params.set('limit', String(p.limit));
      const qs = params.toString();

      const res = await apiCall('GET', `/connect/${projId}/actions${qs ? '?' + qs : ''}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'get_action': {
      if (!p.action_key) fail('action_key is required for get_action');

      const res = await apiCall('GET', `/connect/${projId}/actions/${encodeURIComponent(p.action_key)}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'configure_prop': {
      if (!p.action_key) fail('action_key is required for configure_prop');
      if (!p.prop_name) fail('prop_name is required for configure_prop');

      const extUserId = getDefaultExternalUserId(p.external_user_id);
      if (!extUserId) fail('external_user_id is required for configure_prop');

      const body = {
        external_user_id: extUserId,
        id: p.action_key,
        prop_name: p.prop_name,
        configured_props: p.configured_props || {},
      };

      const res = await apiCall('POST', `/connect/${projId}/actions/configure`, body);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'reload_props': {
      if (!p.action_key) fail('action_key is required for reload_props');

      const extUserId = getDefaultExternalUserId(p.external_user_id);
      if (!extUserId) fail('external_user_id is required for reload_props');

      const body = {
        external_user_id: extUserId,
        id: p.action_key,
        configured_props: p.configured_props || {},
      };

      const res = await apiCall('POST', `/connect/${projId}/actions/props`, body);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'run_action': {
      if (!p.action_key) fail('action_key is required for run_action');
      if (!p.configured_props) fail('configured_props is required for run_action');

      const extUserId = getDefaultExternalUserId(p.external_user_id);
      if (!extUserId) fail('external_user_id is required for run_action');

      const body = {
        id: p.action_key,
        external_user_id: extUserId,
        configured_props: p.configured_props,
      };

      if (p.dynamic_props_id) body.dynamic_props_id = p.dynamic_props_id;
      if (p.version) body.version = p.version;

      const res = await apiCall('POST', `/connect/${projId}/actions/run`, body, { timeout: 55_000 });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: truncate(JSON.stringify(res.data), 30_000) });
    }

    default:
      fail(`Unknown action "${p.action}". Valid: list_actions, get_action, configure_prop, reload_props, run_action`);
  }
}

main();
