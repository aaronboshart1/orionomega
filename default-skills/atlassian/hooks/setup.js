#!/usr/bin/env node
/**
 * Atlassian skill setup handler.
 *
 * When invoked as postInstall: checks if credentials are already configured.
 * When invoked as setup handler: validates auth, performs OAuth flow if needed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { URL } from 'node:url';

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

async function main() {
  // Read config from stdin (may be empty for postInstall)
  let config = {};
  try {
    let raw = '';
    process.stdin.setEncoding('utf-8');
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    await new Promise((resolve) => {
      process.stdin.on('end', resolve);
      setTimeout(resolve, 500);
    });
    raw = chunks.join('');
    if (raw.trim()) config = JSON.parse(raw);
  } catch { /* ignore */ }

  const result = { fields: {}, validated: false };

  // Determine auth method
  const authMethod = config.auth_method || process.env.ATLASSIAN_AUTH_METHOD || 'oauth';
  result.fields.auth_method = authMethod;

  // Load existing config
  const skillsDir = process.env.ORIONOMEGA_SKILLS_DIR
    || join(process.env.ORIONOMEGA_HOME || join(homedir(), '.orionomega'), 'skills');
  const configPath = join(skillsDir, 'atlassian', 'config.json');

  let existingConfig = {};
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      existingConfig = raw.fields ?? raw ?? {};
    } catch { /* ignore */ }
  }

  // Merge incoming config
  const merged = { ...existingConfig, ...config };

  // Validate connectivity
  try {
    const endpoint = merged.mcp_endpoint || 'https://mcp.atlassian.com/v1/mcp';
    let authHeader = '';

    if (authMethod === 'oauth') {
      const token = merged.oauth_access_token || process.env.ATLASSIAN_OAUTH_TOKEN;
      if (token) authHeader = `Bearer ${token}`;
    } else if (authMethod === 'basic') {
      const email = merged.api_email || process.env.ATLASSIAN_EMAIL;
      const token = merged.api_token || process.env.ATLASSIAN_API_TOKEN;
      if (email && token) authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    }

    if (authHeader) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'orionomega-atlassian-setup', version: '1.1.0' },
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.ok) {
        result.validated = true;
        result.fields.mcp_server_status = 'connected';
        result.fields.auth_method_validated = authMethod;
      } else {
        result.fields.mcp_server_status = `HTTP ${res.status}`;
      }
    } else {
      if (authMethod === 'oauth') {
        // Check if we have client credentials for OAuth
        const clientId = merged.oauth_client_id;
        const clientSecret = merged.oauth_client_secret;
        // Prefer the user-configured callback URL. Fall back to the built-in
        // gateway route which works over any network (Tailscale, remote, etc.)
        // and does not require a separate listener on port 9876.
        const callbackUrl = merged.oauth_callback_url || 'http://localhost:9876/callback';

        if (clientId && clientSecret) {
          result.fields.mcp_server_status = 'OAuth credentials configured — ready to authorize';
          result.fields.oauth_authorize_url = buildAuthUrl(clientId, callbackUrl, merged.oauth_scopes);
          result.fields.setup_instructions =
            'Click the authorization URL above to complete the OAuth flow. ' +
            'Ensure the Callback URL field above is registered in your Atlassian Developer Console under ' +
            'Authorization → OAuth 2.0 (3LO) → Callback URL. ' +
            'After authorizing, copy the full redirect URL from your browser and paste it into the WebUI.';
        } else {
          result.fields.mcp_server_status = 'OAuth not configured';
          result.fields.setup_instructions =
            'Enter your OAuth Client ID and Client Secret from developer.atlassian.com/console/myapps/. ' +
            'Set the Callback URL in the Developer Console and in the field above. ' +
            'Option A (paste flow, works everywhere): use http://localhost:9876/callback — after authorizing, copy the redirect URL and paste it here. ' +
            'Option B (auto flow, best for Tailscale/remote): use http://<your-hostname>:<gateway-port>/api/gateway/skills/atlassian/oauth/callback — authorization completes automatically.';
        }
      } else {
        result.fields.mcp_server_status = 'no credentials configured';
        result.fields.setup_instructions =
          'Enter your Atlassian account email and API token from id.atlassian.com/manage-profile/security/api-tokens';
      }
    }
  } catch (err) {
    result.fields.mcp_server_status = `error: ${err.message || String(err)}`;
  }

  // If we have OAuth credentials but no access token, try to detect accessible resources
  if (authMethod === 'oauth' && merged.oauth_access_token && !merged.default_cloud_id) {
    try {
      const res = await fetch(ATLASSIAN_RESOURCES_URL, {
        headers: {
          'Authorization': `Bearer ${merged.oauth_access_token}`,
          'Accept': 'application/json',
        },
      });
      if (res.ok) {
        const sites = await res.json();
        if (Array.isArray(sites) && sites.length > 0) {
          result.fields.accessible_sites = sites.map(s => `${s.name} (${s.id})`).join(', ');
          result.fields.auto_cloud_id = sites[0].id;
          result.fields.auto_site_url = sites[0].url;
        }
      }
    } catch { /* ignore */ }
  }

  // Report enabled products
  const products = ['jira', 'confluence', 'compass', 'jsm', 'bitbucket', 'search'];
  const enabled = products.filter(p => {
    const key = `enable_${p}`;
    if (key in merged) return !!merged[key];
    return p === 'jira' || p === 'confluence' || p === 'search';
  });
  result.fields.enabled_products = enabled.join(', ');

  // Persist merged config
  try {
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ fields: merged }, null, 2), { mode: 0o600 });
  } catch { /* ignore */ }

  process.stdout.write(JSON.stringify(result));
}

// Hardcoded scopes — must match what is approved in the Atlassian Developer Console.
// Jira platform REST API (classic)
const JIRA_SCOPES = [
  'read:jira-work', 'write:jira-work', 'manage:jira-project',
  'manage:jira-configuration', 'read:jira-user',
  'manage:jira-webhook', 'manage:jira-data-provider',
];
// Jira Service Management API (classic)
const JSM_SCOPES = [
  'read:servicedesk-request', 'manage:servicedesk-customer',
  'write:servicedesk-request', 'read:servicemanagement-insight-objects',
];
// Confluence API (classic)
const CONFLUENCE_SCOPES = [
  'write:confluence-content', 'read:confluence-space.summary',
  'write:confluence-space', 'write:confluence-file',
  'read:confluence-props', 'write:confluence-props',
  'manage:confluence-configuration', 'read:confluence-content.all',
  'read:confluence-content.summary', 'search:confluence',
  'read:confluence-content.permission', 'read:confluence-user',
  'read:confluence-groups', 'write:confluence-groups',
  'readonly:content.attachment:confluence',
];
const ALL_APPROVED_SCOPES = [
  ...JIRA_SCOPES, ...JSM_SCOPES, ...CONFLUENCE_SCOPES, 'offline_access',
];
const HARDCODED_SCOPE_STRING = ALL_APPROVED_SCOPES.join(' ');

function buildAuthUrl(clientId, callbackUrl, _scopes) {
  // Always use the hardcoded scope string — ignore any dynamic/persisted value.
  const scopeStr = HARDCODED_SCOPE_STRING;

  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: clientId,
    scope: scopeStr,
    redirect_uri: callbackUrl,
    state: `orionomega_${Date.now()}`,
    response_type: 'code',
    prompt: 'consent',
  });

  return `${ATLASSIAN_AUTH_URL}?${params.toString()}`;
}

main();
