# GeoMix 编码代理开发约定与迭代手册

本手册面向所有在 `yexiu700/geomix` 仓库工作的编码代理，聚焦**如何安全、高效、一次过 CI 地完成功能开发、缺陷修复与重构**。
关于当前代码库的模块清单、API 路由、队列、数据模型与前端组件索引，请配合查阅 [架构与模块索引](./架构与模块索引.md)。

---

## 1. 交付流程与 GitHub Actions 流水线

### 1.1 分支与 PR 铁律

1. **永远从最新 `origin/main` 拉分支**：先执行 `git fetch origin main`，再 `git checkout -b <type>/<short-topic> origin/main`（推荐前缀：`feat/`、`fix/`、`refactor/`、`perf/`、`docs/`、`chore/`）。
2. **绝不直接推 `main`、绝不手动合并 PR、绝不直接执行部署**。
3. **理解自动合并与 CD 行为（关键）**：
   - 仓库配置了 [auto-merge.yml](../.github/workflows/auto-merge.yml)：任何**非草稿（Ready for review）PR**在创建后会被自动开启 Auto-Merge，且一旦 [ci.yml](../.github/workflows/ci.yml) 全绿，GitHub Actions 会自动合并到 `main` 并触发 [cd.yml](../.github/workflows/cd.yml) 构建 GHCR 镜像并部署到 Self-Hosted Runner。
   - **因此**：未完成自检、仍需迭代或希望人工先审后合的改动，请使用 `gh pr create --draft` 创建草稿 PR；仅在本地验证通过且确认可进入自动合流时创建/转为非草稿 PR。

### 1.2 本地门禁与 CI 门禁

提交或更新 PR 前，本地必须全部通过：

```bash
pnpm lint       # turbo run lint && prettier --check .
pnpm typecheck  # turbo run typecheck && tsc -p e2e/tsconfig.json --noEmit
pnpm test       # turbo run test（各包 Vitest 单元测试）
```

> 提示：修改 `.md` / `.json` / `.ts` / `.tsx` 后若格式报错，运行 `pnpm format` 即可通过 Prettier 检查。

推送到远程并创建 PR 后，GitHub Actions 会并行/串行运行两项门禁：

- **`lint, typecheck, test`**（[ci.yml](../.github/workflows/ci.yml)）：包含 `prisma generate` + 上述三项检查。
- **`playwright e2e`**（[e2e.yml](../.github/workflows/e2e.yml)）：拉起 `pgvector/pgvector:pg16` + `redis:7-alpine`、执行迁移与种子、构建前后端（`NEXT_E2E_FAST_BUILD=1`）、以确定性假适配器跑全套 Playwright 端到端测试并上传截图产物。

**硬性要求**：必须等待两项检查全部变绿才能交接；若任一失败，必须在当前分支修至全绿，不得带红灯交接。

### 1.3 PR 描述清单

- 关联 Issue（如 `Closes #xxx` 或 `Refs #xxx`）。
- 变更范围与根因摘要（避免大段粘贴无关日志）。
- 本地验证结果（`pnpm lint`、`pnpm typecheck`、`pnpm test`，涉及 DB/Redis 改动时注明 `GEOMIX_DB_INTEGRATION=1` / `GEOMIX_REDIS_INTEGRATION=1` 结果）。
- 页面/交互类 PR 说明视觉与 DOM 契约核对情况（切勿把截图二进制提交到仓库）。

---

## 2. 机器强制契约与工程规范（编码前必查）

以下规范均由 **ESLint 或 Vitest 单测直接强制校验**，违反会在 CI 立刻报错。

### 2.1 `@geomix/shared` 包契约（`packages/shared`）

由 [`packages/shared/src/package-contract.spec.ts`](../packages/shared/src/package-contract.spec.ts) 强制校验：

1. **`exports` 1 对 1 双射**：`packages/shared/src/` 下每一个生产 `.ts` 文件（不含 `.spec.ts` / `.d.ts`）都必须在 `packages/shared/package.json#exports` 中有精确对应项，且条件键顺序必须严格为 `types` 在前、`default` 在后：
   ```json
   "./my-module": {
     "types": "./dist/my-module.d.ts",
     "default": "./dist/my-module.js"
   }
   ```
2. **零循环依赖**：`packages/shared/src/*.ts` 构成严格 DAG，任何自循环、二元或 N 元循环都会导致测试失败；`task-status.ts` 必须保持**零导入**。
3. **禁止自引用**：`packages/shared/src/` 内禁止 `import ... from '@geomix/shared'` 或 `'@geomix/shared/...'`，一律用相对路径。
4. **并行防冲突**：多代理并行开发时，优先在 `packages/shared/src/` 追加本模块专属文件，避免大面积改动他人模块文件；仅在需要统一导出时按需在 `index.ts` 与 `package.json#exports` 追加条目。

### 2.2 `@geomix/db` 数据层与多租户契约（`packages/db`）

由 [`packages/db/src/schema-contract.spec.ts`](../packages/db/src/schema-contract.spec.ts) 与 [`packages/db/src/tenant-scope.ts`](../packages/db/src/tenant-scope.ts) 共同守卫：

1. **已落地迁移不可改写**：禁止编辑 `packages/db/prisma/migrations/` 下任何已有迁移 SQL，所有结构变更必须新增一条时间戳迁移目录，且保持幂等安全（不 `DROP TABLE`，不在增量迁移里重复 `CREATE EXTENSION`）。
2. **同步契约测试**：增删 Prisma model 或新增迁移目录后，必须同步更新 `packages/db/src/schema-contract.spec.ts` 中的 `PHASE1_MODELS` 与迁移目录断言列表，并运行 `pnpm db:validate`。
3. **同步租户隔离登记**：任何新增 model 必须归类登记到 `packages/db/src/tenant-scope.ts` 的四个常量之一：
   - `REQUIRED_TENANT_MODELS`（绝大多数业务表，读写自动绑定当前 `tenantId`）
   - `NULLABLE_TENANT_MODELS`（如 `PromptTemplate`：读含系统行 `null` 与本租户行，写仅限本租户行）
   - `UNSCOPED_OPTIONAL_TENANT_MODELS`（如 `AuditLog`）
   - `UNSCOPED_UNOWNED_MODELS`（如 `Tenant`、`PricingItem`、`Announcement`、`KnowledgeChunk`、`AiTaskItem`）
4. **无 `tenantId` 子表的访问红线**：`KnowledgeChunk` 和 `AiTaskItem` 不会被 Prisma 租户扩展自动过滤；调用方必须**先查验父记录属于当前租户**，再按父 ID 查询或修改子表。
5. **时间精度约定**：队列租约、心跳与任务执行时间戳（`leaseUntil`、`startedAt`、`finishedAt`、`beatAt`）使用 `timestamptz`（`@db.Timestamptz(3)`），避免数据库会话时区差异误判租约过期。

### 2.3 `@geomix/server` 后端规范（`apps/server`）

1. **双入口架构**：同一套代码编译出 `dist/main.api.js`（`ApiModule`，HTTP 入口）与 `dist/main.worker.js`（`WorkerModule`，BullMQ 消费者）。新增异步队列任务时，注意在 `QueueModule.forApi()` 注册生产者、在 `QueueModule.forWorker()` 注册消费者与 Runner。
2. **统一路由、信封与校验**：
   - 全局路由前缀为 `/api/v1`（见 `common/create-api-app.ts`），不要在 Controller 里重复写 `api/v1`。
   - 成功响应一律返回 `ok(data)`（来自 `@geomix/shared`，格式 `{ code: 0, msg: 'ok', data }`）。
   - 请求体用 `parseBody(zodSchema, body)`（`common/parse-body.ts`）校验；业务异常统一抛出 `new ApiError(httpStatus, errorCode, message)`（由 `ApiExceptionFilter` 转换）。
3. **三层访问守卫与租户上下文**：
   - `AuthContextMiddleware` 通过 `AsyncLocalStorage`（`tenant/tenant-context.ts`）写入当前请求的 `tenantId`。
   - 普通商户接口：`@UseGuards(AuthGuard, TenantActiveGuard)`；到期/停用租户读接口放行、写接口返回 `403` / `40301`。
   - 管理员接口：额外挂载 `AdminGuard`——对非管理员返回 **`404`**（非 `403`），防止接口探测。
   - **数据库客户端选择**：日常商户业务一律使用 `this.prisma.scoped`；仅登录认证、种子/对账、管理员跨租户操作、Worker 后台消费以及原始 SQL 可用 `this.prisma.base`（且所有面向租户的原始 SQL 必须显式带 `WHERE "tenantId" = $...`）。
4. **计费与配额口径**：
   - 全局默认 `BILLING_MODE=SHADOW`；`Tenant.billingMode` 为 `null` 时继承全局值。
   - 计费流程固定为 `reserve`（整单冻结）→ `settle`（按产出单元结算，按 `unitKey + action` 幂等）→ `releaseUnit` / `close`（失败或取消退回未结算冻结）。无产出不得实扣。
   - 存量配额（`MAIN_KEYWORD`、`QUESTION`、`STORAGE_BYTES`）删除时回退；累计配额（`AI_WRITE`）仅写作任务创建时累加、只增不减。
5. **外部适配器与安全边界**：
   - 所有大模型、向量、生图、网页抓取、搜索、对象存储均走 `AdaptersModule`，开发/CI 默认确定性假实现（`LLM_PROVIDERS={}`、`EMBEDDING_PROVIDER=fake`、`IMAGE_PROVIDER=fake`、`VISIBILITY_COLLECTOR=fake`、`STORAGE_DRIVER=memory`、`SEARCH_PROVIDER=link_list`）。
   - 任何出网请求必须复用 `PublicFetchService` / `ssrf.ts`（仅 `http/https` 80/443、DNS 解析 IPv4/IPv6 校验、连接钉住、最多 3 次重定向校验、遵守 `robots.txt`）。
   - 文本/生图入口必须经过 `ComplianceService` 禁做行业校验（命中返回 `403` / `40302` 并写 `AuditLog`）。
6. **大型 Service 拆解范式**：参考 `apps/server/src/visibility/`，当单一 Service 过长时，按「对外 Facade（保持方法签名与依赖注入兼容）+ 领域子 Service（Profile / RunLifecycle / Analytics 等）+ 纯函数 Mapper」拆分。

### 2.4 `@geomix/web` 前端规范与 UX 守卫（`apps/web`）

#### A. 控制台多标签壳机制（极易踩坑）

- `apps/web/app/(console)/**/page.tsx` **只负责导出 Next.js `metadata` 并 `return null`**！
- 所有控制台业务页面由 `app/(console)/layout.tsx` → `ConsoleShell` → `ModuleScreen`（`apps/web/components/shell/module-screen.tsx`）统一按标签栈保活渲染（非激活页签不会卸载，通过 `active?: boolean` 通知是否在前台）。
- 新增控制台路由必须同时完成：
  1. 在 `apps/web/lib/routes.ts` 的 `STATIC_ROUTES`、`MENU`（及可选 `QUERY_KEYS`）登记；
  2. 在 `apps/web/components/shell/module-screen.tsx` 添加路由分发；
  3. 在 `apps/web/app/(console)/<path>/page.tsx` 添加空壳 `page.tsx`（含 `metadata`）；
  4. 如涉及旧路径兼容，更新 `apps/web/lib/route-map.ts`（`middleware.ts` 自动读取）。

#### B. 静态守卫红线（ESLint + `ux-foundation-guard.spec.ts`）

以下规则由 [`apps/web/eslint.config.mjs`](../apps/web/eslint.config.mjs) 和 [`apps/web/lib/ux-foundation-guard.spec.ts`](../apps/web/lib/ux-foundation-guard.spec.ts) 强制拦截：

| 禁止写法 | 正确替代 |
| --- | --- |
| 在 `components/` 调用静态 `Modal.confirm(...)` | `const { confirm } = useUxFeedback()`（`components/crud/ux-feedback.tsx`），自动继承暗黑主题与 ESC 关闭 |
| 在 `components/` 调用 `URL.revokeObjectURL(...)` | `triggerBlobDownload(...)`（`lib/ux-foundation.ts`），统一挂 DOM 触发并延迟释放 |
| 对 ISO 时间做 `.replace('T', ' ').slice(0, 16)` / `.expiresAt.slice(0, 10)` 等 UTC 切片 | `formatShanghaiDateTime` / `formatShanghaiDate` / `parseShanghaiDateTimeLocal`（`@geomix/shared`，固定 `Asia/Shanghai` UTC+8） |
| 文案包含内部研发黑话（如 `影子计费`、`零拷贝`、`检索适配器`、`复刻落库状态`、`已落库查看`、`切分向量索引`、`整段注入`、`切片向量化`、`含手工槽位·不入随机池`、`模型收录计数留到后续模块`）或 `placeholder="名称或备注"` | 使用 `UX_TERMS` 与 `replaceUxJargon`（`@geomix/shared`），写业务语义清晰的占位符 |
| 在标签标题、副标题、提示语中暴露裸 CUID | 使用 `isOpaqueEntityId`、`sanitizeEntityTitleSegment`、`formatShortDisplayId` 与 `useSyncTabTitle` |
| 业务列表页手写 `gm-crud-toolbar` 类或传入 `toolbarOrder="default"` | 统一使用 `<CrudTable>` 或 `<CrudToolbar>`（创建前置顺序：`[主创建] -> [刷新] -> [删除] -> [extraLeft]`） |
| 在 `apps/web/lib/*` 重复定义私有的 `function unwrap` | 复用 `unwrapEnvelope` / `createEnvelopeUnwrapper` / `GatewayApiError`（`apps/web/lib/envelope.ts`） |

#### C. 必用前端底座工具

- **任务轮询**：使用 [`useTaskPolling`](../apps/web/lib/use-task-polling.ts)（传入 `active` 自动在后台标签页暂停定时器，并内置 `inFlightRef` 防止慢请求重叠）。
- **跨标签页新鲜度同步**：使用 [`useTabFreshness`](../apps/web/lib/tab-freshness.ts) 订阅数据域，写操作成功后调用 `invalidateFreshness(...domains)`，确保后台页签切回前台时自动刷新。
- **暗黑原生 `<select>` 样式**：复用 [`NATIVE_SELECT_STYLE` / `COMPACT_SELECT_STYLE`](../apps/web/lib/select-styles.ts)。
- **ESC 浮层保护**：在自定义弹窗监听 `Escape` 时先检查 `hasOpenFloatingOverlay()`（`lib/ux-foundation.ts`），避免误关底层弹窗。

#### D. 技术栈锁定、Sonar Ink 暗色主题与 DOM 契约

- **不随意加依赖**：前端仅使用 Next.js 15 + React 19 + Ant Design 5 + Zustand + 原生 CSS（`apps/web/app/globals.css`）+ 手写 SVG。**严禁引入** Tailwind CSS、`@ant-design/pro-components`、`@tanstack/react-query`、ECharts、wangEditor 等未批准依赖。
- **视觉令牌**：所有颜色、圆角、阴影必须引用 `var(--gm-*)`（`globals.css`）或 `GM.*`（`lib/design-tokens.ts`）；关键数字加 `.gm-num`；禁止硬编码亮色背景或靛紫色（`#5E6AD2` / `#8B5CF6` / `#6366F1`）；动效尊重 `prefers-reduced-motion`。
- **DOM 契约保护**：修改既有页面布局或重构拆解组件时，保留已有 `aria-label`、`data-testid`、表头文案、核心按钮文案与 Modal 标题，避免破坏组件单测与 `e2e/` 断言。

### 2.5 与文档强耦合的单测

- `packages/shared/src/qa.spec.ts`：校验 `docs/页面对照验收清单.md` 必须覆盖 `M01`–`M09`、`S00`–`S27` 及扩展项且零未勾选/零外链图；同时扫描 `docs/` 目录，**任何 `.png/.jpg/.jpeg/.webp/.gif` 文件都会导致 CI 失败**。
- `apps/server/src/admin/llm-cost-report.spec.ts`：校验 `docs/运维与部署手册.md` 包含 `deploy-staging.sh`、`backup.sh`、`restore.sh`、`LLM_COST_RATES_JSON`。

---

## 3. 高频任务操作手册（Recipes）

### 3.1 新增 `@geomix/shared` 模块

1. 在 `packages/shared/src/<module>.ts` 编写纯类型、Zod Schema、常量与纯函数（严禁引入循环依赖或自包名）。
2. 在 `packages/shared/package.json` 的 `exports` 中追加 `"./<module>": { "types": "./dist/<module>.d.ts", "default": "./dist/<module>.js" }`。
3. 在 `packages/shared/src/index.ts` 按需具名或全量再导出。
4. 添加 `packages/shared/src/<module>.spec.ts`，执行：
   ```bash
   pnpm --filter @geomix/shared build && pnpm --filter @geomix/shared test
   ```

### 3.2 新增或修改 Prisma 数据模型

1. 修改 `packages/db/prisma/schema.prisma`。
2. 在 `packages/db/prisma/migrations/<YYYYMMDDHHMMSS>_<slug>/migration.sql` 新增增量迁移（幂等、无 `DROP TABLE`、无 `CREATE EXTENSION`）。
3. 若新增了 model：
   - 在 `packages/db/src/schema-contract.spec.ts` 更新 `PHASE1_MODELS` 与迁移列表断言；
   - 在 `packages/db/src/tenant-scope.ts` 正确登记租户隔离分类；
   - 如涉及种子默认项，更新 `packages/db/src/seed.ts` 并保持**可重复幂等执行**。
4. 运行 `pnpm db:validate`、`pnpm --filter @geomix/db typecheck`、`pnpm --filter @geomix/db test`（以及在有本地 PG 时跑 `GEOMIX_DB_INTEGRATION=1 pnpm --filter @geomix/db test`）。

### 3.3 新增后端接口或异步队列任务

1. 共享请求/响应 Schema 与常量放 `packages/shared`。
2. Controller 挂 `@UseGuards(AuthGuard, TenantActiveGuard)`（管理端另挂 `AdminGuard`），用 `parseBody` 校验入参，返回 `ok(...)`，失败抛 `ApiError`。
3. 业务查询走 `prisma.scoped`；涉计费操作走 `BillingService` 冻结与幂等结算；涉出网/内容生成走 `AdaptersModule` 适配器与 `ComplianceService`。
4. 如需异步队列：在 `packages/shared/src/queue.ts` 复用已有队列（或新增队列常量与并发配置并在 `.env.example` 补充），在 `QueueModule.forApi()` / `QueueModule.forWorker()` 注册生产者与 Runner。
5. 编写 `*.spec.ts` 单元测试覆盖正常流、权限/到期只读、租户隔离、参数校验与计费幂等。

### 3.4 新增或重构大型前端页面

1. **先护栏、后拆解**：重构大型页面前，若缺乏独立黑盒测试，先补齐覆盖核心交互、深链、轮询与错误态的 `*.spec.tsx`（测试用户可见行为而非内部实现细节）。
2. **推荐拆解结构**：
   - `*-screen.tsx`：薄容器，编排状态、拉取与子组件装配；
   - `*-helpers.ts` + `*-helpers.spec.ts`：纯数据映射、筛选、校验、导出转换函数；
   - `*-create-modal.tsx` / `*-detail-drawer.tsx` / `*-columns.tsx`：高内聚弹窗、抽屉与列定义；
   - `use-*.ts`：需要复用的局部状态或数据钩子。
3. **接入统一底座**：`unwrapEnvelope`、`useUxFeedback`、`triggerBlobDownload`、`CrudTable`/`CrudToolbar`、`useTaskPolling`、`useTabFreshness`、`NATIVE_SELECT_STYLE`、`formatShanghaiDateTime`。
4. 跑单页测试与守卫测试：
   ```bash
   pnpm --filter @geomix/web test lib/ux-foundation-guard.spec.ts <your-spec>
   ```

---

## 4. 测试矩阵与本地调试

| 测试层级 | 命令 | 说明 |
| --- | --- | --- |
| 全仓单测 | `pnpm test` | 默认不连 DB/Redis，自动经 Turborepo 先构建上游包（`^build`），CI 必跑 |
| 单文件快测 | `pnpm --filter <pkg> test <path>` | pnpm 10 直接传路径（勿加 `--`，否则 Vitest 会跑全量）；绕过 Turbo `^build`，首次安装或改动 `shared`/`db` 后需先执行 `node packages/db/scripts/prisma-cli.mjs generate` 或对应包 `build` |
| DB 集成测试 | `GEOMIX_DB_INTEGRATION=1 pnpm --filter @geomix/db test` / `@geomix/server test` | 需本机或 Compose PostgreSQL 16（pgvector）。`apps/server/src/common/test-db.ts` 的 `createIsolatedTestContext` 会自动建/删临时库；注意 `@geomix/db` 种子集成测试会改写目标库演示钱包，勿指共享库 |
| Redis 队列集成 | `GEOMIX_DB_INTEGRATION=1 GEOMIX_REDIS_INTEGRATION=1 pnpm --filter @geomix/server test` | 需本机或 Compose Redis 7；建议设置独立 `QUEUE_PREFIX` |
| Playwright E2E | `pnpm test:e2e` | 需 PG + Redis、先 `pnpm db:migrate && pnpm db:seed && pnpm build`；设 `NEXT_E2E_FAST_BUILD=1` 可跳过 Next 构建期重复 lint/tsc 并匹配 `next start`（非 `standalone`），完整环境变量见 `.github/workflows/e2e.yml` |

> **常见调试细节**：
> - **jsdom 环境**：`apps/web/vitest.setup.ts` 已补齐 `matchMedia`、`ResizeObserver`、`scrollIntoView` 与 AntD `rc-css` 样式兼容，单测无需重复 mock。
> - **ESLint 基础约定**：[`packages/config/eslint/base.js`](../packages/config/eslint/base.js) 启用 `@typescript-eslint/no-unused-vars`，有意未使用的参数或变量请以 `_` 开头。

---

## 5. 合规与安全检查清单

- [ ] 站名仅使用「GeoMix」，无任何原站品牌名、原站 URL、原站截图、原站协议或系统提示词原文。
- [ ] 默认计费模式仍为 `BILLING_MODE=SHADOW`；不改动全局默认扣点策略。
- [ ] 新增环境变量已同步写入根目录 [`.env.example`](../.env.example)，且不含任何真实密钥或第三方真实账号。
- [ ] 未在 `docs/` 下提交任何图片二进制文件。
- [ ] 涉及表格导出时沿用公式注入转义（`toCsv` / `toXlsx`）；涉及网页抓取走 `PublicFetchService`（SSRF + robots）；涉及上传图片走压缩与去 EXIF 管线。
