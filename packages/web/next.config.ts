import type { NextConfig } from 'next';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

// Bundle analyzer — only active when ANALYZE=true (requires @next/bundle-analyzer installed).
// Usage: ANALYZE=true pnpm build
let wrapWithAnalyzer = (cfg: NextConfig): NextConfig => cfg;
if (process.env.ANALYZE === 'true') {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  const withBundleAnalyzer = _require('@next/bundle-analyzer') as Function;
  wrapWithAnalyzer = withBundleAnalyzer({ enabled: true }) as (cfg: NextConfig) => NextConfig;
}

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

// Extra dev origins from env var — avoids committing internal IPs to source control.
// Usage: ALLOWED_DEV_ORIGINS=192.168.1.10,192.168.1.10:5000 pnpm dev
const extraDevOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    '*.replit.dev',
    '*.janeway.replit.dev',
    'localhost',
    'localhost:5000',
    ...extraDevOrigins,
  ],
  devIndicators: false,
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: getPackageVersion(),
    NEXT_PUBLIC_GIT_HASH: getGitHash(),
  },
  images: {
    // Add external image hostnames here as needed.
    // Never use `images.domains` (deprecated) — use remotePatterns.
    remotePatterns: [],
  },
  experimental: {
    optimizePackageImports: ['lucide-react', '@xyflow/react'],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // Prevent MIME-type sniffing
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Block framing by other sites (clickjacking protection)
          { key: 'X-Frame-Options', value: 'DENY' },
          // Only send origin on cross-origin requests, no full URL
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Restrict access to browser features
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Speed up DNS resolution for linked resources
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
        ],
      },
    ];
  },
};

export default wrapWithAnalyzer(nextConfig);
