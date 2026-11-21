import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  QUEUE_TENANT_LIMIT,
  classifyCitationSource,
  normalizeFanOutQueries,
  normalizeVisibilityDomain,
  type CitationSourceKind,
  type TaskStatusName,
  type VisibilityCompetitor,
  type VisibilityTriggerType,
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { TX_OPTIONS } from '../billing/billing.sql';
import { ApiError } from '../common/api-error';
import { ProviderError } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import { VisibilityCollectorService } from './visibility-collector.service';
import { VisibilityEngineHealthService } from './visibility-engine-health.service';
import { VisibilityJudgeService } from './visibility-judge.service';

export const VISIBILITY_RUN_HANDLER = Symbol('VISIBILITY_RUN_HANDLER');
export const VISIBILITY_RUN_ENQUEUER = Symbol('VISIBILITY_RUN_ENQUEUER');
export const VISIBILITY_RUN_COMPLETE_HOOKS = Symbol('VISIBILITY_RUN_COMPLETE_HOOKS');

export type VisibilityCheckJobData = {
  tenantId: string;
  runId: string;
};

export type VisibilityRunCompleteEvent = {
  tenantId: string;
  brandId: string;
  brandMarketId: string;
  runId: string;
  triggerType: VisibilityTriggerType;
  retestArticleId: string | null;
  status: 'COMPLETED' | 'PARTIAL';
  successCount: number;
};

export interface OnVisibilityRunCompleteHook {
  readonly name: string;
  onVisibilityRunComplete(event: VisibilityRunCompleteEvent): Promise<void> | void;
}

export interface VisibilityRunHandler {
  process(payload: VisibilityCheckJobData): Promise<void>;
}

export interface VisibilityRunEnqueuer {
  enqueueVisibilityRun(job: VisibilityCheckJobData): Promise<void>;
}

type ClaimOutcome =
  | { kind: 'stopped' }
  | { kind: 'busy' }
  | { kind: 'drain' }
  | {
      kind: 'claimed';
      observationId: string;
      spawnSibling: boolean;
    };

const STALE_OBSERVATION_MS = 10 * 60_000;

export function parseProfileCompetitors(raw: unknown): VisibilityCompetitor[] {
  if (!Array.isArray(raw)) return [];
  const out: VisibilityCompetitor[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    const aliases = Array.isArray(rec.aliases)
      ? rec.aliases
          .filter((a): a is string => typeof a === 'string')
          .map((a) => a.trim())
          .filter(Boolean)
      : [];
    const domains = Array.isArray(rec.domains)
      ? rec.domains
          .filter((d): d is string => typeof d === 'string')
          .map((d) => normalizeVisibilityDomain(d))
          .filter(Boolean)
      : [];
    out.push({ name, aliases, domains });
  }
  return out;
}

function safeVisibilityError(error: unknown): string {
  if (error instanceof ApiError || error instanceof ProviderError) {
    return error.message
      .replace(/[\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, 200);
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
      .replace(/[\u0000-\u001f]/g, ' ')
      .trim()
      .slice(0, 200);
  }
  return '单次可见性采集或判定失败';
}

@Injectable()
export class VisibilityRunRunner implements VisibilityRunHandler {
  private readonly logger = new Logger(VisibilityRunRunner.name);
  private readonly completeHooks: OnVisibilityRunCompleteHook[];

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(VisibilityCollectorService) private readonly collector: VisibilityCollectorService,
    @Inject(VisibilityJudgeService) private readonly judge: VisibilityJudgeService,
    @Optional() @Inject(VISIBILITY_RUN_ENQUEUER) private readonly enqueuer?: VisibilityRunEnqueuer,
    @Optional()
    @Inject(VisibilityEngineHealthService)
    private readonly engineHealth?: VisibilityEngineHealthService,
    @Optional()
    @Inject(VISIBILITY_RUN_COMPLETE_HOOKS)
    initialHooks?: readonly OnVisibilityRunCompleteHook[],
  ) {
    this.completeHooks = [...(initialHooks ?? [])];
  }

  registerCompleteHook(hook: OnVisibilityRunCompleteHook): void {
    const existingIdx = this.completeHooks.findIndex((item) => item.name === hook.name);
    if (existingIdx >= 0) {
      this.completeHooks[existingIdx] = hook;
    } else {
      this.completeHooks.push(hook);
    }
  }

  async process(payload: VisibilityCheckJobData): Promise<void> {
    const { tenantId, runId } = payload;

    for (;;) {
      const claimed = await this.claimNextObservation(tenantId, runId);
      if (claimed.kind === 'stopped' || claimed.kind === 'busy') {
        return;
      }
      if (claimed.kind === 'drain') {
        await this.finalizeIfComplete(tenantId, runId);
        return;
      }

      if (claimed.spawnSibling && this.enqueuer) {
        await this.enqueuer.enqueueVisibilityRun({ tenantId, runId }).catch((err: unknown) => {
          this.logger.warn(
            `sibling visibility enqueue skipped: ${err instanceof Error ? err.message : 'unknown'}`,
          );
        });
      }

      await this.executeClaimedObservation({
        tenantId,
        runId,
        observationId: claimed.observationId,
      });
    }
  }

  private async claimNextObservation(tenantId: string, runId: string): Promise<ClaimOutcome> {
    const tenantLimit = QUEUE_TENANT_LIMIT['visibility-check'];

    return this.prisma.base.$transaction(async (tx) => {
      const run = await tx.visibilityRun.findFirst({
        where: { id: runId, tenantId },
        select: { id: true, status: true },
      });
      if (!run) return { kind: 'stopped' };

      if (run.status === 'PAUSED') {
        return { kind: 'stopped' };
      }

      if (run.status === 'CANCELLED') {
        await tx.visibilityObservation.updateMany({
          where: { runId, tenantId, status: 'PENDING' },
          data: { status: 'SKIPPED', checkedAt: new Date() },
        });
        return { kind: 'drain' };
      }

      if (run.status === 'COMPLETED' || run.status === 'PARTIAL' || run.status === 'FAILED') {
        return { kind: 'drain' };
      }

      const now = new Date();
      const staleCutoff = new Date(now.getTime() - STALE_OBSERVATION_MS);
      await tx.visibilityObservation.updateMany({
        where: {
          tenantId,
          status: 'RUNNING',
          checkedAt: { lt: staleCutoff },
        },
        data: { status: 'PENDING' },
      });

      const runningForTenant = await tx.visibilityObservation.count({
        where: { tenantId, status: 'RUNNING' },
      });
      if (runningForTenant >= tenantLimit) {
        return { kind: 'busy' };
      }

      const candidates = await tx.visibilityObservation.findMany({
        where: { runId, tenantId, status: 'PENDING' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 4,
        select: { id: true },
      });

      let claimedId: string | null = null;
      for (const candidate of candidates) {
        const updated = await tx.visibilityObservation.updateMany({
          where: { id: candidate.id, tenantId, status: 'PENDING' },
          data: { status: 'RUNNING', checkedAt: now },
        });
        if (updated.count === 1) {
          claimedId = candidate.id;
          break;
        }
      }

      if (!claimedId) {
        const runRunning = await tx.visibilityObservation.count({
          where: { runId, tenantId, status: 'RUNNING' },
        });
        return runRunning === 0 ? { kind: 'drain' } : { kind: 'busy' };
      }

      if (run.status === 'QUEUED') {
        await tx.visibilityRun.updateMany({
          where: { id: runId, tenantId, status: 'QUEUED' },
          data: { status: 'RUNNING' },
        });
      }

      const remainingCandidates = candidates.filter((c) => c.id !== claimedId).length;
      const spawnSibling = remainingCandidates > 0 && runningForTenant + 1 < tenantLimit;

      return {
        kind: 'claimed',
        observationId: claimedId,
        spawnSibling,
      };
    }, TX_OPTIONS);
  }

  private async executeClaimedObservation(input: {
    tenantId: string;
    runId: string;
    observationId: string;
  }): Promise<void> {
    const { tenantId, runId, observationId } = input;

    const [run, obs] = await Promise.all([
      this.prisma.base.visibilityRun.findFirst({
        where: { id: runId, tenantId },
        include: { brandMarket: true },
      }),
      this.prisma.base.visibilityObservation.findFirst({
        where: { id: observationId, runId, tenantId },
      }),
    ]);

    if (!run || !run.brandMarket || !obs) return;

    if (run.status === 'CANCELLED') {
      await this.prisma.base.visibilityObservation.updateMany({
        where: { id: observationId, tenantId, status: 'RUNNING' },
        data: { status: 'SKIPPED', checkedAt: new Date() },
      });
      await this.finalizeIfComplete(tenantId, runId);
      return;
    }

    const reservationId = await this.resolveReservationId(tenantId, run.id, run.reservationId);
    const competitors = parseProfileCompetitors(run.brandMarket.competitors);
    const ownedDomains = run.brandMarket.ownedDomains
      .map((dom) => normalizeVisibilityDomain(dom))
      .filter(Boolean);
    const competitorDomains = competitors.flatMap((comp) => comp.domains);

    try {
      const collected = await this.collector.collect({
        tenantId,
        engine: obs.engine,
        promptText: obs.promptText,
        brandName: run.brandMarket.localBrandName,
        brandAliases: run.brandMarket.aliases,
        ownedDomains,
        competitors,
        market: run.brandMarket.market,
        locale: run.brandMarket.locale,
        region: run.brandMarket.region,
        triggerType: run.triggerType,
        idempotencyKey: `vis-col:${obs.id}`,
      });
      if (this.engineHealth) {
        await this.engineHealth.recordObservationSuccess(obs.engine);
      }

      const fanOutQueries = normalizeFanOutQueries(collected.fanOutQueries, obs.promptText);

      const classifiedCitations: Array<{
        url: string;
        domain: string;
        title: string | null;
        snippet: string | null;
        sourceKind: CitationSourceKind;
        position: number;
      }> = [];

      for (const item of collected.citations) {
        const domain = normalizeVisibilityDomain(item.url);
        if (!domain) continue;
        const sourceKind = classifyCitationSource(item.url, {
          ownedDomains,
          competitorDomains,
        });
        classifiedCitations.push({
          url: item.url,
          domain,
          title: item.title ?? null,
          snippet: item.snippet ?? null,
          sourceKind,
          position: classifiedCitations.length + 1,
        });
      }

      const judged = await this.judge.evaluate({
        tenantId,
        promptText: obs.promptText,
        engine: obs.engine,
        answerText: collected.answerText,
        citations: classifiedCitations.map((cite) => ({
          url: cite.url,
          title: cite.title,
          snippet: cite.snippet,
        })),
        profile: {
          brandName: run.brandMarket.localBrandName,
          brandAliases: run.brandMarket.aliases,
          ownedDomains,
          competitors,
        },
        idempotencyKey: `vis-jdg:${obs.id}`,
      });

      const persisted = await this.persistObservationSuccess({
        tenantId,
        runId: run.id,
        observationId: obs.id,
        collectorKind: collected.collectorKind,
        answerText: collected.answerText,
        brandMentioned: judged.brandMentioned,
        brandPosition: judged.brandPosition,
        brandSentiment: judged.brandSentiment,
        brandPassage: judged.brandPassage,
        competitorHits: judged.competitorHits as unknown as Prisma.InputJsonValue,
        fanOutQueries,
        judgeModel: judged.judgeModel,
        tokensIn: judged.tokensIn,
        tokensOut: judged.tokensOut,
        citations: classifiedCitations,
      });

      if (persisted === 'cancelled') {
        await this.finalizeIfComplete(tenantId, run.id);
        return;
      }

      if (reservationId) {
        const settleTitle = `AI可见性监测-${run.name}`.slice(0, 80);
        await this.billing.settle({
          tenantId,
          reservationId,
          unitKey: `visibility_obs:${obs.id}`,
          action: 'visibility_check',
          amount: run.unitPrice,
          title: settleTitle,
          detail: {
            runId: run.id,
            observationId: obs.id,
            engine: obs.engine,
          },
        });
      }
    } catch (error) {
      if (this.engineHealth) {
        await this.engineHealth.recordObservationFailure(obs.engine, error);
      }
      await this.handleObservationFailure({
        tenantId,
        runId: run.id,
        runName: run.name,
        unitPrice: run.unitPrice,
        reservationId,
        observationId: obs.id,
        error,
      });
    }
  }

  private async resolveReservationId(
    tenantId: string,
    runId: string,
    storedId: string | null,
  ): Promise<string | null> {
    if (storedId) return storedId;
    const found = await this.prisma.base.pointReservation.findFirst({
      where: {
        tenantId,
        refType: 'visibility_run',
        refId: runId,
      },
      select: { id: true },
    });
    return found?.id ?? null;
  }

  private async persistObservationSuccess(input: {
    tenantId: string;
    runId: string;
    observationId: string;
    collectorKind: string;
    answerText: string;
    brandMentioned: boolean;
    brandPosition: number | null;
    brandSentiment: string | null;
    brandPassage: string | null;
    competitorHits: Prisma.InputJsonValue;
    fanOutQueries: string[];
    judgeModel: string;
    tokensIn: number;
    tokensOut: number;
    citations: ReadonlyArray<{
      url: string;
      domain: string;
      title: string | null;
      snippet: string | null;
      sourceKind: CitationSourceKind;
      position: number;
    }>;
  }): Promise<'saved' | 'cancelled'> {
    return this.prisma.base.$transaction(async (tx) => {
      const currentRun = await tx.visibilityRun.findFirst({
        where: { id: input.runId, tenantId: input.tenantId },
        select: { status: true },
      });
      if (!currentRun || currentRun.status === 'CANCELLED') {
        await tx.visibilityObservation.updateMany({
          where: { id: input.observationId, tenantId: input.tenantId, status: 'RUNNING' },
          data: { status: 'SKIPPED', checkedAt: new Date() },
        });
        return 'cancelled';
      }

      const existing = await tx.visibilityObservation.findFirst({
        where: { id: input.observationId, tenantId: input.tenantId },
        select: { status: true },
      });
      if (existing?.status === 'SUCCESS') {
        return 'saved';
      }

      const now = new Date();
      await tx.visibilityCitation.deleteMany({
        where: { observationId: input.observationId, tenantId: input.tenantId },
      });

      if (input.citations.length > 0) {
        await tx.visibilityCitation.createMany({
          data: input.citations.map((cite) => ({
            tenantId: input.tenantId,
            observationId: input.observationId,
            url: cite.url,
            domain: cite.domain,
            title: cite.title,
            snippet: cite.snippet,
            sourceKind: cite.sourceKind,
            position: cite.position,
          })),
        });
      }

      await tx.visibilityObservation.update({
        where: { id: input.observationId },
        data: {
          status: 'SUCCESS',
          collectorKind: input.collectorKind,
          answerText: input.answerText,
          brandMentioned: input.brandMentioned,
          brandPosition: input.brandPosition,
          brandSentiment: input.brandSentiment,
          brandPassage: input.brandPassage,
          competitorHits: input.competitorHits,
          fanOutQueries: input.fanOutQueries,
          judgeModel: input.judgeModel,
          tokensIn: input.tokensIn,
          tokensOut: input.tokensOut,
          error: null,
          checkedAt: now,
        },
      });

      await tx.visibilityRun.update({
        where: { id: input.runId },
        data: {
          doneCount: { increment: 1 },
        },
      });

      return 'saved';
    }, TX_OPTIONS);
  }

  private async handleObservationFailure(input: {
    tenantId: string;
    runId: string;
    runName: string;
    unitPrice: number;
    reservationId: string | null;
    observationId: string;
    error: unknown;
  }): Promise<void> {
    const errMsg = safeVisibilityError(input.error);

    if (input.reservationId) {
      const releaseTitle = `退还预扣-${input.runName}`.slice(0, 80);
      await this.billing
        .releaseUnit({
          tenantId: input.tenantId,
          reservationId: input.reservationId,
          unitKey: `visibility_obs:${input.observationId}`,
          amount: input.unitPrice,
          title: releaseTitle,
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `releaseUnit on ${input.observationId} skipped: ${err instanceof Error ? err.message : 'unknown'}`,
          );
        });
    }

    await this.prisma.base.$transaction(async (tx) => {
      const run = await tx.visibilityRun.findFirst({
        where: { id: input.runId, tenantId: input.tenantId },
        select: { status: true },
      });
      if (!run) return;

      const current = await tx.visibilityObservation.findFirst({
        where: { id: input.observationId, tenantId: input.tenantId },
        select: { status: true },
      });
      if (!current || current.status === 'SUCCESS' || current.status === 'SKIPPED') {
        return;
      }

      if (current.status !== 'FAILED') {
        await tx.visibilityObservation.update({
          where: { id: input.observationId },
          data: {
            status: 'FAILED',
            error: errMsg,
            checkedAt: new Date(),
          },
        });

        await tx.visibilityRun.update({
          where: { id: input.runId },
          data:
            run.status === 'PAUSED'
              ? { failCount: { increment: 1 } }
              : { failCount: { increment: 1 }, lastError: errMsg },
        });
      }
    }, TX_OPTIONS);
  }

  async finalizeIfComplete(tenantId: string, runId: string): Promise<void> {
    const summary = await this.prisma.base.$transaction(async (tx) => {
      const run = await tx.visibilityRun.findFirst({
        where: { id: runId, tenantId },
        select: {
          id: true,
          brandId: true,
          brandMarketId: true,
          triggerType: true,
          retestArticleId: true,
          status: true,
          totalChecks: true,
          reservationId: true,
          finishedAt: true,
        },
      });
      if (!run) return null;
      if (run.status === 'PAUSED') return null;

      const [pending, running, success, failed, skipped] = await Promise.all([
        tx.visibilityObservation.count({ where: { runId, tenantId, status: 'PENDING' } }),
        tx.visibilityObservation.count({ where: { runId, tenantId, status: 'RUNNING' } }),
        tx.visibilityObservation.count({ where: { runId, tenantId, status: 'SUCCESS' } }),
        tx.visibilityObservation.count({ where: { runId, tenantId, status: 'FAILED' } }),
        tx.visibilityObservation.count({ where: { runId, tenantId, status: 'SKIPPED' } }),
      ]);

      if (run.status !== 'CANCELLED' && (pending > 0 || running > 0)) {
        return null;
      }

      let nextStatus: TaskStatusName = run.status;
      if (run.status !== 'CANCELLED') {
        if (failed === 0 && skipped === 0 && success >= run.totalChecks) {
          nextStatus = 'COMPLETED';
        } else if (success > 0) {
          nextStatus = 'PARTIAL';
        } else {
          nextStatus = 'FAILED';
        }
      }

      const now = new Date();
      let transitioned = false;

      if (run.status !== 'CANCELLED') {
        const updated = await tx.visibilityRun.updateMany({
          where: { id: runId, tenantId, status: { in: ['QUEUED', 'RUNNING'] } },
          data: {
            status: nextStatus,
            doneCount: success,
            failCount: failed,
            finishedAt: run.finishedAt ?? (running === 0 ? now : null),
          },
        });
        transitioned = updated.count === 1;
        if (!transitioned) {
          await tx.visibilityRun.updateMany({
            where: { id: runId, tenantId },
            data: {
              doneCount: success,
              failCount: failed,
              finishedAt: run.finishedAt ?? (running === 0 ? now : null),
            },
          });
        }
      } else {
        await tx.visibilityRun.update({
          where: { id: runId },
          data: {
            status: nextStatus,
            doneCount: success,
            failCount: failed,
            finishedAt: run.finishedAt ?? (running === 0 ? now : null),
          },
        });
      }

      return {
        closeReservation: running === 0,
        reservationId: run.reservationId,
        transitioned,
        brandId: run.brandId,
        brandMarketId: run.brandMarketId,
        triggerType: run.triggerType,
        retestArticleId: run.retestArticleId ?? null,
        status: nextStatus,
        successCount: success,
      };
    }, TX_OPTIONS);

    if (!summary) return;

    if (summary.closeReservation) {
      const reservationId = await this.resolveReservationId(tenantId, runId, summary.reservationId);
      if (reservationId) {
        const reservation = await this.prisma.base.pointReservation.findFirst({
          where: { id: reservationId, tenantId },
          select: { id: true, status: true },
        });
        if (reservation && reservation.status === 'OPEN') {
          await this.billing.close({ tenantId, reservationId: reservation.id });
        }
      }
    }

    if (
      summary.transitioned &&
      (summary.status === 'COMPLETED' || summary.status === 'PARTIAL') &&
      summary.successCount > 0 &&
      this.completeHooks.length > 0
    ) {
      const event: VisibilityRunCompleteEvent = {
        tenantId,
        brandId: summary.brandId,
        brandMarketId: summary.brandMarketId,
        runId,
        triggerType: summary.triggerType,
        retestArticleId: summary.retestArticleId,
        status: summary.status,
        successCount: summary.successCount,
      };

      for (const hook of this.completeHooks) {
        try {
          await hook.onVisibilityRunComplete(event);
        } catch (error) {
          this.logger.error(
            `visibility run complete hook "${hook.name}" failed for run ${runId}: ${
              error instanceof Error ? error.message : 'unknown'
            }`,
          );
        }
      }
    }
  }
}
