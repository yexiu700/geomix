#!/usr/bin/env bash
# GeoMix 恢复脚本（校验 SHA256SUMS -> 停写服务 -> 恢复 PostgreSQL 与 MinIO -> 跑迁移 -> 重启验活）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${ROOT_DIR}/.env"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"
BACKUP_DIR=""
ASSUME_YES=false
DRY_RUN=false

usage() {
  cat <<'EOF'
用法: ./scripts/restore.sh --backup-dir <path> [选项]

选项:
  --backup-dir <dir>      必填，指定由 backup.sh 生成的备份目录（含 postgres.dump / minio-data.tar.gz / SHA256SUMS）
  --env-file <path>       指定环境变量文件（默认: ./.env）
  --compose-file <path>   指定 Compose 编排文件（默认: ./docker-compose.prod.yml）
  --yes                   确认覆盖当前环境数据库与对象存储（非 dry-run 必填）
  --dry-run               仅校验备份文件完整性并打印恢复步骤，不修改运行中环境
  -h, --help              查看帮助信息
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir)
      BACKUP_DIR="${2:?缺少 --backup-dir 参数}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:?缺少 --env-file 参数}"
      shift 2
      ;;
    --compose-file)
      COMPOSE_FILE="${2:?缺少 --compose-file 参数}"
      shift 2
      ;;
    --yes)
      ASSUME_YES=true
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

if [[ -z "${BACKUP_DIR}" ]]; then
  echo "[ERROR] 请通过 --backup-dir 指定要恢复的备份目录" >&2
  usage >&2
  exit 1
fi

for required_file in "postgres.dump" "minio-data.tar.gz" "SHA256SUMS"; do
  if [[ ! -f "${BACKUP_DIR}/${required_file}" ]]; then
    echo "[ERROR] 备份目录缺少必要文件: ${BACKUP_DIR}/${required_file}" >&2
    exit 1
  fi
done

echo "[INFO] 校验备份完整性 (SHA256SUMS)..."
(
  cd "${BACKUP_DIR}"
  sha256sum -c SHA256SUMS
)

read_env_var() {
  local key="$1"
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo ""
    return
  fi
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

PG_USER="$(read_env_var "POSTGRES_USER")"
PG_USER="${PG_USER:-geomix}"
PG_DB="$(read_env_var "POSTGRES_DB")"
PG_DB="${PG_DB:-geomix}"
API_PORT_VAL="$(read_env_var "API_PORT")"
API_PORT_VAL="${API_PORT_VAL:-3001}"
PROJECT_NAME="$(awk -F': *' '/^name:/ {print $2; exit}' "${COMPOSE_FILE}")"
PROJECT_NAME="${PROJECT_NAME:-geomix-prod}"
MINIO_VOLUME="${PROJECT_NAME}_geomix_minio"
ABS_BACKUP_DIR="$(cd "${BACKUP_DIR}" && pwd)"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[DRY-RUN] 停止写入层容器: docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} stop api worker web minio"
  echo "[DRY-RUN] 恢复 PostgreSQL: pg_restore --clean --if-exists --no-owner -U ${PG_USER} -d ${PG_DB} < ${ABS_BACKUP_DIR}/postgres.dump"
  echo "[DRY-RUN] 恢复 MinIO 卷 ${MINIO_VOLUME} 并重设 UID/GID 65532:65532"
  echo "[DRY-RUN] 执行数据库迁移对齐: docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} run --rm migrate"
  echo "[DRY-RUN] 重新拉起全部服务并验证 http://127.0.0.1:${API_PORT_VAL}/api/v1/health"
  exit 0
fi

if [[ "${ASSUME_YES}" != "true" ]]; then
  echo "[ERROR] 恢复操作将覆盖当前环境的 PostgreSQL 与 MinIO 数据，请确认无误后附带 --yes 参数执行" >&2
  exit 1
fi

echo "[INFO] 1/5 停止业务写入容器 (api / worker / web / minio)..."
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" stop api worker web minio

echo "[INFO] 2/5 恢复 PostgreSQL 数据库 (${PG_DB})..."
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d postgres
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" \
  exec -T postgres pg_restore --clean --if-exists --no-owner -U "${PG_USER}" -d "${PG_DB}" < "${ABS_BACKUP_DIR}/postgres.dump"

echo "[INFO] 3/5 恢复 MinIO 对象存储数据卷 (${MINIO_VOLUME})..."
docker run --rm \
  -v "${MINIO_VOLUME}:/target" \
  -v "${ABS_BACKUP_DIR}:/backup:ro" \
  busybox:1.37 sh -euc 'rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null || true; tar -xzf /backup/minio-data.tar.gz -C /target; chown -R 65532:65532 /target'

echo "[INFO] 4/5 重新启动存储与执行 Prisma 迁移对齐..."
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d redis minio minio-init
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" run --rm migrate

echo "[INFO] 5/5 拉起 api / worker / web 服务并验证健康检查..."
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d api worker web

HEALTH_URL="http://127.0.0.1:${API_PORT_VAL}/api/v1/health"
DEADLINE=$((SECONDS + 60))
while (( SECONDS < DEADLINE )); do
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "[OK] 恢复演练/灾难恢复完成，API 健康检查通过: ${HEALTH_URL}"
    exit 0
  fi
  sleep 2
done

echo "[ERROR] 服务重启后健康检查超时: ${HEALTH_URL}" >&2
exit 1
