/**
 * @module github-device-auth
 * GitHub Device Flow authentication for SSH-friendly environments.
 * Instead of trying to open a browser (which fails over SSH), this displays
 * the verification URL and user code in the terminal, then polls GitHub
 * until the user completes authentication in their own browser.
 */

import { execSync } from 'node:child_process';

// The gh CLI's public OAuth App client ID (from the open-source gh CLI repository).
// This is not a secret — it identifies the OAuth App, not the user.
const GH_CLIENT_ID = '178c6fc778ccc68e1d6a';
const DEFAULT_SCOPES = 'repo,read:org,workflow';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function println(msg: string = ''): void {
  process.stdout.write(msg + '\n');
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Run GitHub's device flow authentication.
 * Displays the verification URL and user code, then polls for completion.
 * On success, stores the token via `gh auth login --with-token`.
 *
 * @param gitProtocol - Git protocol to configure (default: 'https')
 * @returns true if authentication succeeded
 */
export async function githubDeviceFlowAuth(gitProtocol: string = 'https'): Promise<boolean> {
  // Step 1: Request device and user codes
  let codeData: DeviceCodeResponse;
  try {
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: GH_CLIENT_ID,
        scope: DEFAULT_SCOPES,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      println(`  ${RED}✗${RESET} Failed to initiate device flow (HTTP ${res.status})${body ? ': ' + body.slice(0, 120) : ''}`);
      return false;
    }

    codeData = (await res.json()) as DeviceCodeResponse;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    println(`  ${RED}✗${RESET} Could not reach GitHub: ${msg}`);
    return false;
  }

  if (!codeData.device_code || !codeData.user_code || !codeData.verification_uri) {
    println(`  ${RED}✗${RESET} Invalid response from GitHub device flow endpoint.`);
    return false;
  }

  // Step 2: Display instructions clearly
  println();
  println(`  🔗 Please open this URL in your browser:`);
  println();
  println(`     ${BOLD}${BLUE}${codeData.verification_uri}${RESET}`);
  println();
  println(`  📋 Enter this code when prompted:`);
  println();
  println(`     ${BOLD}${codeData.user_code}${RESET}`);
  println();
  println(`  ⏳ Waiting for authentication to complete...`);
  println(`     ${DIM}(code expires in ${Math.floor(codeData.expires_in / 60)} minutes)${RESET}`);

  // Step 3: Poll for token
  let pollInterval = Math.max((codeData.interval || 5) * 1000, 5000);
  const expiresAt = Date.now() + codeData.expires_in * 1000;

  while (Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    let tokenData: TokenResponse;
    try {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          client_id: GH_CLIENT_ID,
          device_code: codeData.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        signal: AbortSignal.timeout(15000),
      });

      tokenData = (await res.json()) as TokenResponse;
    } catch {
      // Network hiccup during polling — keep trying
      continue;
    }

    if (tokenData.access_token) {
      // Step 4: Store the token via gh CLI
      const stored = storeToken(tokenData.access_token, gitProtocol);
      if (!stored) return false;

      println(`  ${GREEN}✓${RESET} Authentication successful!`);
      return true;
    }

    switch (tokenData.error) {
      case 'authorization_pending':
        // Still waiting for user — continue polling
        break;
      case 'slow_down':
        // GitHub asked us to slow down — increase interval
        pollInterval += 5000;
        break;
      case 'expired_token':
        println(`  ${RED}✗${RESET} Device code expired. Please try again.`);
        return false;
      case 'access_denied':
        println(`  ${RED}✗${RESET} Authorization was denied.`);
        return false;
      default:
        println(`  ${RED}✗${RESET} Unexpected error: ${tokenData.error_description || tokenData.error || 'unknown'}`);
        return false;
    }
  }

  println(`  ${RED}✗${RESET} Authentication timed out. Please try again.`);
  return false;
}

/**
 * Store the OAuth token via the gh CLI.
 * Uses stdin to pass the token (avoids exposing it in process arguments).
 */
function storeToken(token: string, gitProtocol: string): boolean {
  try {
    execSync('gh auth login --with-token', {
      input: token,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    println(`  ${RED}✗${RESET} Failed to store token via gh CLI: ${msg}`);
    return false;
  }

  // Set git protocol separately (more reliable across gh CLI versions)
  try {
    execSync(`gh config set git_protocol ${gitProtocol} --host github.com`, {
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch {
    // Non-critical — default protocol still works
  }

  return true;
}

/**
 * Check if a command is a `gh auth login --web` command that should use
 * the SSH-friendly device flow instead of trying to open a browser.
 */
export function isGhWebAuthCommand(command: string): boolean {
  return /\bgh\s+auth\s+login\b.*--web\b/.test(command);
}

/**
 * Extract the git protocol from a gh auth login command string.
 * Returns 'https' if not specified.
 */
export function extractGitProtocol(command: string): string {
  const match = command.match(/--git-protocol\s+(\S+)/);
  return match?.[1] ?? 'https';
}
