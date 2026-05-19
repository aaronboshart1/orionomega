#!/usr/bin/env node
/**
 * Pipedream users handler — manage external users and create Connect tokens
 * for frontend authorization flows.
 */
import {
  apiCall, readParams, respond, fail,
  getProjectId, getDefaultExternalUserId, isFeatureEnabled,
} from './lib.js';

async function main() {
  if (!isFeatureEnabled('users')) {
    fail('Users feature is not enabled. Go to Settings → Skills → Pipedream → Enable User Management.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  const projId = getProjectId();
  if (!projId) fail('project_id is not configured');

  switch (p.action) {
    case 'list_users': {
      const params = new URLSearchParams();
      if (p.limit) params.set('limit', String(p.limit));
      const qs = params.toString();

      const res = await apiCall('GET', `/connect/${projId}/users${qs ? '?' + qs : ''}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'delete_user': {
      const userId = p.external_user_id || getDefaultExternalUserId();
      if (!userId) fail('external_user_id is required for delete_user');

      const res = await apiCall('DELETE', `/connect/${projId}/users/${encodeURIComponent(userId)}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data ?? { deleted: true } });
    }

    case 'create_connect_token': {
      const extUserId = p.external_user_id || getDefaultExternalUserId();
      if (!extUserId) fail('external_user_id is required for create_connect_token');

      const body = { external_user_id: extUserId };

      if (p.token_expires_in !== undefined) body.expires_in = p.token_expires_in;
      if (p.token_scope) body.token_scope = p.token_scope;
      if (p.webhook_uri) body.webhook_uri = p.webhook_uri;
      if (p.success_redirect_uri) body.success_redirect_uri = p.success_redirect_uri;
      if (p.error_redirect_uri) body.error_redirect_uri = p.error_redirect_uri;

      const res = await apiCall('POST', `/connect/${projId}/tokens`, body);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    default:
      fail(`Unknown action "${p.action}". Valid: list_users, delete_user, create_connect_token`);
  }
}

main();
