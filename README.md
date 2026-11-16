# GeoMix

GEO 优化系统一期。目标是复刻同类产品的功能和交互，品牌、文案、模板和素材全部自制，不复用原站资源。

一期范围：AI 素材源力、AI 文章写作、AI 流量复刻、AI 生图，以及登录、多标签后台壳、个人中心、管理后台和计费基础。视频发布等后续模块不在一期。

站名「GeoMix」为占位，品牌确定后替换。计费默认只记账、不实扣点数，可由管理员切换为正式扣点。大模型默认使用 DeepSeek（开发期先走假 Provider）。

## 文档

- [终版实现路线](docs/终版实现路线.md)：范围、技术栈、数据模型、关键实现、里程碑和 24 个 issue
- [评审与验证报告](docs/评审与验证报告.md)：两份调研报告的评审与核实
- [已确认决策](docs/decisions.md)
- [开发约定](docs/AGENTS.md)

原始调研材料（第三方文档、原站截图等）不在本仓库。

## 技术栈

前端 Next.js 15（App Router）+ Ant Design 5，后端 NestJS 10（同一个代码库的 `api` 和 `worker` 入口），PostgreSQL 16（pgvector）+ Redis 7 + MinIO。包管理用 pnpm workspace，任务编排用 Turborepo。语言是 TypeScript 5（strict）。

本仓库目前只完成工程骨架。Prisma 模型、认证、计费服务、队列消费者和后台页面都在后续 issue。

## 仓库结构

```
geomix/
├─ apps/
│  ├─ web/                 # Next.js 15 占位页
│  └─ server/              # NestJS：src/main.api.ts 与 src/main.worker.ts
├─ packages/
│  ├─ config/              # ESLint 与 tsconfig 预设
│  ├─ shared/              # 站名、接口信封、环境变量和计费模式占位
│  ├─ prompts/             # 提示词渲染纯函数（系统模板正文尚未写入）
│  └─ db/                  # Prisma 数据源占位，模型在后续 schema issue
├─ docker/postgres/init/   # 本地库启用 vector 扩展
├─ docker-compose.yml
└─ .github/workflows/ci.yml
```

## 本地开发

需要 Node.js 22、pnpm 10 和 Docker Compose。

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm dev
```

`docker compose up -d` 启动 PostgreSQL 16（镜像 `pgvector/pgvector:pg16`，首次初始化会执行 `CREATE EXTENSION vector`）、Redis 7 和 MinIO。官方 `minio/minio` 镜像已从 Docker Hub 下架，所以这里使用 Chainguard 发布的 MinIO 构建，并用摘要固定版本。

`pnpm dev` 会同时启动：

| 进程   | 地址                  | 说明                                    |
| ------ | --------------------- | --------------------------------------- |
| web    | http://localhost:3000 | 占位首页，站名 GeoMix                   |
| api    | http://localhost:3001 | HTTP 入口                               |
| worker | 无端口                | 待机进程，日志里会打印 `worker started` |

不复制 `.env` 也能启动。代码里的缺省值和 `.env.example` 一致。已经导出的 shell 变量优先于 `.env`。

停止应用用 `Ctrl+C`。停止依赖：

```bash
docker compose down
```

查看依赖状态：

```bash
docker compose ps
```

## 脚本

| 命令             | 作用                         |
| ---------------- | ---------------------------- |
| `pnpm dev`       | 同时启动 web、api、worker    |
| `pnpm lint`      | ESLint 与 Prettier           |
| `pnpm typecheck` | 各包 `tsc --noEmit`          |
| `pnpm test`      | Vitest 单元测试              |
| `pnpm build`     | 构建 packages、server 和 web |

只启动后端其中一个入口：

```bash
pnpm --filter @geomix/server dev:api
pnpm --filter @geomix/server dev:worker
```

## 接口

骨架阶段只有健康检查。返回格式是 `{code, msg, data}`。

```bash
curl -s http://localhost:3001/api/v1/health
```

```json
{ "code": 0, "msg": "ok", "data": { "service": "api", "name": "GeoMix", "billingMode": "SHADOW" } }
```

`BILLING_MODE` 缺省为 `SHADOW`。这只是配置占位，不会冻结或扣减点数。

## 配置

新增配置写在根目录 `.env.example`。不要提交 `.env` 或真实密钥。本地 Compose 里的数据库口令、MinIO 口令都是开发占位，只供本机使用。

当前键：`DATABASE_URL`、`REDIS_URL`、`S3_*`、`JWT_*`、`LLM_PROVIDERS`、`EMBEDDING_*`、`IMAGE_PROVIDER`、`SEARCH_PROVIDER`、`BILLING_MODE`、`FEATURE_AI_IMAGE`、`ARTICLE_RETENTION_DAYS`，以及 `WEB_PORT`、`API_PORT`、`WEB_ORIGIN`。

## 当前范围

- 已完成：monorepo、两个 Nest 入口、四个 package、本地 Compose、CI 的 lint / typecheck / test。
- 未实现：Prisma 模型与迁移、认证、计费与配额、BullMQ 消费者、后台壳。Worker 只用一个定时器保持进程，不连接 Redis。API 启动时不连接数据库。
- `packages/db` 的 `schema.prisma` 还没有 model，因此先不要运行 `prisma validate` 或 `prisma generate`。

## 开发节奏

按 `docs/终版实现路线.md` 第 F05 节分 4 批推进。每个功能在独立分支开发并开 PR，不直接推 `main`，不在代理侧合并或部署。
