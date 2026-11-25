import { z } from 'zod';
import type { GeoMarket } from './brands';
import {
  L2_EXTENSION_PROVIDERS,
  isSafeDistributionHttpUrl,
  type DistributionTaskStatus,
  type L2ExtensionProvider,
} from './distribution';

/**
 * GeoMix v2.2 国内 L2 Chrome 扩展桥接协议契约（Bridge v1，Issue #367 / #371）：
 * - 主仓与伴生仓库 `yexiu700/geomix-extension` 共享口径
 * - 最小权限 `gmext_` Token（SHA-256 哈希落库、仅创建时展示一次）
 * - 3 个薄桥接端点（/me、/tasks、/tasks/:taskId/confirm-published）DTO 与输入校验
 */

export const EXTENSION_BRIDGE_VERSION = 'v1' as const;
export const EXTENSION_TOKEN_PREFIX = 'gmext_' as const;
export const EXTENSION_DEFAULT_TTL_DAYS = 90 as const;
export const EXTENSION_MAX_TTL_DAYS = 365 as const;
export const EXTENSION_DEFAULT_SCOPES = ['extension:distribution'] as const;

export const createExtensionTokenSchema = z.object({
  label: z.string().trim().min(1, '请填写设备或浏览器备注名称').max(64, '备注名称最多 64 字符'),
  ttlDays: z
    .number()
    .int()
    .min(1, '有效期至少 1 天')
    .max(EXTENSION_MAX_TTL_DAYS, `有效期最多 ${EXTENSION_MAX_TTL_DAYS} 天`)
    .optional()
    .default(EXTENSION_DEFAULT_TTL_DAYS),
});
export type CreateExtensionTokenInput = z.input<typeof createExtensionTokenSchema>;
export type ParsedCreateExtensionTokenInput = z.output<typeof createExtensionTokenSchema>;

/** 绝不包含明文 Token 或 tokenHash。 */
export type ExtensionTokenDto = {
  id: string;
  label: string;
  tokenPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};

/** 仅在创建成功当次返回一次 plainToken。 */
export type CreateExtensionTokenResponseDto = {
  token: ExtensionTokenDto;
  plainToken: string;
};

export type ExtensionMeBrandDto = {
  id: string;
  name: string;
  localBrandName: string;
  category: string;
  market: GeoMarket;
};

export type ExtensionMeDto = {
  bridgeVersion: typeof EXTENSION_BRIDGE_VERSION;
  userDisplayName: string;
  tokenLabel: string;
  tokenPrefix: string;
  expiresAt: string;
  brands: ExtensionMeBrandDto[];
};

export const EXTENSION_TASK_FILTER_STATUSES = [
  'DRAFT_VARIANT',
  'READY_TO_PUBLISH',
  'DRAFT_PUSHED',
  'PUBLISHED',
] as const;
export type ExtensionTaskFilterStatus = (typeof EXTENSION_TASK_FILTER_STATUSES)[number];

const extensionTaskFilterStatusEnum = z.enum(EXTENSION_TASK_FILTER_STATUSES);

const extensionTasksStatusFilterSchema = z.preprocess(
  (raw) => {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'string') return raw;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return '';
    if (!trimmed.includes(',')) return trimmed;
    const parts = trimmed.split(',').map((part) => part.trim());
    if (parts.some((part) => part.length === 0)) {
      return parts;
    }
    const unique = Array.from(new Set(parts));
    return unique.length === 1 ? unique[0] : unique;
  },
  z
    .union([extensionTaskFilterStatusEnum, z.array(extensionTaskFilterStatusEnum).min(1)])
    .optional(),
);

export const extensionTasksQuerySchema = z.object({
  brandId: z.string().trim().min(1).max(64).optional(),
  provider: z.enum(L2_EXTENSION_PROVIDERS).optional(),
  status: extensionTasksStatusFilterSchema,
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});
export type ExtensionTasksQueryInput = z.input<typeof extensionTasksQuerySchema>;
export type ParsedExtensionTasksQueryInput = z.output<typeof extensionTasksQuerySchema>;

export type ExtensionPendingTaskMediaDto = {
  id: string;
  title: string;
  url: string;
  mime?: string | null;
};

export type ExtensionPendingTaskDto = {
  taskId: string;
  brandId: string;
  brandName: string;
  articleId: string;
  provider: L2ExtensionProvider;
  channelLabel: string;
  status: DistributionTaskStatus;
  variantTitle: string;
  variantMarkdown: string;
  variantHtml: string;
  targetUrlHint: string | null;
  mediaAssets: ExtensionPendingTaskMediaDto[];
  antiBanChecklist: string[];
  remotePublishedUrl: string | null;
  updatedAt: string;
};

export type ExtensionPendingTasksResponseDto = {
  bridgeVersion: typeof EXTENSION_BRIDGE_VERSION;
  items: ExtensionPendingTaskDto[];
};

export const extensionConfirmPublishedSchema = z.object({
  publishedUrl: z
    .string()
    .trim()
    .min(1, '请回传文章公网链接')
    .max(2048, '链接长度不能超过 2048 字符')
    .refine(isSafeDistributionHttpUrl, '仅支持有效的 http:// 或 https:// 公网文章链接'),
  note: z.string().trim().max(300).optional(),
});
export type ExtensionConfirmPublishedInput = z.infer<typeof extensionConfirmPublishedSchema>;

export type ExtensionConfirmPublishedResultDto = {
  accepted: boolean;
  taskId: string;
  publishRecordId: string;
  publishedUrl: string;
  status: DistributionTaskStatus;
  alreadyRecorded: boolean;
  retestScheduledCount: number;
};
