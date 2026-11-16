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

本仓库已有工程骨架、一期 Prisma 模型、登录认证、计费与配额、外部适配层和多标签后台壳。队列消费者和通用列表仍在后续 issue。

## 仓库结构

```
geomix/
├─ apps/
│  ├─ web/                 # Next.js 15：登录页和多标签后台壳
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

| 进程   | 地址                  | 说明                                                           |
| ------ | --------------------- | -------------------------------------------------------------- |
| web    | http://localhost:3000 | 站名 GeoMix。登录在 `/login`，后台在 `/dashboard`              |
| api    | http://localhost:3001 | HTTP 入口                                                      |
| worker | 无端口                | BullMQ 消费者，日志里会打印 `worker started` 和 `queue bullmq` |

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

| 方法  | 路径                             | 说明                                                                             |
| ----- | -------------------------------- | -------------------------------------------------------------------------------- |
| POST  | `/api/v1/auth/captcha`           | 获取验证码                                                                       |
| POST  | `/api/v1/auth/login`             | 校验验证码和口令，签发访问令牌和刷新令牌                                         |
| POST  | `/api/v1/auth/refresh`           | 用刷新令牌换新令牌                                                               |
| POST  | `/api/v1/auth/logout`            | 撤销该用户当前全部登录                                                           |
| POST  | `/api/v1/auth/password`          | 修改密码。到期账号返回 403                                                       |
| GET   | `/api/v1/account`                | 当前账号。到期后仍返回 200                                                       |
| GET   | `/api/v1/account/users/:id`      | 只查本租户用户，其他租户返回 404                                                 |
| GET   | `/api/v1/pricing`                | 价格表。写作报价按库里的单价计算                                                 |
| GET   | `/api/v1/billing/quote`          | `count` 与 `knowledgeBase=1`。总额是篇数 ×（写作单价 + 知识库加价）              |
| GET   | `/api/v1/billing/wallet`         | 当前租户点数、冻结和生效中的计费模式                                             |
| GET   | `/api/v1/billing/ledger`         | 当前租户点数明细                                                                 |
| GET   | `/api/v1/billing/quotas`         | 当前租户配额                                                                     |
| POST  | `/api/v1/admin/billing/adjust`   | 管理员加点或扣点。商户访问返回 404                                               |
| POST  | `/api/v1/admin/billing/mode`     | 管理员设置租户计费模式，`null` 表示继续继承全局                                  |
| POST  | `/api/v1/queue/runs`             | 提交假任务。整单冻结，成功单元结算，失败或取消释放剩余冻结                       |
| GET   | `/api/v1/queue/runs/:id`         | 查询本租户进度。其他租户返回 404                                                 |
| POST  | `/api/v1/queue/runs/:id/pause`   | 暂停。不再领取新单元，进行中的单元做完当前这一篇                                 |
| POST  | `/api/v1/queue/runs/:id/resume`  | 继续。重新投递驱动任务                                                           |
| POST  | `/api/v1/queue/runs/:id/cancel`  | 终止。未产出的单元不再执行，并释放剩余冻结                                       |
| GET   | `/api/v1/admin/queues`           | 管理员看队列计数。商户返回 404。响应里没有任务正文                               |
| GET   | `/api/v1/admin/queues/board`     | 管理员的 bull-board。商户返回 404                                                |
| GET   | `/api/v1/workbench/samples`      | 当前租户的列表示例。支持 `page`、`pageSize`、`sort`、`order`、`filter`、`export` |
| POST  | `/api/v1/workbench/samples`      | 新增一条示例。不扣点                                                             |
| PATCH | `/api/v1/workbench/samples/:id`  | 修改本租户的一条示例。其他租户返回 404                                           |
| POST  | `/api/v1/workbench/samples/bulk` | 批量删除、启用或停用。编号必须全部属于当前租户                                   |

口令校验复用 `packages/db` 的 scrypt 格式，登录时用异步 scrypt。停用账号（`isActive=false`）不能登录。到期账号可以登录和读取，写接口返回 `403`，错误码 `40301`。未登录是 `401` / `40101`。用户名或密码错误、验证码错误是 `400` / `40001`，不区分用户是否存在。请求过多是 `429` / `42901`，文案同样不区分用户是否存在。

种子账号默认是 `admin` / `geomix-admin-dev` 和 `demo` / `geomix-demo-dev`，只给本机使用。需要先 `pnpm db:migrate` 和 `pnpm db:seed`。

## 配置

新增配置写在根目录 `.env.example`。不要提交 `.env` 或真实密钥。本地 Compose 里的数据库口令、MinIO 口令都是开发占位，只供本机使用。

当前键：`DATABASE_URL`、`REDIS_URL`、`QUEUE_PREFIX`、`QUEUE_HEARTBEAT_MS`、`QUEUE_HEARTBEAT_TTL_MS`、`QUEUE_LEASE_MS`、`QUEUE_UNIT_ATTEMPTS`、`QUEUE_BACKOFF_MS`、`QUEUE_RECOVER_MS`、`QUEUE_WRITE_CONCURRENCY`、`QUEUE_REWRITE_CONCURRENCY`、`QUEUE_BATCH_CONCURRENCY`、`QUEUE_KB_CONCURRENCY`、`QUEUE_IMAGE_CONCURRENCY`、`S3_*`、`JWT_*`、`AUTH_CAPTCHA_*`、`AUTH_LOGIN_FAIL_*`、`LLM_PROVIDERS`、`DEEPSEEK_API_KEY`、`TONGYI_API_KEY`、`DOUBAO_API_KEY`、`LLM_TIMEOUT_MS`、`EMBEDDING_*`、`IMAGE_PROVIDER`、`IMAGE_BASE_URL`、`IMAGE_MODEL`、`IMAGE_API_KEY`、`IMAGE_TIMEOUT_MS`、`SEARCH_PROVIDER`、`SEARCH_REMOTE_*`、`SEARCH_TIMEOUT_MS`、`FETCH_*`、`ROBOTS_CACHE_MS`、`STORAGE_DRIVER`、`STORAGE_MAX_OBJECT_BYTES`、`BILLING_MODE`、`BILLING_RECONCILE_AFTER_MS`、`BILLING_RECONCILE_INTERVAL_MS`、`FEATURE_AI_IMAGE`、`ARTICLE_RETENTION_DAYS`、`SEED_ADMIN_*`、`SEED_DEMO_*`，以及 `WEB_PORT`、`API_PORT`、`WEB_ORIGIN`、`NEXT_PUBLIC_API_BASE`。

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

写作任务引用知识库时，预扣总额是篇数 ×（`ai_write` + `kb_addon`），结算写成两条明细。不挂知识库就只有写作一条。无产出或失败会释放剩余冻结。对账会释放创建超过两小时、而且没有排队、暂停或新鲜心跳的冻结。正在跑的任务按 `QUEUE_HEARTBEAT_TTL_MS` 续心跳，长任务不会被两小时对账清掉。

管理员加点写「管理员充值」，扣点写「管理员扣点」，都会改钱包，不受 SHADOW 影响。同一幂等键重放不重复入账。

配额：主关键词、写作问题、存储按存量，删除时回退；AI 写作只增不减。只有写作任务的创建计入 AI 写作数量。复刻、手动文章、改状态都不计入，也不改文章发布配额。发布和自媒体授权的回退口径还没定，服务拒绝回退。

原始 SQL 都带 `tenantId`。商户接口只使用登录租户。管理接口对商户返回 404。

## 外部适配层

适配层在 `apps/server/src/infra`，由 api 和 worker 一起注入。开发默认全部走假实现，不读取真实密钥，也不会访问外网。`LLM_PROVIDERS={}` 时，正文、改写、蒸馏、标题和生图提示词都用假模型。假输出以 `【FAKE】` 开头，只说明这是 GeoMix 占位，不复述用户提示里的品牌结论。

切到真实实现时，在 `LLM_PROVIDERS` 里写 `deepseek`、`tongyi`、`doubao`。没写 `route` 的话，各场景主模型是 DeepSeek，备用按通义、豆包排列。厂商地址由配置给出，代码里不写死。调用前会做和网页抓取同一套地址校验，拒绝内网、链路本地、元数据地址和重定向。密钥只从 `DEEPSEEK_API_KEY`、`TONGYI_API_KEY`、`DOUBAO_API_KEY` 读取。

`LlmService.complete` 记录 token 和占位成本（每个 token 1 微元，`costBasis=placeholder`）。这不是厂商报价，也不写点数钱包，计费模式仍是 `SHADOW`，除非管理员另行切换。同一个租户和幂等键的成功调用只记一次；换输入会冲突。账本在进程内，重启后消失。没有为它新增表。

向量固定 1024 维，和已经落地的 `KnowledgeChunk.embedding vector(1024)` 一致。`EMBEDDING_DIMENSIONS` 不是 1024 时直接拒绝。假向量由文本哈希得到，相同文本结果相同。

图片接受 jpg、png、webp。长边缩到 1600，输出 jpeg 不超过 1MB，去掉 EXIF。宽度小于 500 只警告。输入超过 100MB 或像素超过 1600 万会被拒绝。假生图是纯色占位图，会先过禁做行业检查再压缩入库。对象默认放在进程内存，键是 `tenants/{tenantId}/{name}`。`STORAGE_DRIVER=s3` 才连 `S3_*` 指向的 MinIO。存储幂等也只在当前进程生效。

搜索默认 `link_list`：一行一个链接，去掉 `utm` / `gclid` / `fbclid`，不请求这些地址，标题和摘要留空。内网和非常规端口的链接会被丢掉。`SEARCH_PROVIDER=remote` 需要端点和密钥，契约是 `{ results: [{ url, title, snippet }] }`。摘要字段不能当正文。博查、Bing 和其他搜索厂商的原始报文没有接，避免猜接口。

公开网页抓取只允许 http/https 的 80 和 443。DNS 解析后的每个 IPv4 和 IPv6 都要检查，连接钉在通过检查的地址上。每次重定向重新检查，最多 3 次。超时 10 秒，正文不超过 5MB，只收 `text/html`。不发送 Cookie。robots.txt 缓存 1 小时；404 视为允许，其他失败拒绝抓取。401、403 和很短的验证页返回「无法公开访问」。测试使用注入的解析器和传输，不访问参考站点。

合规扫描用的是仓库里自写的禁做行业、敏感词和极限词。命中禁做行业返回 `403` / `40302`，并写 `AuditLog.action=forbidden_blocked`，payload 只留标签和文本哈希。极限词里可替换的会替换，`绝对` 和 `永久` 只打标。`最近`、`最后` 不会被当成极限词。原站词表不在仓库里，所以这份名单需要产品再确认。

还没做、也不要在本层猜的事：抓取后的正文提取、把 token 成本落成独立表、搜索厂商的官方请求格式。队列演练不调用这些适配器。后台壳和通用列表示例已经落地，关键词、写作、复刻和生图仍是占位。

## 当前范围

- 已完成：monorepo、两个 Nest 入口、四个 package、本地 Compose、CI 的 lint / typecheck / test、一期 Prisma 模型、初始迁移和种子、登录 / 刷新 / 退出 / 修改密码、图形验证码、租户查询隔离、到期只读守卫、登录页、计费与配额（#4）、外部适配层（#5，假 Provider）、BullMQ 队列框架（#6）、多标签后台壳（#7），以及通用列表、弹层、价格按钮和列表示例（#8）。
- 未实现：写作流水线（#16）。健康检查不连数据库，也不调用外部 Provider。队列演练只写运行状态，不写文章，也不调用上游模型。
- 没有 `tenantId` 的子表（知识库切片、写作子任务）不会被扩展自动过滤，调用方必须先确认父记录属于当前租户。系统模板可以读，不能被租户改掉。`WorkRun`、`WorkUnit`、`ActiveWork` 和 `CrudSample` 都有 `tenantId`，请求上下文会自动加上。
- CI 不启动数据库和 Redis，所以迁移、种子、认证、计费、队列和列表示例的集成测试要在本机跑。`pnpm test` 默认不连数据库；设置 `GEOMIX_DB_INTEGRATION=1` 后，`@geomix/db` 会执行迁移、重复种子和租户隔离测试，`@geomix/server` 会跑认证、计费和列表示例测试。再设置 `GEOMIX_REDIS_INTEGRATION=1` 后才会连本机 Redis 跑队列测试。计费另建 `geomix_bill_*`，队列另建 `geomix_queue_*`，列表示例另建 `geomix_crud_*`，都不改种子演示钱包。种子集成测试会把演示钱包改成 42 点，所以不要把它指到还要继续使用的库。

## 后台壳

登录成功后进入 `/dashboard`。顶栏是站名 GeoMix、滚动公告、有效期和账号菜单（修改密码、退出）。左侧是分组菜单。多标签默认开启：点菜单会打开或切到对应标签，右键可以刷新当前、关闭、关闭其他、关闭右侧、关闭全部。首页标签不能关闭，同时最多 15 个。不在前台的页面留在页面里，不卸载，所以输入中的草稿还在。

当前标签写在地址栏。标签栈和布局开关保存在 `localStorage` 的 `geomix.shell.v1`，刷新后恢复标签，不恢复草稿。右上角「布局」可以关闭多标签，之后每次只留当前页。布局开关目前只存在这台浏览器里，还没有写回 `User.uiPrefs`。

issue #7 已经点名的旧入口 `/user/zhiling` 会跳到 `/writing/prompts`。别的旧地址不会跳转。除了「列表示例」，业务列表页仍是占位，用来确认壳的切换和跳转。

## 通用列表

`/workbench/samples` 用来验收通用表格、搜索、分页、勾选、批量操作、弹层和价格按钮。其它业务页还没有接上这些组件。

表格左侧是刷新、添加、删除、启用、停用，需要时还有返回上一级。右侧是切换密度、列显隐、导出和搜索。空列表文案是「没有找到匹配的记录」。分页大小只有 10、25、50。搜索只提交关键字和启用状态，关键字按字面包含匹配，百分号、下划线和反斜杠不是通配符。弹层可以最小化到右下角、最大化，底部是重置和确定；确定可以换成价格按钮。

价格按钮读 `GET /pricing`，文案是「动作（X点数/篇）」。蒸馏显示「次」，生图显示「张」，数字来自价格表，不写死。示例页上的这个按钮只保存记录，不调用计费，也不调用外部模型。默认仍是 `SHADOW`。

示例接口是 `/api/v1/workbench/samples`。列表参数是 `page`、`pageSize`、`sort`、`order`、`filter`（JSON，只允许 `keyword` 和 `enabled`）和 `export=csv|xlsx`。筛选里出现租户编号或其他字段会返回 `400` / `40001`。查询带当前租户的 `tenantId`，走 Prisma，不使用原始 SQL，也不读取 `KnowledgeChunk`。其它租户的记录返回 `404` / `40401`。到期账号可以查看和导出，新增、修改和批量操作返回 `403` / `40301`。名称在同一个租户内不能重复，另一个租户可以用同一个名称。

导出最多 1000 条，只包含编号、名称、备注、状态和更新时间。单元格里以 `=`、`+`、`-`、`@` 开头的内容会先加引号，避免表格软件把它当成公式。

## 队列

Worker 连接 Redis，消费 `write-article`、`rewrite-single`、`rewrite-batch`、`kb-index`、`image-gen` 和 `maintenance`。假任务走 `write-article`，同一租户最多同时跑 2 个单元。驱动任务每次领一个未开始的单元，做完再领下一个。暂停后不再领；继续会重新入队；终止后未产出的步骤不再执行。

任务状态写在 PostgreSQL。BullMQ 只保存租户编号和运行编号。重复投递、重试和两个 worker 同时领到同一单元时，结算和 AI 写作配额都只记一次。没有产出的失败或取消会按单元退回剩余冻结，SHADOW 下钱包不变、明细 `delta=0`。进程重启后，租约过期的单元由维护任务重新投递。租约、开始时间和心跳都是 `timestamptz`，原始 SQL 和 Prisma 比的是同一个绝对时间，数据库会话设成上海或 UTC 都不会把还在心跳的任务当成过期。

`maintenance` 按 `BILLING_RECONCILE_INTERVAL_MS` 对账，并按 `QUEUE_RECOVER_MS` 找回卡住的任务。每天 03:00（worker 进程时区）的文章清理和孤儿文件清理只记一条跳过日志，一期不删除数据。关闭 worker 时会等当前单元写完再断开。

队列演练不调用真实模型、搜索或网页。`LLM_PROVIDERS={}` 时适配层仍是假 Provider，worker 状态里的 `upstream` 固定是 `disabled`。

## 开发节奏

按 `docs/终版实现路线.md` 第 F05 节分 4 批推进。每个功能在独立分支开发并开 PR，不直接推 `main`，不在代理侧合并或部署。
