import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSolidRgbPng,
  E2E_DEFAULT_API_BASE,
  E2E_DEFAULT_BASE_URL,
  E2E_DEFAULT_FIXTURE_HOST,
  resolveE2eRuntimeConfig,
  validateQaChecklistMarkdown,
} from './qa';

const repoRoot = resolve(__dirname, '../../..');
const docsDir = resolve(repoRoot, 'docs');
const checklistPath = resolve(docsDir, '页面对照验收清单.md');

describe('qa checklist & e2e helpers (#23)', () => {
  it('resolves default and custom E2E runtime endpoints cleanly', () => {
    expect(resolveE2eRuntimeConfig({})).toEqual({
      baseUrl: E2E_DEFAULT_BASE_URL,
      apiBase: E2E_DEFAULT_API_BASE,
      fixtureHost: E2E_DEFAULT_FIXTURE_HOST,
    });

    expect(
      resolveE2eRuntimeConfig({
        E2E_BASE_URL: 'http://127.0.0.1:3100/',
        E2E_API_BASE: 'http://127.0.0.1:3101/api/v1/',
        E2E_PUBLIC_FIXTURE_HOST: 'https://Articles.Test.Example/path',
      }),
    ).toEqual({
      baseUrl: 'http://127.0.0.1:3100',
      apiBase: 'http://127.0.0.1:3101/api/v1',
      fixtureHost: 'articles.test.example',
    });
  });

  it('builds a valid 600x400 RGB PNG buffer with standard PNG signature and IHDR dimensions', () => {
    const png = buildSolidRgbPng(600, 400, [22, 119, 255]);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(600);
    expect(png.readUInt32BE(20)).toBe(400);
    expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND');
  });

  it('verifies docs/页面对照验收清单.md covers M01..M09 and S00..S27 with zero unclosed differences', () => {
    const markdown = readFileSync(checklistPath, 'utf8');
    const report = validateQaChecklistMarkdown(markdown);
    expect(report).toEqual({
      ok: true,
      missingMainSteps: [],
      missingBaselineScreens: [],
      missingExtendedScreens: [],
      uncheckedItems: [],
      unclosedStatusLines: [],
      externalImageLinks: [],
    });
  });

  it('flags missing screens or unchecked items when checklist is incomplete', () => {
    const broken = '# 页面对照\n| M01 | 登录 | [ ] 待修复 |\n![bad](https://origin.example/00.png)';
    const report = validateQaChecklistMarkdown(broken);
    expect(report.ok).toBe(false);
    expect(report.missingMainSteps.length).toBeGreaterThan(0);
    expect(report.missingBaselineScreens.length).toBe(28);
    expect(report.uncheckedItems.length).toBe(1);
    expect(report.unclosedStatusLines.length).toBe(1);
    expect(report.externalImageLinks).toEqual(['https://origin.example/00.png']);
  });

  it('ensures no screenshot binaries are committed inside docs/', () => {
    const entries = readdirSync(docsDir);
    const binaries = entries.filter((name) => /\.(png|jpg|jpeg|webp|gif)$/i.test(name));
    expect(binaries).toEqual([]);
  });
});
