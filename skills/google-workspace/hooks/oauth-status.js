#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function main() {
  const credDir = join(homedir(), '.google_workspace_mcp', 'credentials');

  if (!existsSync(credDir)) {
    process.stdout.write(JSON.stringify({ authenticated: false, reason: 'No credentials directory' }));
    return;
  }

  try {
    const entries = readdirSync(credDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const tokenPath = join(credDir, entry.name, 'token.json');
      if (existsSync(tokenPath)) {
        try {
          const token = JSON.parse(readFileSync(tokenPath, 'utf-8'));
          const stat = statSync(tokenPath);
          const ageMs = Date.now() - stat.mtimeMs;
          const ageHours = Math.round(ageMs / 3600000);

          process.stdout.write(JSON.stringify({
            authenticated: true,
            email: entry.name,
            hasRefreshToken: !!token.refresh_token,
            tokenAge: ageHours < 24 ? `${ageHours}h ago` : `${Math.round(ageHours / 24)}d ago`,
            lastModified: stat.mtime.toISOString(),
          }));
          return;
        } catch {}
      }
    }
  } catch {}

  process.stdout.write(JSON.stringify({ authenticated: false, reason: 'No valid tokens found' }));
}

main();
