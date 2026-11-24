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

const USE_CLIENT_DIRECTIVE_RE = /^\s*['"]use client['"]/;
const ROUTE_METADATA_EXPORT_RE =
  /^export\s+(?:const\s+metadata\b|(?:async\s+)?function\s+generateMetadata\b)/m;

describe('App Router page metadata parity (#203)', () => {
  it('exports route metadata on every (console), (marketing), /admin/*, /share/*, and /login page', () => {
    const pages = collectPageFiles(APP_DIR);
    const missing: string[] = [];

    for (const file of pages) {
      const rel = relative(APP_DIR, file).replace(/\\/g, '/');
      // /admin redirects immediately
      if (rel === 'page.tsx' || rel === 'admin/page.tsx') continue;
      const content = readFileSync(file, 'utf8');
      if (USE_CLIENT_DIRECTIVE_RE.test(content) || !ROUTE_METADATA_EXPORT_RE.test(content)) {
        missing.push(rel);
      }
    }

    expect(missing).toEqual([]);
  });
});
