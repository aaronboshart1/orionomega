#!/usr/bin/env node
/**
 * Pipedream Connect API Proxy handler.
 *
 * Routes requests through /connect/{proj}/proxy/{app}/{path} with automatic
 * credential injection. Supports all HTTP methods (GET, POST, PUT, PATCH, DELETE).
 *
 * Required Pipedream headers per spec §5.8:
 *   x-pd-environment       — development | production
 *   x-pd-account-id        — Account ID (apn_xxx), OR
 *   x-pd-external-user-id  — External user ID (alternative to account_id)
 *
 * Timeout: 30 seconds.
 */
import {
  apiCall,
  readParams,
  respond,
  fail,
  truncate,
  getProjectId,
  getEnvironment,
  getDefaultExternalUserId,
  isFeatureEnabled,
} from './lib.js';

async function main() {
  if (!isFeatureEnabled('proxy')) {
    fail('Connect Proxy is not enabled. Go to Settings → Skills → Pipedream → Enable Connect Proxy.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  switch (p.action) {
    case 'proxy_request': {
      if (!p.app) fail('app is required for proxy_request');

      const projId = getProjectId();
      if (!projId) fail('project_id is not configured');

      const method = (p.method || 'GET').toUpperCase();
      const env = getEnvironment();
      const extUserId = p.external_user_id || getDefaultExternalUserId();

      // ── Build the target path ─────────────────────────────────────
      // url may be a full URL (https://slack.com/api/chat.postMessage)
      // or a relative path (/api/chat.postMessage or api/chat.postMessage).
      // The proxy endpoint only takes the path portion after the app slug.
      let targetPath = p.url || '';

      if (targetPath.startsWith('http')) {
        try {
          const u = new URL(targetPath);
          // Use pathname + search but strip the leading slash — we'll add it below
          targetPath = u.pathname.replace(/^\//, '') + u.search;
        } catch { /* use as-is */ }
      } else {
        // Strip leading slash so we can insert one consistently
        targetPath = targetPath.replace(/^\//, '');
      }

      // ── Build the proxy API path ──────────────────────────────────
      // /connect/{proj}/proxy/{app}/{path}
      let apiPath = `/connect/${projId}/proxy/${encodeURIComponent(p.app)}`;
      if (targetPath) apiPath += `/${targetPath}`;

      // Append query_params if provided
      if (p.query_params && typeof p.query_params === 'object' && Object.keys(p.query_params).length > 0) {
        const qs = new URLSearchParams(
          Object.entries(p.query_params).map(([k, v]) => [k, String(v)])
        ).toString();
        apiPath += (apiPath.includes('?') ? '&' : '?') + qs;
      }

      // ── Build extra headers ───────────────────────────────────────
      const extraHeaders = {
        'x-pd-environment': env,
      };

      if (p.account_id) {
        extraHeaders['x-pd-account-id'] = p.account_id;
      } else if (extUserId) {
        extraHeaders['x-pd-external-user-id'] = extUserId;
      }

      // Merge any caller-supplied custom headers
      if (p.headers && typeof p.headers === 'object') {
        for (const [k, v] of Object.entries(p.headers)) {
          if (k && v !== undefined && v !== null) {
            extraHeaders[k] = String(v);
          }
        }
      }

      // ── Body (only for mutating methods) ─────────────────────────
      const body = (method !== 'GET' && method !== 'DELETE' && p.body)
        ? p.body
        : null;

      // ── Execute via apiCall (handles auth + 401 retry) ───────────
      const res = await apiCall(method, apiPath, body, {
        timeout: 30_000,
        extraHeaders,
      });

      if (!res.ok) return respond({ error: res.error });

      return respond({
        result: {
          app: p.app,
          method,
          path: targetPath || '/',
          data: res.data !== undefined ? res.data : null,
        },
      });
    }

    default:
      fail(`Unknown action "${p.action}". Valid: proxy_request`);
  }
}

main();
