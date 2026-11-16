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

本仓库已有工程骨架、一期 Prisma 模型、登录认证，以及计费与配额服务。外部 Provider、队列消费者和后台壳仍在后续 issue。

## 仓库结构

```
geomix/
├─ apps/
│  ├─ web/                 # Next.js 15：占位首页和登录页
│  └─ server/              # NestJS：src/main.api.ts 与 src/main.worker.ts
├─ packages/
│  ├─ config/              # ESLint 与 tsconfig 预设
│  ├─ shared/              # 站名、接口信封、环境变量、价格/配额/方向常量
│  ├─ prompts/             # 提示词渲染，以及自写的 10+7+1 系统模板
│  └─ db/                  # Prisma schema、迁移、可重复种子
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

`docker compose up -d` 启动 PostgreSQL 16（镜像 `pgvector/pgvector:pg16`，首次初始化会执行 `CREATE EXTENSION IF NOT EXISTS vector`）、Redis 7 和 MinIO。官方 `minio/minio` 镜像已从 Docker Hub 下架，所以这里使用 Chainguard 发布的 MinIO 构建，并用摘要固定版本。

迁移脚本里也有同一句扩展语句，已提交的迁移不再改写。没有 Docker 时，本机 PostgreSQL 16 安装 `pgvector` 后，把 `DATABASE_URL` 指过去即可。

业务账号如果不是超级用户，要先由超级用户在目标库执行 `CREATE EXTENSION IF NOT EXISTS vector`，再让业务账号执行 `pnpm db:migrate`。在 PostgreSQL 16 上，没装扩展时受限账号会得到 `permission denied to create extension "vector"`（必须是超级用户）。扩展已经存在时，迁移里的同一句会提示 already exists 并继续，库主可以建表。本地 Compose 的 `geomix` 用户就是该库的超级用户，初始化脚本也会创建扩展，所以本机 `docker compose` 不需要再手工做这一步。

`prisma migrate dev` 会另建影子库并重放迁移。连接账号需要 `CREATEDB`，否则建不出影子库。影子库是空的，里面同样会执行 `CREATE EXTENSION vector`。只有 `CREATEDB`、不是超级用户时，这一步仍然被拒绝，所以影子库账号还得能创建扩展。服务器上也要先装好 pgvector。日常应用迁移用 `pnpm db:migrate`（`migrate deploy`），不要为了部署去改已经落地的迁移文件。

`pnpm dev` 会同时启动：

| 进程   | 地址                  | 说明                                    |
| ------ | --------------------- | --------------------------------------- |
| web    | http://localhost:3000 | 占位首页，站名 GeoMix，登录在 `/login`  |
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

| 命令               | 作用                         |
| ------------------ | ---------------------------- |
| `pnpm dev`         | 同时启动 web、api、worker    |
| `pnpm lint`        | ESLint 与 Prettier           |
| `pnpm typecheck`   | 各包 `tsc --noEmit`          |
| `pnpm test`        | Vitest 单元测试              |
| `pnpm build`       | 构建 packages、server 和 web |
| `pnpm db:validate` | 校验 Prisma schema           |
| `pnpm db:migrate`  | 把已提交的迁移应用到数据库   |
| `pnpm db:seed`     | 写入可重复执行的种子         |

只启动后端其中一个入口：

```bash
pnpm --filter @geomix/server dev:api
pnpm --filter @geomix/server dev:worker
```

## 接口

返回格式是 `{code, msg, data}`。健康检查不需要登录，也不连数据库。

```bash
curl -s http://localhost:3001/api/v1/health
```

```json
{ "code": 0, "msg": "ok", "data": { "service": "api", "name": "GeoMix", "billingMode": "SHADOW" } }
```

`BILLING_MODE` 缺省为 `SHADOW`。租户 `billingMode` 为空时继承这个全局值。认证本身不扣点。计费服务见下方「计费与配额」。

登录前先取图形验证码。图片是服务端画的 PNG，响应里没有答案文本。验证码和登录失败计数存在当前 API 进程的内存里，重启后失效，多个 API 进程不共享。计数按 TCP 对端地址，不看客户端自己写的转发头。同一地址的验证码默认 10 分钟 10 次；同一地址加规范化用户名的密码失败默认 15 分钟 5 次，超出返回 429。答案只在测试进程的内存里可读，不会放进接口响应。

```bash
curl -s -X POST http://localhost:3001/api/v1/auth/captcha
curl -s -X POST http://localhost:3001/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"demo","password":"geomix-demo-dev","captchaId":"...","captchaCode":"..."}'
```

登录成功后用 `Authorization: Bearer <accessToken>` 访问：

| 方法 | 路径                           | 说明                                                                |
| ---- | ------------------------------ | ------------------------------------------------------------------- |
| POST | `/api/v1/auth/captcha`         | 获取验证码                                                          |
| POST | `/api/v1/auth/login`           | 校验验证码和口令，签发访问令牌和刷新令牌                            |
| POST | `/api/v1/auth/refresh`         | 用刷新令牌换新令牌                                                  |
| POST | `/api/v1/auth/logout`          | 撤销该用户当前全部登录                                              |
| POST | `/api/v1/auth/password`        | 修改密码。到期账号返回 403                                          |
| GET  | `/api/v1/account`              | 当前账号。到期后仍返回 200                                          |
| GET  | `/api/v1/account/users/:id`    | 只查本租户用户，其他租户返回 404                                    |
| GET  | `/api/v1/pricing`              | 价格表。写作报价按库里的单价计算                                    |
| GET  | `/api/v1/billing/quote`        | `count` 与 `knowledgeBase=1`。总额是篇数 ×（写作单价 + 知识库加价） |
| GET  | `/api/v1/billing/wallet`       | 当前租户点数、冻结和生效中的计费模式                                |
| GET  | `/api/v1/billing/ledger`       | 当前租户点数明细                                                    |
| GET  | `/api/v1/billing/quotas`       | 当前租户配额                                                        |
| POST | `/api/v1/admin/billing/adjust` | 管理员加点或扣点。商户访问返回 404                                  |
| POST | `/api/v1/admin/billing/mode`   | 管理员设置租户计费模式，`null` 表示继续继承全局                     |

口令校验复用 `packages/db` 的 scrypt 格式，登录时用异步 scrypt。停用账号（`isActive=false`）不能登录。到期账号可以登录和读取，写接口返回 `403`，错误码 `40301`。未登录是 `401` / `40101`。用户名或密码错误、验证码错误是 `400` / `40001`，不区分用户是否存在。请求过多是 `429` / `42901`，文案同样不区分用户是否存在。

种子账号默认是 `admin` / `geomix-admin-dev` 和 `demo` / `geomix-demo-dev`，只给本机使用。需要先 `pnpm db:migrate` 和 `pnpm db:seed`。

## 配置

新增配置写在根目录 `.env.example`。不要提交 `.env` 或真实密钥。本地 Compose 里的数据库口令、MinIO 口令都是开发占位，只供本机使用。

当前键：`DATABASE_URL`、`REDIS_URL`、`S3_*`、`JWT_*`、`AUTH_CAPTCHA_*`、`AUTH_LOGIN_FAIL_*`、`LLM_PROVIDERS`、`EMBEDDING_*`、`IMAGE_PROVIDER`、`SEARCH_PROVIDER`、`BILLING_MODE`、`BILLING_RECONCILE_AFTER_MS`、`BILLING_RECONCILE_INTERVAL_MS`、`FEATURE_AI_IMAGE`、`ARTICLE_RETENTION_DAYS`、`SEED_ADMIN_*`、`SEED_DEMO_*`，以及 `WEB_PORT`、`API_PORT`、`WEB_ORIGIN`、`NEXT_PUBLIC_API_BASE`。

`SEED_*` 只用于本机种子。口令是开发占位，不要拿到共享环境里用。

## 数据库

一期模型在 `packages/db/prisma/schema.prisma`，覆盖租户、用户、钱包、配额、价格、知识库向量、写作、复刻和生图。`pnpm build` 和 `pnpm typecheck` 会先执行 `prisma generate`。

```bash
pnpm db:validate
pnpm db:migrate
pnpm db:seed
```

种子可以重复执行。第二次会把价格和系统模板写回仓库里的默认值，不会把演示租户的 1000 点再加一次，也不会改口令、有效期、配额或已有的计费模式覆盖。新租户的 `billingMode` 为空，继承全局配置，默认 `SHADOW`。

创作方向 29 项和文案类型 15 项放在 `packages/shared/src/catalog.ts`，不进数据库。系统模板 10 篇正文、7 个标题、1 个复刻，正文在 `packages/prompts`，种子写入 `PromptTemplate`。带 `【品牌N】` 槽位的模板 `randomPool` 为 false。

口令哈希格式是 `scrypt$N$r$p$salt$hash`。登录直接复用 `verifyPassword`。

## 计费与配额

可用点数 = `points - pointsReserved`。STRICT 预扣用条件更新增加冻结；结算同时减少账面和冻结；失败或结单只减少冻结，账面在结算前不变。SHADOW 不改钱包，明细 `delta=0`、`listPrice` 为原价，标题加「（免费期）」。冻结单记下当时的 `shadow`，之后切换模式不追溯。

写作任务引用知识库时，预扣总额是篇数 ×（`ai_write` + `kb_addon`），结算写成两条明细。不挂知识库就只有写作一条。无产出或失败会释放剩余冻结，对账任务也会释放超过两小时且没有活跃任务的冻结。队列消费者还没做，这两小时内的冻结不会被对账清掉。

管理员加点写「管理员充值」，扣点写「管理员扣点」，都会改钱包，不受 SHADOW 影响。同一幂等键重放不重复入账。

配额：主关键词、写作问题、存储按存量，删除时回退；AI 写作只增不减。只有写作任务的创建计入 AI 写作数量。复刻、手动文章、改状态都不计入，也不改文章发布配额。发布和自媒体授权的回退口径还没定，服务拒绝回退。

原始 SQL 都带 `tenantId`。商户接口只使用登录租户。管理接口对商户返回 404。

## 当前范围

- 已完成：monorepo、两个 Nest 入口、四个 package、本地 Compose、CI 的 lint / typecheck / test、一期 Prisma 模型、初始迁移和种子、登录 / 刷新 / 退出 / 修改密码、图形验证码、租户查询隔离、到期只读守卫、登录页、计费与配额（#4）。
- 未实现：外部 Provider 适配层（#5）、BullMQ 消费者、后台壳。Worker 按 `BILLING_RECONCILE_INTERVAL_MS` 对账，不连接 Redis。健康检查不连数据库。
- 没有 `tenantId` 的子表（知识库切片、写作子任务）不会被扩展自动过滤，调用方必须先确认父记录属于当前租户。系统模板可以读，不能被租户改掉。
- CI 不启动数据库，所以迁移、种子、认证和计费集成测试要在本机跑。`pnpm test` 默认不连数据库；设置 `GEOMIX_DB_INTEGRATION=1` 后，`@geomix/db` 会执行迁移、重复种子和租户隔离测试，`@geomix/server` 会跑认证和计费测试。计费测试会另建 `geomix_bill_*` 库，不改种子演示钱包。种子集成测试会把演示钱包改成 42 点，所以不要把它指到还要继续使用的库。

## 开发节奏

按 `docs/终版实现路线.md` 第 F05 节分 4 批推进。每个功能在独立分支开发并开 PR，不直接推 `main`，不在代理侧合并或部署。
