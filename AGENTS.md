# AGENTS.md

GeoMix 是一个基于 TypeScript Monorepo 的多租户 **GEO（Generative Engine Optimization）** 内容创作、多渠道分发与 **AI 可见度增长**平台（Next.js 15 + React 19 + Ant Design 5 + NestJS 10 + Prisma 5 + PostgreSQL 16/pgvector + Redis 7/BullMQ + MinIO）。**GeoMix 2.0 / v2.1**（双市场 `CN` / `GLOBAL`、极简 6 工作区壳、品牌事实卡与 `pgvector` 检索、AI 可见度诊断、GEO 写作意见引擎、SSE 靶向写作与 2–20 篇批量队列、双轨合规与 5 维 GEO 体检、独立发布中心 `/publish`、1→N 异步渠道变体、海外 L1 官方 API 直发与免登录 PR 供稿页 `/share/pr/[token]`、T+1 抓取体检与 T+7/14/30 自动复测闭环、Sonar Ink 暗色设计系统、Playwright `e2e` + `e2e/v2` + `distribution-v2-1` 与 GHCR/Self-Hosted CD）均已落地。

在本仓库工作的编码代理，请**按需查阅**以下文档，避免一次性加载过长历史文档浪费上下文：

## 文档导航

### 活文档（开发必读 / 随时查）

- [开发约定与迭代手册（docs/AGENTS.md）](./docs/AGENTS.md)：**编码前必读**，涵盖分支/PR/CI 流水线、机器强制契约、高频变更配方、重构规范与测试调试。
- [架构与模块索引（docs/架构与模块索引.md）](./docs/架构与模块索引.md)：当前代码库实时地图（真实技术栈、31 个数据模型与租户隔离表、`/api/v1` + `/api/v2` 接口前缀、5 个队列与 Runner、5 工作区前端路由、公开 PR 页与复用底座）。
- [已确认决策（docs/decisions.md）](./docs/decisions.md)：产品与合规决策及 GeoMix 2.0 / v2.1 演进补充。
- [v2.1 分发与写作打通需求与架构设计（docs/v2.1分发与写作打通需求与架构设计.md）](./docs/v2.1分发与写作打通需求与架构设计.md)：Global-First v2.1 PRD、领域模型与 Batch 0–3 拆分规范（对应 Epic #357 / Issues #349–#356）。
- [v2.2 可证明 ROI 与渠道扩容需求与架构设计（docs/v2.2可证明ROI与渠道扩容需求与架构设计.md）](./docs/v2.2可证明ROI与渠道扩容需求与架构设计.md)：v2.2 PRD、Near-Miss/ROI/多语种/L1 扩容/L2 扩展桥接架构与 Batch 0–4 拆分规范（对应 Epic #375 / Issues #367–#374，伴生仓 `yexiu700/geomix-extension`）。
- [品牌官网需求与架构设计（docs/GeoMix品牌官网需求与架构设计.md）](./docs/GeoMix品牌官网需求与架构设计.md)：Global-First 中英双语品牌官网 PRD、交互沙盒、点数计算器、试用线索闭环与 Batch 0–3 拆分规范（对应 Epic #382 / Issues #378–#381）。
- [产品体验与多产品线轻量改造方案（docs/GeoMix产品体验与多产品线轻量改造方案.md）](./docs/GeoMix产品体验与多产品线轻量改造方案.md)：`/studio` 宽屏专注布局、冷启动抽事实与 `[TBD]` 批量回填、渠道启停与 `GLOBAL` 强校验、可选多产品线（`BrandProductLine`）与月度复测预算上限（对应 Epic #388 / Issues #384–#387）。
- [Sonar Ink 2.0 视觉精修方案（docs/SonarInk2视觉精修方案.md）](./docs/SonarInk2视觉精修方案.md)：深色「沉静精确」视觉令牌 2.0、7 大基础 UI 原语、全站去框化外壳、`/home` & `/visibility` & `/brands` & `/studio` 重排与静态防回潮守卫棘轮（对应 Epic #395 / Issues #390–#394，与 #384 合并交付 `/studio`）。
- [极简交互规范（docs/极简交互规范.md）](./docs/极简交互规范.md)：控制台降认知负载规范（YAGNI、单一主操作、2–4 字标题/表头/按钮、`> 8` 字说明收进 ⓘ、`copy-guard` 棘轮守卫与短标签映射）。
- [运维与部署手册（docs/运维与部署手册.md）](./docs/运维与部署手册.md) & [CD 部署指南（docs/CD部署指南.md）](./docs/CD部署指南.md)：生产/预发 Compose、备份恢复、LLM 成本日报与 Runner 部署。

### 基线与归档文档（按需查阅，日常开发无需通读）

- [设计系统与 UI 重构清单（docs/设计系统与UI重构Issue清单.md）](./docs/设计系统与UI重构Issue清单.md)：ISSUE-01..10 已全部落地；改 UI 时仅参考 Part 0/Part 1 视觉令牌，运行时真值见 `apps/web/lib/design-tokens.ts` 与 `apps/web/app/globals.css`。
- [页面对照验收清单（docs/页面对照验收清单.md）](./docs/页面对照验收清单.md)：一期历史验收基线（M01–M09 / S00–S27，仍受 `packages/shared/src/qa.spec.ts` 校验，勿删改结构）。
- [终版实现路线（docs/终版实现路线.md）](./docs/终版实现路线.md)：一期 #1–#24 历史蓝图；仅作初期业务规则溯源，现行架构与实现细节以实时代码与 `docs/架构与模块索引.md` 为准。
- [评审与验证报告（docs/评审与验证报告.md）](./docs/评审与验证报告.md)：一期立项调研评审归档，日常编码无需阅读。

## 不可妥协红线

1. **Git 与交付**：仅从最新 `origin/main` 拉出独立功能分支并通过 Pull Request 交付；**严禁推 `main`，严禁代理手动合并 PR，严禁代理直接部署**。
2. **自动合并与 CD 须知**：本仓库启用了 `.github/workflows/auto-merge.yml`——**非草稿（Ready）PR 在 CI 全绿后会被 GitHub Actions 自动合入 `main` 并触发 `cd.yml` 部署**。未完成、需人工前置评审或仍在排查的 PR 务必先用 `gh pr create --draft` 创建。
3. **CI 全绿门禁**：提交 PR 前本地必须通过 `pnpm lint`（含 Prettier）、`pnpm typecheck`（含 `e2e`）、`pnpm test`；推送后必须等待 GitHub Actions 全部检查（`lint, typecheck, test` 与 `playwright e2e`）**全绿**才能交接。
4. **合规与安全**：站名固定「GeoMix」；默认计费模式固定 `BILLING_MODE=SHADOW`；严禁引入任何原站文案、图片、Logo、协议正文、系统模板原文或站点地址；严禁提交真实密钥；新增配置同步写入 `.env.example`；**严禁在 `docs/` 下提交任何图片二进制文件**。

## 高频 CI 踩坑速查（详见 `docs/AGENTS.md`）

- **`@geomix/shared`（`packages/shared/src/package-contract.spec.ts`）**：`src/*.ts`（非 `.spec.ts`）与 `package.json#exports` 必须 **1 对 1 精确匹配**（键序 `types` 在前、`default` 在后）；禁止任何内部循环依赖与 `@geomix/shared` 自引用；`task-status.ts` 必须零导入；并行开发只追加模块文件。
- **`@geomix/db`（`packages/db/src/schema-contract.spec.ts` & `tenant-scope.ts`）**：严禁修改已落地的 14 条迁移 SQL；增删模型或迁移必须同步更新 `schema-contract.spec.ts`（`SCHEMA_MODELS` 与迁移列表）及 `tenant-scope.ts` 分类（当前 31 个模型，27 个业务表均带 `tenantId`）；若未来新增无 `tenantId` 子表，访问前必须先校验父记录归属。
- **`@geomix/web` 静态守卫（`apps/web/eslint.config.mjs` & `ux-foundation-guard.spec.ts`）**：
  - 禁止 `Modal.confirm(...)` → 用 `useUxFeedback().confirm(...)`。
  - 禁止 `URL.revokeObjectURL(...)` → 用 `triggerBlobDownload(...)`。
  - 禁止手写 UTC 字符串切片格式化时间 → 用 `@geomix/shared` 的 `formatShanghaiDateTime` / `formatShanghaiDate` / `parseShanghaiDateTimeLocal`。
  - 禁止在组件中出现禁用研发黑话与 `placeholder="名称或备注"`，禁止向用户暴露裸 CUID（用 `UX_TERMS`、`isOpaqueEntityId`、`useSyncTabTitle`）。
  - 列表页工具栏必须复用 `<CrudTable>` / `<CrudToolbar>` 创建前置顺序，禁止手写 `gm-crud-toolbar` 或 `toolbarOrder="default"`。
  - 禁止在 `apps/web/lib/*` 重复定义 `function unwrap` → 复用 `apps/web/lib/envelope.ts`。
  - 轮询用 `useTaskPolling`（防重叠、按 `active` 启停），跨区刷新同步用 `useTabFreshness` / `invalidateFreshness`。
- **`@geomix/web` 路由与样式**：控制台为极简 6 工作区路由（`/home`、`/brands`、`/visibility`、`/studio`、`/publish`、`/account`），`app/(console)/**/page.tsx` 导出 `metadata` 并直接渲染各自工作区组件作为 `ConsoleLayout` → `ConsoleShell` → `ShellFrame` 的 `children`；全局品牌与双市场（`CN` / `GLOBAL`）上下文由 `lib/workspace-store.ts` 管理并与 `?brandId=&market=` 同步；不引入 Tailwind / ProComponents / React Query / ECharts；使用 `var(--gm-*)` / `GM.*` 令牌，锁定既有 `aria-label` 与 `data-testid` 不变；页面可见文案、主按钮与 `> 8` 字说明遵循 [极简交互规范（docs/极简交互规范.md）](./docs/极简交互规范.md)。
- **`@geomix/server` 隔离与权限**：全局前缀 `/api` + URI 版本控制（默认 `/api/v1`，v2 核心业务域用 `@Controller({ path: '...', version: '2' })` 暴露 `/api/v2`）；业务查询默认走 `prisma.scoped`，`prisma.base` 受 `prisma-base-allowlist.ts` 与 `prisma-base-usage.spec.ts` AST 棘轮白名单精确约束；管理接口挂 `AdminGuard`（对非管理员返 `404`）；写接口挂 `TenantActiveGuard`（到期返 `403` / `40301`）。
- **文档测试耦合**：勿重命名或破坏 `docs/页面对照验收清单.md`（`qa.spec.ts`）与 `docs/运维与部署手册.md`（`llm-cost-report.spec.ts`）。

## 常用命令速查

```bash
pnpm install --frozen-lockfile && node packages/db/scripts/prisma-cli.mjs generate
pnpm format                           # Prettier 格式化全仓（修复 pnpm lint 格式失败）
pnpm lint                             # turbo run lint && prettier --check .
pnpm typecheck                        # 全仓 tsc + e2e/tsconfig.json 类型检查
pnpm test                             # 全仓 Vitest 单元测试（自动先构依赖包，默认不连 DB/Redis）
pnpm build                            # 构建 packages + server + web（先自动 prisma generate）
E2E_V2=1 pnpm test:e2e                # Playwright 全栈端到端测试（含 e2e/v2，需 PG + Redis）
pnpm db:validate && pnpm db:migrate && pnpm db:seed
# 单包 / 单文件快速迭代（pnpm 10 不加 `--`；改动 shared/db 后请先 build 对应依赖包）：
pnpm --filter @geomix/web test components/studio/studio-workspace.spec.tsx
pnpm --filter @geomix/server test src/visibility/visibility.http.spec.ts
# 数据库 / Redis 集成测试（按需启用）：
GEOMIX_DB_INTEGRATION=1 pnpm --filter @geomix/server test
GEOMIX_DB_INTEGRATION=1 GEOMIX_REDIS_INTEGRATION=1 pnpm --filter @geomix/server test
```
