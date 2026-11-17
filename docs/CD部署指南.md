# GeoMix CD 部署指南（GHCR + Self-Hosted Runner）

合入 `main` 后，[cd.yml](../.github/workflows/cd.yml) 会先在 GitHub 云端构建 `geomix-web` 与 `geomix-server` 镜像并推送到 `ghcr.io`，随后由服务器上的 **Self-Hosted Runner** 主动拉取镜像并重启服务（**无需开放公网 SSH 22 端口**）。

---

## 1. 服务器准备（一次性）

1. 安装 **Docker** 与 **Docker Compose (v2)**，并确保运行 Runner 的用户有权限执行 `docker` 命令（如加入 `docker` 用户组或使用 `root`）。
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
STORAGE_DRIVER=s3
S3_BUCKET=geomix

JWT_ACCESS_SECRET=请替换为随机长密钥
JWT_REFRESH_SECRET=请替换为随机长密钥
WEB_ORIGIN=https://你的域名

# 大模型配置（不填或 {} 则使用本地假 Provider）
# DEEPSEEK_API_KEY=sk-你的密钥
# LLM_PROVIDERS={"providers":{"deepseek":{"kind":"openai","baseUrl":"https://api.deepseek.com/v1","apiKeyEnv":"DEEPSEEK_API_KEY","cheapModel":"deepseek-chat","qualityModel":"deepseek-chat"}}}

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

## 2. 在服务器上注册 Self-Hosted Runner（一次性）

1. 打开 GitHub 仓库：**Settings → Actions → Runners → New self-hosted runner**，系统选择 **Linux**。
2. 按页面给出的命令在服务器上下载并配置 Runner（注意不要放在 `/opt/geomix` 里面，建议放 `/opt/actions-runner`）。
3. 配置完成后，安装为系统后台服务并启动（这样服务器重启后也会自动在线）：

```bash
sudo ./svc.sh install
sudo ./svc.sh start
```

4. 回到 GitHub **Settings → Actions → Runners** 页面，看到状态变成绿色 **Idle** 即表示连接成功。

---

## 3. 可选 Variables / Secrets

* 之前如果填过 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`，现在可以直接删掉，不再需要。
* 如需自定义部署目录（默认 `/opt/geomix`），可在 **Variables** 中添加 `DEPLOY_PATH`。
* 如需自定义前端构建时的接口前缀（默认 `/api/v1`），可在 **Variables** 中添加 `NEXT_PUBLIC_API_BASE`。
