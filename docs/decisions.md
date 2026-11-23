# 已确认决策

日期：2026-11-16（Asia/Shanghai）。未单独回复的条目，按终版路线 F06 的推荐答案执行。

| 项 | 决定 |
|---|---|
| 仓库可见性 | 保持公开。本仓库只放脱敏后的路线、评审报告和代码，不放入第三方原文、原站截图或原站地址。 |
| 原站实测 | 已批准。先做免费步骤 S1–S7，再做耗点步骤 P1–P5；预计约 35 点，上限 50 点，累计到 45 点或单步超出预计 5 点以上即停止。 |
| 大模型 | 正文和改写用 DeepSeek，备用通义或豆包；向量用 bge-m3（1024 维）。API 密钥和费用由项目方提供。开发期使用假 Provider。 |
| 站名 | 品牌确定前使用占位名「GeoMix」，不使用原站文案。 |
| AI 生图 | 做最小推测版（表单、生成、存入图库），由功能开关控制。 |
| 计费默认模式 | 默认 SHADOW（不实扣，完整记账原价），正式商用前由管理员切到 STRICT；新租户种子 1000 点。 |
| 技术栈 | Next.js 15 + Ant Design 5 + NestJS + Prisma + PostgreSQL / pgvector + BullMQ。不采用 PHP / FastAdmin。 |
| 批量复刻寻源 | 默认「粘贴链接清单」；若提供搜索 API 密钥再启用自动搜索。 |
| 复刻品牌替换指令 | 不内置「把原文推荐的第一个品牌换成我方品牌」。系统模板改为参考原文重新创作、自然融入品牌。 |
| 「夸张方式」「情感煽动」 | 保留选项，提示词内部映射成合规写法。 |
| 多标签页 | 默认开启，可在布局面板关闭。 |
| 账号模型 | 一期单站点 + 管理员开户；一个租户一个账号；数据层预留 tenantId。 |
| 系统模板与说明示例 | 按结构自写，不复制原文。 |
| 文章导出 | 一期增加 Markdown / HTML / Docx 批量导出。 |
| URL | 英文语义路径，同时提供原路径跳转。 |
| 部署 | 先部署到测试服务器做单机预发；国内生产环境需提前准备 ICP 备案和域名。 |
| 实测数据 | 默认保留，删除需另行批准。 |

## 后续演进补充

以下条目在后续迭代中落地或演进，覆盖/补充上表初期基线（现行实现详情见 [架构与模块索引](./架构与模块索引.md)）：

- **AI 可见度提前落地**：原定二期的 AI 可见度诊断已在一期后提前实现（受 `FEATURE_VISIBILITY` 控制），新增队列 `visibility-check` 与计费项 `visibility_check`（默认 `2` 点/次），并在 GeoMix 2.0 扩展为双市场引擎矩阵（国内 8 引擎 + 海外 5 引擎）。
- **视觉体系与前端组件选型收敛**：全站采用 **Sonar Ink（声呐墨）暗色主题**（运行时真值在 `apps/web/lib/design-tokens.ts` 与 `apps/web/app/globals.css`）；保持零多余重依赖，以 Ant Design 5 + 原生 CSS + 手写 SVG 替代早先路线图中的 ProComponents、ECharts、wangEditor 与 Tailwind（编辑器在 GeoMix 2.0 演进为 `studio-editor-canvas.tsx`）。
- **GeoMix 2.0 极简 5 工作区与双市场重构**：控制台从一期多标签 15 页收敛为品牌 + 双市场（`CN` / `GLOBAL`）驱动的 5 工作区（`/home`、`/brands`、`/visibility`、`/studio`、`/account`），通过 `middleware.ts` + `lib/route-map.ts` 提供 23 条 307 旧路由兼容跳转，下线前端 `/me/money` 入口；侧栏折叠偏好仍通过 `PATCH /api/v1/account/ui-prefs` 持久化至 `User.uiPrefs`。
- **GeoMix 2.0 领域模型、队列与定价收敛**：数据模型通过增量迁移 `20261120100000_geomix_v2_domain_schema` 重构为 27 个模型，核心业务接口采用 `/api/v2` 版本化路由，异步队列收敛为 4 个（`fact-index`、`geo-batch`、`visibility-check`、`maintenance`）；计费项收敛为 3 项（`geo_write` 10 点、`visibility_check` 2 点、`inline_image_gen` 5 点，取消 `kb_addon` 拆账），事实卡提炼、写作意见、GEO 体检与局部改写转为 0 点防刷限流标配能力。
- **自动化门禁与发布**：GitHub Actions 已接入 Playwright 全栈 E2E（`e2e.yml`，含 `E2E_V2=1` 四层与 Tier 5 对抗套件）、非草稿 PR 自动合入（`auto-merge.yml`）与 GHCR + Self-Hosted Runner CD（`cd.yml`）。

