#!/usr/bin/env node
/**
 * Atlassian skill setup handler.
 *
 * When invoked as postInstall: checks if credentials are already configured.
 * When invoked as setup handler: validates auth and returns config fields.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

  // Check existing config
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

  // Validate connectivity by calling list_resources
  try {
    const endpoint = existingConfig.mcp_endpoint || 'https://mcp.atlassian.com/v1/mcp';
    let authHeader = '';

    if (authMethod === 'oauth') {
      const token = existingConfig.oauth_token || config.oauth_token || process.env.ATLASSIAN_OAUTH_TOKEN;
      if (token) authHeader = `Bearer ${token}`;
    } else if (authMethod === 'basic') {
      const email = existingConfig.api_email || config.api_email || process.env.ATLASSIAN_EMAIL;
      const token = existingConfig.api_token || config.api_token || process.env.ATLASSIAN_API_TOKEN;
      if (email && token) authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    } else if (authMethod === 'bearer') {
      const token = existingConfig.api_token || config.api_token || process.env.ATLASSIAN_API_TOKEN;
      if (token) authHeader = `Bearer ${token}`;
    }

    if (authHeader) {
      // Try a lightweight call to verify auth
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
            clientInfo: { name: 'orionomega-atlassian-setup', version: '1.0.0' },
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
      result.fields.mcp_server_status = 'no credentials configured';
    }
  } catch (err) {
    result.fields.mcp_server_status = `error: ${err.message || String(err)}`;
  }

  // Report enabled products
  const products = ['jira', 'confluence', 'compass', 'jsm', 'bitbucket', 'search'];
  const enabled = products.filter(p => {
    const key = `enable_${p}`;
    if (key in existingConfig) return !!existingConfig[key];
    // defaults
    return p === 'jira' || p === 'confluence' || p === 'search';
  });
  result.fields.enabled_products = enabled.join(', ');

  process.stdout.write(JSON.stringify(result));
}

main();
