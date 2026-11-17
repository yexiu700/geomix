import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['@geomix/shared', '@geomix/prompts'],
};

export default nextConfig;
