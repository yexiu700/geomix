# GeoMix

GeoMix 是一个多租户 GEO 内容创作与 AI 可见度平台。所有品牌、文案、视觉体系、合规协议与系统模板均为自制。

当前仓库已完整落地：

- **认证、多租户与计费底座**：图形验证码登录、刷新与撤销、到期只读守卫、Prisma 租户隔离扩展、`SHADOW` / `STRICT` 双模式冻结结算计费、配额管理与管理后台（租户、价格表、公告、系统模板、LLM 成本日报）。
- **AI 创作工作台**：关键词与 AI 蒸馏、写作标题池、企业画像图库（压缩/去 EXIF/缩略图/S3 存储）、企业知识库（细分/汇总、必读协议、1024 维 pgvector 检索）、写作指令（10+7+1 套自写系统模板 + 克隆）、文章分类、AI 写作任务队列、文章富文本编辑/审核/ZIP 批量导出（Markdown / HTML / Docx）。
- **流量复刻与 AI 生图**：单篇/批量全网爆文复刻（SSRF 防护 + robots 校验 + 相似度自检 + 合规改写）、AI 生图工作台（受 `FEATURE_AI_IMAGE` 控制）。
- **AI 可见度监测**：AI 数据看板与 AI 可见度诊断（监测档案、多引擎采集与裁判评分、引用溯源、声呐雷达可视化，受 `FEATURE_VISIBILITY` 控制）。
- **全站工程保障**：Sonar Ink 暗色设计系统、多标签保活后台壳（支持 `User.uiPrefs` 持久化与 16 条 `/user/*` 历史入口跳转）、全量 Vitest 单测、Playwright 全栈 E2E 与 GHCR / Self-Hosted Runner 自动部署流水线。

站名「GeoMix」为占位，默认计费模式为 `SHADOW`（只记账、不实扣点数），开发与 CI 默认使用确定性假 Provider，不依赖真实外网密钥。

---

## 文档导航

| 文档                                                        | 用途                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| [AGENTS.md](AGENTS.md)                                      | 编码代理入口速查（红线、CI 踩坑与常用命令）                  |
| [开发约定与迭代手册](docs/AGENTS.md)                        | 面向编码代理的完整开发规范、机器契约与操作手册               |
| [架构与模块索引](docs/架构与模块索引.md)                    | 实时技术栈、API 路由、7 个队列、前端底座与 34 个数据模型索引 |
| [运维与部署手册](docs/运维与部署手册.md)                    | 单机预发/生产 Compose、Nginx HTTPS、备份恢复与 LLM 成本日报  |
| [CD 部署指南](docs/CD部署指南.md)                           | GHCR + Self-Hosted Runner 自动发布配置                       |
| [页面对照验收清单](docs/页面对照验收清单.md)                | M01–M09 端到端主流程与 S00–S27 逐页核验基线                  |
| [已确认决策](docs/decisions.md)                             | 立项已确认决策与后续演进记录                                 |
| [设计系统与 UI 重构清单](docs/设计系统与UI重构Issue清单.md) | Sonar Ink 暗色视觉令牌规范（ISSUE-01..10 已全部落地）        |
| [终版实现路线](docs/终版实现路线.md)                        | 一期立项蓝图与业务规则基线（#1–#24 已全部完成）              |
| [评审与验证报告](docs/评审与验证报告.md)                    | 一期立项调研评审归档                                         |

原始第三方调研材料不存放于本仓库。

---

## 技术栈与仓库结构

- **前端**：Next.js 15（App Router）+ React 19 + Ant Design 5 + Zustand + 原生 CSS（`--gm-*` 令牌）+ 手写 SVG
- **后端**：NestJS 10（同代码库 `api` 与 `worker` 双入口）+ Zod + BullMQ + sharp + undici
- **数据与存储**：PostgreSQL 16（`pgvector` 1024 维）+ Prisma 5 + Redis 7 + MinIO（S3 兼容）
- **工程化**：pnpm 10 workspace + Turborepo 2 + TypeScript 5（strict）+ Vitest + Playwright

```text
geomix/
├─ apps/
│  ├─ web/                 # Next.js 15：登录页、多标签工作台壳、全业务模块与管理后台
│  └─ server/              # NestJS 10：src/main.api.ts 与 src/main.worker.ts
├─ packages/
│  ├─ config/              # ESLint 与 tsconfig 预设
│  ├─ shared/              # 跨端常量、信封、Zod Schema、计费/队列/时间/UX 纯逻辑
│  ├─ prompts/             # 提示词渲染与自写 10+7+1 系统模板
│  └─ db/                  # Prisma schema（34 模型）、迁移、幂等种子、租户隔离扩展
├─ e2e/                    # Playwright 全栈端到端测试套件
├─ scripts/                # 部署、备份、恢复与环境变量加载脚本
├─ docker/                 # Dockerfile、Nginx TLS 模板、PostgreSQL pgvector 初始化脚本
├─ docs/                   # 工程、架构、运维与验收文档
└─ .github/workflows/      # ci.yml（verify + e2e）、e2e.yml、auto-merge.yml、cd.yml
```

---

## 本地开发

环境要求：**Node.js >= 22**、**pnpm 10**、**Docker Compose v2**。

```bash
cp .env.example .env
docker compose up -d
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`docker compose up -d` 启动 PostgreSQL 16（`pgvector/pgvector:pg16`，初始化脚本自动执行 `CREATE EXTENSION IF NOT EXISTS vector`）、Redis 7 和 Chainguard MinIO 镜像。

> **PostgreSQL `pgvector` 权限说明**：
>
> - 本地 Compose 的 `geomix` 账号为库超级用户，无需手动建扩展。
> - 若连接外部 PostgreSQL 且业务账号非超级用户，需先由超级用户在目标库执行 `CREATE EXTENSION IF NOT EXISTS vector`，再运行 `pnpm db:migrate`（`prisma migrate deploy`）。已落地的迁移文件不可改写。
> - 如需在本地使用 `prisma migrate dev`，连接账号需具备 `CREATEDB` 及在影子库建 `vector` 扩展的权限。

`pnpm dev` 同时启动以下三个进程（不复制 `.env` 也可使用 `.env.example` 一致的缺省值启动，已导出环境变量优先于 `.env`）：

| 进程     | 地址                  | 说明                                                                 |
| -------- | --------------------- | -------------------------------------------------------------------- |
| `web`    | http://localhost:3000 | 站名 GeoMix；登录页 `/login`，工作台 `/dashboard`，管理后台 `/admin` |
| `api`    | http://localhost:3001 | NestJS REST API，全局前缀 `/api/v1`，健康检查 `GET /api/v1/health`   |
| `worker` | 无端口                | BullMQ 消费者，消费 7 个异步队列                                     |

本地开发默认种子账号（仅限本机使用，共享/预发环境务必通过 `.env` 修改）：

- 管理员：`admin` / `geomix-admin-dev`
- 演示商户：`demo` / `geomix-demo-dev`（初始 1000 点，默认继承全局 `SHADOW` 计费模式）

重复执行 `pnpm db:seed` 是幂等的：会恢复系统默认价格项和系统模板，不会重复加点，也不会覆盖已修改的口令、有效期、配额或租户计费模式。

---

## 常用脚本

| 命令               | 作用                                                             |
| ------------------ | ---------------------------------------------------------------- |
| `pnpm dev`         | 同时启动 `web`、`api`、`worker`                                  |
| `pnpm build`       | 构建所有 packages、server 与 web（自动先执行 `prisma generate`） |
| `pnpm lint`        | 全仓 ESLint + `prettier --check .`                               |
| `pnpm format`      | 使用 Prettier 格式化全仓代码与文档                               |
| `pnpm typecheck`   | 全仓 `tsc --noEmit`（含 `e2e/tsconfig.json`）                    |
| `pnpm test`        | 全仓 Vitest 单元测试（默认不连接 DB / Redis）                    |
| `pnpm test:e2e`    | 运行 Playwright 全栈端到端测试（需 PG + Redis + 已迁移/已构建）  |
| `pnpm db:validate` | 校验 Prisma schema                                               |
| `pnpm db:migrate`  | 应用已提交的 Prisma 迁移（`migrate deploy`）                     |
| `pnpm db:seed`     | 写入可重复执行的种子数据                                         |

按进程单独启动后端：

```bash
pnpm --filter @geomix/server dev:api
pnpm --filter @geomix/server dev:worker
```

---

## 测试与 CI

GitHub Actions（[ci.yml](.github/workflows/ci.yml)）在每次 Push / PR 上运行两项检查：

1. **`lint, typecheck, test`**：安装依赖、生成 Prisma Client 并执行 `pnpm lint`、`pnpm typecheck`、`pnpm test`。
2. **`playwright e2e`**（[e2e.yml](.github/workflows/e2e.yml)）：启动 PostgreSQL 16（pgvector）与 Redis 7 服务容器，完成迁移、种子、构建（`NEXT_E2E_FAST_BUILD=1`）并以确定性假适配器执行 `e2e/` 全量测试。

本地按需运行数据库 / Redis 集成测试：

```bash
# 数据库集成测试（@geomix/server 会自动建/删临时隔离库；@geomix/db 种子测试会修改目标库，勿指向共享库）
GEOMIX_DB_INTEGRATION=1 pnpm --filter @geomix/server test

# 包含 BullMQ / Redis 的完整后端集成测试
GEOMIX_DB_INTEGRATION=1 GEOMIX_REDIS_INTEGRATION=1 pnpm --filter @geomix/server test
```

更多配置说明、生产部署、备份恢复与架构细节，请查阅 [架构与模块索引](docs/架构与模块索引.md) 与 [运维与部署手册](docs/运维与部署手册.md)。
