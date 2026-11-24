import { Module } from '@nestjs/common';
import { LLM_COST_AUDIT_ACTION, resolveFetchSettings } from '@geomix/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ComplianceService, type AuditWriter } from './compliance';
import { EmbeddingService } from './embedding';
import { ImageService } from './image';
import { LlmService, type LlmCostSink } from './llm';
import { OUTBOUND_HTTP_DEPS, OutboundHttpClient, type OutboundHttpDeps } from './outbound-http';
import { fetchPublicPage, type FetchDeps } from './public-fetch';
import { SearchService } from './search';
import { StorageService } from './storage';

export class PublicFetchService {
  constructor(private readonly deps: FetchDeps) {}

  fetch(url: string, signal?: AbortSignal) {
    return fetchPublicPage(url, { ...this.deps, signal });
  }
}

@Module({
  providers: [
    {
      provide: ComplianceService,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new ComplianceService(prismaAudit(prisma)),
    },
    {
      provide: LlmService,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        LlmService.fromEnv(process.env, { costSink: prismaLlmCostSink(prisma) }),
    },
    {
      provide: EmbeddingService,
      useFactory: () => EmbeddingService.fromEnv(process.env),
    },
    {
      provide: StorageService,
      useFactory: () => StorageService.fromEnv(process.env),
    },
    {
      provide: SearchService,
      useFactory: () => SearchService.fromEnv(process.env),
    },
    {
      provide: PublicFetchService,
      useFactory: () =>
        new PublicFetchService({
          ...resolveFetchSettings(process.env),
          resolver: {
            async resolve(hostname: string) {
              const { createDnsResolver } = await import('./guarded-request');
              return createDnsResolver().resolve(hostname);
            },
          },
          transport: async (request) => {
            const { createUndiciTransport } = await import('./undici-transport');
            return createUndiciTransport()(request);
          },
        }),
    },
    {
      provide: ImageService,
      inject: [StorageService, ComplianceService],
      useFactory: (storage: StorageService, compliance: ComplianceService) => {
        const resolver = {
          async resolve(hostname: string) {
            const { createDnsResolver } = await import('./guarded-request');
            return createDnsResolver().resolve(hostname);
          },
        };
        const transport = async (
          request: Parameters<
            ReturnType<typeof import('./undici-transport').createUndiciTransport>
          >[0],
        ) => {
          const { createUndiciTransport } = await import('./undici-transport');
          return createUndiciTransport()(request);
        };
        return ImageService.fromEnv(process.env, {
          storage,
          compliance,
          resolver,
          transport,
          fetchDeps: {
            ...resolveFetchSettings(process.env),
            resolver,
            transport,
          },
        });
      },
    },
    {
      provide: OutboundHttpClient,
      inject: [{ token: OUTBOUND_HTTP_DEPS, optional: true }],
      useFactory: (deps?: OutboundHttpDeps) => new OutboundHttpClient(deps),
    },
  ],
  exports: [
    ComplianceService,
    LlmService,
    EmbeddingService,
    StorageService,
    SearchService,
    PublicFetchService,
    ImageService,
    OutboundHttpClient,
  ],
})
export class AdaptersModule {}

function prismaAudit(prisma: PrismaService): AuditWriter {
  return {
    async write(entry) {
      if (!process.env.DATABASE_URL?.trim()) return;
      await prisma.base.auditLog.create({
        data: {
          tenantId: entry.tenantId,
          userId: entry.userId,
          action: entry.action,
          payload: entry.payload,
        },
      });
    },
  };
}

function prismaLlmCostSink(prisma: PrismaService): LlmCostSink {
  return {
    async write(record) {
      if (!process.env.DATABASE_URL?.trim()) return;
      try {
        await prisma.base.auditLog.create({
          data: {
            tenantId: record.tenantId,
            action: LLM_COST_AUDIT_ACTION,
            payload: {
              recordId: record.recordId,
              idempotencyKey: record.idempotencyKey,
              scene: record.scene,
              provider: record.provider,
              model: record.model,
              fake: record.fake,
              tokensIn: record.tokensIn,
              tokensOut: record.tokensOut,
              costMicro: record.costMicro,
              costBasis: record.costBasis,
              latencyMs: record.latencyMs,
            },
          },
        });
      } catch {
        // Best-effort cost audit sink; never block or fail request/teardown
      }
    },
  };
}
