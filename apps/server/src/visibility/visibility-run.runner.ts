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
} from '@geomix/shared';
import { BillingService } from '../billing/billing.service';
import { TX_OPTIONS } from '../billing/billing.sql';
import { ApiError } from '../common/api-error';
import { ProviderError } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import { VisibilityCollectorService } from './visibility-collector.service';
import { VisibilityJudgeService } from './visibility-judge.service';

export const VISIBILITY_RUN_HANDLER = Symbol('VISIBILITY_RUN_HANDLER');
export const VISIBILITY_RUN_ENQUEUER = Symbol('VISIBILITY_RUN_ENQUEUER');

export type VisibilityCheckJobData = {
  tenantId: string;
  runId: string;
};

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

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(VisibilityCollectorService) private readonly collector: VisibilityCollectorService,
    @Inject(VisibilityJudgeService) private readonly judge: VisibilityJudgeService,
    @Optional() @Inject(VISIBILITY_RUN_ENQUEUER) private readonly enqueuer?: VisibilityRunEnqueuer,
  ) {}

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
        include: { profile: true },
      }),
      this.prisma.base.visibilityObservation.findFirst({
        where: { id: observationId, runId, tenantId },
      }),
    ]);

    if (!run || !run.profile || !obs) return;

    if (run.status === 'CANCELLED') {
      await this.prisma.base.visibilityObservation.updateMany({
        where: { id: observationId, tenantId, status: 'RUNNING' },
        data: { status: 'SKIPPED', checkedAt: new Date() },
      });
      await this.finalizeIfComplete(tenantId, runId);
      return;
    }

    const reservationId = await this.resolveReservationId(tenantId, run.id, run.reservationId);
    const competitors = parseProfileCompetitors(run.profile.competitors);
    const ownedDomains = run.profile.ownedDomains
      .map((dom) => normalizeVisibilityDomain(dom))
      .filter(Boolean);
    const competitorDomains = competitors.flatMap((comp) => comp.domains);

    try {
      const collected = await this.collector.collect({
        tenantId,
        engine: obs.engine,
        promptText: obs.promptText,
        brandName: run.profile.brandName,
        brandAliases: run.profile.brandAliases,
        ownedDomains,
        competitors,
        idempotencyKey: `vis-col:${obs.id}`,
      });

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
          brandName: run.profile.brandName,
          brandAliases: run.profile.brandAliases,
          ownedDomains,
          competitors,
        },
        idempotencyKey: `vis-jdg:${obs.id}`,
      });

      const persisted = await this.persistObservationSuccess({
        tenantId,
        runId: run.id,
        observationId: obs.id,
        questionId: obs.questionId,
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
    questionId: string | null;
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

      if (input.brandMentioned && input.questionId) {
        const question = await tx.question.findFirst({
          where: { id: input.questionId, tenantId: input.tenantId },
          select: { id: true, keywordId: true, included: true },
        });
        if (question) {
          if (!question.included) {
            await tx.question.update({
              where: { id: question.id },
              data: { included: true },
            });
          }
          await tx.keyword.updateMany({
            where: { id: question.keywordId, tenantId: input.tenantId },
            data: { optStatus: 'INCLUDED' },
          });
        }
      }

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
          status: true,
          totalChecks: true,
          keywordId: true,
          questionIds: true,
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
      await tx.visibilityRun.update({
        where: { id: runId },
        data: {
          status: nextStatus,
          doneCount: success,
          failCount: failed,
          finishedAt: run.finishedAt ?? (running === 0 ? now : null),
        },
      });

      if (running === 0) {
        await this.syncKeywordOptStatuses(tx, {
          tenantId,
          runId,
          runKeywordId: run.keywordId,
          questionIds: run.questionIds,
          completedWithChecks: nextStatus !== 'CANCELLED' && success > 0,
        });
      }

      return {
        closeReservation: running === 0,
        reservationId: run.reservationId,
      };
    }, TX_OPTIONS);

    if (!summary?.closeReservation) return;

    const reservationId = await this.resolveReservationId(tenantId, runId, summary.reservationId);
    if (!reservationId) return;

    const reservation = await this.prisma.base.pointReservation.findFirst({
      where: { id: reservationId, tenantId },
      select: { id: true, status: true },
    });
    if (reservation && reservation.status === 'OPEN') {
      await this.billing.close({ tenantId, reservationId: reservation.id });
    }
  }

  private async syncKeywordOptStatuses(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      runId: string;
      runKeywordId: string | null;
      questionIds: string[];
      completedWithChecks: boolean;
    },
  ): Promise<void> {
    const keywordIds = new Set<string>();
    if (input.runKeywordId) {
      keywordIds.add(input.runKeywordId);
    }

    if (input.questionIds.length > 0) {
      const questions = await tx.question.findMany({
        where: {
          tenantId: input.tenantId,
          id: { in: input.questionIds },
        },
        select: { id: true, keywordId: true },
      });
      for (const q of questions) {
        keywordIds.add(q.keywordId);
      }
    }

    if (keywordIds.size === 0) return;

    const succeededObs = await tx.visibilityObservation.findMany({
      where: {
        runId: input.runId,
        tenantId: input.tenantId,
        status: 'SUCCESS',
        questionId: { not: null },
      },
      select: { questionId: true },
    });
    const checkedQuestionIdSet = new Set(
      succeededObs.map((row) => row.questionId).filter((id): id is string => Boolean(id)),
    );

    for (const keywordId of keywordIds) {
      const kw = await tx.keyword.findFirst({
        where: { id: keywordId, tenantId: input.tenantId },
        select: { id: true, optStatus: true },
      });
      if (!kw) continue;

      const includedCount = await tx.question.count({
        where: { tenantId: input.tenantId, keywordId, included: true },
      });

      if (includedCount > 0) {
        if (kw.optStatus !== 'INCLUDED') {
          await tx.keyword.update({
            where: { id: kw.id },
            data: { optStatus: 'INCLUDED' },
          });
        }
        continue;
      }

      if (!input.completedWithChecks) continue;

      const keywordQuestions = await tx.question.findMany({
        where: { tenantId: input.tenantId, keywordId },
        select: { id: true },
      });
      const testedAnyForKeyword =
        keywordId === input.runKeywordId ||
        keywordQuestions.some((q) => checkedQuestionIdSet.has(q.id));

      if (testedAnyForKeyword && kw.optStatus !== 'INCLUDED' && kw.optStatus !== 'OPTIMIZING') {
        await tx.keyword.update({
          where: { id: kw.id },
          data: { optStatus: 'OPTIMIZING' },
        });
      }
    }
  }
}
