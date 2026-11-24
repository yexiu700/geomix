import { describe, expect, it } from 'vitest';
import { buildNextConfig } from '../next.config';

describe('buildNextConfig', () => {
  it('keeps standalone output and build-time checks enabled by default for production builds', () => {
    const config = buildNextConfig({});

    expect(config.output).toBe('standalone');
    expect(config.htmlLimitedBots).toBeInstanceOf(RegExp);
    expect(config.htmlLimitedBots?.test('GPTBot/1.0')).toBe(true);
    expect(config.htmlLimitedBots?.test('node')).toBe(true);
    expect(config.eslint).toBeUndefined();
    expect(config.typescript).toBeUndefined();
    expect(config.experimental?.optimizePackageImports).toContain('antd');
  });

  it('skips standalone file tracing and duplicate lint/type checks when NEXT_E2E_FAST_BUILD=1', () => {
    const config = buildNextConfig({ NEXT_E2E_FAST_BUILD: '1' });

    expect(config.output).toBeUndefined();
    expect(config.htmlLimitedBots).toBeInstanceOf(RegExp);
    expect(config.eslint).toEqual({ ignoreDuringBuilds: true });
    expect(config.typescript).toEqual({ ignoreBuildErrors: true });
    expect(config.experimental?.optimizePackageImports).toContain('antd');
  });
});
