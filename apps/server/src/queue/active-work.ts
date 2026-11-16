import type { ActiveJobRef } from '@geomix/shared';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * 对账只看这张登记。
 * 排队和暂停是用户还要的冻结，一直算活跃。
 * 正在跑的任务要在心跳有效期内才算活跃，过期后两小时对账可以释放。
 */
export async function hasLiveActiveWork(
  prisma: PrismaService,
  ref: ActiveJobRef,
  now: Date,
  ttlMs: number,
): Promise<boolean> {
  if (!ref.tenantId || !ref.refType || !ref.refId) return false;
  const row = await prisma.base.activeWork.findUnique({
    where: { refType_refId: { refType: ref.refType, refId: ref.refId } },
  });
  if (!row || row.tenantId !== ref.tenantId) return false;
  if (row.reason === 'paused' || row.reason === 'queued') return true;
  return now.getTime() - row.beatAt.getTime() <= ttlMs;
}
