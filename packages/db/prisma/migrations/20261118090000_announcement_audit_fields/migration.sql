-- Add audit metadata columns to Announcement and backfill from AuditLog where available
ALTER TABLE "Announcement"
  ADD COLUMN IF NOT EXISTS "operatorId" TEXT,
  ADD COLUMN IF NOT EXISTS "operatorName" TEXT,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

WITH latest_save AS (
  SELECT DISTINCT ON (a.payload->>'tenantId')
    a.payload->>'tenantId' AS announcement_id,
    a."userId" AS user_id,
    a."createdAt" AS created_at,
    CASE
      WHEN NULLIF(BTRIM(u."nickname"), '') IS NOT NULL AND BTRIM(u."nickname") <> u."username"
        THEN BTRIM(u."nickname") || ' (' || u."username" || ')'
      ELSE COALESCE(u."username", a."userId")
    END AS operator_name
  FROM "AuditLog" a
  LEFT JOIN "User" u ON u."id" = a."userId"
  WHERE a."action" = 'announcement_save'
    AND a.payload IS NOT NULL
    AND a.payload->>'tenantId' IS NOT NULL
  ORDER BY a.payload->>'tenantId', a."createdAt" ASC
),
latest_op AS (
  SELECT DISTINCT ON (a.payload->>'tenantId')
    a.payload->>'tenantId' AS announcement_id,
    a."userId" AS user_id,
    a."createdAt" AS updated_at,
    CASE
      WHEN NULLIF(BTRIM(u."nickname"), '') IS NOT NULL AND BTRIM(u."nickname") <> u."username"
        THEN BTRIM(u."nickname") || ' (' || u."username" || ')'
      ELSE COALESCE(u."username", a."userId")
    END AS operator_name
  FROM "AuditLog" a
  LEFT JOIN "User" u ON u."id" = a."userId"
  WHERE a."action" IN ('announcement_save', 'announcement_update')
    AND a.payload IS NOT NULL
    AND a.payload->>'tenantId' IS NOT NULL
  ORDER BY a.payload->>'tenantId', a."createdAt" DESC
)
UPDATE "Announcement" ann
SET
  "createdAt" = COALESCE(s.created_at, ann."createdAt"),
  "updatedAt" = COALESCE(o.updated_at, s.created_at, ann."updatedAt"),
  "operatorId" = COALESCE(ann."operatorId", o.user_id, s.user_id),
  "operatorName" = COALESCE(ann."operatorName", o.operator_name, s.operator_name)
FROM latest_save s
FULL OUTER JOIN latest_op o ON o.announcement_id = s.announcement_id
WHERE ann."id" = COALESCE(o.announcement_id, s.announcement_id);
