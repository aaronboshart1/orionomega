#!/usr/bin/env node
/**
 * Health check: verifies Pipedream API connectivity and auth.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function getConfig() {
  const skillsDir = process.env.ORIONOMEGA_SKILLS_DIR
    || join(process.env.ORIONOMEGA_HOME || join(homedir(), '.orionomega'), 'skills');
  const configPath = join(skillsDir, 'pipedream', 'config.json');
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return raw.fields ?? raw ?? {};
    } catch { /* ignore */ }
  }
  return {};
}

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

async function main() {
  const config = getConfig();

  const checks = await Promise.all([
    check('config loaded', () => {
      const method = config.auth_method || 'not set';
      const projectId = config.project_id || 'not set';
      const env = config.environment || 'development';
      return `auth_method=${method}, project=${projectId}, env=${env}`;
    }),

    check('credentials configured', () => {
      const method = config.auth_method || 'oauth';
      if (method === 'oauth') {
        if (config.oauth_client_id && config.oauth_client_secret) {
          return 'OAuth client credentials present';
        }
        throw new Error('Missing OAuth client_id or client_secret');
      }
      if (method === 'api_key') {
        if (config.api_key) return 'API key present';
        throw new Error('Missing API key');
      }
      throw new Error(`Unknown auth_method="${method}"`);
    }),

    check('project_id configured', () => {
      if (config.project_id) return config.project_id;
      throw new Error('project_id not set');
    }),

    check('API reachable', async () => {
      let token;
      const method = config.auth_method || 'oauth';

      if (method === 'oauth') {
        // Try cached token first
        token = config.oauth_access_token;
        if (!token && config.oauth_client_id && config.oauth_client_secret) {
          // Try to get fresh token
          const res = await fetch('https://api.pipedream.com/v1/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'client_credentials',
              client_id: config.oauth_client_id,
              client_secret: config.oauth_client_secret,
            }),
          });
          if (res.ok) {
            const data = await res.json();
            token = data.access_token;
          }
        }
      } else {
        token = config.api_key;
      }

      if (!token) throw new Error('No auth token available');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      const baseUrl = config.api_base_url || 'https://api.pipedream.com/v1';
      const res = await fetch(`${baseUrl}/users/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timer);
      if (res.ok) return `HTTP ${res.status} — API reachable`;
      throw new Error(`HTTP ${res.status} from ${baseUrl}`);
    }),
  ]);

  const allOk = checks.every((c) => c.ok);
  process.stdout.write(JSON.stringify({ healthy: allOk, checks }, null, 2));
  process.exit(allOk ? 0 : 1);
}

main();
