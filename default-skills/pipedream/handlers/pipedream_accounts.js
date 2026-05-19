#!/usr/bin/env node
/**
 * Pipedream accounts handler — list, retrieve, and delete connected accounts
 * (OAuth and API key connections for end users).
 */
import {
  apiCall, readParams, respond, fail,
  getProjectId, isFeatureEnabled,
} from './lib.js';

async function main() {
  if (!isFeatureEnabled('accounts')) {
    fail('Accounts feature is not enabled. Go to Settings → Skills → Pipedream → Enable Account Management.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  const projId = getProjectId();
  if (!projId) fail('project_id is not configured');

  switch (p.action) {
    case 'list_accounts': {
      const params = new URLSearchParams();
      if (p.external_user_id) params.set('external_user_id', p.external_user_id);
      if (p.app) params.set('app', p.app);
      if (p.limit) params.set('limit', String(p.limit));
      const qs = params.toString();

      const res = await apiCall('GET', `/connect/${projId}/accounts${qs ? '?' + qs : ''}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'get_account': {
      if (!p.account_id) fail('account_id is required for get_account');

      const params = new URLSearchParams();
      if (p.include_credentials) params.set('include_credentials', '1');
      const qs = params.toString();

      const res = await apiCall('GET', `/connect/${projId}/accounts/${encodeURIComponent(p.account_id)}${qs ? '?' + qs : ''}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data });
    }

    case 'delete_account': {
      if (!p.account_id) fail('account_id is required for delete_account');

      const res = await apiCall('DELETE', `/connect/${projId}/accounts/${encodeURIComponent(p.account_id)}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data ?? { deleted: true } });
    }

    case 'delete_accounts_by_app': {
      if (!p.app) fail('app is required for delete_accounts_by_app');

      const res = await apiCall('DELETE', `/connect/${projId}/accounts?app=${encodeURIComponent(p.app)}`);
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: res.data ?? { deleted: true } });
    }

    default:
      fail(`Unknown action "${p.action}". Valid: list_accounts, get_account, delete_account, delete_accounts_by_app`);
  }
}

main();
