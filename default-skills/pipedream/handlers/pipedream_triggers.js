#!/usr/bin/env node
/**
 * Pipedream triggers handler — list trigger components, configure props,
 * deploy triggers, and manage deployed trigger instances.
 */
import {
  apiCall, readParams, respond, fail, truncate,
  getProjectId, getDefaultExternalUserId, isFeatureEnabled,
} from './lib.js';

async function main() {
  if (!isFeatureEnabled('triggers')) {
    fail('Triggers feature is not enabled. Go to Settings → Skills → Pipedream → Enable Triggers.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  const projId = getProjectId();
  if (!projId) fail('project_id is not configured');

  switch (p.action) {
    case 'list_triggers': {
      const params = new URLSearchParams();
      if (p.query) params.set('q', p.query);
      if (p.app) params.set('app', p.app);
      if (p.limit) params.set('limit', String(p.limit));
      const qs = params.toString();

      const res = await apiCall('GET', `/connect/${projId}/triggers${qs ? '?' + qs : ''}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'get_trigger': {
      if (!p.trigger_key) fail('trigger_key is required for get_trigger');

      const res = await apiCall('GET', `/connect/${projId}/triggers/${encodeURIComponent(p.trigger_key)}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'configure_prop': {
      if (!p.trigger_key) fail('trigger_key is required for configure_prop');
      if (!p.prop_name) fail('prop_name is required for configure_prop');

      const extUserId = p.external_user_id || getDefaultExternalUserId();
      if (!extUserId) fail('external_user_id is required');

      const body = {
        external_user_id: extUserId,
        id: p.trigger_key,
        prop_name: p.prop_name,
        configured_props: p.configured_props || {},
      };

      const res = await apiCall('POST', `/connect/${projId}/triggers/configure`, body);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'reload_props': {
      if (!p.trigger_key) fail('trigger_key is required for reload_props');

      const extUserId = p.external_user_id || getDefaultExternalUserId();
      if (!extUserId) fail('external_user_id is required');

      const body = {
        external_user_id: extUserId,
        id: p.trigger_key,
        configured_props: p.configured_props || {},
      };

      const res = await apiCall('POST', `/connect/${projId}/triggers/props`, body);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'deploy_trigger': {
      if (!p.trigger_key) fail('trigger_key is required for deploy_trigger');
      if (!p.configured_props) fail('configured_props is required for deploy_trigger');
      if (!p.webhook_url && !p.workflow_id) fail('webhook_url or workflow_id is required for deploy_trigger');

      const extUserId = p.external_user_id || getDefaultExternalUserId();
      if (!extUserId) fail('external_user_id is required');

      const body = {
        id: p.trigger_key,
        external_user_id: extUserId,
        configured_props: p.configured_props,
      };

      if (p.webhook_url) body.webhook_url = p.webhook_url;
      if (p.workflow_id) body.workflow_id = p.workflow_id;
      if (p.emit_on_deploy !== undefined) body.emit_on_deploy = p.emit_on_deploy;
      if (p.dynamic_props_id) body.dynamic_props_id = p.dynamic_props_id;
      if (p.version) body.version = p.version;

      const res = await apiCall('POST', `/connect/${projId}/triggers/deploy`, body);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'list_deployed': {
      const params = new URLSearchParams();
      if (p.external_user_id) params.set('external_user_id', p.external_user_id);
      if (p.limit) params.set('limit', String(p.limit));
      const qs = params.toString();

      const res = await apiCall('GET', `/connect/${projId}/deployed-triggers${qs ? '?' + qs : ''}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'get_deployed': {
      if (!p.deployed_trigger_id) fail('deployed_trigger_id is required for get_deployed');

      const res = await apiCall('GET', `/connect/${projId}/deployed-triggers/${encodeURIComponent(p.deployed_trigger_id)}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'update_deployed': {
      if (!p.deployed_trigger_id) fail('deployed_trigger_id is required for update_deployed');
      if (p.active === undefined) fail('active is required for update_deployed');

      const body = { active: p.active };

      const res = await apiCall('PUT', `/connect/${projId}/deployed-triggers/${encodeURIComponent(p.deployed_trigger_id)}`, body);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'delete_deployed': {
      if (!p.deployed_trigger_id) fail('deployed_trigger_id is required for delete_deployed');

      const res = await apiCall('DELETE', `/connect/${projId}/deployed-triggers/${encodeURIComponent(p.deployed_trigger_id)}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data ?? { deleted: true } });
    }

    case 'get_events': {
      if (!p.deployed_trigger_id) fail('deployed_trigger_id is required for get_events');

      const params = new URLSearchParams();
      if (p.limit) params.set('limit', String(p.limit));
      const qs = params.toString();

      const res = await apiCall('GET', `/connect/${projId}/deployed-triggers/${encodeURIComponent(p.deployed_trigger_id)}/events${qs ? '?' + qs : ''}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: truncate(JSON.stringify(res.data), 30_000) });
    }

    default:
      fail(`Unknown action "${p.action}". Valid: list_triggers, get_trigger, configure_prop, reload_props, deploy_trigger, list_deployed, get_deployed, update_deployed, delete_deployed, get_events`);
  }
}

main();
