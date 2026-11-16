import { Prisma } from '@prisma/client';
import { API_ERROR, AUTH_ERROR, BILLING_ERROR } from '@geomix/shared';
import { ApiError } from '../common/api-error';

export type BillingTx = Prisma.TransactionClient;

export const TX_OPTIONS = { maxWait: 60_000, timeout: 60_000 } as const;

const REF_ID = /^[A-Za-z0-9:_-]{1,120}$/;
const UNIT_KEY = /^[A-Za-z0-9:_-]{8,160}$/;

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, API_ERROR.BAD_REQUEST, message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, BILLING_ERROR.CONFLICT, message);
}

export function notFound(message = '不存在'): ApiError {
  return new ApiError(404, AUTH_ERROR.NOT_FOUND, message);
}

export function insufficient(amount: number, available: number): ApiError {
  return new ApiError(
    402,
    API_ERROR.INSUFFICIENT_POINTS,
    `本任务需要预扣 ${amount} 点，当前可用 ${available} 点`,
  );
}

export function assertRefId(value: string): string {
  if (!REF_ID.test(value)) throw badRequest('冻结单编号不正确');
  return value;
}

export function assertUnitKey(value: string): string {
  if (!UNIT_KEY.test(value) || value.startsWith('close:')) throw badRequest('幂等编号不正确');
  return value;
}

export function assertActorId(value: string): string {
  if (!REF_ID.test(value)) throw badRequest('操作人不正确');
  return value;
}

type WalletRow = { points: number; pointsReserved: number };

export async function lockWallet(tx: BillingTx, tenantId: string): Promise<WalletRow> {
  const rows = await tx.$queryRaw<WalletRow[]>`
    SELECT points, "pointsReserved"
    FROM "Wallet"
    WHERE "tenantId" = ${tenantId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw notFound('钱包不存在');
  return { points: Number(row.points), pointsReserved: Number(row.pointsReserved) };
}

export type LockedReservation = {
  id: string;
  tenantId: string;
  refType: string;
  refId: string;
  shadow: boolean;
  frozen: number;
  settled: number;
  released: number;
  status: 'OPEN' | 'CLOSED';
};

type ReservationSqlRow = {
  id: string;
  tenantId: string;
  refType: string;
  refId: string;
  shadow: boolean;
  frozen: number;
  settled: number;
  released: number;
  status: string;
};

export async function lockReservation(
  tx: BillingTx,
  tenantId: string,
  reservationId: string,
): Promise<LockedReservation | null> {
  const rows = await tx.$queryRaw<ReservationSqlRow[]>`
    SELECT id, "tenantId", "refType", "refId", shadow, frozen, settled, released, status::text AS status
    FROM "PointReservation"
    WHERE id = ${reservationId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) return null;
  if (row.status !== 'OPEN' && row.status !== 'CLOSED') return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    refType: row.refType,
    refId: row.refId,
    shadow: row.shadow,
    frozen: Number(row.frozen),
    settled: Number(row.settled),
    released: Number(row.released),
    status: row.status,
  };
}

export function remainder(
  reservation: Pick<LockedReservation, 'frozen' | 'settled' | 'released'>,
): number {
  return reservation.frozen - reservation.settled - reservation.released;
}
