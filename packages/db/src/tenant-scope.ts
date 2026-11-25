import { Prisma } from '@prisma/client';
import { createPrismaClient } from './client';

/**
 * 租户隔离用 Prisma extension 注入 tenantId。
 * 没有租户上下文时（登录、种子、健康检查）不过滤。
 *
 * 不自动隔离的表：
 * - Tenant：租户本身
 * - AuditLog：可选 tenantId，登录撤销记录要按 userId 读取，不能被请求上下文藏掉
 * - PricingItem / Announcement / MarketingLead：全局数据
 */

export const REQUIRED_TENANT_MODELS = [
  'User',
  'Wallet',
  'Quota',
  'PointReservation',
  'PointLog',
  'MoneyLog',
  'Verification',
  'WorkRun',
  'WorkUnit',
  'ActiveWork',
  'Brand',
  'BrandMarket',
  'BrandProductLine',
  'BrandFact',
  'BrandFactChunk',
  'BrandMediaAsset',
  'VisibilityRun',
  'VisibilityObservation',
  'VisibilityCitation',
  'GeoBrief',
  'GeoArticle',
  'GeoPublishRecord',
  'GeoBatchJob',
  'PromptPreference',
  'ChannelConnection',
  'GeoDistributionTask',
  'GeoRetestSchedule',
  'GeoVariantJob',
  'VisibilityRetrievedSource',
  'GeoRoiReport',
  'ExtensionAccessToken',
] as const;

export const NULLABLE_TENANT_MODELS = [] as const;

/** 可选 tenantId，但故意不自动过滤。 */
export const UNSCOPED_OPTIONAL_TENANT_MODELS = ['AuditLog'] as const;

/**
 * 不按请求租户过滤的模型。
 * Tenant 自己就是租户；PricingItem / Announcement / MarketingLead 是全局数据。
 */
export const UNSCOPED_UNOWNED_MODELS = [
  'Tenant',
  'PricingItem',
  'Announcement',
  'MarketingLead',
] as const;

const REQUIRED = new Set<string>(REQUIRED_TENANT_MODELS);
const NULLABLE = new Set<string>(NULLABLE_TENANT_MODELS);
const READ_LIST = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);
const READ_ONE = new Set(['findUnique', 'findUniqueOrThrow']);
const WRITE_ONE = new Set(['update', 'delete']);

export function andTenant(
  where: unknown,
  tenantId: string,
  mode: 'required' | 'nullable-read',
): Record<string, unknown> {
  const tenant =
    mode === 'nullable-read' ? { OR: [{ tenantId }, { tenantId: null }] } : { tenantId };
  if (where === undefined || where === null) return tenant;
  return { AND: [where, tenant] };
}

export function stampTenantCreate(data: unknown, tenantId: string): unknown {
  if (Array.isArray(data)) return data.map((item) => stampTenantCreate(item, tenantId));
  if (!data || typeof data !== 'object') return { tenantId };
  const row = { ...(data as Record<string, unknown>) };
  delete row.tenant;
  row.tenantId = tenantId;
  return row;
}

/** findUnique 的复合唯一键是 `a_b: { a, b }`，findFirst 只接受展开后的字段。 */
export function expandUniqueWhere(where: unknown): unknown {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return where;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key.includes('_') && value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(next, value);
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function stripTenantWrite(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const row = { ...(data as Record<string, unknown>) };
  delete row.tenantId;
  delete row.tenant;
  return row;
}

type Query = (args: never) => Promise<unknown>;

type Delegate = {
  findFirst(args: { where: unknown; select?: unknown }): Promise<unknown>;
};

function delegateOf(client: object, model: string): Delegate {
  const key = `${model.slice(0, 1).toLowerCase()}${model.slice(1)}`;
  const value = (client as Record<string, unknown>)[key];
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { findFirst?: unknown }).findFirst !== 'function'
  ) {
    throw new Error(`Prisma delegate missing for ${model}`);
  }
  const target = value as { findFirst: Delegate['findFirst'] };
  return {
    findFirst: (args) => target.findFirst(args),
  };
}

function missingRow(): never {
  throw new Prisma.PrismaClientKnownRequestError('Record not found in this tenant', {
    code: 'P2025',
    clientVersion: '5.22.0',
  });
}

function scopedMode(model: string): 'required' | 'nullable' | null {
  if (REQUIRED.has(model)) return 'required';
  if (NULLABLE.has(model)) return 'nullable';
  return null;
}

export function createTenantExtension(getTenantId: () => string | undefined) {
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'geomix-tenant',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const tenantId = getTenantId();
            const mode = scopedMode(model);
            if (!tenantId || !mode) return query(args);
            return applyScope({
              client,
              model,
              operation,
              args,
              query: query as Query,
              tenantId,
              mode,
            });
          },
        },
      },
    }),
  );
}

async function applyScope(input: {
  client: object;
  model: string;
  operation: string;
  args: unknown;
  query: Query;
  tenantId: string;
  mode: 'required' | 'nullable';
}): Promise<unknown> {
  const { client, model, operation, args, query, tenantId, mode } = input;
  const bag = (args ?? {}) as {
    where?: unknown;
    data?: unknown;
    create?: unknown;
    update?: unknown;
  };
  const readMode = mode === 'nullable' ? 'nullable-read' : 'required';

  if (operation === 'create') {
    return query({ ...bag, data: stampTenantCreate(bag.data, tenantId) } as never);
  }
  if (operation === 'createMany') {
    return query({ ...bag, data: stampTenantCreate(bag.data, tenantId) } as never);
  }
  if (READ_LIST.has(operation)) {
    return query({ ...bag, where: andTenant(bag.where, tenantId, readMode) } as never);
  }
  if (operation === 'updateMany') {
    return query({
      ...bag,
      where: andTenant(bag.where, tenantId, 'required'),
      data: stripTenantWrite(bag.data),
    } as never);
  }
  if (operation === 'deleteMany') {
    return query({ ...bag, where: andTenant(bag.where, tenantId, 'required') } as never);
  }
  if (READ_ONE.has(operation) || WRITE_ONE.has(operation)) {
    const found = await delegateOf(client, model).findFirst({
      where: andTenant(
        expandUniqueWhere(bag.where),
        tenantId,
        operation.startsWith('find') ? readMode : 'required',
      ),
      select: { tenantId: true },
    });
    if (!found) {
      if (operation === 'findUnique') return null;
      missingRow();
    }
    if (operation === 'update') {
      return query({ ...bag, data: stripTenantWrite(bag.data) } as never);
    }
    return query(args as never);
  }
  if (operation === 'upsert') {
    const probe = delegateOf(client, model);
    const where = expandUniqueWhere(bag.where);
    const existing = await probe.findFirst({ where });
    if (existing) {
      const owned = await probe.findFirst({
        where: andTenant(where, tenantId, 'required'),
        select: { tenantId: true },
      });
      if (!owned) missingRow();
      return query({ ...bag, update: stripTenantWrite(bag.update) } as never);
    }
    return query({ ...bag, create: stampTenantCreate(bag.create, tenantId) } as never);
  }
  throw new Error(`tenant scope does not implement ${model}.${operation}`);
}

export function createScopedClient(getTenantId: () => string | undefined, databaseUrl?: string) {
  const base = createPrismaClient(databaseUrl);
  const scoped = base.$extends(createTenantExtension(getTenantId));
  return { base, scoped };
}
