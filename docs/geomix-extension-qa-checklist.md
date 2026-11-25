# GeoMix Chrome 扩展（`yexiu700/geomix-extension`）跨仓本地联调与真机验收清单

> **对应需求与架构**：[`docs/v2.2可证明ROI与渠道扩容需求与架构设计.md`](./v2.2可证明ROI与渠道扩容需求与架构设计.md)（主线 B Lite · Issue `#371` / `#373` / `#374`）  
> **主仓桥接契约**：[`packages/shared/src/extension-bridge.ts`](../packages/shared/src/extension-bridge.ts)、[`apps/server/src/extension/`](../apps/server/src/extension/)  
> **伴生扩展仓**：`yexiu700/geomix-extension`（Epic `#7` / Issues `#1`–`#6`，Chrome MV3）

---

## 1. 架构边界与安全红线

GeoMix 主仓与伴生扩展仓通过 **Bridge v1** 最小化协议通信，任何联调或真机发版前必须满足以下红线：

1. **仅写草稿箱、不代点发布**：扩展仅负责把待分发图文与本地中转图片注入平台草稿箱，由作者在已登录浏览器中人工复核并手动点击「发布」，严禁自动点击平台最终发布按钮或绕过人机校验。
2. **零平台 Cookie 离端**：主仓后端绝不接收、存储或转发任何第三方平台（知乎 / 今日头条 / 什么值得买）登录 Cookie。
3. **最小权限扩展令牌（`gmext_`）**：扩展仅持有用户在 `/brands` 或 `/account` 颁发的 `gmext_` 令牌（后端仅存 SHA-256 哈希，90 天过期），严禁存储控制台 JWT；`ExtensionAuthGuard` 仅放行 `/api/v2/extension/{me,tasks,tasks/:taskId/confirm-published}`，访问计费、管理、品牌删除或令牌管理接口一律返回 `401`/`403`/`404`。
4. **受控 CORS**：后端 `createExtensionBridgeCorsMiddleware` 仅对合法 32 位小写 `[a-p]{32}` 的 `chrome-extension://<id>` 来源在 3 个桥接端点放行 CORS，其余路由与来源一律不返回 `Access-Control-Allow-Origin`。

---

## 2. 本地联调环境前置条件

### 2.1 启动 GeoMix 主仓（API + Web + PostgreSQL + Redis）

```bash
# 1. 启动 PostgreSQL 16 (pgvector) 与 Redis 7
docker compose up -d postgres redis

# 2. 生成 Prisma Client、应用迁移并初始化默认演示数据
node packages/db/scripts/prisma-cli.mjs generate
pnpm db:migrate && pnpm db:seed

# 3. 启动 API (http://127.0.0.1:3001) 与 Web (http://127.0.0.1:3000)
# 确保默认 BILLING_MODE=SHADOW，WEB_ORIGIN=http://localhost:3000,http://127.0.0.1:3000
pnpm --filter @geomix/server dev:api
pnpm --filter @geomix/web dev
```

### 2.2 加载伴生 Chrome MV3 扩展（`yexiu700/geomix-extension`）

1. 在伴生仓库构建扩展产物（例如 `pnpm install && pnpm build`，生成 `dist/` 目录，含 `manifest.json`）。
2. 在 Chrome 浏览器打开 `chrome://extensions`，右上角启用 **开发者模式（Developer mode）**。
3. 点击 **加载已解压的扩展程序（Load unpacked）**，选择 `geomix-extension/dist/`。
4. 记录扩展卡片上的 32 位小写扩展 ID（形如 `abcdefghijklmnopabcdefghijklmnop`，严格匹配 `/^[a-p]{32}$/`），供 CORS 联调核对。

### 2.3 准备测试品牌与 CN L2 待分发任务

1. 登录 GeoMix 控制台（默认本地账号 `demo` / `geomix-demo-dev`），切换或新建一个包含 **`CN`（中国大陆）市场** 的品牌。
2. 在 `/brands?market=CN` 的 **品牌素材库** 上传 1–2 张合规测试图片（用于验证扩展本地中转上传图片至平台草稿箱）。
3. 在 `/studio?market=CN` 打开或生成 1 篇中文 GEO 文章，打开右侧 **分发与变体工作台**，勾选 **知乎 (`ZHIHU_EXT`)**、**今日头条 (`TOUTIAO_EXT`)**、**什么值得买 (`SMZDM_EXT`)** 生成 L2 扩展变体任务。

---

## 3. Bridge v1 配对与安全前置验收清单

| 编号  | 验收项                     | 操作步骤                                                                                           | 预期结果                                                                                     |
| ----- | -------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| B1-01 | 控制台颁发 `gmext_` 令牌   | 在 `/brands?market=CN`（或 `/account?tab=extension`）填写设备名称，点击「生成扩展配对令牌」        | 弹窗仅此一次展示 `gmext_` 完整明文；关闭弹窗并刷新页面后，页面与列表接口均不再出现明文       |
| B1-02 | 扩展弹窗配对与 `/me` 握手  | 在扩展 Popup 填入 API 地址（`http://127.0.0.1:3001`）与 `gmext_` 令牌，点击连接                    | `GET /api/v2/extension/me` 返回 `200`，含 `bridgeVersion: "v1"`、脱敏用户名与当前租户品牌列表 |
| B1-03 | 任务拉取最小化过滤         | 扩展调用 `GET /api/v2/extension/tasks?provider=ZHIHU_EXT`                                          | 仅返回本租户 `L2_EXTENSION` 且状态为待发布/草稿的任务，含 `mediaAssets` 与 `antiBanChecklist` |
| B1-04 | 受控 `chrome-extension://` | 使用 32 位 `[a-p]{32}` 扩展 Origin 访问 `/api/v2/extension/me` 与 `/api/v2/brands`                 | `/extension/me` 返回匹配 `Access-Control-Allow-Origin`；`/brands` 与 `/extension/tokens` 拒绝 |
| B1-05 | 越权路由隔离               | 使用 `gmext_` 令牌请求 `/api/v1/billing/wallet`、`/api/v1/admin/tenants`、`DELETE /api/v2/brands/*` | 全部返回 `401` / `403` / `404`，绝不可返回 `2xx`                                             |
| B1-06 | 即时吊销失效               | 在 `/brands` 或 `/account` 点击「吊销令牌」并确认，随即在扩展刷新任务                              | `GET /api/v2/extension/me` 与 `/tasks` 立即返回 `401`，扩展提示重新配对                      |

---

## 4. 三大国内平台真机草稿箱与 URL 捕获回传验收矩阵

在真实 Chrome 浏览器中预先人工登录对应创作者后台，逐平台完成以下端到端验收：

| 平台           | Provider      | 草稿箱注入与图片中转验收                                                                       | 人工发布与 URL 捕获回传验收                                                                                           | 归因闭环核对                                                                                       |
| -------------- | ------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **知乎专栏**   | `ZHIHU_EXT`   | 在知乎写作页拉取任务，展示 `antiBanChecklist`；一键注入标题、正文与本地中转图片至知乎草稿箱    | 作者人工核对排版后手动点击知乎发布；扩展 Shadow DOM 浮条自动捕获 `https://zhuanlan.zhihu.com/p/...` 并触发回传        | 任务状态变为 `PUBLISHED`；生成 `GeoPublishRecord`、T+1 抓取体检及 T+7/14/30 复测排期；重复点击幂等 |
| **今日头条**   | `TOUTIAO_EXT` | 在头条号发文页拉取任务，展示 `antiBanChecklist`；一键注入标题、正文与配图至头条号草稿箱        | 作者人工核对后手动发布；浮条捕获公开文章 URL（或手动粘贴公开 URL 确认）并调用 `confirm-published`                     | `/home?market=CN` 与 `/studio` 右栏可见该发布回链与 3 条复测里程碑；不重复创建 `GeoPublishRecord` |
| **什么值得买** | `SMZDM_EXT`   | 在什么值得买社区发文页拉取任务，展示 `antiBanChecklist`；注入评测标题、对比表正文与实测图草稿  | 作者人工复核参数与合规声明后手动提交；审核发布后捕获公开文章 URL 并调用 `confirm-published`                           | 公开 URL 通过 SSRF 公网校验；任务完成闭环并进入 T+1 抓取体检与 T+7/14/30 自动复测                  |

---

## 5. 合规、反封号与异常边界核查

- [ ] **零自动发布验证**：检查扩展内容脚本源码与实测交互，确认无任何自动点击平台「发布 / 提交审核」按钮的逻辑。
- [ ] **合规清单显式展示**：注入草稿前，扩展界面清晰呈现服务端下发的 `antiBanChecklist`。
- [ ] **SSRF 拦截验证**：在 `confirm-published` 手动输入内网/非法 URL（如 `http://127.0.0.1/p/1`、`http://169.254.169.254/`、`javascript:alert(1)`），后端返回 `400` 且不落库。
- [ ] **重复回传幂等验证**：对同一 `taskId` 连续提交两次 `confirm-published`，首次返回 `alreadyRecorded: false, retestScheduledCount: 3`，二次返回 `alreadyRecorded: true` 且返回相同的 `publishRecordId`（零重复 `GeoPublishRecord` 与 `GeoRetestSchedule` 记录）。
- [ ] **Manifest 权限审计**：核对 `manifest.json` 的 `host_permissions` 仅覆盖声明的目标创作平台域名与用户配置的 GeoMix API 域名；`chrome.storage.local` 仅保存 `gmext_` 令牌与 API 基址，不含任何控制台 JWT 或第三方平台 Cookie。

---

## 6. 主仓侧快速 Mock 联调脚本（`curl`）

在伴生扩展尚未打包前，可直接使用以下 `curl` 命令验证主仓 Bridge v1 契约与安全边界（替换 `GMEXT_TOKEN`、`TASK_ID` 与 32 位 `EXT_ID`）：

```bash
export API_BASE="http://127.0.0.1:3001"
export EXT_ORIGIN="chrome-extension://abcdefghijklmnopabcdefghijklmnop"
export GMEXT_TOKEN="gmext_replace_with_issued_token"
export TASK_ID="replace_with_l2_task_id"

# 1. 握手校验 + CORS 响应头检查
curl -i -sS -H "Origin: ${EXT_ORIGIN}" -H "Authorization: Bearer ${GMEXT_TOKEN}" \
  "${API_BASE}/api/v2/extension/me"

# 2. 拉取知乎待分发 L2 任务
curl -sS -H "Origin: ${EXT_ORIGIN}" -H "Authorization: Bearer ${GMEXT_TOKEN}" \
  "${API_BASE}/api/v2/extension/tasks?provider=ZHIHU_EXT"

# 3. 首次回传公网发布 URL（应返回 alreadyRecorded: false, retestScheduledCount: 3）
curl -sS -X POST -H "Origin: ${EXT_ORIGIN}" -H "Authorization: Bearer ${GMEXT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"publishedUrl":"https://zhuanlan.zhihu.com/p/123456789"}' \
  "${API_BASE}/api/v2/extension/tasks/${TASK_ID}/confirm-published"

# 4. 幂等重放回传（应返回 alreadyRecorded: true 且 publishRecordId 不变、无重复记录）
curl -sS -X POST -H "Origin: ${EXT_ORIGIN}" -H "Authorization: Bearer ${GMEXT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"publishedUrl":"https://zhuanlan.zhihu.com/p/123456789"}' \
  "${API_BASE}/api/v2/extension/tasks/${TASK_ID}/confirm-published"

# 5. 安全负向：gmext_ 访问计费接口必须被拒（401）
curl -i -sS -H "Authorization: Bearer ${GMEXT_TOKEN}" \
  "${API_BASE}/api/v1/billing/wallet"

# 6. 安全负向：SSRF 内网回传必须被拒（400）
curl -i -sS -X POST -H "Origin: ${EXT_ORIGIN}" -H "Authorization: Bearer ${GMEXT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"publishedUrl":"http://127.0.0.1:3001/api/v1/health"}' \
  "${API_BASE}/api/v2/extension/tasks/${TASK_ID}/confirm-published"
```

---

## 7. 发版真机验收签核表

| 检查日期 | 验收人 | Chrome 版本 | 扩展版本 / Commit | 主仓 Commit | 知乎 (`ZHIHU_EXT`) | 今日头条 (`TOUTIAO_EXT`) | 什么值得买 (`SMZDM_EXT`) | 安全红线核查 | 结论 |
| -------- | ------ | ----------- | ----------------- | ----------- | ------------------ | ------------------------ | ------------------------ | ------------ | ---- |
| 待填写   | 待填写 | 待填写      | 待填写            | 待填写      | 待测               | 待测                     | 待测                     | 待测         | 待签 |
