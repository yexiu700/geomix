# AGENTS.md

在本仓库工作的编码代理，请先阅读并严格遵守：

- [开发约定（docs/AGENTS.md）](./docs/AGENTS.md)
- [终版实现路线（docs/终版实现路线.md）](./docs/终版实现路线.md)
- [已确认决策（docs/decisions.md）](./docs/decisions.md)

## 核心速查

- **交付方式**：仅在独立功能分支提交并通过 Pull Request 交付；**不要推 `main`，不要合并 PR，不要部署**。
- **CI 门禁**：PR 提交前本地需通过 `pnpm lint`、`pnpm typecheck`、`pnpm test`；推送后必须等待 GitHub Actions CI **全绿**才能交接或请求合并。
- **并行防冲突**：修改 `packages/shared` 时只追加本模块常量文件，不修改其他模块的已有文件。
- **合规红线**：站名暂用「GeoMix」，计费默认 `SHADOW`，严禁引入原站文案、图片、Logo、协议正文、系统模板原文或站点地址。
