#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OAUTH_PORT = 9877;
const MCP_ENDPOINT = `http://localhost:${OAUTH_PORT}/mcp`;
const WM_DIR = join(homedir(), '.google_workspace_mcp');
const STATE_FILE = join(WM_DIR, '.oauth_server_pid');
const LOG_FILE = join(WM_DIR, 'oauth-server.log');

/**
 * MCP streamable-http returns SSE format: "event: message\ndata: {json}\n\n"
 * This helper parses the SSE body to extract the JSON payload.
 */
function parseSSE(body) {
  try { return JSON.parse(body); } catch {}
  const lines = body.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
  }
  return null;
}

/** Standard headers for MCP streamable-http requests */
function mcpHeaders(sessionId) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return h;
}

/** Read tail of the log file for diagnostics */
function readLogTail(maxBytes = 1000) {
  try {
    const content = readFileSync(LOG_FILE, 'utf-8');
    return content.slice(-maxBytes);
  } catch {
    return '(no log)';
  }
}

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

  // Kill any existing OAuth server
  if (existsSync(STATE_FILE)) {
    try {
      const oldPid = parseInt(readFileSync(STATE_FILE, 'utf-8').trim(), 10);
      process.kill(oldPid, 'SIGTERM');
      // Give it a moment to release the port
      await new Promise((r) => setTimeout(r, 1000));
    } catch {}
  }

  // Ensure workspace-mcp directory exists
  mkdirSync(WM_DIR, { recursive: true });

  // Build environment for workspace-mcp child process.
  // CRITICAL: Set PORT explicitly because workspace-mcp reads it first:
  //   int(os.getenv("PORT", os.getenv("WORKSPACE_MCP_PORT", 8000)))
  // The gateway sets PORT=8000 which would override WORKSPACE_MCP_PORT.
  const env = {
    ...process.env,
    PORT: String(OAUTH_PORT),
    WORKSPACE_MCP_PORT: String(OAUTH_PORT),
    WORKSPACE_MCP_HOST: '127.0.0.1',
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
    USER_GOOGLE_EMAIL: userEmail,
    OAUTHLIB_INSECURE_TRANSPORT: '1',
  };

  // CRITICAL: Use file descriptors (not pipes) for the child's stdio.
  // When this script exits, pipe file descriptors would close and
  // workspace-mcp (uvicorn) would get SIGPIPE on its next write to
  // stdout/stderr, causing it to crash. File descriptors backed by
  // actual files survive the parent process exiting.
  const logFd = openSync(LOG_FILE, 'w');

  const child = spawn('uvx', ['workspace-mcp', '--single-user', '--transport', 'streamable-http'], {
    env,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });

  child.unref();

  // Close our copy of the fd — the child has its own copy now
  closeSync(logFd);

  // Save PID for cleanup
  writeFileSync(STATE_FILE, String(child.pid));

  // Wait for server to be ready (poll up to 30s)
  const startTime = Date.now();
  let ready = false;
  let lastPollError = '';

  while (Date.now() - startTime < 30000) {
    // Check if child process has already exited
    try {
      process.kill(child.pid, 0);
    } catch {
      const logTail = readLogTail();
      process.stdout.write(JSON.stringify({
        error: `workspace-mcp server exited before becoming ready. Log: ${logTail}`,
      }));
      process.exit(1);
    }

    try {
      const res = await fetch(MCP_ENDPOINT, {
        method: 'POST',
        headers: mcpHeaders(null),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'orionomega', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        ready = true;
        break;
      }
      lastPollError = `HTTP ${res.status}`;
    } catch (e) {
      lastPollError = e.message || String(e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!ready) {
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
    const logTail = readLogTail();
    process.stdout.write(JSON.stringify({
      error: `workspace-mcp server failed to start within 30s. Last poll error: ${lastPollError}. Log: ${logTail}`,
    }));
    process.exit(1);
  }

  // Initialize MCP session
  const initRes = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: mcpHeaders(null),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'orionomega', version: '1.0.0' },
      },
    }),
  });
  const sessionId = initRes.headers.get('mcp-session-id');

  // Send initialized notification (required by MCP protocol)
  await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: mcpHeaders(sessionId),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });

  // Call start_google_auth tool
  const toolRes = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: mcpHeaders(sessionId),
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
  const toolBody = await toolRes.text();
  const toolResult = parseSSE(toolBody);

  // Extract auth URL from the response text
  let authUrl = null;
  const content = toolResult?.result?.content;
  if (Array.isArray(content)) {
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const urlMatch = text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s)"]+/);
    if (urlMatch) authUrl = urlMatch[0];
  }

  if (!authUrl) {
    process.stdout.write(JSON.stringify({
      error: 'Could not extract auth URL from workspace-mcp response.',
      raw: toolBody.slice(0, 1000),
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

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err.message || String(err) }));
  process.exit(1);
});
