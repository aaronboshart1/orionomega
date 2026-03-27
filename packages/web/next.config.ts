import type { NextConfig } from 'next';

const devDomain = process.env.REPLIT_DEV_DOMAIN;

const nextConfig: NextConfig = {
  allowedDevOrigins: devDomain
    ? [`https://${devDomain}`, `http://${devDomain}`]
    : [],
};

export default nextConfig;
