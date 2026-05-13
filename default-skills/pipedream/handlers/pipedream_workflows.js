#!/usr/bin/env node
/**
 * Pipedream workflows handler — invoke workflows via HTTP trigger.
 *
 * Supports two invocation modes:
 *   - Direct: POST to workflow_url (e.g. https://xxx.m.pipedream.net)
 *   - Connect: Resolve endpoint from workflow_id via Platform REST API, then invoke
 *
 * Passes x-pd-environment and x-pd-external-user-id headers per spec §5.7.
 */
import {
  apiCall,
  readParams,
  respond,
  fail,
  truncate,
  getAccessToken,
  getEnvironment,
  getDefaultExternalUserId,
  isFeatureEnabled,
  fetchWithTimeout,
} from './lib.js';

async function main() {
  if (!isFeatureEnabled('workflows')) {
    fail('Workflow invocation is not enabled. Go to Settings → Skills → Pipedream → Enable Workflow Invocation.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  switch (p.action) {
    case 'invoke_workflow': {
      const method = p.method || 'POST';
      const env = getEnvironment();
      const extUserId = p.external_user_id || getDefaultExternalUserId();

      // ── Mode 1: Direct HTTP trigger via workflow_url ──────────────
      if (p.workflow_url) {
        let token;
        try {
          token = await getAccessToken();
        } catch { /* workflow URLs may not require auth */ }

        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-pd-environment': env,
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        if (extUserId) headers['x-pd-external-user-id'] = extUserId;

        const fetchOpts = { method, headers };
        if (p.payload && method !== 'GET') {
          fetchOpts.body = JSON.stringify(p.payload);
        }

        try {
          const res = await fetchWithTimeout(p.workflow_url, fetchOpts, 60_000);

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            return respond({
              error: `Workflow invocation failed (HTTP ${res.status}): ${truncate(errText, 500)}`,
            });
          }

          const contentType = res.headers.get('content-type') || '';
          let data;
          if (contentType.includes('application/json')) {
            data = await res.json().catch(() => null);
          } else {
            data = await res.text().catch(() => '');
          }

          return respond({ result: { status: res.status, data } });
        } catch (err) {
          if (err.name === 'AbortError') {
            return respond({ error: 'Workflow invocation timed out after 60s' });
          }
          return respond({ error: `Workflow invocation failed: ${err.message}` });
        }
      }

      // ── Mode 2: Resolve endpoint from workflow_id via Platform API ─
      if (p.workflow_id) {
        // Fetch workflow metadata to get its HTTP trigger endpoint
        const workflowRes = await apiCall('GET', `/workflows/${encodeURIComponent(p.workflow_id)}`, null, {
          timeout: 30_000,
        });
        if (!workflowRes.ok) {
          return respond({
            error: `Could not retrieve workflow ${p.workflow_id}: ${workflowRes.error}`,
          });
        }

        const workflow = workflowRes.data?.data ?? workflowRes.data;
        const httpEndpoint =
          workflow?.http_endpoint ||
          workflow?.trigger?.url ||
          workflow?.url;

        if (!httpEndpoint) {
          return respond({
            error: `Workflow ${p.workflow_id} does not have an HTTP trigger endpoint. ` +
              'Use workflow_url to invoke it directly.',
          });
        }

        // Invoke the resolved endpoint
        let token;
        try {
          token = await getAccessToken();
        } catch { /* continue without auth header */ }

        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-pd-environment': env,
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        if (extUserId) headers['x-pd-external-user-id'] = extUserId;

        const fetchOpts = { method, headers };
        if (p.payload && method !== 'GET') {
          fetchOpts.body = JSON.stringify(p.payload);
        }

        try {
          const res = await fetchWithTimeout(httpEndpoint, fetchOpts, 60_000);

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            return respond({
              error: `Workflow invocation failed (HTTP ${res.status}): ${truncate(errText, 500)}`,
            });
          }

          const contentType = res.headers.get('content-type') || '';
          let data;
          if (contentType.includes('application/json')) {
            data = await res.json().catch(() => null);
          } else {
            data = await res.text().catch(() => '');
          }

          return respond({ result: { status: res.status, workflow_id: p.workflow_id, data } });
        } catch (err) {
          if (err.name === 'AbortError') {
            return respond({ error: 'Workflow invocation timed out after 60s' });
          }
          return respond({ error: `Workflow invocation failed: ${err.message}` });
        }
      }

      fail('Either workflow_url or workflow_id is required for invoke_workflow');
      break;
    }

    default:
      fail(`Unknown action "${p.action}". Valid: invoke_workflow`);
  }
}

main();
