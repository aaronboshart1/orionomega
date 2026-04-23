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

    // Strategy 1: Check for flat credential files (workspace-mcp ≥ 3.x stores
    // tokens as credentials/<email>.json)
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const filePath = join(credDir, entry.name);
        try {
          const token = JSON.parse(readFileSync(filePath, 'utf-8'));
          const stat = statSync(filePath);
          const ageMs = Date.now() - stat.mtimeMs;
          const ageHours = Math.round(ageMs / 3600000);

          // Derive email from filename (strip .json)
          const email = entry.name.replace(/\.json$/, '');

          // Validate it looks like a real token file (has token or refresh_token)
          if (!token.token && !token.refresh_token && !token.access_token) {
            continue;
          }

          process.stdout.write(JSON.stringify({
            authenticated: true,
            email,
            hasRefreshToken: !!(token.refresh_token),
            tokenAge: ageHours < 24 ? `${ageHours}h ago` : `${Math.round(ageHours / 24)}d ago`,
            lastModified: stat.mtime.toISOString(),
          }));
          return;
        } catch {
          // Skip unparseable files
        }
      }
    }

    // Strategy 2: Check for directory-based credential storage (older workspace-mcp
    // versions store tokens as credentials/<email>/token.json)
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
            hasRefreshToken: !!(token.refresh_token),
            tokenAge: ageHours < 24 ? `${ageHours}h ago` : `${Math.round(ageHours / 24)}d ago`,
            lastModified: stat.mtime.toISOString(),
          }));
          return;
        } catch {
          // Skip unparseable token files
        }
      }
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({
      authenticated: false,
      reason: `Error reading credentials: ${err.message || String(err)}`,
    }));
    return;
  }

  process.stdout.write(JSON.stringify({ authenticated: false, reason: 'No valid tokens found' }));
}

main();
