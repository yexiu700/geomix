import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  API_ERROR,
  AUTH_ERROR,
  isL1ChannelProvider,
  isSafeDistributionHttpUrl,
  isSupportedLocale,
  supportedLocalesForMarket,
  type ChannelConnectionConfig,
  type ChannelConnectionDto,
  type ChannelConnectionStatus,
  type ChannelConnectionTestResultDto,
  type ChannelProvider,
  type CreateChannelConnectionInput,
  type GeoMarket,
  type L1ChannelProvider,
  type SupportedLocale,
  type TestChannelConnectionInput,
  type UpdateChannelConnectionInput,
} from '@geomix/shared';
import { type BillingTx, TX_OPTIONS } from '../billing/billing.sql';
import { QuotaService } from '../billing/quota.service';
import { ApiError } from '../common/api-error';
import { SecretBox, SecretBoxError, type EncryptedEnvelope } from '../common/secret-box';
import { OutboundHttpClient } from '../infra/outbound-http';
import { PROVIDER_KIND, ProviderError } from '../infra/provider-error';
import { UrlPolicyError } from '../infra/ssrf';
import { PrismaService } from '../prisma/prisma.service';
import {
  CmsConnectorRegistry,
  collectSecretCandidates,
  ConnectorError,
  redactSecrets,
  type ConnectorConnectionContext,
  type ConnectorSecrets,
} from './connectors';

export type ChannelConnectionRow = {
  id: string;
  brandId: string;
  brandMarketId: string;
  provider: string;
  displayName: string;
  siteBaseUrl: string;
  credentialsCiphertext: string;
  credentialsIv: string;
  credentialsTag: string;
  keyVersion: number;
  credentialHint: string;
  configJson: Prisma.JsonValue;
  status: string;
  authType: string;
  targetLocale?: string | null;
  externalShopDomain?: string | null;
  lastTestedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  brandMarket?: { market: string } | null;
};

type EncryptedRowSlice = {
  credentialsCiphertext: string;
  credentialsIv: string;
  credentialsTag: string;
  keyVersion: number;
};

function normalizeConfigRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  return { ...(raw as Record<string, unknown>) };
}

function mergeDefinedConfig(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

export function presentConnection(
  row: ChannelConnectionRow,
  fallbackMarket?: GeoMarket,
): ChannelConnectionDto {
  const market = (row.brandMarket?.market ?? fallbackMarket ?? 'GLOBAL') as GeoMarket;
  return {
    id: row.id,
    brandId: row.brandId,
    brandMarketId: row.brandMarketId,
    market,
    provider: row.provider as ChannelProvider,
    displayName: row.displayName,
    siteBaseUrl: row.siteBaseUrl,
    credentialHint: row.credentialHint,
    configJson: normalizeConfigRecord(row.configJson),
    status: row.status as ChannelConnectionStatus,
    authType: row.authType,
    targetLocale: isSupportedLocale(row.targetLocale) ? row.targetLocale : null,
    externalShopDomain: row.externalShopDomain ?? null,
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(SecretBox) private readonly secretBox: SecretBox,
    @Inject(OutboundHttpClient) private readonly outboundHttp: OutboundHttpClient,
    @Inject(CmsConnectorRegistry) private readonly connectors: CmsConnectorRegistry,
  ) {}

  async list(brandId: string, market?: GeoMarket): Promise<{ items: ChannelConnectionDto[] }> {
    const brand = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      include: { markets: true },
    });
    if (!brand) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }

    let brandMarketId: string | undefined;
    if (market) {
      const targetMarket = brand.markets.find((m) => m.market === market);
      if (!targetMarket) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '该品牌尚未开启目标市场');
      }
      brandMarketId = targetMarket.id;
    }

    const rows = await this.prisma.scoped.channelConnection.findMany({
      where: {
        brandId,
        ...(brandMarketId ? { brandMarketId } : {}),
      },
      include: { brandMarket: { select: { market: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return {
      items: rows.map((row) => presentConnection(row, market)),
    };
  }

  async create(
    tenantId: string,
    brandId: string,
    input: CreateChannelConnectionInput,
  ): Promise<ChannelConnectionDto> {
    const brand = await this.prisma.scoped.brand.findFirst({
      where: { id: brandId },
      include: { markets: true },
    });
    if (!brand) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '品牌不存在');
    }

    const brandMarket = brand.markets.find((m) => m.market === input.market);
    if (!brandMarket) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '该品牌尚未开启目标市场');
    }

    const siteBaseUrl = input.siteBaseUrl.trim();
    await this.assertSafeSiteUrl(siteBaseUrl);
    await this.assertSafeOptionalApiBaseUrl(input.configJson);
    const targetLocale = this.validateTargetLocaleForMarket(input.targetLocale, input.market);

    if (
      input.provider === 'SHOPIFY' &&
      Object.prototype.hasOwnProperty.call(input.credentials, 'oauthAccessToken')
    ) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        'Shopify OAuth 令牌只能通过「重新授权」完成 OAuth 流程写入，手动更新请填写 accessToken',
      );
    }

    const trimmedCredentials = this.trimCredentials(input.credentials);
    this.validateProviderCredentials(input.provider, trimmedCredentials);

    const envelope = this.encryptCredentials(trimmedCredentials);
    const credentialHint = this.buildCredentialHint(input.provider, trimmedCredentials);
    const configJson = normalizeConfigRecord(input.configJson);

    const created = await this.prisma.scoped.$transaction(async (tx) => {
      await this.quota.consume(tenantId, 'SOCIAL_AUTH', 1, tx as unknown as BillingTx);
      return tx.channelConnection.create({
        data: {
          tenantId,
          brandId,
          brandMarketId: brandMarket.id,
          provider: input.provider,
          displayName: input.displayName.trim(),
          siteBaseUrl,
          credentialsCiphertext: envelope.ciphertext,
          credentialsIv: envelope.iv,
          credentialsTag: envelope.tag,
          keyVersion: envelope.keyVersion,
          credentialHint,
          configJson: configJson as Prisma.InputJsonValue,
          status: 'ACTIVE',
          authType: input.authType ?? 'API_KEY',
          targetLocale,
          externalShopDomain: null,
        },
        include: { brandMarket: { select: { market: true } } },
      });
    }, TX_OPTIONS);

    return presentConnection(created, input.market);
  }

  async update(
    brandId: string,
    connectionId: string,
    input: UpdateChannelConnectionInput,
  ): Promise<ChannelConnectionDto> {
    const existing = await this.prisma.scoped.channelConnection.findFirst({
      where: { id: connectionId, brandId },
      include: { brandMarket: { select: { market: true } } },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '渠道连接不存在');
    }

    if (!isL1ChannelProvider(existing.provider)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '不支持更新非 L1 渠道连接');
    }

    const updateData: Prisma.ChannelConnectionUpdateInput = {};

    if (input.displayName !== undefined) {
      updateData.displayName = input.displayName.trim();
    }

    if (input.siteBaseUrl !== undefined) {
      const nextSiteUrl = input.siteBaseUrl.trim();
      await this.assertSafeSiteUrl(nextSiteUrl);
      updateData.siteBaseUrl = nextSiteUrl;
    }

    if (input.configJson !== undefined) {
      await this.assertSafeOptionalApiBaseUrl(input.configJson);
      const mergedConfig = mergeDefinedConfig(
        normalizeConfigRecord(existing.configJson),
        normalizeConfigRecord(input.configJson),
      );
      updateData.configJson = mergedConfig as Prisma.InputJsonValue;
    }

    if (input.targetLocale !== undefined) {
      const market = (existing.brandMarket?.market === 'CN' ? 'CN' : 'GLOBAL') as GeoMarket;
      updateData.targetLocale = this.validateTargetLocaleForMarket(input.targetLocale, market);
    }

    let hasNewCredentials = false;
    if (input.credentials !== undefined) {
      if (
        existing.provider === 'SHOPIFY' &&
        Object.prototype.hasOwnProperty.call(input.credentials, 'oauthAccessToken')
      ) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          'Shopify OAuth 令牌只能通过「重新授权」完成 OAuth 流程写入，手动更新请填写 accessToken',
        );
      }
      const nonBlankPatch = this.extractNonBlankCredentials(input.credentials);
      if (Object.keys(nonBlankPatch).length > 0) {
        let baseCredentials: ConnectorSecrets = {};
        try {
          baseCredentials = this.decryptCredentials(existing);
        } catch (error) {
          if (error instanceof SecretBoxError) {
            if (error.code === 'MISSING_KEY' || error.code === 'INVALID_KEY') {
              throw new ApiError(503, API_ERROR.UPSTREAM_UNAVAILABLE, error.message);
            }
            // 旧密文损坏时允许通过全量凭据旋转覆盖
            baseCredentials = {};
          } else {
            throw error;
          }
        }

        const mergedCredentials: ConnectorSecrets = {
          ...baseCredentials,
          ...nonBlankPatch,
        };
        if (existing.provider === 'SHOPIFY' && nonBlankPatch.accessToken) {
          delete mergedCredentials.oauthAccessToken;
          updateData.authType = 'API_KEY';
          updateData.oauthAccessTokenCiphertext = null;
          updateData.oauthExpiresAt = null;
          updateData.externalShopDomain = null;
        }
        this.validateProviderCredentials(existing.provider, mergedCredentials);
        const envelope = this.encryptCredentials(mergedCredentials);
        updateData.credentialsCiphertext = envelope.ciphertext;
        updateData.credentialsIv = envelope.iv;
        updateData.credentialsTag = envelope.tag;
        updateData.keyVersion = envelope.keyVersion;
        updateData.credentialHint = this.buildCredentialHint(existing.provider, mergedCredentials);
        hasNewCredentials = true;
      }
    }

    if (input.status !== undefined) {
      if (input.status === 'ACTIVE' && !hasNewCredentials) {
        const hasStoredCredentials =
          Boolean(existing.credentialsCiphertext?.trim()) &&
          Boolean(existing.credentialsIv?.trim()) &&
          Boolean(existing.credentialsTag?.trim());
        if (!hasStoredCredentials) {
          const message =
            existing.provider === 'SHOPIFY' && existing.authType === 'OAUTH'
              ? '该 Shopify OAuth 连接授权凭据已清除或失效，无法直接重新启用，请点击「重新授权」完成 OAuth 授权'
              : '该渠道连接缺少有效凭据，请先更新凭据后再重新启用';
          throw new ApiError(400, API_ERROR.BAD_REQUEST, message);
        }
      }
      updateData.status = input.status;
    }

    const updated = await this.prisma.scoped.channelConnection.update({
      where: { id: existing.id },
      data: updateData,
      include: { brandMarket: { select: { market: true } } },
    });

    return presentConnection(updated);
  }

  async remove(
    tenantId: string,
    brandId: string,
    connectionId: string,
  ): Promise<{ deleted: 1; id: string }> {
    await this.prisma.scoped.$transaction(async (tx) => {
      const deleted = await tx.channelConnection.deleteMany({
        where: { id: connectionId, brandId },
      });
      if (deleted.count !== 1) {
        throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '渠道连接不存在');
      }
      await this.quota.release(tenantId, 'SOCIAL_AUTH', 1, tx as unknown as BillingTx);
    }, TX_OPTIONS);

    return { deleted: 1, id: connectionId };
  }

  async test(
    brandId: string,
    connectionId: string,
    input?: TestChannelConnectionInput,
  ): Promise<ChannelConnectionTestResultDto> {
    const existing = await this.prisma.scoped.channelConnection.findFirst({
      where: { id: connectionId, brandId },
      include: { brandMarket: { select: { market: true } } },
    });
    if (!existing) {
      throw new ApiError(404, AUTH_ERROR.NOT_FOUND, '渠道连接不存在');
    }

    if (!isL1ChannelProvider(existing.provider)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '仅 L1 API 渠道支持连通性测试');
    }

    const now = new Date();
    if (existing.status === 'DISABLED' && !existing.credentialsCiphertext) {
      return {
        ok: false,
        status: 'DISABLED',
        message: '该连接已停用或已卸载，请重新授权或更新凭据',
        testedAt: now.toISOString(),
      };
    }

    let credentials: ConnectorSecrets;
    try {
      credentials = this.decryptCredentials(existing);
    } catch (error) {
      if (error instanceof SecretBoxError) {
        if (error.code === 'MISSING_KEY' || error.code === 'INVALID_KEY') {
          throw new ApiError(503, API_ERROR.UPSTREAM_UNAVAILABLE, error.message);
        }
        const safeMsg = this.sanitizeConnectionError(error.message);
        await this.prisma.scoped.channelConnection.update({
          where: { id: existing.id },
          data: {
            status: 'INVALID',
            lastTestedAt: now,
            lastError: safeMsg,
          },
        });
        return {
          ok: false,
          status: 'INVALID',
          message: safeMsg,
          testedAt: now.toISOString(),
        };
      }
      throw error;
    }

    const configRecord = normalizeConfigRecord(existing.configJson);

    // 防止创建后 DNS 重绑定绕过 SSRF 保护
    try {
      await this.outboundHttp.assertAllowedUrl(existing.siteBaseUrl);
      const rawApiBase = configRecord.apiBaseUrl;
      if (typeof rawApiBase === 'string' && rawApiBase.trim()) {
        await this.outboundHttp.assertAllowedUrl(rawApiBase.trim());
      }
    } catch (error) {
      const rawMsg =
        error instanceof UrlPolicyError ||
        (error instanceof ProviderError && error.kind === PROVIDER_KIND.SSRF)
          ? '站点地址不允许访问（已触发 SSRF 安全拦截）'
          : '站点域名解析失败，请检查站点地址';
      const safeMsg = this.sanitizeConnectionError(rawMsg, credentials);
      await this.prisma.scoped.channelConnection.update({
        where: { id: existing.id },
        data: {
          status: 'INVALID',
          lastTestedAt: now,
          lastError: safeMsg,
        },
      });
      return {
        ok: false,
        status: 'INVALID',
        message: safeMsg,
        testedAt: now.toISOString(),
      };
    }

    const connector = this.connectors.get(existing.provider);
    const context: ConnectorConnectionContext = {
      id: existing.id,
      provider: existing.provider,
      displayName: existing.displayName,
      siteBaseUrl: existing.siteBaseUrl,
      configJson: configRecord as ChannelConnectionConfig,
      authType: existing.authType,
      targetLocale: existing.targetLocale ?? null,
      externalShopDomain: existing.externalShopDomain ?? null,
    };

    try {
      const result = await connector.testConnection(context, credentials, input);
      const backfilledConfig = { ...configRecord };
      let configChanged = false;
      const discovered = result.discoveredConfig;
      if (discovered) {
        for (const key of [
          'primaryDomain',
          'publicationId',
          'branch',
          'repoOwner',
          'repoName',
        ] as const) {
          const val = discovered[key];
          if (typeof val === 'string' && val.trim() && !backfilledConfig[key]) {
            backfilledConfig[key] = val.trim();
            configChanged = true;
          }
        }
      }
      const nextConfig = configChanged ? (backfilledConfig as Prisma.InputJsonValue) : undefined;

      await this.prisma.scoped.channelConnection.update({
        where: { id: existing.id },
        data: {
          status: 'ACTIVE',
          lastTestedAt: now,
          lastError: null,
          ...(nextConfig ? { configJson: nextConfig } : {}),
        },
      });

      return {
        ok: true,
        status: 'ACTIVE',
        message: this.sanitizeConnectionError(result.message, credentials, configRecord),
        testedAt: now.toISOString(),
        targets: result.targets,
      };
    } catch (error) {
      const rawMessage =
        error instanceof ConnectorError
          ? error.message
          : error instanceof Error
            ? error.message
            : '渠道连接测试失败';
      const safeMsg = this.sanitizeConnectionError(rawMessage, credentials, configRecord);

      await this.prisma.scoped.channelConnection.update({
        where: { id: existing.id },
        data: {
          status: 'INVALID',
          lastTestedAt: now,
          lastError: safeMsg,
        },
      });

      return {
        ok: false,
        status: 'INVALID',
        message: safeMsg,
        testedAt: now.toISOString(),
      };
    }
  }

  /**
   * 供 M5 DistributionRunner 复用的安全解密方法。
   */
  decryptCredentials(row: EncryptedRowSlice): ConnectorSecrets {
    const raw = this.secretBox.decryptJson<unknown>({
      ciphertext: row.credentialsCiphertext,
      iv: row.credentialsIv,
      tag: row.credentialsTag,
      keyVersion: row.keyVersion,
    });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SecretBoxError('INVALID_ENVELOPE', '渠道凭据内容格式异常');
    }
    const result: ConnectorSecrets = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * 供本服务及 M5 DistributionRunner 复用的错误信息脱敏方法。
   */
  sanitizeConnectionError(
    rawMessage: string,
    credentials?: ConnectorSecrets,
    configJson?: Record<string, unknown> | null,
  ): string {
    const candidates =
      credentials || configJson ? collectSecretCandidates(credentials ?? {}, configJson) : [];
    const cleaned = redactSecrets(rawMessage, candidates, 500);
    return cleaned || '渠道连接异常';
  }

  private async assertSafeSiteUrl(url: string): Promise<URL> {
    if (!isSafeDistributionHttpUrl(url)) {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '请输入有效的 http:// 或 https:// 站点地址');
    }
    try {
      return await this.outboundHttp.assertAllowedUrl(url);
    } catch (error) {
      if (
        error instanceof UrlPolicyError ||
        (error instanceof ProviderError && error.kind === PROVIDER_KIND.SSRF)
      ) {
        throw new ApiError(
          400,
          API_ERROR.BAD_REQUEST,
          '站点地址不允许访问（禁止内网、回环或保留地址）',
        );
      }
      if (error instanceof ProviderError && error.kind === PROVIDER_KIND.UPSTREAM) {
        throw new ApiError(400, API_ERROR.BAD_REQUEST, '站点域名解析失败，请检查站点地址');
      }
      throw error;
    }
  }

  private async assertSafeOptionalApiBaseUrl(configJson: unknown): Promise<void> {
    if (!configJson || typeof configJson !== 'object' || Array.isArray(configJson)) return;
    const rawApiBase = (configJson as Record<string, unknown>).apiBaseUrl;
    if (rawApiBase === undefined || rawApiBase === null || rawApiBase === '') return;
    if (typeof rawApiBase !== 'string') {
      throw new ApiError(400, API_ERROR.BAD_REQUEST, '自定义 API 地址格式不正确');
    }
    const trimmed = rawApiBase.trim();
    if (!trimmed) return;
    await this.assertSafeSiteUrl(trimmed);
  }

  private encryptCredentials(credentials: ConnectorSecrets): EncryptedEnvelope {
    try {
      return this.secretBox.encryptJson(credentials);
    } catch (error) {
      if (
        error instanceof SecretBoxError &&
        (error.code === 'MISSING_KEY' || error.code === 'INVALID_KEY')
      ) {
        throw new ApiError(503, API_ERROR.UPSTREAM_UNAVAILABLE, error.message);
      }
      throw error;
    }
  }

  private trimCredentials(raw: Record<string, string>): ConnectorSecrets {
    const out: ConnectorSecrets = {};
    for (const [key, value] of Object.entries(raw)) {
      out[key] = value.trim();
    }
    return out;
  }

  private extractNonBlankCredentials(raw: Record<string, string>): ConnectorSecrets {
    const out: ConnectorSecrets = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        out[key] = trimmed;
      }
    }
    return out;
  }

  private validateTargetLocaleForMarket(
    rawLocale: SupportedLocale | null | undefined,
    market: GeoMarket,
  ): SupportedLocale | null {
    if (rawLocale === undefined || rawLocale === null) {
      return null;
    }
    const allowed = supportedLocalesForMarket(market);
    if (!allowed.includes(rawLocale)) {
      throw new ApiError(
        400,
        API_ERROR.BAD_REQUEST,
        `目标语种 ${rawLocale} 与当前市场（${market}）不匹配`,
      );
    }
    return rawLocale;
  }

  private validateProviderCredentials(
    provider: L1ChannelProvider,
    credentials: ConnectorSecrets,
  ): void {
    switch (provider) {
      case 'SHOPIFY': {
        if (!credentials.accessToken?.trim() && !credentials.oauthAccessToken?.trim()) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, '请填写 Shopify Admin API Access Token');
        }
        break;
      }
      case 'WORDPRESS': {
        if (!credentials.username?.trim()) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, '请填写 WordPress 用户名');
        }
        if (!credentials.appPassword?.trim()) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, '请填写 WordPress Application Password');
        }
        break;
      }
      case 'WEBFLOW': {
        if (!credentials.apiToken?.trim()) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, '请填写 Webflow API Token');
        }
        break;
      }
      case 'WEBHOOK': {
        const secret = credentials.signingSecret?.trim() ?? '';
        if (secret.length < 8) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, 'Webhook 签名密钥长度至少为 8 位');
        }
        break;
      }
      case 'GHOST': {
        const key = credentials.adminApiKey?.trim() ?? '';
        if (!/^[^:\s]+:(?:[0-9a-fA-F]{2}){8,}$/.test(key)) {
          throw new ApiError(
            400,
            API_ERROR.BAD_REQUEST,
            '请填写有效的 Ghost Admin API Key（格式为 id:hex_secret）',
          );
        }
        break;
      }
      case 'DEVTO': {
        if (!credentials.apiKey?.trim()) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, '请填写 Dev.to API Key');
        }
        break;
      }
      case 'HASHNODE': {
        if (!credentials.apiToken?.trim()) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, '请填写 Hashnode Personal Access Token');
        }
        break;
      }
      case 'GITHUB_MDX': {
        if (!credentials.token?.trim()) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, '请填写 GitHub Personal Access Token');
        }
        break;
      }
      case 'WECHAT_OFFICIAL': {
        if (!credentials.appId?.trim()) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, '请填写微信公众号 AppID');
        }
        if (!credentials.appSecret?.trim()) {
          throw new ApiError(400, API_ERROR.BAD_REQUEST, '请填写微信公众号 AppSecret');
        }
        break;
      }
    }
  }

  private buildCredentialHint(provider: L1ChannelProvider, credentials: ConnectorSecrets): string {
    let primarySecret = '';
    switch (provider) {
      case 'SHOPIFY':
        primarySecret = credentials.accessToken ?? credentials.oauthAccessToken ?? '';
        break;
      case 'WORDPRESS':
        primarySecret = credentials.appPassword ?? credentials.applicationPassword ?? '';
        break;
      case 'WEBFLOW':
        primarySecret = credentials.apiToken ?? '';
        break;
      case 'WEBHOOK':
        primarySecret = credentials.signingSecret ?? '';
        break;
      case 'GHOST':
        primarySecret = credentials.adminApiKey ?? '';
        break;
      case 'DEVTO':
        primarySecret = credentials.apiKey ?? '';
        break;
      case 'HASHNODE':
        primarySecret = credentials.apiToken ?? '';
        break;
      case 'GITHUB_MDX':
        primarySecret = credentials.token ?? '';
        break;
      case 'WECHAT_OFFICIAL':
        primarySecret = credentials.appSecret ?? credentials.appId ?? '';
        break;
    }
    return this.secretBox.maskSecret(primarySecret) || '****';
  }
}
