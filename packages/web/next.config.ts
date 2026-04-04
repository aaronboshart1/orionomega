import type { NextConfig } from 'next';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function getGitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ['*.replit.dev', '*.janeway.replit.dev', '100.117.199.128', '100.117.199.128:5000', 'localhost', 'localhost:5000'],
  devIndicators: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: getPackageVersion(),
    NEXT_PUBLIC_GIT_HASH: getGitHash(),
  },
};

export default nextConfig;
