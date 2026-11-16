import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@geomix/shared', '@geomix/prompts'],
};

export default nextConfig;
