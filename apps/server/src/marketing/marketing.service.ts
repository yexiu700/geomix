import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AUTH_ERROR,
  RATE_LIMIT_MESSAGE,
  buildPublicPricingPayload,
  createMarketingLeadSchema,
  escapeLikeLiteral,
  type ListMarketingLeadsQuery,
  type MarketingLeadDto,
  type MarketingLeadMarket,
  type MarketingLeadStatus,
  type PublicPricingPayload,
  type UpdateMarketingLeadStatusInput,
} from '@geomix/shared';
import IORedis from 'ioredis';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  type FreeActionRateLimit,
} from '../common/free-action-rate-limiter';
import { parseBody } from '../common/parse-body';
import { PrismaService } from '../prisma/prisma.service';

export const MARKETING_SERVICE_OPTIONS = Symbol('MARKETING_SERVICE_OPTIONS');

const DEFAULT_IP_HASH_SALT = 'geomix-marketing-lead-ip-salt-dev';
const DEFAULT_LEAD_IP_RATE_LIMIT_MAX = 10;
const DEFAULT_LEAD_IP_RATE_LIMIT_WINDOW_SECONDS = 600;
const DEFAULT_LEAD_EMAIL_RATE_LIMIT_MAX = 3;
const DEFAULT_LEAD_EMAIL_RATE_LIMIT_WINDOW_SECONDS = 3600;

const FIXED_WINDOW_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`;

export type MarketingLeadSubmitResult = {
  accepted: true;
  id?: string;
};

export type MarketingLeadListResult = {
  items: MarketingLeadDto[];
  total: number;
  page: number;
  pageSize: number;
};

export type MarketingRateDecision =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface MarketingRateLimitStore {
  consume(
    scope: string,
    keyHash: string,
    limit: FreeActionRateLimit,
  ): Promise<MarketingRateDecision>;
  reset?(): void;
  close?(): Promise<void>;
}

export type MarketingServiceOptions = {
  rateLimiter?: FreeActionRateLimiter;
  redisStore?: MarketingRateLimitStore | null;
  env?: Record<string, string | undefined>;
};

const MARKETING_LEAD_SELECT = {
  id: true,
  locale: true,
  name: true,
  email: true,
  companyBrand: true,
  websiteUrl: true,
  targetMarket: true,
  monthlyGoal: true,
  estimatedPts: true,
  notes: true,
  sourcePage: true,
  status: true,
  adminNote: true,
  createdAt: true,
  updatedAt: true,
} as const;

type SelectedMarketingLead = {
  id: string;
  locale: string;
  name: string;
  email: string;
  companyBrand: string;
  websiteUrl: string | null;
  targetMarket: MarketingLeadMarket;
  monthlyGoal: string | null;
  estimatedPts: number | null;
  notes: string | null;
  sourcePage: string | null;
  status: MarketingLeadStatus;
  adminNote: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^[1-9]\d*$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readMarketingLeadIpRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(env.MARKETING_LEAD_IP_RATE_LIMIT_MAX, DEFAULT_LEAD_IP_RATE_LIMIT_MAX);
  const windowSeconds = readPositiveInt(
    env.MARKETING_LEAD_IP_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_LEAD_IP_RATE_LIMIT_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function readMarketingLeadEmailRateLimit(
  env: Record<string, string | undefined> = process.env,
): FreeActionRateLimit {
  const max = readPositiveInt(
    env.MARKETING_LEAD_EMAIL_RATE_LIMIT_MAX,
    DEFAULT_LEAD_EMAIL_RATE_LIMIT_MAX,
  );
  const windowSeconds = readPositiveInt(
    env.MARKETING_LEAD_EMAIL_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_LEAD_EMAIL_RATE_LIMIT_WINDOW_SECONDS,
  );
  return { max, windowMs: windowSeconds * 1000 };
}

export function resolveMarketingIpSalt(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.MARKETING_LEAD_IP_SALT?.trim() || env.JWT_ACCESS_SECRET?.trim() || DEFAULT_IP_HASH_SALT
  );
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashClientIp(
  ip: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const cleaned = ip.trim();
  if (!cleaned || cleaned === 'unknown') return null;
  const salt = resolveMarketingIpSalt(env);
  return sha256Hex(`${salt}:${cleaned}`);
}

function createRedisRateLimitStore(redisUrl: string, queuePrefix: string): MarketingRateLimitStore {
  let client: IORedis | null = null;
  const ensure = (): IORedis => {
    if (!client) {
      client = new IORedis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        connectTimeout: 2_000,
      });
      client.on('error', () => {
        // Silent fallback to in-memory limiter when Redis is unavailable.
      });
    }
    return client;
  };

  return {
    async consume(scope, keyHash, limit) {
      const safeMax = Math.max(1, Math.floor(limit.max));
      const safeWindowMs = Math.max(1_000, Math.floor(limit.windowMs));
      const redisKey = `${queuePrefix}:marketing:rl:${scope}:${keyHash}`;
      const raw = await ensure().eval(FIXED_WINDOW_LUA, 1, redisKey, String(safeWindowMs));
      if (!Array.isArray(raw) || raw.length < 2) {
        throw new Error('Unexpected Redis rate limit response');
      }
      const current = Number(raw[0]);
      const ttlMs = Number(raw[1]);
      if (!Number.isFinite(current)) {
        throw new Error('Invalid Redis rate limit counter');
      }
      if (current > safeMax) {
        const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(1, ttlMs) / 1000));
        return { allowed: false, retryAfterSeconds };
      }
      return { allowed: true };
    },
    async close() {
      if (!client) return;
      const current = client;
      client = null;
      try {
        await current.quit();
      } catch {
        current.disconnect();
      }
    },
  };
}

function presentMarketingLead(row: SelectedMarketingLead): MarketingLeadDto {
  return {
    id: row.id,
    locale: row.locale,
    name: row.name,
    email: row.email,
    companyBrand: row.companyBrand,
    websiteUrl: row.websiteUrl,
    targetMarket: row.targetMarket,
    monthlyGoal: row.monthlyGoal,
    estimatedPts: row.estimatedPts,
    notes: row.notes,
    sourcePage: row.sourcePage,
    status: row.status,
    adminNote: row.adminNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isPrismaNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2025'
  );
}

@Injectable()
export class MarketingService implements OnModuleDestroy {
  private readonly memoryLimiter: FreeActionRateLimiter;
  private readonly redisStore: MarketingRateLimitStore | null;
  private readonly env: Record<string, string | undefined>;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(MARKETING_SERVICE_OPTIONS)
    options?: MarketingServiceOptions,
  ) {
    this.env = options?.env ?? process.env;
    this.memoryLimiter = options?.rateLimiter ?? new FreeActionRateLimiter();
    if (options?.redisStore !== undefined) {
      this.redisStore = options.redisStore;
    } else {
      const redisUrl = this.env.REDIS_URL?.trim();
      const isTest = this.env.NODE_ENV === 'test' || Boolean(this.env.VITEST);
      if (redisUrl && !isTest) {
        const prefix = this.env.QUEUE_PREFIX?.trim() || 'geomix';
        this.redisStore = createRedisRateLimitStore(redisUrl, prefix);
      } else {
        this.redisStore = null;
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redisStore?.close?.();
  }

  resetRateLimits(): void {
    this.memoryLimiter.reset();
    this.redisStore?.reset?.();
  }

  async submitLead(body: unknown, clientIp: string): Promise<MarketingLeadSubmitResult> {
    const normalizedIp = clientIp.trim() || 'unknown';
    await this.assertRateAllowed(
      'marketing_lead_ip',
      normalizedIp,
      readMarketingLeadIpRateLimit(this.env),
    );

    const input = parseBody(createMarketingLeadSchema, body);

    if (input.honeypot !== undefined && input.honeypot.trim().length > 0) {
      return { accepted: true };
    }

    const normalizedEmail = input.email.trim().toLowerCase();
    await this.assertRateAllowed(
      'marketing_lead_email',
      normalizedEmail,
      readMarketingLeadEmailRateLimit(this.env),
    );

    const created = await this.prisma.scoped.marketingLead.create({
      data: {
        locale: input.locale,
        name: input.name,
        email: normalizedEmail,
        companyBrand: input.companyBrand,
        websiteUrl: input.websiteUrl ?? null,
        targetMarket: input.targetMarket,
        monthlyGoal: input.monthlyGoal ?? null,
        estimatedPts: input.estimatedPts ?? null,
        notes: input.notes ?? null,
        sourcePage: input.sourcePage ?? null,
        sourceIpHash: hashClientIp(normalizedIp, this.env),
      },
      select: { id: true },
    });

    return { accepted: true, id: created.id };
  }

  async getPublicPricing(): Promise<PublicPricingPayload> {
    const rows = await this.prisma.scoped.pricingItem.findMany({
      where: { enabled: true },
      select: {
        action: true,
        unitPoints: true,
        enabled: true,
      },
      orderBy: { action: 'asc' },
    });
    return buildPublicPricingPayload(rows);
  }

  async listLeads(query: ListMarketingLeadsQuery): Promise<MarketingLeadListResult> {
    const where: Prisma.MarketingLeadWhereInput = {};
    if (query.status) {
      where.status = query.status;
    }
    if (query.targetMarket) {
      where.targetMarket = query.targetMarket;
    }
    if (query.keyword) {
      const escaped = escapeLikeLiteral(query.keyword);
      where.OR = [
        { email: { contains: escaped, mode: 'insensitive' } },
        { companyBrand: { contains: escaped, mode: 'insensitive' } },
        { name: { contains: escaped, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await Promise.all([
      this.prisma.scoped.marketingLead.count({ where }),
      this.prisma.scoped.marketingLead.findMany({
        where,
        select: MARKETING_LEAD_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items: rows.map(presentMarketingLead),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async updateLead(id: string, input: UpdateMarketingLeadStatusInput): Promise<MarketingLeadDto> {
    const existing = await this.prisma.scoped.marketingLead.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '线索不存在');
    }

    const data: Prisma.MarketingLeadUpdateInput = {};
    if (input.status !== undefined) {
      data.status = input.status;
    }
    if (input.adminNote !== undefined) {
      data.adminNote = input.adminNote === null || input.adminNote === '' ? null : input.adminNote;
    }

    try {
      const updated = await this.prisma.scoped.marketingLead.update({
        where: { id },
        data,
        select: MARKETING_LEAD_SELECT,
      });
      return presentMarketingLead(updated);
    } catch (error) {
      if (isPrismaNotFoundError(error)) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '线索不存在');
      }
      throw error;
    }
  }

  private async assertRateAllowed(
    scope: string,
    identifier: string,
    limit: FreeActionRateLimit,
  ): Promise<void> {
    const salt = resolveMarketingIpSalt(this.env);
    const keyHash = sha256Hex(`${salt}:${scope}:${identifier}`);
    let decision: MarketingRateDecision;

    if (this.redisStore) {
      try {
        decision = await this.redisStore.consume(scope, keyHash, limit);
      } catch {
        decision = this.memoryLimiter.consume(scope, keyHash, limit);
      }
    } else {
      decision = this.memoryLimiter.consume(scope, keyHash, limit);
    }

    if (!decision.allowed) {
      throw new ApiError(
        429,
        AUTH_ERROR.TOO_MANY_REQUESTS,
        RATE_LIMIT_MESSAGE,
        decision.retryAfterSeconds,
      );
    }
  }
}
