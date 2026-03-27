import type { NextConfig } from 'next';

const devDomain = process.env.REPLIT_DEV_DOMAIN;

const nextConfig: NextConfig = {
  allowedDevOrigins: devDomain
    ? [devDomain, `https://${devDomain}`, `http://${devDomain}`]
    : ['*.replit.dev'],
};

export default nextConfig;
