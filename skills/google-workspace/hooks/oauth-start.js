#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OAUTH_PORT = 9877;
const MCP_ENDPOINT = `http://localhost:${OAUTH_PORT}/mcp`;
const STATE_FILE = join(homedir(), '.google_workspace_mcp', '.oauth_server_pid');

async function main() {
  const configPath = join(homedir(), '.orionomega', 'skills', 'google-workspace', 'config.json');
  let config = {};
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, 'utf-8')).fields || {};
  }

  const clientId = config.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = config.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const userEmail = config.USER_GOOGLE_EMAIL || process.env.USER_GOOGLE_EMAIL;

  if (!clientId || !clientSecret) {
    process.stdout.write(JSON.stringify({ error: 'OAuth Client ID and Secret must be configured first.' }));
    process.exit(1);
  }
  if (!userEmail) {
    process.stdout.write(JSON.stringify({ error: 'Google email address must be configured first.' }));
    process.exit(1);
  }

  if (existsSync(STATE_FILE)) {
    try {
      const oldPid = parseInt(readFileSync(STATE_FILE, 'utf-8').trim(), 10);
      process.kill(oldPid, 'SIGTERM');
    } catch {}
  }

  const env = {
    ...process.env,
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
    USER_GOOGLE_EMAIL: userEmail,
    WORKSPACE_MCP_PORT: String(OAUTH_PORT),
    WORKSPACE_MCP_HOST: '127.0.0.1',
    OAUTHLIB_INSECURE_TRANSPORT: '1',
  };

  const child = spawn('uvx', ['workspace-mcp', '--single-user', '--transport', 'streamable-http'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.unref();

  mkdirSync(join(homedir(), '.google_workspace_mcp'), { recursive: true });
  writeFileSync(STATE_FILE, String(child.pid));

  const startTime = Date.now();
  let ready = false;
  while (Date.now() - startTime < 30000) {
    try {
      const res = await fetch(MCP_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'orionomega', version: '1.0.0' } } }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) { ready = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!ready) {
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
    process.stdout.write(JSON.stringify({ error: 'workspace-mcp server failed to start within 30 seconds.' }));
    process.exit(1);
  }

  const initRes = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'orionomega', version: '1.0.0' } } }),
  });
  const sessionId = initRes.headers.get('mcp-session-id');

  const headers = { 'Content-Type': 'application/json' };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const toolRes = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'start_google_auth',
        arguments: { service_name: 'Google Workspace', user_google_email: userEmail },
      },
    }),
  });
  const toolResult = await toolRes.json();

  let authUrl = null;
  const content = toolResult?.result?.content;
  if (Array.isArray(content)) {
    const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const urlMatch = text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s)]+/);
    if (urlMatch) authUrl = urlMatch[0];
  }

  if (!authUrl) {
    process.stdout.write(JSON.stringify({
      error: 'Could not extract auth URL from workspace-mcp response.',
      raw: JSON.stringify(toolResult),
    }));
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({
    authUrl,
    port: OAUTH_PORT,
    pid: child.pid,
    message: 'Open the auth URL in your browser to authenticate with Google.',
  }));
}

main().catch(err => {
  process.stdout.write(JSON.stringify({ error: err.message }));
  process.exit(1);
});
