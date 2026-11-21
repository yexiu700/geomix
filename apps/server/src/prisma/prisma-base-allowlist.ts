/**
 * `prisma.base`（不自动注入 tenantId 的原始客户端）使用白名单与棘轮基线。
 *
 * 由 `prisma-base-usage.spec.ts` 强制校验：
 * - 不在本表中的文件禁止出现 `prisma.base`，新代码一律使用 `prisma.scoped`；
 * - 表中每个文件的实际次数必须与登记值 **完全相等**：增加即失败；减少也失败，
 *   以提醒同步下调基线（棘轮只降不升）；
 * - `direct` = 直接经 base 访问模型 delegate 的次数（如 `prisma.base.visibilityRun.findMany`），
 *   这是租户隔离风险所在；`txOrRaw` = `prisma.base.$transaction / $queryRaw / $executeRaw`
 *   次数（事务需与 QuotaService/BillingService 共享 base 事务句柄；原始 SQL 必须显式
 *   `WHERE "tenantId" = ...`）；
 * - `*.controller.ts` 永远不允许登记。
 *
 * 为什么事务暂不迁到 `prisma.scoped.$transaction`：租户扩展对 findUnique/update/delete/upsert
 * 的归属探测走的是扩展外层 client，而不是事务句柄，同一事务内「先创建再按主键更新」会探测不到
 * 未提交行而误报 P2025。迁移事务前需先改造扩展。
 *
 * 类别说明：
 * - `auth`：登录/会话阶段尚无租户上下文。
 * - `admin`：管理员跨租户操作（挂 AdminGuard）。
 * - `worker`：BullMQ / WorkDriver 后台消费，无请求级租户上下文，查询需显式带 tenantId。
 * - `billing`：计费账本，需要与业务事务共享 base 事务句柄。
 * - `infra`：全局数据（AuditLog 等）。
 * - `test-support`：测试数据库辅助。
 * - `merchant-debt`：**历史技术债**——普通商户请求链路仍在用 base + 手写 tenantId，
 *   应逐步迁到 `prisma.scoped` 并下调 `direct`，目标是只剩 `txOrRaw`。
 */
export type PrismaBaseCategory =
  'auth' | 'admin' | 'worker' | 'billing' | 'infra' | 'test-support' | 'merchant-debt';

export type PrismaBaseAllowance = {
  category: PrismaBaseCategory;
  /** 直接经 `prisma.base.<model>` 访问的次数（含把 base 赋给别名）。 */
  direct: number;
  /** `prisma.base.$transaction / $queryRaw / $executeRaw` 次数。 */
  txOrRaw: number;
};

/** 路径相对 `apps/server/src`，按路径字母序排列。 */
export const PRISMA_BASE_ALLOWLIST: Readonly<Record<string, PrismaBaseAllowance>> = {
  'admin/admin-office.service.ts': { category: 'admin', direct: 27, txOrRaw: 5 },
  'auth/prisma-auth.store.ts': { category: 'auth', direct: 6, txOrRaw: 0 },
  'billing/billing.service.ts': { category: 'billing', direct: 22, txOrRaw: 2 },
  'billing/quota.service.ts': { category: 'billing', direct: 2, txOrRaw: 2 },
  'brands/brand-fact-index.runner.ts': { category: 'worker', direct: 3, txOrRaw: 3 },
  'brands/brand-media.service.ts': { category: 'billing', direct: 0, txOrRaw: 2 },
  'brands/brands.service.ts': { category: 'billing', direct: 0, txOrRaw: 1 },
  'briefs/briefs-auto-generator.service.ts': { category: 'worker', direct: 1, txOrRaw: 1 },
  'common/test-db.ts': { category: 'test-support', direct: 5, txOrRaw: 0 },
  'dashboard/dashboard.service.ts': { category: 'merchant-debt', direct: 2, txOrRaw: 0 },
  'infra/adapters.module.ts': { category: 'infra', direct: 2, txOrRaw: 0 },
  'me/me.service.ts': { category: 'merchant-debt', direct: 16, txOrRaw: 0 },
  'queue/active-work.ts': { category: 'worker', direct: 3, txOrRaw: 0 },
  'queue/work-driver.ts': { category: 'worker', direct: 28, txOrRaw: 2 },
  'studio/geo-batch.runner.ts': { category: 'worker', direct: 0, txOrRaw: 6 },
  'studio/retest-metrics-hook.service.ts': { category: 'worker', direct: 0, txOrRaw: 1 },
  'studio/studio.service.ts': { category: 'billing', direct: 0, txOrRaw: 1 },
  'visibility/visibility-run-lifecycle.service.ts': {
    category: 'billing',
    direct: 0,
    txOrRaw: 2,
  },
  'visibility/visibility-run.runner.ts': { category: 'worker', direct: 5, txOrRaw: 4 },
};
