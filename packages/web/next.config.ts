import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // standalone removed: not needed for pnpm dev/start usage and causes
  // copyfile errors with monorepo layouts in some Next.js 15 versions
  allowedDevOrigins: ['*'],
};

export default nextConfig;
