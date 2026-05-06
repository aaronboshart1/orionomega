#!/usr/bin/env node
/**
 * Start the workspace-mcp OAuth flow for a specific account.
 *
 * Account selection:
 *   - GOOGLE_WORKSPACE_ACCOUNT_ID env (set by the gateway), or
 *   - the active account from config.json.
 *
 * Each account gets:
 *   - its own workspace-mcp child process on a dedicated loopback port
 *     (basePort + slot, base default 9877; configurable via
 *     GOOGLE_WORKSPACE_MCP_BASE_PORT).
 *   - its own isolated $HOME so workspace-mcp's hardcoded
 *     `~/.google_workspace_mcp/credentials/<email>.json` is per-account.
 *
 * stdout: JSON `{ authUrl, port, pid, redirectUri, redirectHost,
 *                 redirectPort, accountId }` on success, or
 *         `{ error }` on failure (process.exit(1)).
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFileSync, existsSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import {
  resolveAccount,
  getAccountHome,
  getAccountStateFile,
  getAccountLogFile,
  getSkillsDir,
} from './_accounts.js';

function readLogTail(file, maxBytes = 1000) {
  try { return readFileSync(file, 'utf-8').slice(-maxBytes); } catch { return '(no log)'; }
}

function parseSSE(body) {
  try { return JSON.parse(body); } catch {}
  for (const line of body.split('\n')) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
  }
  return null;
}

function mcpHeaders(sessionId) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return h;
}

async function main() {
  const skillsDir = getSkillsDir();
  const account = resolveAccount(skillsDir);
  if (!account) {
    process.stdout.write(JSON.stringify({ error: 'No Google Workspace account configured. Add an account first.' }));
    process.exit(1);
  }

  const { id: accountId, GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret, USER_GOOGLE_EMAIL: userEmail } = account;
  const port = account.port;
  const redirectUri = account.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${port}`;
  const mcpEndpoint = `http://127.0.0.1:${port}/mcp`;

  if (!clientId || !clientSecret) {
    process.stdout.write(JSON.stringify({ error: `Account "${account.label}" is missing OAuth Client ID or Secret.` }));
    process.exit(1);
  }
  if (!userEmail) {
    process.stdout.write(JSON.stringify({ error: `Account "${account.label}" is missing the Google email address.` }));
    process.exit(1);
  }

  const accountHome = getAccountHome(accountId);
  const stateFile = getAccountStateFile(accountId);
  const logFile = getAccountLogFile(accountId);
  mkdirSync(accountHome, { recursive: true });

  // Kill any existing OAuth server for this account.
  //
  // CRITICAL: we previously sent SIGTERM to just `oldPid`, which is the
  // `uvx` wrapper. uvx execs python/uvicorn as a grandchild and the
  // grandchild does NOT inherit the signal — so the actual workspace-mcp
  // server kept running on `port` with its ORIGINAL env vars (including
  // GOOGLE_OAUTH_REDIRECT_URI). The newly spawned process would then
  // fail to bind the same port silently (in the detached log), the
  // readiness probe would be answered by the OLD process, and Google
  // would receive the OLD redirect URI even after the user updated it
  // in Settings → saved → re-authenticated. Symptom: Google 400
  // "redirect_uri_mismatch" pointing at the previous port/host.
  //
  // Fix: kill the entire process group (negative pid — works because we
  // spawn with detached:true so uvx is the group leader), escalate to
  // SIGKILL, AND wait until the port is actually free before spawning
  // the replacement.
  const killGroup = (pid, sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } };
  if (existsSync(stateFile)) {
    try {
      const oldPid = parseInt(readFileSync(stateFile, 'utf-8').trim(), 10);
      if (Number.isFinite(oldPid) && oldPid > 0) {
        killGroup(oldPid, 'SIGTERM');
        await new Promise((r) => setTimeout(r, 800));
        killGroup(oldPid, 'SIGKILL');
      }
    } catch {}
  }
  // Wait up to 5s for the port to become free regardless of how the old
  // listener was tracked — defends against orphan listeners from prior
  // crashes whose pid we no longer have.
  const portFree = (p) => new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port: p });
    let done = false;
    const finish = (free) => { if (done) return; done = true; try { sock.destroy(); } catch {}; resolve(free); };
    sock.setTimeout(400);
    sock.once('connect', () => finish(false));
    sock.once('timeout', () => finish(true));
    sock.once('error', () => finish(true));
  });
  let freed = false;
  for (let i = 0; i < 10; i++) {
    if (await portFree(port)) { freed = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!freed) {
    process.stdout.write(JSON.stringify({
      error:
        `Port ${port} is still in use by a previous workspace-mcp listener for account "${account.label}" ` +
        `that wouldn't shut down. Find and kill it: \`lsof -i :${port}\` then \`kill -9 <pid>\`, then click Authenticate again.`,
    }));
    process.exit(1);
  }

  // CRITICAL: PORT must be set explicitly because workspace-mcp reads it first
  // (int(os.getenv("PORT", os.getenv("WORKSPACE_MCP_PORT", 8000)))) and the
  // gateway sets PORT=8000 which would otherwise override WORKSPACE_MCP_PORT.
  // HOME is overridden so workspace-mcp's hardcoded ~/.google_workspace_mcp
  // path becomes per-account.
  const env = {
    ...process.env,
    HOME: accountHome,
    PORT: String(port),
    WORKSPACE_MCP_PORT: String(port),
    WORKSPACE_MCP_HOST: '127.0.0.1',
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
    GOOGLE_OAUTH_REDIRECT_URI: redirectUri,
    USER_GOOGLE_EMAIL: userEmail,
    OAUTHLIB_INSECURE_TRANSPORT: '1',
  };

  // File-descriptor stdio (not pipes) so the child survives when this
  // hook script exits — pipes would close on exit and crash uvicorn on
  // its next write.
  const logFd = openSync(logFile, 'w');
  const child = spawn('uvx', ['workspace-mcp', '--single-user', '--transport', 'streamable-http'], {
    env,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(stateFile, String(child.pid));

  // Poll readiness for up to 30s
  const startTime = Date.now();
  let ready = false;
  let lastPollError = '';
  while (Date.now() - startTime < 30000) {
    try { process.kill(child.pid, 0); } catch {
      const logTail = readLogTail(logFile);
      process.stdout.write(JSON.stringify({ error: `workspace-mcp server exited before becoming ready. Log: ${logTail}` }));
      process.exit(1);
    }
    try {
      const res = await fetch(mcpEndpoint, {
        method: 'POST',
        headers: mcpHeaders(null),
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'orionomega', version: '1.0.0' } },
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) { ready = true; break; }
      lastPollError = `HTTP ${res.status}`;
    } catch (e) { lastPollError = e.message || String(e); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) {
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
    const logTail = readLogTail(logFile);
    process.stdout.write(JSON.stringify({ error: `workspace-mcp server failed to start within 30s. Last poll error: ${lastPollError}. Log: ${logTail}` }));
    process.exit(1);
  }

  // MCP handshake
  const initRes = await fetch(mcpEndpoint, {
    method: 'POST', headers: mcpHeaders(null),
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'orionomega', version: '1.0.0' } },
    }),
  });
  const sessionId = initRes.headers.get('mcp-session-id');
  await fetch(mcpEndpoint, {
    method: 'POST', headers: mcpHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  // Start the auth flow
  const toolRes = await fetch(mcpEndpoint, {
    method: 'POST', headers: mcpHeaders(sessionId),
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'start_google_auth', arguments: { service_name: 'Google Workspace', user_google_email: userEmail } },
    }),
  });
  const toolBody = await toolRes.text();
  const toolResult = parseSSE(toolBody);

  let authUrl = null;
  const content = toolResult?.result?.content;
  if (Array.isArray(content)) {
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const urlMatch = text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s)"]+/);
    if (urlMatch) authUrl = urlMatch[0];
  }
  if (!authUrl) {
    process.stdout.write(JSON.stringify({ error: 'Could not extract auth URL from workspace-mcp response.', raw: toolBody.slice(0, 1000) }));
    process.exit(1);
  }

  let redirectHost = 'localhost';
  let redirectPort = port;
  try {
    const u = new URL(redirectUri);
    redirectHost = u.hostname;
    redirectPort = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
  } catch {}

  process.stdout.write(JSON.stringify({
    authUrl, port, pid: child.pid, redirectUri, redirectHost, redirectPort,
    accountId, accountLabel: account.label,
    message: 'Open the auth URL in your browser to authenticate with Google.',
  }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err.message || String(err) }));
  process.exit(1);
});
