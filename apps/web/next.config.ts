import type { NextConfig } from 'next';

export function buildNextConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): NextConfig {
  const isE2eFastBuild = env.NEXT_E2E_FAST_BUILD === '1';

  return {
    ...(isE2eFastBuild
      ? {
          eslint: { ignoreDuringBuilds: true },
          typescript: { ignoreBuildErrors: true },
        }
      : {
          output: 'standalone',
        }),
    reactStrictMode: true,
    transpilePackages: ['@geomix/shared', '@geomix/prompts'],
    experimental: {
      optimizePackageImports: ['antd'],
    },
  };
}

const nextConfig: NextConfig = buildNextConfig();

export default nextConfig;
