# GeoMix 品牌官网需求规格与技术架构设计

> **版本定位**：Global-First 中英双语品牌官网与获客转化门户  
> **代码基线**：`main@f305327`（已包含 v2.0 极简工作区、`Sonar Ink / Phosphor` 设计系统与 v2.1 分发/归因能力）  
> **关联追踪**：总 Epic [#382](https://github.com/yexiu700/geomix/issues/382) · Batch 0–3 拆分单 [#378](https://github.com/yexiu700/geomix/issues/378)–[#381](https://github.com/yexiu700/geomix/issues/381) · 开发红线详见 [docs/AGENTS.md](./AGENTS.md)

---

## 一、已拍板核心决策（架构与产品边界）

| 决策域            | 已确认方案                                                                                | 核心约束与原因                                                                                                                                                                                                                                                                |
| :---------------- | :---------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 宿主与架构** | **同仓集成进 `apps/web` 根路径 `/`**（`(marketing)` 路由组替换当前 `redirect('/login')`） | 零额外运维/CD 成本，直接复用 `globals.css` 令牌，并在官网根目录原生输出 `robots.txt`、`sitemap.xml`、`llms.txt` 与 JSON-LD。已登录用户访问 `/` 不强制跳走，顶栏 CTA 自动切换为「进入控制台 → `/home`」；`/login` 保持已登录自动进 `/home`。                                   |
| **2. 受众与语言** | **中英双语且海外优先（Global-First）**                                                    | 英文为默认根路径（`/`、`/pricing`、`/guides`、`/demo`），中文为独立 SSR 路径（`/zh`、`/zh/pricing`、`/zh/guides`、`/zh/demo`），确保 `GPTBot` / `PerplexityBot` / `Googlebot` 无需点击 JS 切换即可索引双语，并配齐 `hreflang`（`en` / `zh-CN` / `x-default`）与 `canonical`。 |
| **3. 转化与试用** | **「预约演示 / 申请试用（Lead 表单入库）」+「登录控制台」**                               | 当前无自助注册与在线支付，不开放无门槛注册以防刷点数；公开表单入库 `MarketingLead` 表并支持 `/admin/leads` 审核后按既有租户机制开通 `1,000 点 / 365 天` Demo 租户。                                                                                                           |
| **4. 信息架构**   | **轻量多页矩阵（4 类核心页 × EN/ZH = 8 个 SSR 页面）**                                    | 首页（产品闭环 + 交互沙盒 + FAQ）、定价与点数预算计算器（`/pricing`）、GEO 实操指南（`/guides` 与 `/guides/[slug]`）、预约试用表单页（`/demo`）。                                                                                                                             |
| **5. 视觉与实证** | **延续「深色暗黑实验室」美学 + 交互式产品沙盒**                                           | `#0a0c0b` 底色 + `#c5f04a` Phosphor 亮绿 + `#3de0c8` Cited Teal + `JetBrains Mono`；Hero 内嵌 3 Tab 交互沙盒（引用拓扑 / 双轨门禁 / 多渠道分发与 T+7/14/30 归因），全部使用脱敏样例品牌数据。                                                                                 |
| **6. 定价口径**   | **透明点数规则 + 免费标配 + 互动计算器**                                                  | 100% 对齐 `packages/shared/src/catalog.ts`（`geo_write=10`、`visibility_check=2`、`inline_image_gen=5`、`geo_variant=2` 及 7 项 0 点免费动作），方案卡以「Demo 1,000 点试用 / 增长团队版 / 企业代理版 · Contact Sales」展示，不在代码写死未拍板法币价格。                     |

---

## 二、信息架构与页面规划

### 2.1 路由地图与 SEO / GEO 矩阵

| 英文默认路径                 | 中文对应路径                       | 页面定位                                                                                                                                | 核心 Schema（JSON-LD）                             |
| :--------------------------- | :--------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------- |
| `/`                          | `/zh`                              | **品牌首页**：Hero 价值主张、3 Tab 交互式产品沙盒、4 步 GEO 闭环、连接器与安全红线、FAQ、底部转化区                                     | `Organization` + `SoftwareApplication` + `FAQPage` |
| `/pricing`                   | `/zh/pricing`                      | **定价与点数规则**：3 档方案卡、动作点价表（实时对接 `PRICING_DEFAULTS`）、7 项 0 点免费标配、月度点数计算器、计费 FAQ                  | `SoftwareApplication` + `FAQPage`                  |
| `/guides` & `/guides/[slug]` | `/zh/guides` & `/zh/guides/[slug]` | **GEO 实操指南与架构专栏**（TypeScript 强类型静态内容源，4 篇深度实操指南）                                                             | `CollectionPage` / `TechArticle`                   |
| `/demo`                      | `/zh/demo`                         | **预约演示与 1,000 点试用申请**：结构化线索表单 + 开通流程说明 + 隐私与数据隔离承诺                                                     | `ContactPage`                                      |
| `/robots.txt`                | —                                  | 允许主流搜索与 AI 检索爬虫抓取公开官网路径，屏蔽 `/admin`、`/home`、`/brands`、`/visibility`、`/studio`、`/account`、`/share/`、`/api/` | —                                                  |
| `/sitemap.xml`               | —                                  | 输出全部 EN / ZH 公开页面及 `alternates.languages` 映射                                                                                 | —                                                  |
| `/llms.txt`                  | —                                  | 遵循 `llms.txt` 规范的机器可读站点索引（产品定位、双市场引擎、连接器、定价摘要与指南链接）                                              | —                                                  |

### 2.2 导航与登录态兼容规则

1. **顶部导航栏（`MarketingHeader`）**：
   - 左侧：GeoMix 品牌标识（Phosphor 圆环标志 + `GeoMix`）
   - 中部：`Product`（锚点 `#workflow`）/ `Pricing`（`/pricing`）/ `Guides`（`/guides`）
   - 右侧：`EN | 中文` 路由切换器（保留当前子路由上下文）+ 次要按钮（未登录显示「Sign In / 登录」→ `/login`；检测到本地会话 Token 时显示「Enter Console / 进入控制台」→ `/home`）+ 主 CTA「Request Demo / 申请试用」→ `/demo`
2. **与现有控制台隔离与零回归**：
   - 不改动 `app/(console)/layout.tsx` 与 `/home`、`/brands`、`/visibility`、`/studio`、`/account` 的鉴权逻辑；
   - 不改动 `apps/web/middleware.ts` 对 `/user/*`、`/dashboard/*`、`/me/*` 的 307 兼容重定向；
   - `app/layout.tsx` 保持全局 `AppProviders`，`(marketing)/layout.tsx` 使用轻量 Header/Footer 与纯 CSS（`.gm-mkt-*`），不加载控制台重型工作区状态树，且遵循 `AGENTS.md` 规范（禁用 Tailwind、禁用未审批的研发黑话与手动 UTC 字符串切片）。

---

## 三、首页核心区块与交互沙盒设计（`/` & `/zh`）

1. **Hero 区块**：
   - Eyebrow 徽标：`DUAL-MARKET GEO PLATFORM · GLOBAL + CN`
   - 主标题（EN）：`Make Your Brand the Source AI Cites — Not Just Mentions.`
   - 主标题（ZH）：`让品牌成为 AI 回答的「首选信源」，而不只是被顺带提及`
   - 副标题：点明「真实品牌事实底座 → 多引擎引用拓扑诊断 → 规则合规精写与 1→N 分发 → T+1/7/14/30 归因复测」端到端闭环。
   - 双 CTA：`Request 1,000-Pt Trial / 申请 1,000 点试用`（Phosphor 主按钮）+ `Explore Live Sandbox / 体验交互沙盒`（锚点滚动）。
   - 引擎覆盖条：切换预览 **GLOBAL**（ChatGPT / Perplexity / Google Search / Gemini）与 **CN**（豆包 / DeepSeek / Kimi / 元宝 / 通义）监测矩阵。
2. **交互式产品沙盒（`InteractiveProductSandbox`）**：
   - **Tab 1 · Citation Diagnosis（引用拓扑诊断）**：支持切换 `GLOBAL` vs `CN` 样例品牌（脱敏虚构品牌如 `NordicAudio` / `北境声学`），展示 `CITED`（青绿 `#3de0c8`）、`MENTIONED`（冷灰）、`COMPETITOR`（珊瑚橙 `#ff7a59`）、`ABSENT` 分布与自有域名引用占比条。
   - **Tab 2 · Studio & Dual-Track Gate（合规门禁与写作体检）**：可点击注入/修复测试片段（`[TBD: runtime]`、超标宣传词、中文字符泄漏），实时演示 `evaluateDistributionPreflight` 的拦截效果与 `0–100` GEO 评分变化。
   - **Tab 3 · 1→N Distribution & Attribution（多渠道分发与归因）**：切换查看 `Shopify / WordPress L1（含 JSON-LD + IndexNow）`、`Reddit 去营销防封自检清单`、`免登录 PR/KOL 供稿包`，以及 `T+1 CrawlProbe（robots.txt / JSON-LD / HTTP 200）` 与 `T+7 → T+14 → T+30` 阶梯复测曲线。
3. **4 步闭环能力矩阵 + 连接器生态带**：
   - L1 直发（Shopify / WordPress / Webflow / HMAC Webhook + IndexNow）
   - L3 社区合规辅发与外协（Reddit / Quora / 知乎去营销指南、30 天免登录 PR/KOL 供稿单）
   - Roadmap 预告条（清晰标注 `Upcoming v2.2`：Near-Miss 掘金、Wilson 95% 置信区间、Ghost / Dev.to / Hashnode / GitHub MDX / 公众号草稿箱 / Chrome 扩展 L2）。
4. **安全与工程信任底座（4 项硬承诺）**：
   - `AES-256-GCM` 凭据加密落库，永不回传明文
   - 全量出站连接与抓取探测 `100% SSRF` 防护
   - 严格租户隔离（PostgreSQL + pgvector）与可审计点数账本
   - 严禁社区自动水军发帖（仅辅助人工合规创作与防封自检）
5. **FAQ 手风琴 + 底部转化条 + 页脚**：
   - 覆盖「GEO 与传统 SEO 的区别」「点数如何计费（含 0 点免费项）」「如何防止 AI 幻觉」「支持哪些独立站与海外/国内平台」「如何申请 Demo 试用」。

---

## 四、`/pricing` 与 `/guides` 页面详细规格

### 4.1 `/pricing` & `/zh/pricing`

1. **三档方案卡片**：
   - **Trial Demo（体验试跑）**：默认 `1,000 点 / 365 天`（沿用 `DEMO_TENANT_POINTS` / `DEMO_TENANT_VALID_DAYS`），包含完整双市场诊断、写作与 L1/L3 分发验证，通过 `/demo` 申请开通。
   - **Growth Brand Team（成长品牌团队）**：面向出海 DTC / SaaS 或国内主理人团队，按需配置点数包与品牌/发布配额，CTA「预约演示 / 获取方案」。
   - **Agency & Enterprise（代理商与多品牌企业）**：多品牌矩阵、定制高并发采集配额、专属运维与部署支持，CTA「联系架构顾问」。
2. **透明计费规则表（服务端接口 + `catalog.ts` 双重对齐）**：
   - 收费动作：`GEO 靶向写作 = 10 点/篇`、`AI 可见性监测 = 2 点/引擎/次`、`行内 AI 配图 = 5 点/张`、`渠道变体改写 = 2 点/渠道`（由公开只读接口下发，兜底值来自 `@geomix/shared`）。
   - 免费标配（0 点 + 租户限流）：品牌事实卡提取、GEO 0–100 实时体检、局部分段重写、发布前门禁校验、JSON-LD & `llms.txt` 导出、T+1 线上抓取与 Schema 体检、免登录 PR/KOL 供稿单。
3. **交互式月度点数估算器（`PointsBudgetCalculator`）**：
   - 输入项：月度母稿数（1–50）、每篇派生变体渠道数（0–4）、追踪核心问句数（5–100）、监测引擎数（1–5）、是否开启 T+7/14/30 自动复测（1 次 / 3 次高置信）。
   - 实时输出：月度预计点数拆解（写作 + 变体 + 基线监测 + 阶梯复测）、对应推荐档位，点击「带配置申请试用」可携带估算摘要跳转 `/demo`。

### 4.2 `/guides` & `/guides/[slug]`（含 `/zh/guides*`）

基于 `packages/shared/src/marketing.ts` 维护 4 篇结构化双语指南（无需新建富文本 CMS 表，版本可控、Build 期零外部依赖）：

1. `geo-citation-vs-mention`：_From Brand Mention to Source Citation: Why GEO Replaces Guesswork_（从品牌提及到信源引用：GEO 的衡量基准）
2. `llms-txt-and-jsonld-playbook`：_Engineering AI Crawlability: robots.txt, JSON-LD, and llms.txt_（AI 可抓取工程指南：`robots.txt`、`JSON-LD` 与 `llms.txt`）
3. `zero-ban-community-geo`：_Zero-Ban Community GEO: Reddit, Quora, and Login-Free PR Media Kits_（零封号社区 GEO 与免登录 PR/KOL 协作实践）
4. `t7-t14-t30-attribution`：_Measuring Real GEO Impact with T+1 Crawl Probes & T+7/14/30 Retests_（T+1 抓取体检与 T+7/14/30 归因复测方法论）

---

## 五、数据模型、后端 API 与管理后台线索闭环

### 5.1 数据库扩展（`packages/db/prisma/schema.prisma`）

新增全平台级模型 `MarketingLead`（在 `packages/db/src/tenant-scope.ts` 归入 `UNSCOPED_UNOWNED_MODELS`，同步更新 `schema-contract.spec.ts`）：

```prisma
enum MarketingLeadStatus {
  NEW
  CONTACTED
  TRIAL_PROVISIONED
  ARCHIVED
}

enum MarketingLeadMarket {
  GLOBAL
  CN
  BOTH
}

model MarketingLead {
  id             String              @id @default(cuid())
  locale         String              @default("en") // "en" | "zh-CN"
  name           String
  email          String
  companyBrand   String
  websiteUrl     String?
  targetMarket   MarketingLeadMarket @default(GLOBAL)
  monthlyGoal    String?
  estimatedPts   Int?
  notes          String?
  sourcePage     String?             // "/demo" | "/zh/demo" | "/pricing"
  status         MarketingLeadStatus @default(NEW)
  adminNote      String?
  sourceIpHash   String?             // SHA-256(ip + salt) 仅作反垃圾审计，不存明文 IP
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt

  @@index([status, createdAt])
  @@index([email, createdAt])
}
```

### 5.2 共享契约（`packages/shared/src/marketing.ts`）

- 严格遵守 `package-contract.spec.ts`：在 `packages/shared/package.json#exports` 与 `src/index.ts` 同步导出。
- 包含：`createMarketingLeadSchema`、`updateMarketingLeadStatusSchema`、`PUBLIC_PRICING_FALLBACK`、`calculateMonthlyPointsEstimate()` 与 `MARKETING_GUIDES`。

### 5.3 服务端接口（`apps/server/src/marketing/`，注册至 `AppModule`）

1. **公开端点（无 `AuthGuard`，防滥用把关）**：
   - `POST /api/v2/public/leads`：Honeypot 命中静默返回伪成功；IP + Email 限流（`429`）；`websiteUrl` 仅校验格式、绝不触发服务端外呼（零 SSRF 面）；`sourceIpHash` 单向哈希落库。
   - `GET /api/v2/public/pricing`：只读返回生效 `PricingItem`（兜底 `PRICING_DEFAULTS`）、免费标配清单与 Demo 默认配额，绝不泄露租户或 LLM 成本信息。
2. **管理员端点（`AdminGuard`，非管理员返回 `404`）**：
   - `GET /api/v1/admin/leads` & `PATCH /api/v1/admin/leads/:id`。
   - **运营后台（`/admin/leads`）**：同步更新 `apps/web/components/admin/admin-frame.tsx`、`apps/web/lib/route-map.ts`（`ADMIN_ROUTES`）与 `route-map.spec.ts`。

---

## 六、分批交付路线与 GitHub Issues 映射

| 批次        | Issue                                                 | 范围                                                                                                                             | 依赖           | 并发策略       |
| :---------- | :---------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------- | :------------- | :------------- |
| **Epic**    | [#382](https://github.com/yexiu700/geomix/issues/382) | GeoMix 品牌官网总追踪（Global-First 双语 SSR + 交互沙盒 + 点数计算器 + Lead 闭环）                                               | —              | 总控           |
| **Batch 0** | [#378](https://github.com/yexiu700/geomix/issues/378) | DB（`MarketingLead` + 迁移 + 隔离校验）、Shared（`marketing.ts` 契约/指南/估算器）、路由底座                                     | 无             | 顺序优先合入   |
| **Batch 1** | [#379](https://github.com/yexiu700/geomix/issues/379) | 后端 `MarketingModule`（`POST /api/v2/public/leads`、`GET /api/v2/public/pricing`、Admin CRUD）+ `/admin/leads`                  | `#378`         | 与 `#380` 并行 |
| **Batch 2** | [#380](https://github.com/yexiu700/geomix/issues/380) | `(marketing)` 骨架、`/` & `/zh` 首页、3 Tab 交互沙盒、Logged-in CTA 自适应、`/robots.ts` / `/sitemap.ts` / `/llms.txt` / JSON-LD | `#378`         | 与 `#379` 并行 |
| **Batch 3** | [#381](https://github.com/yexiu700/geomix/issues/381) | `/pricing`（点数计算器）、`/guides` & `/guides/[slug]`、`/demo`（EN/ZH）+ Playwright 全链路 E2E                                  | `#379`, `#380` | 端到端收口     |

---

## 七、验收清单与 CI 红线

- **CI 门禁**：每个 PR 必须通过 `pnpm lint`（含 Prettier）、`pnpm typecheck`（含 `e2e/tsconfig.json`）、`pnpm test`、`pnpm build` 及 `playwright e2e`。
- **关键 E2E 断言**：
  1. 匿名访问 `/` 返回 `200` 渲染品牌首页（不再重定向 `/login`），`/home` / `/brands` / `/visibility` / `/studio` / `/account` 匿名访问仍正常重定向 `/login`；
  2. `/zh` 正常渲染中文首页，`hreflang` 与语言切换按钮在子路由间保持路径对齐；
  3. 首页 3 Tab 交互沙盒与 `/pricing` 点数计算器可实时交互且计算结果与 `@geomix/shared` 一致；
  4. `/demo` 提交表单命中 `POST /api/v2/public/leads`，Honeypot 触发时静默成功不入库，合法提交在管理员登录 `/admin/leads` 可见并可更新状态；
  5. `/llms.txt`（`text/plain; charset=utf-8`）、`/robots.txt`、`/sitemap.xml` 与页面 `<script type="application/ld+json">` 均可解析校验，全程 0 条未捕获 JS 错误。
