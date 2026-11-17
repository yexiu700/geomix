#!/usr/bin/env bash
# GeoMix 备份脚本（PostgreSQL 逻辑全量备份 + MinIO 对象归档 + SHA256 校验清单）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${ROOT_DIR}/.env"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.prod.yml"
OUTPUT_DIR=""
RETENTION_DAYS=""
DRY_RUN=false

usage() {
  cat <<'EOF'
用法: ./scripts/backup.sh [选项]

选项:
  --env-file <path>         指定环境变量文件（默认: ./.env）
  --compose-file <path>     指定 Compose 编排文件（默认: ./docker-compose.prod.yml）
  --output-dir <dir>        备份输出根目录（默认读取 BACKUP_DIR 或 ./backups）
  --retention-days <days>   历史备份保留天数（默认读取 BACKUP_RETENTION_DAYS 或 7）
  --dry-run                 仅校验并打印将执行的备份步骤，不实际执行 docker 命令
  -h, --help                查看帮助信息
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
    --output-dir)
      OUTPUT_DIR="${2:?缺少 --output-dir 参数}"
      shift 2
      ;;
    --retention-days)
      RETENTION_DAYS="${2:?缺少 --retention-days 参数}"
      shift 2
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

if [[ -z "${OUTPUT_DIR}" ]]; then
  OUTPUT_DIR="$(read_env_var "BACKUP_DIR")"
  OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/backups}"
fi

if [[ -z "${RETENTION_DAYS}" ]]; then
  RETENTION_DAYS="$(read_env_var "BACKUP_RETENTION_DAYS")"
  RETENTION_DAYS="${RETENTION_DAYS:-7}"
fi

if ! [[ "${RETENTION_DAYS}" =~ ^[0-9]+$ ]]; then
  echo "[ERROR] retention-days 必须是非负整数: ${RETENTION_DAYS}" >&2
  exit 1
fi

PG_USER="$(read_env_var "POSTGRES_USER")"
PG_USER="${PG_USER:-geomix}"
PG_DB="$(read_env_var "POSTGRES_DB")"
PG_DB="${PG_DB:-geomix}"
S3_BUCKET_VAL="$(read_env_var "S3_BUCKET")"
S3_BUCKET_VAL="${S3_BUCKET_VAL:-geomix}"
PROJECT_NAME="$(awk -F': *' '/^name:/ {print $2; exit}' "${COMPOSE_FILE}")"
PROJECT_NAME="${PROJECT_NAME:-geomix-prod}"
MINIO_VOLUME="${PROJECT_NAME}_geomix_minio"

TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
TARGET_DIR="${OUTPUT_DIR}/geomix-backup-${TIMESTAMP}"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[DRY-RUN] 创建备份目录: ${TARGET_DIR}"
  echo "[DRY-RUN] PostgreSQL 备份: docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} exec -T postgres pg_dump -Fc -U ${PG_USER} -d ${PG_DB} > ${TARGET_DIR}/postgres.dump"
  echo "[DRY-RUN] MinIO 卷归档: docker run --rm -v ${MINIO_VOLUME}:/source:ro -v ${TARGET_DIR}:/backup busybox:1.37 tar -czf /backup/minio-data.tar.gz -C /source ."
  echo "[DRY-RUN] 写入脱敏配置快照 ${TARGET_DIR}/env.redacted 与校验文件 ${TARGET_DIR}/SHA256SUMS"
  echo "[DRY-RUN] 清理 ${OUTPUT_DIR} 下超过 ${RETENTION_DAYS} 天的旧备份目录"
  exit 0
fi

mkdir -p "${TARGET_DIR}"
chmod 700 "${TARGET_DIR}"

echo "[INFO] 1/4 导出 PostgreSQL 数据库 (${PG_DB})..."
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" \
  exec -T postgres pg_dump -Fc -U "${PG_USER}" -d "${PG_DB}" > "${TARGET_DIR}/postgres.dump"

echo "[INFO] 2/4 归档 MinIO 对象存储数据卷 (${MINIO_VOLUME})..."
docker run --rm \
  -v "${MINIO_VOLUME}:/source:ro" \
  -v "${TARGET_DIR}:/backup" \
  busybox:1.37 tar -czf /backup/minio-data.tar.gz -C /source .

echo "[INFO] 3/4 生成脱敏配置摘要与校验清单..."
if [[ -f "${ENV_FILE}" ]]; then
  sed -E 's/^([[:space:]]*[A-Za-z0-9_]*(PASSWORD|SECRET|KEY|TOKEN)[A-Za-z0-9_]*)=.*/\1=***REDACTED***/I' \
    "${ENV_FILE}" > "${TARGET_DIR}/env.redacted"
fi

cat > "${TARGET_DIR}/manifest.json" <<EOF
{
  "createdAtUtc": "${TIMESTAMP}",
  "postgresDatabase": "${PG_DB}",
  "postgresUser": "${PG_USER}",
  "minioVolume": "${MINIO_VOLUME}",
  "s3Bucket": "${S3_BUCKET_VAL}"
}
EOF

(
  cd "${TARGET_DIR}"
  sha256sum postgres.dump minio-data.tar.gz manifest.json > SHA256SUMS
)

echo "[INFO] 4/4 清理超过 ${RETENTION_DAYS} 天的过期备份..."
if (( RETENTION_DAYS > 0 )); then
  find "${OUTPUT_DIR}" -maxdepth 1 -mindepth 1 -type d -name 'geomix-backup-*' \
    -mtime "+${RETENTION_DAYS}" -exec rm -rf {} +
fi

echo "[OK] 备份完成: ${TARGET_DIR}"
