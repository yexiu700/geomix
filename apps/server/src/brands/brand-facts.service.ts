import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  API_ERROR,
  AUTH_ERROR,
  BRAND_FACT_CARD_MAX,
  BRAND_FACT_CORE_SLOTS,
  BRAND_FACT_EXTRACT_MAX_FILE_BYTES,
  BRAND_FACT_SLOTS,
  BRAND_FACT_SLOT_LABELS,
  BRAND_FACT_TOP_K_CHUNKS,
  requiresBrandFactVectorIndex,
  type BrandFactCoreSlot,
  type BrandFactRecord,
  type BrandFactSlot,
  type BrandFactsResponse,
  type ExtractBrandFactsResponse,
  type ExtractedBrandFactDraft,
  type FactIndexStatus,
  type FactSourceType,
  type ParsedUpsertBrandFactsInput,
} from '@geomix/shared';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import {
  FreeActionRateLimiter,
  readFactExtractRateLimit,
} from '../common/free-action-rate-limiter';
import { PublicFetchService } from '../infra/adapters.module';
import { ComplianceService } from '../infra/compliance';
import { extractPlainTextFromHtml } from '../infra/html-extract';
import { LlmService, assertCompletionAllowed } from '../infra/llm';
import { PdfExtractError, extractTextFromPdf } from '../infra/pdf-extract';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { PrismaService } from '../prisma/prisma.service';
import {
  BrandFactIndexRunner,
  FACT_INDEX_ENQUEUER,
  type FactIndexEnqueuer,
  type RetrievedBrandFactSnippet,
} from './brand-fact-index.runner';
import { BrandProductLinesService } from './brand-product-lines.service';
import { normalizeClientIp } from './brands.http-utils';

const MAX_EXTRACT_SOURCE_CHARS = 50_000;
const MAX_LLM_EXTRACT_PROMPT_CHARS = 15_000;

const SLOT_ORDER: Readonly<Record<BrandFactSlot, number>> = {
  PRODUCT_SPECS: 0,
  DIFFERENTIATORS: 1,
  CREDENTIALS: 2,
  CASE_STUDIES: 3,
  EXTRA_DOC: 4,
};

const llmExtractedFactsSchema = z.object({
  facts: z
    .array(
      z.object({
        slot: z.enum(BRAND_FACT_CORE_SLOTS),
        title: z.string().trim().max(120).optional(),
        content: z.string().trim().max(BRAND_FACT_CARD_MAX),
      }),
    )
    .min(1),
});

export type FactExtractInput = {
  sourceType?: 'URL_EXTRACT' | 'DOC_UPLOAD' | 'MANUAL';
  url?: string;
  rawText?: string;
  text?: string;
  fileName?: string;
  file?: {
    filename: string;
    mimetype?: string;
    buffer: Buffer;
  };
};

type BrandFactRow = {
  id: string;
  brandId: string;
  productLineId?: string | null;
  slot: string;
  title: string;
  content: string;
  sourceType: string;
  sourceUrl: string | null;
  indexStatus: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * 品牌事实卡服务（100% 走 prisma.scoped）：
 * - 维护 4 块核心事实卡 + 可选 EXTRA_DOC 补充长文档（支持可选多产品线归属隔离）
 * - 轻量单选合规承诺留痕（truthAgreementSignedAt + truthAgreementIp）
 * - 0 点防刷限流 AI 提炼（URL / 粘贴文本 / .txt / .md / .pdf）
 * - >6,000 字自动异步触发 fact-index 队列向量化；≤6,000 字零延迟直注并清理旧切片
 */
@Injectable()
export class BrandFactsService {
  private readonly logger = new Logger(BrandFactsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ComplianceService) private readonly compliance: ComplianceService,
    @Inject(PublicFetchService) private readonly publicFetch: PublicFetchService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(FreeActionRateLimiter) private readonly rateLimiter: FreeActionRateLimiter,
    @Inject(BrandFactIndexRunner) private readonly factIndexRunner: BrandFactIndexRunner,
    @Optional()
    @Inject(FACT_INDEX_ENQUEUER)
    private readonly factIndexEnqueuer?: FactIndexEnqueuer,
    @Optional()
    @Inject(BrandProductLinesService)
    private readonly productLines?: BrandProductLinesService,
  ) {}

  async getFacts(brandId: string, productLineId?: string): Promise<BrandFactsResponse> {
    const brand = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      select: { id: true, truthAgreementSignedAt: true },
    });
    if (!brand) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }

    const normalizedProductLineId = productLineId?.trim() || undefined;
    if (normalizedProductLineId) {
      await this.assertProductLineBelongsToBrand(brandId, normalizedProductLineId);
    }

    const rows = await this.prisma.scoped.brandFact.findMany({
      where: normalizedProductLineId
        ? {
            brandId,
            OR: [{ productLineId: null }, { productLineId: normalizedProductLineId }],
          }
        : { brandId },
      orderBy: [{ slot: 'asc' }, { updatedAt: 'desc' }],
    });

    const filteredRows = normalizedProductLineId
      ? rows.filter(
          (row) => row.productLineId == null || row.productLineId === normalizedProductLineId,
        )
      : rows;

    return buildFactsResponse(brand.id, brand.truthAgreementSignedAt, filteredRows);
  }

  async upsertFacts(
    tenantId: string,
    userId: string,
    brandId: string,
    input: ParsedUpsertBrandFactsInput,
    clientIp?: string | null,
  ): Promise<BrandFactsResponse> {
    const brand = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      select: { id: true, truthAgreementSignedAt: true },
    });
    if (!brand) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }

    const agreed = Boolean(input.truthAgreed || input.agreeTruthTerms);
    if (!brand.truthAgreementSignedAt && !agreed) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请先勾选品牌事实真实性与合规承诺');
    }

    const requestedLineIds = [
      ...new Set(
        input.facts
          .map((item) => item.productLineId)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
      ),
    ];
    if (requestedLineIds.length > 0) {
      await this.assertAllProductLinesBelongToBrand(brandId, requestedLineIds);
    }

    const complianceText = input.facts
      .map((item) => [item.title ?? '', item.content].join('\n'))
      .join('\n');

    await this.compliance.assertAllowed({
      text: complianceText,
      action: 'brand_facts_upsert',
      tenantId,
      userId,
    });

    const signedIp = normalizeClientIp(clientIp);
    let needsIndex = false;

    await this.prisma.scoped.$transaction(async (tx) => {
      if (agreed) {
        await tx.brand.updateMany({
          where: { id: brandId },
          data: {
            truthAgreementSignedAt: new Date(),
            truthAgreementIp: signedIp,
          },
        });
      }

      const existing = await tx.brandFact.findMany({
        where: { brandId },
        orderBy: [{ updatedAt: 'desc' }],
      });

      const matchedIds = new Set<string>();

      for (const item of input.facts) {
        const title = item.title?.trim() || BRAND_FACT_SLOT_LABELS[item.slot];
        const sourceUrl = item.sourceUrl ?? null;
        const hasProductLineField = item.productLineId !== undefined;
        const normalizedProductLineId = item.productLineId ?? null;

        let target = item.id
          ? existing.find((row) => row.id === item.id)
          : existing.find(
              (row) =>
                row.slot === item.slot &&
                (row.productLineId ?? null) === normalizedProductLineId &&
                !matchedIds.has(row.id),
            );

        if (!target && !item.id) {
          target = existing.find(
            (row) =>
              row.slot === item.slot && (row.productLineId ?? null) === normalizedProductLineId,
          );
        }

        if (target) {
          matchedIds.add(target.id);
          await tx.brandFact.updateMany({
            where: { id: target.id, brandId },
            data: {
              slot: item.slot,
              title,
              content: item.content,
              sourceType: item.sourceType,
              sourceUrl,
              ...(hasProductLineField ? { productLineId: normalizedProductLineId } : {}),
            },
          });
          target.slot = item.slot;
          target.title = title;
          target.content = item.content;
          target.sourceType = item.sourceType;
          target.sourceUrl = sourceUrl;
          if (hasProductLineField) {
            target.productLineId = normalizedProductLineId;
          }
        } else {
          const created = await tx.brandFact.create({
            data: {
              tenantId,
              brandId,
              productLineId: normalizedProductLineId,
              slot: item.slot,
              title,
              content: item.content,
              sourceType: item.sourceType,
              sourceUrl,
              indexStatus: 'NONE',
            },
          });
          matchedIds.add(created.id);
          existing.push(created);
        }
      }

      const allFacts = await tx.brandFact.findMany({
        where: { brandId },
        select: { id: true, content: true },
      });

      const totalChars = allFacts.reduce((sum, item) => sum + item.content.length, 0);
      const maxSingleChars = allFacts.reduce((max, item) => Math.max(max, item.content.length), 0);
      needsIndex =
        requiresBrandFactVectorIndex(totalChars) || requiresBrandFactVectorIndex(maxSingleChars);

      if (needsIndex) {
        const nonEmptyIds = allFacts
          .filter((item) => item.content.trim().length > 0)
          .map((item) => item.id);
        const emptyIds = allFacts
          .filter((item) => item.content.trim().length === 0)
          .map((item) => item.id);

        if (nonEmptyIds.length > 0) {
          await tx.brandFact.updateMany({
            where: { brandId, id: { in: nonEmptyIds } },
            data: { indexStatus: 'INDEXING' },
          });
        }
        if (emptyIds.length > 0) {
          await tx.brandFact.updateMany({
            where: { brandId, id: { in: emptyIds } },
            data: { indexStatus: 'NONE' },
          });
        }
      } else {
        await tx.brandFact.updateMany({
          where: { brandId },
          data: { indexStatus: 'NONE' },
        });
        await tx.brandFactChunk.deleteMany({ where: { brandId } });
      }
    });

    if (needsIndex && this.factIndexEnqueuer) {
      try {
        await this.factIndexEnqueuer.enqueueFactIndex({ tenantId, brandId });
      } catch (error) {
        this.logger.warn(
          `enqueue fact-index failed for brand=${brandId}: ${error instanceof Error ? error.message : 'unknown'}`,
        );
        await this.prisma.scoped.brandFact.updateMany({
          where: { brandId, indexStatus: 'INDEXING' },
          data: { indexStatus: 'FAILED' },
        });
      }
    }

    return this.getFacts(brandId);
  }

  async extractFacts(
    tenantId: string,
    userId: string,
    brandId: string,
    input: FactExtractInput,
  ): Promise<ExtractBrandFactsResponse> {
    const brand = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      select: { id: true, name: true, category: true },
    });
    if (!brand) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }

    this.rateLimiter.assertAllowed('brand_fact_extract', tenantId, readFactExtractRateLimit());

    const resolved = await this.resolveExtractSource(input);

    await this.compliance.assertAllowed({
      text: resolved.sourceText,
      action: 'brand_fact_extract',
      tenantId,
      userId,
    });

    const truncatedForLlm = resolved.sourceText.slice(0, MAX_LLM_EXTRACT_PROMPT_CHARS);
    const warnings: string[] = [];
    if (resolved.sourceText.length > MAX_LLM_EXTRACT_PROMPT_CHARS) {
      warnings.push(
        `原始资料较长（${resolved.sourceText.length} 字），已取前 ${MAX_LLM_EXTRACT_PROMPT_CHARS} 字参与 AI 提炼，完整资料可贴入「补充长文档区」。`,
      );
    }

    const digest = createHash('sha256').update(truncatedForLlm).digest('hex').slice(0, 16);
    const idempotencyKey = `fact_extract:${brandId}:${digest}:${randomBytes(4).toString('hex')}`;

    let completion;
    try {
      completion = await this.llm.complete({
        tenantId,
        scene: 'fact_extract',
        messages: [
          {
            role: 'system',
            content: [
              '你是 GeoMix 品牌事实提炼助手。请从商户提供的品牌官方资料中提取客观、可核验的事实，整理为严格 JSON 对象。',
              'JSON 结构必须为：{"facts":[{"slot":"PRODUCT_SPECS"|"DIFFERENTIATORS"|"CREDENTIALS"|"CASE_STUDIES","title":"标题","content":"提炼后的事实要点"}]}。',
              '规则：1) 仅提取原文有据可查的参数、差异点、认证资质、真实案例，严禁虚构数字或奖项；2) 保持与输入资料一致的语言（中文资料输出中文，英文资料输出英文）；3) 必须输出 4 个槽位。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `品牌名称：${brand.name}`,
              `所属品类：${brand.category}`,
              resolved.sourceTitle ? `页面标题：${resolved.sourceTitle}` : '',
              '--- 品牌资料正文 ---',
              truncatedForLlm,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
        idempotencyKey,
        temperature: 0.2,
        maxTokens: 2048,
        disableThinking: true,
      });

      assertCompletionAllowed({
        completion,
        llm: this.llm,
        scene: 'fact_extract',
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof ProviderError) {
        if (error.reason === 'fake_fallback_rejected') {
          throw new ApiError(503, API_ERROR.UPSTREAM_UNAVAILABLE, error.message);
        }
        throw new ApiError(
          502,
          API_ERROR.UPSTREAM_UNAVAILABLE,
          error.message || 'AI 事实提炼服务暂时不可用，请稍后重试',
        );
      }
      throw new ApiError(502, API_ERROR.UPSTREAM_UNAVAILABLE, 'AI 事实提炼失败，请稍后重试');
    }

    const facts: ExtractedBrandFactDraft[] = completion.fake
      ? extractDeterministicFactsFromSource(resolved.sourceText, brand.name, resolved.sourceTitle)
      : parseLlmExtractedFacts(completion.text);

    return {
      sourceType: resolved.sourceType,
      sourceUrl: resolved.sourceUrl,
      fileName: resolved.fileName,
      extractedChars: resolved.sourceText.length,
      facts,
      fake: completion.fake,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  retrieveRelevantBrandFacts(
    tenantId: string,
    brandId: string,
    query: string,
    topK: number = BRAND_FACT_TOP_K_CHUNKS,
    productLineId?: string | null,
  ): Promise<RetrievedBrandFactSnippet[]> {
    return this.factIndexRunner.retrieveRelevantBrandFacts(
      tenantId,
      brandId,
      query,
      topK,
      productLineId,
    );
  }

  private async assertProductLineBelongsToBrand(
    brandId: string,
    productLineId: string,
  ): Promise<void> {
    if (this.productLines) {
      await this.productLines.assertBelongsToBrand(brandId, productLineId);
      return;
    }
    const row = await this.prisma.scoped.brandProductLine.findFirst({
      where: { id: productLineId, brandId },
      select: { id: true },
    });
    if (!row) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所属产品线不存在或不属于当前品牌');
    }
  }

  private async assertAllProductLinesBelongToBrand(
    brandId: string,
    productLineIds: readonly string[],
  ): Promise<void> {
    if (this.productLines) {
      await this.productLines.assertAllBelongToBrand(brandId, productLineIds);
      return;
    }
    const rows = await this.prisma.scoped.brandProductLine.findMany({
      where: { brandId, id: { in: [...productLineIds] } },
      select: { id: true },
    });
    if (rows.length !== productLineIds.length) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '所属产品线不存在或不属于当前品牌');
    }
  }

  private async resolveExtractSource(input: FactExtractInput): Promise<{
    sourceType: FactSourceType;
    sourceUrl: string | null;
    fileName: string | null;
    sourceTitle: string;
    sourceText: string;
  }> {
    if (input.file) {
      return this.resolveUploadedFileSource(input.file);
    }

    if (input.url) {
      let page;
      try {
        page = await this.publicFetch.fetch(input.url);
      } catch (error) {
        if (error instanceof ProviderError) {
          if (error.kind === PROVIDER_KIND.SSRF) {
            throw new ApiError(400, API_ERROR.BAD_REQUEST, '目标地址不允许访问');
          }
          if (error.kind === PROVIDER_KIND.CONTRACT) {
            throw new ApiError(400, API_ERROR.BAD_REQUEST, error.message || '链接格式不正确');
          }
          throw new ApiError(
            422,
            API_ERROR.UPSTREAM_UNAVAILABLE,
            error.message || '无法抓取该网页，请改用粘贴文本或上传文档',
          );
        }
        throw new ApiError(
          422,
          API_ERROR.UPSTREAM_UNAVAILABLE,
          '网页抓取失败，请改用粘贴文本或上传文档',
        );
      }

      const extracted = extractPlainTextFromHtml(page.body);
      const text = extracted.text.slice(0, MAX_EXTRACT_SOURCE_CHARS).trim();
      if (text.replace(/\s+/g, '').length < 10) {
        throw new ApiError(
          422,
          API_ERROR.UPSTREAM_UNAVAILABLE,
          '网页未提取到足够的正文内容，请改用粘贴资料或上传文档',
        );
      }
      return {
        sourceType: 'URL_EXTRACT',
        sourceUrl: page.url || input.url,
        fileName: null,
        sourceTitle: extracted.title,
        sourceText: text,
      };
    }

    const pasted = (input.rawText ?? input.text ?? '').trim();
    if (pasted.length < 10) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '资料内容至少 10 字');
    }
    const sourceText = pasted.slice(0, MAX_EXTRACT_SOURCE_CHARS);
    return {
      sourceType: input.sourceType === 'DOC_UPLOAD' ? 'DOC_UPLOAD' : 'MANUAL',
      sourceUrl: null,
      fileName: input.fileName?.trim() || null,
      sourceTitle: '',
      sourceText,
    };
  }

  private resolveUploadedFileSource(file: {
    filename: string;
    mimetype?: string;
    buffer: Buffer;
  }): {
    sourceType: FactSourceType;
    sourceUrl: string | null;
    fileName: string;
    sourceTitle: string;
    sourceText: string;
  } {
    if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '上传的资料文件为空');
    }
    if (file.buffer.length > BRAND_FACT_EXTRACT_MAX_FILE_BYTES) {
      throw new ApiError(413, API_ERROR.BAD_REQUEST, '产品资料文件不能超过 10MB');
    }

    const fileName = file.filename.trim() || 'upload';
    const extMatch = /\.([a-z0-9]+)$/i.exec(fileName);
    const ext = extMatch?.[1]?.toLowerCase() ?? '';
    const mime = (file.mimetype ?? '').trim().toLowerCase();

    if (ext !== 'txt' && ext !== 'md' && ext !== 'pdf') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '仅支持上传 TXT、MD、PDF 格式的产品资料');
    }

    if (ext === 'pdf') {
      if (mime && (mime.startsWith('image/') || mime === 'text/html')) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '上传文件类型与 PDF 格式不匹配');
      }
      try {
        const extracted = extractTextFromPdf(file.buffer).slice(0, MAX_EXTRACT_SOURCE_CHARS).trim();
        return {
          sourceType: 'DOC_UPLOAD',
          sourceUrl: null,
          fileName,
          sourceTitle: fileName.replace(/\.pdf$/i, ''),
          sourceText: extracted,
        };
      } catch (error) {
        if (error instanceof PdfExtractError) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, error.message);
        }
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '无法解析该 PDF 文档');
      }
    }

    // .txt or .md: reject binary MIME and binary magic bytes
    if (
      mime &&
      (mime.startsWith('image/') ||
        mime === 'application/pdf' ||
        mime === 'application/zip' ||
        mime === 'application/x-msdownload')
    ) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '文本文件格式校验失败，请上传纯文本 TXT 或 MD',
      );
    }
    if (looksLikeBinaryBuffer(file.buffer)) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        '文件内容为二进制数据，并非有效的 TXT/MD 文档',
      );
    }

    const decoded = file.buffer
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .trim()
      .slice(0, MAX_EXTRACT_SOURCE_CHARS);

    if (decoded.replace(/\s+/g, '').length < 10) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '上传文档中的有效文字少于 10 字');
    }

    return {
      sourceType: 'DOC_UPLOAD',
      sourceUrl: null,
      fileName,
      sourceTitle: fileName.replace(/\.(?:txt|md)$/i, ''),
      sourceText: decoded,
    };
  }
}

function looksLikeBinaryBuffer(buf: Buffer): boolean {
  const sampleLen = Math.min(buf.length, 512);
  // Known binary magic headers: PNG, JPEG, GIF, ZIP, PDF, ELF, PE/MZ, WebP
  if (
    (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ||
    (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
    (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) ||
    (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) ||
    (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) ||
    (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) ||
    (buf[0] === 0x4d && buf[1] === 0x5a) ||
    (buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP')
  ) {
    return true;
  }
  for (let i = 0; i < sampleLen; i += 1) {
    if (buf[i] === 0x00) return true;
  }
  return false;
}

function parseLlmExtractedFacts(rawText: string): ExtractedBrandFactDraft[] {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripped);
  } catch {
    throw new ApiError(502, API_ERROR.UPSTREAM_UNAVAILABLE, 'AI 返回的事实卡结构解析失败，请重试');
  }

  const validated = llmExtractedFactsSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new ApiError(502, API_ERROR.UPSTREAM_UNAVAILABLE, 'AI 返回的事实卡字段不完整，请重试');
  }

  const bySlot = new Map<BrandFactCoreSlot, ExtractedBrandFactDraft>();
  for (const item of validated.data.facts) {
    if (bySlot.has(item.slot)) continue;
    bySlot.set(item.slot, {
      slot: item.slot,
      title: item.title?.trim() || BRAND_FACT_SLOT_LABELS[item.slot],
      content: item.content.trim(),
    });
  }

  return BRAND_FACT_CORE_SLOTS.map((slot) => {
    const found = bySlot.get(slot);
    return (
      found ?? {
        slot,
        title: BRAND_FACT_SLOT_LABELS[slot],
        content: '',
      }
    );
  });
}

const SLOT_MATCHERS: ReadonlyArray<{
  slot: BrandFactCoreSlot;
  headingRe: RegExp;
  lineRe: RegExp;
}> = [
  {
    slot: 'CREDENTIALS',
    headingRe: /资质|认证|背书|专利|奖项|荣誉|certif|credential|award|patent|compliance|soc\s*2/i,
    lineRe:
      /\b(?:ISO\d*|3C|CCC|CE|FCC|UL|SOC\s*2)\b|专利|认证|奖项|红点|Red Dot|发明|检测报告|国标|patent|certified|award|audited/i,
  },
  {
    slot: 'CASE_STUDIES',
    headingRe: /客户|案例|落地|实绩|场景|case\s*stud|customer|client|deploy/i,
    lineRe:
      /客户|案例|工作室|企业|家庭|部署|缩短|提升|增长|降低|服务\s*[\d,]+|agencies|customer|client|post-production|reduced|latency|saved/i,
  },
  {
    slot: 'DIFFERENTIATORS',
    headingRe: /差异|卖点|优势|亮点|特点|differentiator|advantage|why\s+|highlight|feature/i,
    lineRe:
      /免工具|离线|静音|降低|相比|优势|差异|独有|独家|零订阅|zero-subscription|tool-less|lower\s+power|vs\.?|compared|faster|quieter/i,
  },
  {
    slot: 'PRODUCT_SPECS',
    headingRe: /参数|规格|配置|型号|硬件|价格|spec|hardware|pricing|model|technical/i,
    lineRe:
      /\d[ \t]{0,2}(?:GB|TB|W|dB|dBA|GHz|MHz|GbE|SFP|盘位|核|元|mm|kg|mAh|Wh)|MSRP|\$\d|售价|处理器|内存|网口|功耗|噪音|DDR\d|NVMe|CPU/i,
  },
];

const EXPLICIT_HEADING_RE = /^\s*#+\s+/;
const BARE_BULLET_MARKER_RE = /^(?:[-*+•·▪▸]|\d+[.)、）])$/;
const BULLET_PREFIX_RE = /^\s*(?:[-*+•·▪▸]\s+|\d+[.)]\s+|\d+[、）]\s*)/;
const PLAIN_HEADING_PUNCT_RE = /[,，、。.!！?？;；:：]/;
const FACT_ACTION_VERB_RE =
  /^(?:通过|拥有|荣获|服务|获得|支持|采用|搭载|具备|实测|提供|部署|累计|超过|高达|内置|配备)|^(?:deployed|built|certified|trusted|served|supports|includes|powered|reduced|provides|offers)\b/i;

function isPlainSectionHeadingCandidate(clean: string): boolean {
  const maxLen = /[\u4e00-\u9fff]/.test(clean) ? 24 : 32;
  if (clean.length === 0 || clean.length > maxLen) return false;
  if (/\d/.test(clean)) return false;
  if (PLAIN_HEADING_PUNCT_RE.test(clean)) return false;
  if (FACT_ACTION_VERB_RE.test(clean)) return false;
  return true;
}

/**
 * 开发与 E2E 假模型模式下的确定性、基于原文的 4 槽位事实提炼：
 * 严格从 sourceText 真实切分并归类，不编造无关模板文案。
 */
export function extractDeterministicFactsFromSource(
  sourceText: string,
  brandName: string,
  sourceTitle: string,
): ExtractedBrandFactDraft[] {
  type ParsedLine = {
    text: string;
    isExplicitHeading: boolean;
    isBullet: boolean;
  };

  const parsedLines: ParsedLine[] = sourceText
    .replace(/\r\n/g, '\n')
    .split(/\n+/)
    .flatMap((rawLine): ParsedLine[] => {
      const trimmedRaw = rawLine.trim();
      if (!trimmedRaw) return [];

      if (EXPLICIT_HEADING_RE.test(trimmedRaw)) {
        const cleanHeading = trimmedRaw.replace(EXPLICIT_HEADING_RE, '').trim();
        return cleanHeading
          ? [{ text: cleanHeading, isExplicitHeading: true, isBullet: false }]
          : [];
      }

      if (BARE_BULLET_MARKER_RE.test(trimmedRaw)) return [];

      const isBullet = BULLET_PREFIX_RE.test(trimmedRaw);
      const body = isBullet ? trimmedRaw.replace(BULLET_PREFIX_RE, '').trim() : trimmedRaw;
      if (!body) return [];

      if (body.length > 220) {
        return body
          .split(/(?<=[。！？；])\s*|(?<=[.!?;])(?:\s+|$)/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 4)
          .map((text) => ({ text, isExplicitHeading: false, isBullet }));
      }
      return [{ text: body, isExplicitHeading: false, isBullet }];
    });

  const buckets: Record<BrandFactCoreSlot, string[]> = {
    PRODUCT_SPECS: [],
    DIFFERENTIATORS: [],
    CREDENTIALS: [],
    CASE_STUDIES: [],
  };

  let activeSection: BrandFactCoreSlot | null = null;
  const unmatched: string[] = [];
  const contentLines: string[] = [];

  for (const item of parsedLines) {
    const clean = item.text;
    if (!clean) continue;

    if (item.isExplicitHeading) {
      const headingHit = SLOT_MATCHERS.find((m) => m.headingRe.test(clean));
      if (headingHit) {
        activeSection = headingHit.slot;
      }
      continue;
    }

    if (!item.isBullet && isPlainSectionHeadingCandidate(clean)) {
      const headingHit = SLOT_MATCHERS.find((m) => m.headingRe.test(clean));
      if (headingHit && headingHit.slot !== activeSection) {
        activeSection = headingHit.slot;
        continue;
      }
    }

    contentLines.push(clean);

    let assigned: BrandFactCoreSlot | null = activeSection;
    if (!assigned) {
      for (const matcher of SLOT_MATCHERS) {
        if (matcher.lineRe.test(clean)) {
          assigned = matcher.slot;
          break;
        }
      }
    }

    if (assigned) {
      if (buckets[assigned].length < 6 && !buckets[assigned].includes(clean)) {
        buckets[assigned].push(clean);
      }
    } else {
      unmatched.push(clean);
    }
  }

  // Distribute remaining non-heading content lines into any empty slots so all 4 slots are grounded in sourceText
  const fallbackSeen = new Set<string>();
  const fallbackPool: string[] = [];
  for (const line of [...unmatched, ...contentLines]) {
    if (!fallbackSeen.has(line)) {
      fallbackSeen.add(line);
      fallbackPool.push(line);
    }
  }
  let poolCursor = 0;

  return BRAND_FACT_CORE_SLOTS.map((slot) => {
    const collected = buckets[slot];
    let content = collected.slice(0, 6).join('\n').trim();
    if (!content && fallbackPool.length > 0) {
      const slice = fallbackPool.slice(poolCursor, poolCursor + 2);
      poolCursor = (poolCursor + 2) % fallbackPool.length;
      content = slice.join('\n').trim();
    }
    const defaultLabel = BRAND_FACT_SLOT_LABELS[slot];
    const title =
      slot === 'PRODUCT_SPECS' && sourceTitle
        ? `${sourceTitle.slice(0, 48)} · ${defaultLabel}`.slice(0, 120)
        : `${brandName} · ${defaultLabel}`.slice(0, 120);

    return {
      slot,
      title,
      content: content.slice(0, BRAND_FACT_CARD_MAX),
    };
  });
}

function presentFact(row: BrandFactRow): BrandFactRecord {
  const slot: BrandFactSlot = (BRAND_FACT_SLOTS as readonly string[]).includes(row.slot)
    ? (row.slot as BrandFactSlot)
    : 'EXTRA_DOC';
  const sourceType: FactSourceType =
    row.sourceType === 'URL_EXTRACT' ||
    row.sourceType === 'DOC_UPLOAD' ||
    row.sourceType === 'STUDIO_FEEDBACK'
      ? row.sourceType
      : 'MANUAL';
  const indexStatus: FactIndexStatus =
    row.indexStatus === 'INDEXING' || row.indexStatus === 'READY' || row.indexStatus === 'FAILED'
      ? row.indexStatus
      : 'NONE';

  return {
    id: row.id,
    brandId: row.brandId,
    productLineId: row.productLineId ?? null,
    slot,
    title: row.title,
    content: row.content,
    sourceType,
    sourceUrl: row.sourceUrl,
    indexStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function buildFactsResponse(
  brandId: string,
  truthAgreementSignedAt: Date | null,
  rows: readonly BrandFactRow[],
): BrandFactsResponse {
  const items = rows.map(presentFact).sort((a, b) => {
    const slotDiff = SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot];
    if (slotDiff !== 0) return slotDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const totalChars = items.reduce((sum, item) => sum + item.content.length, 0);
  const maxSingleChars = items.reduce((max, item) => Math.max(max, item.content.length), 0);
  const vectorIndexRequired =
    requiresBrandFactVectorIndex(totalChars) || requiresBrandFactVectorIndex(maxSingleChars);
  const vectorIndexed = items.some((item) => item.indexStatus === 'READY');

  return {
    brandId,
    truthAgreementSignedAt: truthAgreementSignedAt ? truthAgreementSignedAt.toISOString() : null,
    totalChars,
    vectorIndexRequired,
    vectorIndexed,
    items,
  };
}
