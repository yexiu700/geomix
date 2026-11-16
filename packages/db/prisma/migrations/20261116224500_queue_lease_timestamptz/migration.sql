-- Lease, start, finish, and heartbeat are absolute instants.
-- The previous migration stored them as timestamp without time zone.
-- Prisma wrote UTC digits. Raw SQL then compared those digits in the
-- session time zone, so a heartbeating lease looked hours early.
-- The stored digits match Prisma's UTC writes, including rows that have
-- not been heartbeated yet: treating them as UTC keeps a fresh lease in
-- the future instead of marking live work expired.

ALTER TABLE "WorkUnit"
  ALTER COLUMN "leaseUntil" TYPE TIMESTAMP(3) WITH TIME ZONE USING "leaseUntil" AT TIME ZONE 'UTC',
  ALTER COLUMN "startedAt" TYPE TIMESTAMP(3) WITH TIME ZONE USING "startedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "finishedAt" TYPE TIMESTAMP(3) WITH TIME ZONE USING "finishedAt" AT TIME ZONE 'UTC';

ALTER TABLE "ActiveWork"
  ALTER COLUMN "beatAt" TYPE TIMESTAMP(3) WITH TIME ZONE USING "beatAt" AT TIME ZONE 'UTC';
