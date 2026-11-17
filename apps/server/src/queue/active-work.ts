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
  if (row) {
    if (row.tenantId !== ref.tenantId) return false;
    if (row.reason === 'paused' || row.reason === 'queued') return true;
    return now.getTime() - row.beatAt.getTime() <= ttlMs;
  }

  if (ref.refType === 'ai_task') {
    const task = await prisma.base.aiTask.findFirst({
      where: { id: ref.refId, tenantId: ref.tenantId },
      select: {
        status: true,
        lastWrittenAt: true,
        createdAt: true,
        items: {
          where: { status: 'RUNNING' },
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: { startedAt: true },
        },
      },
    });
    if (!task) return false;
    if (task.status === 'QUEUED' || task.status === 'PAUSED') return true;
    if (task.status === 'RUNNING') {
      const beatAt = task.items[0]?.startedAt ?? task.lastWrittenAt ?? task.createdAt;
      return now.getTime() - beatAt.getTime() <= ttlMs;
    }
  }

  if (ref.refType === 'rewrite_batch') {
    const batch = await prisma.base.rewriteBatch.findFirst({
      where: { id: ref.refId, tenantId: ref.tenantId },
      select: {
        status: true,
        createdAt: true,
        records: {
          where: { status: { in: ['RUNNING', 'SUCCESS'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { rewrittenAt: true, createdAt: true },
        },
      },
    });
    if (!batch) return false;
    if (batch.status === 'QUEUED' || batch.status === 'PAUSED') return true;
    if (batch.status === 'RUNNING') {
      const lastRec = batch.records[0];
      const beatAt = lastRec?.rewrittenAt ?? lastRec?.createdAt ?? batch.createdAt;
      return now.getTime() - beatAt.getTime() <= ttlMs;
    }
  }

  if (ref.refType === 'image_job') {
    const job = await prisma.base.aiImageJob.findFirst({
      where: { id: ref.refId, tenantId: ref.tenantId },
      select: { status: true, createdAt: true },
    });
    if (!job) return false;
    if (job.status === 'QUEUED' || job.status === 'PAUSED') return true;
    if (job.status === 'RUNNING') {
      return now.getTime() - job.createdAt.getTime() <= ttlMs;
    }
  }

  if (ref.refType === 'visibility_run') {
    const run = await prisma.base.visibilityRun.findFirst({
      where: { id: ref.refId, tenantId: ref.tenantId },
      select: {
        status: true,
        updatedAt: true,
        createdAt: true,
        observations: {
          where: { status: { in: ['RUNNING', 'SUCCESS', 'FAILED'] } },
          orderBy: { checkedAt: 'desc' },
          take: 1,
          select: { checkedAt: true, createdAt: true },
        },
      },
    });
    if (!run) return false;
    if (run.status === 'QUEUED' || run.status === 'PAUSED') return true;
    if (run.status === 'RUNNING') {
      const latestObs = run.observations[0];
      const beatAt = latestObs?.checkedAt ?? run.updatedAt ?? latestObs?.createdAt ?? run.createdAt;
      return now.getTime() - beatAt.getTime() <= ttlMs;
    }
  }

  return false;
}
