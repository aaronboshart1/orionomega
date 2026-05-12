#!/usr/bin/env node
/**
 * Health check: verifies Atlassian MCP Server connectivity and auth.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function check(label, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        (detail) => ({ label, ok: true, detail }),
        (err) => ({ label, ok: false, detail: err.message ?? String(err) }),
      );
    }
    return { label, ok: true, detail: result };
  } catch (err) {
    return { label, ok: false, detail: err.message ?? String(err) };
  }
}

function getConfig() {
  const skillsDir = process.env.ORIONOMEGA_SKILLS_DIR
    || join(process.env.ORIONOMEGA_HOME || join(homedir(), '.orionomega'), 'skills');
  const configPath = join(skillsDir, 'atlassian', 'config.json');
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return raw.fields ?? raw ?? {};
    } catch { /* ignore */ }
  }
  return {};
}

async function main() {
  const config = getConfig();

  const checks = await Promise.all([
    // Check 1: Config exists and products enabled
    check('config loaded', () => {
      const method = config.auth_method || 'not set';
      const products = ['jira', 'confluence', 'compass', 'jsm', 'bitbucket', 'search']
        .filter(p => {
          const key = `enable_${p}`;
          if (key in config) return !!config[key];
          return p === 'jira' || p === 'confluence' || p === 'search';
        });
      return `auth_method=${method}, products=[${products.join(', ')}]`;
    }),

    // Check 2: Auth credentials present
    check('credentials configured', () => {
      const method = config.auth_method || 'oauth';
      if (method === 'oauth') {
        if (config.oauth_access_token || process.env.ATLASSIAN_OAUTH_TOKEN) {
          return 'OAuth access token present';
        }
        if (config.oauth_client_id && config.oauth_client_secret) {
          if (config.oauth_refresh_token) {
            return 'OAuth client credentials + refresh token present (can auto-refresh)';
          }
          return 'OAuth client credentials present — needs authorization';
        }
        throw new Error('No OAuth credentials. Enter Client ID, Client Secret, and complete the authorization flow in Settings.');
      }
      if (method === 'basic') {
        const hasEmail = config.api_email || process.env.ATLASSIAN_EMAIL;
        const hasToken = config.api_token || process.env.ATLASSIAN_API_TOKEN;
        if (hasEmail && hasToken) return 'Basic auth credentials present';
        throw new Error('Missing email or API token for Basic auth.');
      }
      throw new Error(`Unknown auth_method="${method}"`);
    }),

    // Check 3: MCP server reachable
    check('MCP server reachable', async () => {
      const endpoint = config.mcp_endpoint || 'https://mcp.atlassian.com/v1/mcp';
      let authHeader = '';
      const method = config.auth_method || 'oauth';

      if (method === 'oauth') {
        const token = config.oauth_access_token || process.env.ATLASSIAN_OAUTH_TOKEN || '';
        if (token) authHeader = `Bearer ${token}`;
      } else if (method === 'basic') {
        const email = config.api_email || process.env.ATLASSIAN_EMAIL || '';
        const token = config.api_token || process.env.ATLASSIAN_API_TOKEN || '';
        if (email && token) authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
      }

      if (!authHeader) throw new Error('No auth header — cannot test connectivity. Complete auth setup first.');

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
            clientInfo: { name: 'orionomega-atlassian-health', version: '1.1.0' },
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.ok) return `HTTP ${res.status} — connected to ${endpoint}`;
      throw new Error(`HTTP ${res.status} from ${endpoint}`);
    }),
  ]);

  const allOk = checks.every((c) => c.ok);
  const result = { healthy: allOk, checks };

  process.stdout.write(JSON.stringify(result, null, 2));
  process.exit(allOk ? 0 : 1);
}

main();
