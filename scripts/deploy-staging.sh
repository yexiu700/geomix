#!/usr/bin/env bash
# GeoMix 单机预发/生产环境一键部署脚本
# 注意：本脚本由运维/维护者在目标单机宿主机上执行，支持 --dry-run 安全预检。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${ROOT_DIR}/.env"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"
WITH_TLS=false
RUN_SEED=false
BUILD_LOCAL=false
DRY_RUN=false
HEALTH_TIMEOUT_SECONDS=90

usage() {
  cat <<'EOF'
用法: ./scripts/deploy-staging.sh [选项]

选项:
  --env-file <path>       指定环境变量文件（默认: ./.env）
  --compose-file <path>   指定 Compose 编排文件（默认: ./docker-compose.prod.yml）
  --with-tls              同时启用容器化 Nginx + HTTPS 反向代理（--profile tls）
  --seed                  迁移完成后执行幂等种子初始化（价格表与系统模板）
  --build-local           使用本地源码构建 geomix-server / geomix-web 镜像而非从 GHCR 拉取
  --dry-run               仅校验配置并输出将执行的命令，不实际调用 docker
  -h, --help              查看帮助信息
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:?缺少 --env-file 参数}"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="${2:?缺少 --compose-file 参数}"
      shift 2
      ;;
    --with-tls)
      WITH_TLS=true
      shift
      ;;
    --seed)
      RUN_SEED=true
      shift
      ;;
    --build-local)
      BUILD_LOCAL=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[ERROR] 未知选项: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "[ERROR] 未找到 Compose 编排文件: ${COMPOSE_FILE}" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[ERROR] 未找到环境变量文件: ${ENV_FILE}（请先从 .env.example 复制并填入预发配置）" >&2
  exit 1
fi

read_env_var() {
  local key="$1"
  local line
  line="$(grep -E "^[[:space:]]*${key}=" "${ENV_FILE}" | tail -n 1 || true)"
  if [[ -z "${line}" ]]; then
    echo ""
    return
  fi
  local val="${line#*=}"
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  echo "${val}"
}

require_non_placeholder() {
  local key="$1"
  local val
  val="$(read_env_var "${key}")"
  if [[ -z "${val}" ]]; then
    echo "[ERROR] ${ENV_FILE} 缺少必填项: ${key}" >&2
    exit 1
  fi
  case "${val}" in
    geomix|geomix-dev-only|change-me-access|change-me-refresh|请替换为*)
      echo "[ERROR] ${key} 仍为开发占位值，请在预发/生产环境中替换为独立强密钥" >&2
      exit 1
      ;;
  esac
}

require_non_placeholder "POSTGRES_PASSWORD"
require_non_placeholder "MINIO_ROOT_PASSWORD"
require_non_placeholder "JWT_ACCESS_SECRET"
require_non_placeholder "JWT_REFRESH_SECRET"

GHCR_OWNER_VAL="$(read_env_var "GHCR_OWNER")"
if [[ -z "${GHCR_OWNER_VAL}" ]]; then
  echo "[ERROR] ${ENV_FILE} 缺少必填项: GHCR_OWNER（例如 yexiu700）" >&2
  exit 1
fi

BILLING_MODE_VAL="$(read_env_var "BILLING_MODE")"
if [[ -z "${BILLING_MODE_VAL}" ]]; then
  BILLING_MODE_VAL="SHADOW"
fi
echo "[INFO] 预检通过: GHCR_OWNER=${GHCR_OWNER_VAL}, BILLING_MODE=${BILLING_MODE_VAL}"

COMPOSE_ARGS=(-f "${COMPOSE_FILE}" --env-file "${ENV_FILE}")
if [[ "${WITH_TLS}" == "true" ]]; then
  COMPOSE_ARGS+=(--profile tls)
  CERTS_DIR="$(read_env_var "NGINX_CERTS_DIR")"
  if [[ -z "${CERTS_DIR}" ]]; then
    CERTS_DIR="${ROOT_DIR}/docker/nginx/certs"
  fi
  ACME_DIR="$(read_env_var "NGINX_ACME_WEBROOT")"
  if [[ -z "${ACME_DIR}" ]]; then
    ACME_DIR="${ROOT_DIR}/docker/nginx/certbot-www"
  fi
  SELF_SIGNED="$(read_env_var "STAGING_SELF_SIGNED_TLS")"
  if [[ ! -f "${CERTS_DIR}/fullchain.pem" || ! -f "${CERTS_DIR}/privkey.pem" ]]; then
    if [[ "${SELF_SIGNED}" == "true" ]]; then
      SERVER_NAME="$(read_env_var "NGINX_SERVER_NAME")"
      SERVER_NAME="${SERVER_NAME:-staging.geomix.internal}"
      if [[ "${DRY_RUN}" == "true" ]]; then
        echo "[DRY-RUN] mkdir -p ${CERTS_DIR} ${ACME_DIR}"
        echo "[DRY-RUN] openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj /CN=${SERVER_NAME} ..."
      else
        mkdir -p "${CERTS_DIR}" "${ACME_DIR}"
        openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
          -subj "/CN=${SERVER_NAME}" \
          -keyout "${CERTS_DIR}/privkey.pem" \
          -out "${CERTS_DIR}/fullchain.pem" >/dev/null 2>&1
        chmod 600 "${CERTS_DIR}/privkey.pem"
        echo "[INFO] 已在 ${CERTS_DIR} 生成预发自签名证书（CN=${SERVER_NAME}）"
      fi
    else
      echo "[ERROR] 启用 --with-tls 需要证书文件 ${CERTS_DIR}/fullchain.pem 与 privkey.pem（预发测试可在 .env 设置 STAGING_SELF_SIGNED_TLS=true 自动生成）" >&2
      exit 1
    fi
  fi
fi

run_cmd() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] $*"
  else
    echo "[EXEC] $*"
    "$@"
  fi
}

IMAGE_TAG_VAL="$(read_env_var "IMAGE_TAG")"
IMAGE_TAG_VAL="${IMAGE_TAG_VAL:-latest}"
NEXT_API_BASE_VAL="$(read_env_var "NEXT_PUBLIC_API_BASE")"
NEXT_API_BASE_VAL="${NEXT_API_BASE_VAL:-/api/v1}"

if [[ "${BUILD_LOCAL}" == "true" ]]; then
  run_cmd docker build -f "${ROOT_DIR}/docker/server.Dockerfile" \
    -t "ghcr.io/${GHCR_OWNER_VAL}/geomix-server:${IMAGE_TAG_VAL}" "${ROOT_DIR}"
  run_cmd docker build -f "${ROOT_DIR}/docker/web.Dockerfile" \
    --build-arg "NEXT_PUBLIC_API_BASE=${NEXT_API_BASE_VAL}" \
    -t "ghcr.io/${GHCR_OWNER_VAL}/geomix-web:${IMAGE_TAG_VAL}" "${ROOT_DIR}"
else
  run_cmd docker compose "${COMPOSE_ARGS[@]}" pull
fi

run_cmd docker compose "${COMPOSE_ARGS[@]}" up -d postgres redis minio-perms minio minio-init
run_cmd docker compose "${COMPOSE_ARGS[@]}" run --rm migrate

if [[ "${RUN_SEED}" == "true" ]]; then
  run_cmd docker compose "${COMPOSE_ARGS[@]}" run --rm migrate pnpm --filter @geomix/db db:seed
fi

run_cmd docker compose "${COMPOSE_ARGS[@]}" up -d --remove-orphans
run_cmd docker compose "${COMPOSE_ARGS[@]}" ps

API_PORT_VAL="$(read_env_var "API_PORT")"
API_PORT_VAL="${API_PORT_VAL:-3001}"
HEALTH_URL="http://127.0.0.1:${API_PORT_VAL}/api/v1/health"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[DRY-RUN] 轮询健康检查: ${HEALTH_URL}（超时 ${HEALTH_TIMEOUT_SECONDS}s）"
  exit 0
fi

echo "[INFO] 等待 API 健康检查就绪: ${HEALTH_URL}"
DEADLINE=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
while (( SECONDS < DEADLINE )); do
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "[OK] GeoMix 预发部署完成，API 健康检查通过: ${HEALTH_URL}"
    exit 0
  fi
  sleep 2
done

echo "[ERROR] API 健康检查在 ${HEALTH_TIMEOUT_SECONDS}s 内未就绪，请执行 docker compose logs api worker 排查" >&2
exit 1
