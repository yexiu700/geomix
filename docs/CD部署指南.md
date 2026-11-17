# GeoMix CD 部署指南（方案 A：GHCR + SSH）

合入 `main` 后，[cd.yml](../.github/workflows/cd.yml) 会自动构建 `geomix-web` 与 `geomix-server` 镜像并推送到 `ghcr.io`。  
在未配置服务器 Secrets 之前，部署步骤会自动跳过，不影响日常开发与 CI。

---

## 1. 服务器准备（一次性）

1. 安装 Docker 与 Docker Compose（v2）。
2. 创建部署目录和生产环境配置文件：

```bash
mkdir -p /opt/geomix
```

在 `/opt/geomix/.env` 中写入生产配置（可参考 `.env.example`）：

```env
GHCR_OWNER=yexiu700

POSTGRES_USER=geomix
POSTGRES_PASSWORD=请替换为强密码
POSTGRES_DB=geomix

MINIO_ROOT_USER=geomix
MINIO_ROOT_PASSWORD=请替换为强密码
S3_BUCKET=geomix

JWT_ACCESS_SECRET=请替换为随机长密钥
JWT_REFRESH_SECRET=请替换为随机长密钥
WEB_ORIGIN=https://你的域名

# 如需接入真实模型/存储，按 .env.example 补充对应密钥
BILLING_MODE=SHADOW
```

3. 首次初始化需要创建种子数据时，可在服务器上执行一次：

```bash
cd /opt/geomix
docker compose -f docker-compose.prod.yml run --rm migrate pnpm --filter @geomix/db db:seed
```

4. 建议在宿主机使用 Nginx 或 Caddy 做 HTTPS 反向代理：
   * `/api/` → `http://127.0.0.1:3001`
   * `/` → `http://127.0.0.1:3000`

---

## 2. GitHub 仓库配置（一次性）

在仓库 **Settings → Secrets and variables → Actions** 中添加以下 Secrets：

| Secret 名称 | 必填 | 说明 |
| --- | --- | --- |
| `DEPLOY_HOST` | 是 | 服务器公网 IP 或域名 |
| `DEPLOY_USER` | 是 | SSH 登录用户名（如 `root` 或 `deploy`） |
| `DEPLOY_SSH_KEY` | 是 | 对应的 SSH 私钥全文 |
| `DEPLOY_PORT` | 否 | SSH 端口，默认 `22` |
| `DEPLOY_PATH` | 否 | 服务器部署目录，默认 `/opt/geomix` |
| `GHCR_READ_TOKEN` | 否 | 如果仓库为私有且服务器需要长期拉取 GHCR 镜像，建议配置带 `read:packages` 的 PAT |

如需自定义前端构建时的接口前缀，可在 **Variables** 中设置 `NEXT_PUBLIC_API_BASE`（默认 `/api/v1`）。
