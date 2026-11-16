import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NULLABLE_TENANT_MODELS,
  REQUIRED_TENANT_MODELS,
  UNSCOPED_OPTIONAL_TENANT_MODELS,
  UNSCOPED_UNOWNED_MODELS,
  andTenant,
  expandUniqueWhere,
  stampTenantCreate,
  stripTenantWrite,
} from './tenant-scope';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function tenantField(body: string): 'required' | 'optional' | 'none' {
  if (/^[ \t]+tenantId\s+String\?/m.test(body)) return 'optional';
  if (/^[ \t]+tenantId\s+String(?!\?)/m.test(body)) return 'required';
  return 'none';
}

describe('tenant scope classification', () => {
  it('classifies every Prisma model exactly once', () => {
    const schema = readFileSync(resolve(packageRoot, 'prisma/schema.prisma'), 'utf8');
    const models = schema
      .split(/^model /m)
      .slice(1)
      .map((chunk) => {
        const name = chunk.slice(0, chunk.search(/\s/)).trim();
        const body = chunk.slice(0, chunk.indexOf('\n}'));
        return { name, tenant: tenantField(body) };
      });

    const required = new Set<string>(REQUIRED_TENANT_MODELS);
    const nullable = new Set<string>(NULLABLE_TENANT_MODELS);
    const optionalUnscoped = new Set<string>(UNSCOPED_OPTIONAL_TENANT_MODELS);
    const unowned = new Set<string>(UNSCOPED_UNOWNED_MODELS);
    const seen = new Set<string>();

    for (const model of models) {
      expect(seen.has(model.name), model.name).toBe(false);
      seen.add(model.name);
      if (model.tenant === 'required') expect(required.has(model.name)).toBe(true);
      if (model.tenant === 'optional') {
        expect(nullable.has(model.name) || optionalUnscoped.has(model.name)).toBe(true);
      }
      if (model.tenant === 'none') expect(unowned.has(model.name)).toBe(true);
    }

    expect(seen.size).toBe(required.size + nullable.size + optionalUnscoped.size + unowned.size);
  });

  it('adds the tenant predicate without dropping the caller filter', () => {
    expect(andTenant({ id: 'k1' }, 't1', 'required')).toEqual({
      AND: [{ id: 'k1' }, { tenantId: 't1' }],
    });
    expect(andTenant(undefined, 't1', 'nullable-read')).toEqual({
      OR: [{ tenantId: 't1' }, { tenantId: null }],
    });
  });

  it('expands compound unique selectors for findFirst probes', () => {
    expect(expandUniqueWhere({ tenantId_key: { tenantId: 't2', key: 'MAIN_KEYWORD' } })).toEqual({
      tenantId: 't2',
      key: 'MAIN_KEYWORD',
    });
    expect(expandUniqueWhere({ id: 'k1' })).toEqual({ id: 'k1' });
  });

  it('stamps creates onto the current tenant and strips tenant fields from updates', () => {
    expect(
      stampTenantCreate(
        { tenantId: 'other', tenant: { connect: { id: 'other' } }, main: '甲' },
        't1',
      ),
    ).toEqual({
      tenantId: 't1',
      main: '甲',
    });
    expect(stripTenantWrite({ tenantId: 'other', main: '乙' })).toEqual({ main: '乙' });
  });
});
