import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_DIR = fileURLToPath(new URL('../app', import.meta.url));

function collectPageFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectPageFiles(full));
    } else if (entry === 'page.tsx') {
      results.push(full);
    }
  }
  return results.sort();
}

describe('App Router page metadata parity (#203)', () => {
  it('exports non-generic route metadata on every (console), /admin/*, and /login page', () => {
    const pages = collectPageFiles(APP_DIR);
    const missing: string[] = [];

    for (const file of pages) {
      const rel = relative(APP_DIR, file).replace(/\\/g, '/');
      // Root / and /admin redirect immediately
      if (rel === 'page.tsx' || rel === 'admin/page.tsx') continue;
      const content = readFileSync(file, 'utf8');
      if (content.startsWith("'use client'") || !/export const metadata\b/.test(content)) {
        missing.push(rel);
      }
    }

    expect(missing).toEqual([]);
  });
});
