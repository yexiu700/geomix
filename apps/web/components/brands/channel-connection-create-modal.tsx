'use client';

import {
  CHANNEL_PROVIDER_LABELS,
  GEO_MARKET_LABELS,
  L1_CHANNEL_PROVIDERS,
  SUPPORTED_LOCALES,
  isSafeDistributionHttpUrl,
  supportedLocalesForMarket,
  type ChannelConnectionConfig,
  type ChannelConnectionDto,
  type ChannelConnectionTestResultDto,
  type ChannelRemoteTargetDto,
  type GeoMarket,
  type L1ChannelProvider,
  type SupportedLocale,
  type UpdateChannelConnectionInput,
} from '@geomix/shared';
import { Alert, Button, Input, Modal, Select, Space, Switch, Tabs } from 'antd';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChannelConnection,
  startShopifyOAuth,
  testChannelConnection,
  updateChannelConnection,
} from '../../lib/distribution';
import { GatewayApiError } from '../../lib/envelope';
import { copyTextToClipboard } from '../../lib/studio';
import { useUxFeedback } from '../crud/ux-feedback';
import { FormField } from '../ui';

export type ChannelConnectionCreateModalProps = {
  open: boolean;
  brandId: string;
  activeMarket: GeoMarket;
  readOnly: boolean;
  supportedLocales?: readonly SupportedLocale[];
  editingConn?: ChannelConnectionDto | null;
  initialShopifyAuthMode?: 'oauth' | 'custom';
  onOAuthRedirect?: (authorizeUrl: string) => void;
  onClose: () => void;
  onSaved: (conn: ChannelConnectionDto, mode: 'create' | 'update') => void;
  onTested?: (connId: string, result: ChannelConnectionTestResultDto) => void;
};

type WebflowFieldOption = {
  id: string;
  slug: string;
  displayName: string;
  type?: string;
  isRequired?: boolean;
};

type WebflowFieldMapDraft = {
  title: string;
  slug: string;
  bodyHtml: string;
  metaDesc: string;
  jsonLd: string;
};

const EMPTY_WEBFLOW_FIELD_MAP: WebflowFieldMapDraft = {
  title: '',
  slug: '',
  bodyHtml: '',
  metaDesc: '',
  jsonLd: '',
};

const GHOST_ADMIN_API_KEY_PATTERN = /^[^:\s]+:(?:[0-9a-fA-F]{2}){8,}$/;

export const WECHAT_DRAFT_ONLY_NOTICE =
  '仅推送至公众号草稿箱，绝不自动群发；请推送后前往微信公众平台后台人工复核并发布。';
export const WECHAT_IP_WHITELIST_NOTICE =
  '需提前将服务器出口 IP 加入微信公众平台「设置与开发 → 基本配置 → IP 白名单」，否则接口将返回错误码 40164 拦截。';

export function formatConnError(err: unknown, fallback: string): string {
  if (err instanceof GatewayApiError) {
    return err.message || fallback;
  }
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return fallback;
}

export function hasWechatIpWhitelistError(message: string | null | undefined): boolean {
  return Boolean(message && message.includes('40164'));
}

function generateSecureWebhookSecret(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const partA = Math.random().toString(16).slice(2).padEnd(16, '0').slice(0, 16);
  const partB = Date.now().toString(16).padStart(16, '0').slice(-16);
  return `${partA}${partB}`;
}

function providerSitePlaceholder(provider: L1ChannelProvider): string {
  switch (provider) {
    case 'SHOPIFY':
      return 'https://your-store.myshopify.com';
    case 'WORDPRESS':
      return 'https://blog.example.com';
    case 'WEBFLOW':
      return 'https://www.example.com';
    case 'WEBHOOK':
      return 'https://hooks.example.com/geomix';
    case 'GHOST':
      return 'https://blog.example.com';
    case 'DEVTO':
      return 'https://dev.to';
    case 'HASHNODE':
      return 'https://hashnode.com';
    case 'GITHUB_MDX':
      return 'https://github.com/org/repo';
    case 'WECHAT_OFFICIAL':
      return 'https://mp.weixin.qq.com';
  }
}

function providerSiteHint(provider: L1ChannelProvider): string {
  switch (provider) {
    case 'SHOPIFY':
      return '填写 Shopify 店铺域名（含 https://），支持 Admin GraphQL 博客直推。';
    case 'WORDPRESS':
      return '填写 WordPress 站点根地址（自动调用 /wp-json/wp/v2 接口）。';
    case 'WEBFLOW':
      return '填写 Webflow 站点公网域名，保存并测试后可级联拉取站点、集合与字段映射。';
    case 'WEBHOOK':
      return '填写接收推送事件的 HTTPS Webhook 地址，请求头附带 X-GeoMix-Signature HMAC-SHA256 签名。';
    case 'GHOST':
      return '填写 Ghost 站点根地址，使用 Ghost Admin API v5 短期 HS256 JWT 直推文章与 JSON-LD。';
    case 'DEVTO':
      return '填写 Dev.to 社区地址（https://dev.to），支持 Forem REST v1 推送 Markdown 与 Canonical URL。';
    case 'HASHNODE':
      return '填写 Hashnode 站点或主页地址，支持 GraphQL 草稿/发布与 Canonical URL 回指。';
    case 'GITHUB_MDX':
      return '填写目标 GitHub 仓库地址，草稿模式自动新建分支提交 MDX 并发起 PR 审阅。';
    case 'WECHAT_OFFICIAL':
      return '仅调用微信官方草稿箱接口（不自动群发），需提前在公众号后台配置服务器出口 IP 白名单。';
  }
}

function isSafeShopifyOAuthAuthorizeUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.port) return false;
    if (parsed.pathname !== '/admin/oauth/authorize') return false;
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith('.myshopify.com')) return false;
    const prefix = host.slice(0, -'.myshopify.com'.length);
    return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(prefix);
  } catch {
    return false;
  }
}

function readStringConfig(config: Record<string, unknown>, key: string): string {
  const val = config[key];
  return typeof val === 'string' ? val : '';
}

function readStringArrayConfig(config: Record<string, unknown>, key: string): string[] {
  const val = config[key];
  if (!Array.isArray(val)) return [];
  return val
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, 20);
}

function parseTagsInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，\n]/)) {
    const trimmed = part.trim().slice(0, 60);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 20) break;
  }
  return out;
}

function readNumberArrayConfig(config: Record<string, unknown>, key: string): number[] {
  const val = config[key];
  if (!Array.isArray(val)) return [];
  return val
    .map((item) => Number(item))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 20);
}

function readFieldMapConfig(config: Record<string, unknown>): WebflowFieldMapDraft {
  const raw = config.fieldMap;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...EMPTY_WEBFLOW_FIELD_MAP };
  }
  const obj = raw as Record<string, unknown>;
  return {
    title: typeof obj.title === 'string' ? obj.title : '',
    slug: typeof obj.slug === 'string' ? obj.slug : '',
    bodyHtml: typeof obj.bodyHtml === 'string' ? obj.bodyHtml : '',
    metaDesc: typeof obj.metaDesc === 'string' ? obj.metaDesc : '',
    jsonLd: typeof obj.jsonLd === 'string' ? obj.jsonLd : '',
  };
}

function parseWebflowFieldsFromTargets(
  targets: readonly ChannelRemoteTargetDto[],
  selectedCollectionId?: string,
): WebflowFieldOption[] {
  const target =
    (selectedCollectionId ? targets.find((t) => t.id === selectedCollectionId) : null) ??
    targets.find((t) => Array.isArray(t.meta?.fields)) ??
    null;
  const rawFields = target?.meta?.fields;
  if (!Array.isArray(rawFields)) return [];
  const parsed: WebflowFieldOption[] = [];
  for (const item of rawFields) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const slug = typeof rec.slug === 'string' ? rec.slug.trim() : '';
    if (!slug) continue;
    parsed.push({
      id: typeof rec.id === 'string' ? rec.id : slug,
      slug,
      displayName: typeof rec.displayName === 'string' && rec.displayName ? rec.displayName : slug,
      type: typeof rec.type === 'string' ? rec.type : undefined,
      isRequired: typeof rec.isRequired === 'boolean' ? rec.isRequired : undefined,
    });
  }
  return parsed;
}

export function ChannelConnectionCreateModal({
  open,
  brandId,
  activeMarket,
  readOnly,
  supportedLocales,
  editingConn: editingConnProp = null,
  initialShopifyAuthMode,
  onOAuthRedirect,
  onClose,
  onSaved,
  onTested,
}: ChannelConnectionCreateModalProps): JSX.Element {
  const feedback = useUxFeedback();

  // Internal editing target (supports seamless create -> testAfterCreate transition into edit mode)
  const [editingConn, setEditingConn] = useState<ChannelConnectionDto | null>(editingConnProp);
  const [provider, setProvider] = useState<L1ChannelProvider>('SHOPIFY');
  const [displayName, setDisplayName] = useState('');
  const [siteBaseUrl, setSiteBaseUrl] = useState('');
  const [targetLocale, setTargetLocale] = useState<SupportedLocale | null>(null);

  // Shopify Dual-Mode Tabs State (OAuth 2.0 vs Custom App Token)
  const [shopifyAuthMode, setShopifyAuthMode] = useState<'oauth' | 'custom'>('oauth');
  const [shopifyOAuthShop, setShopifyOAuthShop] = useState('');
  const [shopifyOAuthStarting, setShopifyOAuthStarting] = useState(false);
  const [shopifyOAuthUnconfiguredMsg, setShopifyOAuthUnconfiguredMsg] = useState<string | null>(
    null,
  );

  // Provider credential inputs (always cleared on close / after create)
  const [shopifyAccessToken, setShopifyAccessToken] = useState('');
  const [wpUsername, setWpUsername] = useState('');
  const [wpAppPassword, setWpAppPassword] = useState('');
  const [webflowApiToken, setWebflowApiToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [ghostAdminApiKey, setGhostAdminApiKey] = useState('');
  const [devtoApiKey, setDevtoApiKey] = useState('');
  const [hashnodeApiToken, setHashnodeApiToken] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [wechatAppId, setWechatAppId] = useState('');
  const [wechatAppSecret, setWechatAppSecret] = useState('');

  // Provider configJson fields
  const [blogId, setBlogId] = useState('');
  const [blogHandle, setBlogHandle] = useState('');
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [siteId, setSiteId] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [collectionSlug, setCollectionSlug] = useState('');
  const [fieldMap, setFieldMap] = useState<WebflowFieldMapDraft>({ ...EMPTY_WEBFLOW_FIELD_MAP });
  const [publicationId, setPublicationId] = useState('');
  const [repoOwner, setRepoOwner] = useState('');
  const [repoName, setRepoName] = useState('');
  const [repoBranch, setRepoBranch] = useState('');
  const [contentDir, setContentDir] = useState('');
  const [fileExtension, setFileExtension] = useState<'mdx' | 'md'>('mdx');
  const [publicUrlTemplate, setPublicUrlTemplate] = useState('');
  const [primaryDomain, setPrimaryDomain] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [wechatAuthor, setWechatAuthor] = useState('');
  const [wechatCoverMediaId, setWechatCoverMediaId] = useState('');
  const [wechatNeedOpenComment, setWechatNeedOpenComment] = useState(false);
  const [defaultPublishAsDraft, setDefaultPublishAsDraft] = useState(true);
  const [inlineJsonLd, setInlineJsonLd] = useState(true);
  const [indexNowKey, setIndexNowKey] = useState('');

  // Modal async & target discovery state
  const [submitting, setSubmitting] = useState(false);
  const [modalTesting, setModalTesting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalTestResult, setModalTestResult] = useState<ChannelConnectionTestResultDto | null>(
    null,
  );
  const [remoteTargets, setRemoteTargets] = useState<ChannelRemoteTargetDto[]>([]);

  const contextSeqRef = useRef(0);
  const modalActionCtrlRef = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);

  const clearModalSecrets = useCallback(() => {
    setShopifyAccessToken('');
    setWpUsername('');
    setWpAppPassword('');
    setWebflowApiToken('');
    setWebhookSecret('');
    setGhostAdminApiKey('');
    setDevtoApiKey('');
    setHashnodeApiToken('');
    setGithubToken('');
    setWechatAppId('');
    setWechatAppSecret('');
  }, []);

  const resetInternalFields = useCallback(() => {
    modalActionCtrlRef.current?.abort();
    modalActionCtrlRef.current = null;
    submittingRef.current = false;
    setEditingConn(null);
    setProvider('SHOPIFY');
    setDisplayName('');
    setSiteBaseUrl('');
    setTargetLocale(null);
    setShopifyAuthMode('oauth');
    setShopifyOAuthShop('');
    setShopifyOAuthStarting(false);
    setShopifyOAuthUnconfiguredMsg(null);
    clearModalSecrets();
    setBlogId('');
    setBlogHandle('');
    setCategoryIds([]);
    setSiteId('');
    setCollectionId('');
    setCollectionSlug('');
    setFieldMap({ ...EMPTY_WEBFLOW_FIELD_MAP });
    setPublicationId('');
    setRepoOwner('');
    setRepoName('');
    setRepoBranch('');
    setContentDir('');
    setFileExtension('mdx');
    setPublicUrlTemplate('');
    setPrimaryDomain('');
    setTagsInput('');
    setWechatAuthor('');
    setWechatCoverMediaId('');
    setWechatNeedOpenComment(false);
    setDefaultPublishAsDraft(true);
    setInlineJsonLd(true);
    setIndexNowKey('');
    setSubmitting(false);
    setModalTesting(false);
    setModalError(null);
    setModalTestResult(null);
    setRemoteTargets([]);
  }, [clearModalSecrets]);

  const handleClose = useCallback(() => {
    contextSeqRef.current += 1;
    resetInternalFields();
    onClose();
  }, [onClose, resetInternalFields]);

  useEffect(() => {
    contextSeqRef.current += 1;
    resetInternalFields();

    if (open) {
      if (editingConnProp) {
        const cfg = editingConnProp.configJson ?? {};
        const l1Provider: L1ChannelProvider = L1_CHANNEL_PROVIDERS.includes(
          editingConnProp.provider as L1ChannelProvider,
        )
          ? (editingConnProp.provider as L1ChannelProvider)
          : 'SHOPIFY';
        setEditingConn(editingConnProp);
        setProvider(l1Provider);
        setDisplayName(editingConnProp.displayName);
        setSiteBaseUrl(editingConnProp.siteBaseUrl);
        setTargetLocale(editingConnProp.targetLocale ?? null);
        if (l1Provider === 'SHOPIFY') {
          setShopifyAuthMode(
            initialShopifyAuthMode ?? (editingConnProp.authType === 'OAUTH' ? 'oauth' : 'custom'),
          );
          setShopifyOAuthShop(
            editingConnProp.externalShopDomain ?? editingConnProp.siteBaseUrl ?? '',
          );
        }
        setBlogId(readStringConfig(cfg, 'blogId'));
        setBlogHandle(readStringConfig(cfg, 'blogHandle'));
        setCategoryIds(readNumberArrayConfig(cfg, 'categoryIds'));
        setSiteId(readStringConfig(cfg, 'siteId'));
        setCollectionId(readStringConfig(cfg, 'collectionId'));
        setCollectionSlug(readStringConfig(cfg, 'collectionSlug'));
        setFieldMap(readFieldMapConfig(cfg));
        setPublicationId(readStringConfig(cfg, 'publicationId'));
        setRepoOwner(readStringConfig(cfg, 'repoOwner'));
        setRepoName(readStringConfig(cfg, 'repoName'));
        setRepoBranch(readStringConfig(cfg, 'branch'));
        setContentDir(readStringConfig(cfg, 'contentDir'));
        setFileExtension(cfg.fileExtension === 'md' ? 'md' : 'mdx');
        setPublicUrlTemplate(readStringConfig(cfg, 'publicUrlTemplate'));
        setPrimaryDomain(readStringConfig(cfg, 'primaryDomain'));
        setTagsInput(readStringArrayConfig(cfg, 'tags').join(', '));
        setWechatAuthor(readStringConfig(cfg, 'author'));
        setWechatCoverMediaId(readStringConfig(cfg, 'defaultCoverMediaId'));
        setWechatNeedOpenComment(cfg.needOpenComment === true);
        setDefaultPublishAsDraft(
          l1Provider === 'WECHAT_OFFICIAL' ? true : cfg.defaultPublishAsDraft !== false,
        );
        setInlineJsonLd(l1Provider === 'WECHAT_OFFICIAL' ? false : cfg.inlineJsonLd !== false);
        setIndexNowKey(readStringConfig(cfg, 'indexNowKey'));
      } else {
        setProvider('SHOPIFY');
        setShopifyAuthMode(initialShopifyAuthMode ?? 'oauth');
        setDefaultPublishAsDraft(true);
        setInlineJsonLd(true);
      }
    }

    return () => {
      contextSeqRef.current += 1;
      submittingRef.current = false;
      modalActionCtrlRef.current?.abort();
      modalActionCtrlRef.current = null;
    };
  }, [open, brandId, activeMarket, editingConnProp, initialShopifyAuthMode, resetInternalFields]);

  const buildConfigPayload = ():
    { ok: true; config: ChannelConnectionConfig } | { ok: false; error: string } => {
    const isWechat = provider === 'WECHAT_OFFICIAL';
    const trimmedIndexNow = isWechat ? '' : indexNowKey.trim();
    if (trimmedIndexNow && trimmedIndexNow.length < 8) {
      return { ok: false, error: 'IndexNow Key 如需填写，长度至少为 8 位字符' };
    }
    if (trimmedIndexNow && trimmedIndexNow.length > 128) {
      return { ok: false, error: 'IndexNow Key 长度不能超过 128 位字符' };
    }
    const config: ChannelConnectionConfig = {
      defaultPublishAsDraft: isWechat ? true : defaultPublishAsDraft,
      inlineJsonLd: isWechat ? false : inlineJsonLd,
    };
    if (trimmedIndexNow) {
      config.indexNowKey = trimmedIndexNow;
    }

    if (provider === 'SHOPIFY') {
      if (blogId.trim()) config.blogId = blogId.trim();
      if (blogHandle.trim()) config.blogHandle = blogHandle.trim();
    } else if (provider === 'WORDPRESS') {
      if (categoryIds.length > 0) {
        config.categoryIds = categoryIds
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n > 0);
      }
    } else if (provider === 'WEBFLOW') {
      if (siteId.trim()) config.siteId = siteId.trim();
      if (collectionId.trim()) config.collectionId = collectionId.trim();
      if (collectionSlug.trim()) {
        (config as Record<string, unknown>).collectionSlug = collectionSlug.trim();
      }
      const cleanFieldMap: NonNullable<ChannelConnectionConfig['fieldMap']> = {};
      if (fieldMap.title.trim()) cleanFieldMap.title = fieldMap.title.trim();
      if (fieldMap.slug.trim()) cleanFieldMap.slug = fieldMap.slug.trim();
      if (fieldMap.bodyHtml.trim()) cleanFieldMap.bodyHtml = fieldMap.bodyHtml.trim();
      if (fieldMap.metaDesc.trim()) cleanFieldMap.metaDesc = fieldMap.metaDesc.trim();
      if (fieldMap.jsonLd.trim()) cleanFieldMap.jsonLd = fieldMap.jsonLd.trim();
      if (Object.keys(cleanFieldMap).length > 0) {
        config.fieldMap = cleanFieldMap;
      }
    } else if (provider === 'GHOST') {
      const parsedTags = parseTagsInput(tagsInput);
      if (parsedTags.length > 0) config.tags = parsedTags;
      if (editingConn && primaryDomain.trim()) config.primaryDomain = primaryDomain.trim();
    } else if (provider === 'DEVTO') {
      const parsedTags = parseTagsInput(tagsInput);
      if (parsedTags.length > 0) config.tags = parsedTags.slice(0, 4);
    } else if (provider === 'HASHNODE') {
      if (publicationId.trim()) config.publicationId = publicationId.trim();
    } else if (provider === 'GITHUB_MDX') {
      if (repoOwner.trim()) config.repoOwner = repoOwner.trim();
      if (repoName.trim()) config.repoName = repoName.trim();
      if (repoBranch.trim()) config.branch = repoBranch.trim();
      if (contentDir.trim()) config.contentDir = contentDir.trim();
      config.fileExtension = fileExtension;
      if (publicUrlTemplate.trim()) config.publicUrlTemplate = publicUrlTemplate.trim();
      if (primaryDomain.trim()) config.primaryDomain = primaryDomain.trim();
    } else if (provider === 'WECHAT_OFFICIAL') {
      const trimmedAuthor = wechatAuthor.trim();
      if (trimmedAuthor.length > 16) {
        return { ok: false, error: '微信公众号默认作者名最多 16 个字符' };
      }
      if (trimmedAuthor) config.author = trimmedAuthor;
      if (wechatCoverMediaId.trim()) config.defaultCoverMediaId = wechatCoverMediaId.trim();
      config.needOpenComment = wechatNeedOpenComment;
    }

    return { ok: true, config };
  };

  const buildCreateCredentials = ():
    { ok: true; credentials: Record<string, string> } | { ok: false; error: string } => {
    switch (provider) {
      case 'SHOPIFY': {
        const token = shopifyAccessToken.trim();
        if (!token) return { ok: false, error: '请填写 Shopify Admin API Access Token' };
        return { ok: true, credentials: { accessToken: token } };
      }
      case 'WORDPRESS': {
        const user = wpUsername.trim();
        const pass = wpAppPassword.trim();
        if (!user) return { ok: false, error: '请填写 WordPress 用户名' };
        if (!pass) return { ok: false, error: '请填写 WordPress Application Password' };
        return { ok: true, credentials: { username: user, appPassword: pass } };
      }
      case 'WEBFLOW': {
        const token = webflowApiToken.trim();
        if (!token) return { ok: false, error: '请填写 Webflow API Token' };
        return { ok: true, credentials: { apiToken: token } };
      }
      case 'WEBHOOK': {
        const secret = webhookSecret.trim();
        if (secret.length < 8) return { ok: false, error: 'Webhook 签名密钥长度至少为 8 位' };
        return { ok: true, credentials: { signingSecret: secret } };
      }
      case 'GHOST': {
        const key = ghostAdminApiKey.trim();
        if (!GHOST_ADMIN_API_KEY_PATTERN.test(key)) {
          return {
            ok: false,
            error: '请填写有效的 Ghost Admin API Key（格式为 id:hex_secret）',
          };
        }
        return { ok: true, credentials: { adminApiKey: key } };
      }
      case 'DEVTO': {
        const key = devtoApiKey.trim();
        if (!key) return { ok: false, error: '请填写 Dev.to API Key' };
        return { ok: true, credentials: { apiKey: key } };
      }
      case 'HASHNODE': {
        const token = hashnodeApiToken.trim();
        if (!token) return { ok: false, error: '请填写 Hashnode Personal Access Token' };
        return { ok: true, credentials: { apiToken: token } };
      }
      case 'GITHUB_MDX': {
        const token = githubToken.trim();
        if (!token) return { ok: false, error: '请填写 GitHub Personal Access Token' };
        return { ok: true, credentials: { token } };
      }
      case 'WECHAT_OFFICIAL': {
        const appId = wechatAppId.trim();
        const appSecret = wechatAppSecret.trim();
        if (!appId) return { ok: false, error: '请填写微信公众号 AppID' };
        if (!appSecret) return { ok: false, error: '请填写微信公众号 AppSecret' };
        return { ok: true, credentials: { appId, appSecret } };
      }
    }
  };

  const buildPatchCredentials = ():
    { ok: true; credentials?: Record<string, string> } | { ok: false; error: string } => {
    const patch: Record<string, string> = {};
    switch (provider) {
      case 'SHOPIFY': {
        if (shopifyAuthMode === 'custom' && shopifyAccessToken.trim()) {
          patch.accessToken = shopifyAccessToken.trim();
        }
        break;
      }
      case 'WORDPRESS': {
        if (wpUsername.trim()) patch.username = wpUsername.trim();
        if (wpAppPassword.trim()) patch.appPassword = wpAppPassword.trim();
        break;
      }
      case 'WEBFLOW': {
        if (webflowApiToken.trim()) patch.apiToken = webflowApiToken.trim();
        break;
      }
      case 'WEBHOOK': {
        const secret = webhookSecret.trim();
        if (secret) {
          if (secret.length < 8) {
            return { ok: false, error: 'Webhook 签名密钥长度至少为 8 位' };
          }
          patch.signingSecret = secret;
        }
        break;
      }
      case 'GHOST': {
        const key = ghostAdminApiKey.trim();
        if (key) {
          if (!GHOST_ADMIN_API_KEY_PATTERN.test(key)) {
            return {
              ok: false,
              error: '请填写有效的 Ghost Admin API Key（格式为 id:hex_secret）',
            };
          }
          patch.adminApiKey = key;
        }
        break;
      }
      case 'DEVTO': {
        if (devtoApiKey.trim()) patch.apiKey = devtoApiKey.trim();
        break;
      }
      case 'HASHNODE': {
        if (hashnodeApiToken.trim()) patch.apiToken = hashnodeApiToken.trim();
        break;
      }
      case 'GITHUB_MDX': {
        if (githubToken.trim()) patch.token = githubToken.trim();
        break;
      }
      case 'WECHAT_OFFICIAL': {
        if (wechatAppId.trim()) patch.appId = wechatAppId.trim();
        if (wechatAppSecret.trim()) patch.appSecret = wechatAppSecret.trim();
        break;
      }
    }
    return Object.keys(patch).length > 0 ? { ok: true, credentials: patch } : { ok: true };
  };

  const applyDiscoveredTargets = useCallback(
    (
      targetProvider: L1ChannelProvider,
      targets: readonly ChannelRemoteTargetDto[],
      overrides?: { siteId?: string; collectionId?: string },
    ) => {
      setRemoteTargets([...targets]);
      if (targetProvider === 'SHOPIFY' && targets.length > 0) {
        const currentMatch = blogId ? targets.find((t) => t.id === blogId) : null;
        const chosen = currentMatch ?? targets[0]!;
        if (!blogId) {
          setBlogId(chosen.id);
        }
        if (chosen.handle) {
          setBlogHandle(chosen.handle);
        }
      } else if (targetProvider === 'HASHNODE' && targets.length > 0) {
        const currentMatch = publicationId ? targets.find((t) => t.id === publicationId) : null;
        const chosen = currentMatch ?? targets[0]!;
        if (!publicationId) {
          setPublicationId(chosen.id);
        }
      } else if (targetProvider === 'GITHUB_MDX' && targets.length > 0) {
        const chosen = targets[0]!;
        if (!repoBranch && chosen.handle) {
          setRepoBranch(chosen.handle);
        }
        if (!repoOwner && !repoName && chosen.id.includes('/')) {
          const [owner, name] = chosen.id.split('/', 2);
          if (owner && name) {
            setRepoOwner(owner);
            setRepoName(name);
          }
        }
      } else if (targetProvider === 'WEBFLOW' && targets.length > 0) {
        const effectiveSiteId = overrides?.siteId !== undefined ? overrides.siteId : siteId;
        const effectiveCollectionId =
          overrides?.collectionId !== undefined ? overrides.collectionId : collectionId;
        const isSiteList = targets.every((t) => t.meta?.kind === 'site');
        if (isSiteList) {
          if (!effectiveSiteId && targets[0]) {
            setSiteId(targets[0].id);
          }
        } else {
          const firstCollection =
            (effectiveCollectionId ? targets.find((t) => t.id === effectiveCollectionId) : null) ??
            targets[0]!;
          const discoveredSiteId =
            typeof firstCollection.meta?.siteId === 'string' ? firstCollection.meta.siteId : '';
          if (discoveredSiteId && !effectiveSiteId) {
            setSiteId(discoveredSiteId);
          }
          if (!effectiveCollectionId && firstCollection.id) {
            setCollectionId(firstCollection.id);
          }
          if (typeof firstCollection.meta?.collectionSlug === 'string') {
            setCollectionSlug(firstCollection.meta.collectionSlug);
          } else if (firstCollection.handle) {
            setCollectionSlug(firstCollection.handle);
          }
        }
      }
    },
    [blogId, collectionId, publicationId, repoBranch, repoName, repoOwner, siteId],
  );

  const runModalTest = useCallback(
    async (
      connId: string,
      targetProvider: L1ChannelProvider,
      overrides?: { siteId?: string; collectionId?: string },
    ) => {
      if (readOnly) return;
      modalActionCtrlRef.current?.abort();
      const ctrl = new AbortController();
      modalActionCtrlRef.current = ctrl;
      const seq = contextSeqRef.current;
      setModalTesting(true);
      setModalError(null);
      try {
        const effectiveTestSiteId = (
          overrides?.siteId !== undefined ? overrides.siteId : siteId
        ).trim();
        const effectiveTestCollectionId = (
          overrides?.collectionId !== undefined ? overrides.collectionId : collectionId
        ).trim();
        const testPayload =
          targetProvider === 'WEBFLOW'
            ? {
                ...(effectiveTestSiteId ? { siteId: effectiveTestSiteId } : {}),
                ...(effectiveTestCollectionId ? { collectionId: effectiveTestCollectionId } : {}),
              }
            : {};
        const res = await testChannelConnection(brandId, connId, testPayload, {
          storage: window.sessionStorage,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        setModalTestResult(res);
        if (res.targets && res.targets.length > 0) {
          applyDiscoveredTargets(targetProvider, res.targets, overrides);
        }
        onTested?.(connId, res);
        if (res.ok) {
          feedback.notifySuccess(res.message || '连接测试通过');
        } else {
          feedback.notifyWarning(res.message || '连接测试未通过，请检查凭据或站点地址');
        }
      } catch (err) {
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        const msg = formatConnError(err, '测试连接失败');
        setModalError(msg);
        feedback.notifyError(msg);
      } finally {
        if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
          setModalTesting(false);
        }
      }
    },
    [applyDiscoveredTargets, brandId, collectionId, feedback, onTested, readOnly, siteId],
  );

  const handleStartShopifyOAuth = async () => {
    if (readOnly || shopifyOAuthStarting) return;
    setModalError(null);
    setShopifyOAuthUnconfiguredMsg(null);
    const trimmedShop = shopifyOAuthShop.trim();
    if (!trimmedShop) {
      setModalError('请输入有效的 Shopify 店铺域名（*.myshopify.com）');
      return;
    }

    const ctrl = new AbortController();
    modalActionCtrlRef.current?.abort();
    modalActionCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    setShopifyOAuthStarting(true);

    try {
      const res = await startShopifyOAuth(
        brandId,
        {
          shop: trimmedShop,
          market: activeMarket,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          ...(targetLocale ? { targetLocale } : {}),
        },
        { storage: window.sessionStorage, signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      if (!isSafeShopifyOAuthAuthorizeUrl(res.authorizeUrl)) {
        setModalError('拦截到不安全的 Shopify 授权跳转地址，请检查店铺域名后重试');
        return;
      }
      if (onOAuthRedirect) {
        onOAuthRedirect(res.authorizeUrl);
      } else {
        window.location.assign(res.authorizeUrl);
      }
    } catch (err) {
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      if (err instanceof GatewayApiError && err.status === 503) {
        setShopifyOAuthUnconfiguredMsg(
          err.message || 'Shopify OAuth 尚未在服务端配置，请直接切换至 Custom App Token 手动接入。',
        );
      } else {
        const msg = formatConnError(err, '发起 Shopify OAuth 授权失败');
        setModalError(msg);
        feedback.notifyError(msg);
      }
    } finally {
      if (modalActionCtrlRef.current === ctrl) {
        modalActionCtrlRef.current = null;
      }
      if (!ctrl.signal.aborted && seq === contextSeqRef.current) {
        setShopifyOAuthStarting(false);
      }
    }
  };

  const handleModalSubmit = async (options?: { testAfterCreate?: boolean }) => {
    if (readOnly || submittingRef.current) return;
    setModalError(null);
    const trimmedName = displayName.trim();
    const trimmedUrl = siteBaseUrl.trim();
    if (!trimmedName) {
      setModalError('请填写连接名称');
      return;
    }
    if (!trimmedUrl || !isSafeDistributionHttpUrl(trimmedUrl)) {
      setModalError('请输入有效的 http:// 或 https:// 站点地址');
      return;
    }
    const cfgRes = buildConfigPayload();
    if (!cfgRes.ok) {
      setModalError(cfgRes.error);
      return;
    }

    if (editingConn) {
      const credPatch = buildPatchCredentials();
      if (!credPatch.ok) {
        setModalError(credPatch.error);
        return;
      }
      submittingRef.current = true;
      const ctrl = new AbortController();
      modalActionCtrlRef.current = ctrl;
      const seq = contextSeqRef.current;
      setSubmitting(true);

      try {
        const payload: UpdateChannelConnectionInput = {
          displayName: trimmedName,
          siteBaseUrl: trimmedUrl,
          configJson: cfgRes.config,
          targetLocale: targetLocale || null,
          ...(credPatch.credentials ? { credentials: credPatch.credentials } : {}),
        };
        const updated = await updateChannelConnection(brandId, editingConn.id, payload, {
          storage: window.sessionStorage,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        onSaved(updated, 'update');
        feedback.notifySuccess(`已保存渠道连接「${updated.displayName}」`);
        handleClose();
      } catch (err) {
        if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
        const msg = formatConnError(err, '保存渠道连接失败');
        setModalError(msg);
        feedback.notifyError(msg);
      } finally {
        if (modalActionCtrlRef.current === ctrl) {
          modalActionCtrlRef.current = null;
        }
        if (seq === contextSeqRef.current) {
          submittingRef.current = false;
          if (!ctrl.signal.aborted) {
            setSubmitting(false);
          }
        }
      }
      return;
    }

    const credRes = buildCreateCredentials();
    if (!credRes.ok) {
      setModalError(credRes.error);
      return;
    }

    submittingRef.current = true;
    const ctrl = new AbortController();
    modalActionCtrlRef.current = ctrl;
    const seq = contextSeqRef.current;
    setSubmitting(true);

    try {
      const created = await createChannelConnection(
        brandId,
        {
          market: activeMarket,
          provider,
          displayName: trimmedName,
          siteBaseUrl: trimmedUrl,
          credentials: credRes.credentials,
          configJson: cfgRes.config,
          ...(targetLocale ? { targetLocale } : {}),
        },
        {
          storage: window.sessionStorage,
          signal: ctrl.signal,
        },
      );
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      onSaved(created, 'create');

      if (options?.testAfterCreate) {
        // Transition seamlessly into edit mode, wipe raw secrets immediately, and pull remote targets
        setEditingConn(created);
        clearModalSecrets();
        setSubmitting(false);
        feedback.notifySuccess(`已创建连接「${created.displayName}」，正在测试连通性…`);
        await runModalTest(created.id, provider);
        return;
      }

      feedback.notifySuccess(`已添加渠道连接「${created.displayName}」`);
      handleClose();
    } catch (err) {
      if (ctrl.signal.aborted || seq !== contextSeqRef.current) return;
      const msg = formatConnError(err, '添加渠道连接失败');
      setModalError(msg);
      feedback.notifyError(msg);
    } finally {
      if (modalActionCtrlRef.current === ctrl) {
        modalActionCtrlRef.current = null;
      }
      if (seq === contextSeqRef.current) {
        submittingRef.current = false;
        if (!ctrl.signal.aborted) {
          setSubmitting(false);
        }
      }
    }
  };

  const webflowSiteTargets = useMemo(
    () => remoteTargets.filter((t) => t.meta?.kind === 'site'),
    [remoteTargets],
  );
  const webflowCollectionTargets = useMemo(
    () => remoteTargets.filter((t) => t.meta?.kind !== 'site'),
    [remoteTargets],
  );
  const webflowFields = useMemo(
    () => parseWebflowFieldsFromTargets(webflowCollectionTargets, collectionId),
    [collectionId, webflowCollectionTargets],
  );

  const renderWebflowFieldControl = (
    fieldKey: keyof WebflowFieldMapDraft,
    label: string,
    defaultHint: string,
  ) => {
    const value = fieldMap[fieldKey];
    if (webflowFields.length > 0) {
      const options = webflowFields.map((f) => ({
        value: f.slug,
        label: `${f.displayName} (${f.slug})`,
      }));
      if (value && !options.some((opt) => opt.value === value)) {
        options.unshift({ value, label: `${value}（当前配置）` });
      }
      return (
        <FormField key={fieldKey} label={label}>
          <Select
            allowClear
            showSearch
            className="gm-brand-w-full"
            aria-label={label}
            placeholder={`默认：${defaultHint}`}
            value={value || undefined}
            options={options}
            onChange={(next) =>
              setFieldMap((prev) => ({
                ...prev,
                [fieldKey]: typeof next === 'string' ? next : '',
              }))
            }
          />
        </FormField>
      );
    }
    return (
      <FormField key={fieldKey} label={label}>
        <Input
          aria-label={label}
          placeholder={`默认：${defaultHint}`}
          value={value}
          onChange={(e) => setFieldMap((prev) => ({ ...prev, [fieldKey]: e.target.value }))}
        />
      </FormField>
    );
  };

  const availableProviders = useMemo<L1ChannelProvider[]>(() => {
    const base =
      activeMarket === 'GLOBAL'
        ? L1_CHANNEL_PROVIDERS.filter((p) => p !== 'WECHAT_OFFICIAL')
        : [...L1_CHANNEL_PROVIDERS];
    if (editingConn && !base.includes(editingConn.provider as L1ChannelProvider)) {
      return [...base, editingConn.provider as L1ChannelProvider];
    }
    return base;
  }, [activeMarket, editingConn]);

  const marketLocaleOptions = useMemo(() => {
    const allowed = supportedLocalesForMarket(activeMarket);
    const enabledSet = new Set<string>(supportedLocales ?? []);
    const ordered = [
      ...allowed.filter((code) => enabledSet.has(code)),
      ...allowed.filter((code) => !enabledSet.has(code)),
    ];
    return ordered.map((code) => {
      const meta = SUPPORTED_LOCALES[code];
      return {
        value: code,
        label: `${meta.labelZh} (${meta.code}) · ${meta.nativeLabel}`,
      };
    });
  }, [activeMarket, supportedLocales]);

  const isShopifyCreateOAuthTab =
    provider === 'SHOPIFY' && !editingConn && shopifyAuthMode === 'oauth';

  return (
    <Modal
      open={open}
      title={editingConn ? `编辑发布渠道连接 · ${editingConn.displayName}` : '添加发布渠道连接'}
      width="min(640px, calc(100vw - 32px))"
      destroyOnHidden
      keyboard={!submitting && !modalTesting && !shopifyOAuthStarting}
      maskClosable={!submitting && !modalTesting && !shopifyOAuthStarting}
      onCancel={handleClose}
      footer={
        <div className="gm-brand-modal-footer-wrap">
          <Button
            disabled={submitting || modalTesting || shopifyOAuthStarting}
            className="gm-brand-btn-nowrap"
            onClick={handleClose}
          >
            取消
          </Button>
          {isShopifyCreateOAuthTab ? null : editingConn ? (
            <Button
              data-testid="channel-connection-modal-test-btn"
              loading={modalTesting}
              disabled={readOnly || submitting}
              className="gm-brand-btn-nowrap"
              onClick={() => void runModalTest(editingConn.id, provider)}
            >
              测试连接并拉取目标
            </Button>
          ) : (
            <Button
              data-testid="channel-connection-save-and-test-btn"
              loading={submitting || modalTesting}
              disabled={readOnly}
              className="gm-brand-btn-nowrap"
              onClick={() => void handleModalSubmit({ testAfterCreate: true })}
            >
              保存并测试连接
            </Button>
          )}
          {isShopifyCreateOAuthTab ? null : (
            <Button
              type="primary"
              data-testid="channel-connection-submit-btn"
              loading={submitting}
              disabled={readOnly || modalTesting}
              className="gm-brand-btn-nowrap"
              onClick={() => void handleModalSubmit()}
            >
              保存连接
            </Button>
          )}
        </div>
      }
    >
      <div data-testid="channel-connection-modal" className="gm-brand-conn-modal-body">
        {modalError ? (
          <Alert type="error" showIcon message={modalError} className="gm-brand-alert-wrap" />
        ) : null}

        {modalTestResult ? (
          <Alert
            type={modalTestResult.ok ? 'success' : 'warning'}
            showIcon
            message={modalTestResult.message}
            description={
              provider === 'WECHAT_OFFICIAL' &&
              !modalTestResult.ok &&
              hasWechatIpWhitelistError(modalTestResult.message)
                ? '处理指引：请登录微信公众平台 →「设置与开发」→「基本配置」→「IP 白名单」添加出口 IP 后再试。'
                : undefined
            }
            className="gm-brand-alert-wrap"
          />
        ) : null}

        <FormField label={`渠道类型（所属市场：${GEO_MARKET_LABELS[activeMarket]}）`}>
          <Select<L1ChannelProvider>
            data-testid="channel-provider-select"
            aria-label="渠道类型"
            className="gm-brand-w-full"
            listHeight={360}
            disabled={Boolean(editingConn)}
            value={provider}
            options={availableProviders.map((p) => ({
              value: p,
              label: CHANNEL_PROVIDER_LABELS[p],
            }))}
            onChange={(next) => {
              setProvider(next);
              if (!editingConn) {
                clearModalSecrets();
                setShopifyOAuthShop('');
                setBlogId('');
                setBlogHandle('');
                setCategoryIds([]);
                setSiteId('');
                setCollectionId('');
                setCollectionSlug('');
                setFieldMap({ ...EMPTY_WEBFLOW_FIELD_MAP });
                setPublicationId('');
                setRepoOwner('');
                setRepoName('');
                setRepoBranch('');
                setContentDir('');
                setFileExtension('mdx');
                setPublicUrlTemplate('');
                setPrimaryDomain('');
                setTagsInput('');
                setWechatAuthor('');
                setWechatCoverMediaId('');
                setWechatNeedOpenComment(false);
                setDefaultPublishAsDraft(true);
                setInlineJsonLd(next !== 'WECHAT_OFFICIAL');
                if (next === 'SHOPIFY') {
                  setShopifyAuthMode('oauth');
                }
              } else if (next === 'WECHAT_OFFICIAL') {
                setDefaultPublishAsDraft(true);
                setInlineJsonLd(false);
              }
              setModalError(null);
              setModalTestResult(null);
              setShopifyOAuthUnconfiguredMsg(null);
              setRemoteTargets([]);
            }}
          />
        </FormField>

        {provider === 'SHOPIFY' ? (
          <Tabs
            activeKey={shopifyAuthMode}
            onChange={(key) => {
              const nextMode = key === 'custom' ? 'custom' : 'oauth';
              setShopifyAuthMode(nextMode);
              if (nextMode === 'oauth') {
                setShopifyAccessToken('');
              }
              setModalError(null);
              setShopifyOAuthUnconfiguredMsg(null);
            }}
            items={[
              {
                key: 'oauth',
                label: 'Shopify OAuth 2.0 一键授权',
                children: (
                  <div data-testid="shopify-oauth-tab-panel" className="gm-brand-conn-oauth-panel">
                    <Alert
                      type="info"
                      showIcon
                      message="官方 OAuth 2.0 一键授权（推荐）"
                      description="输入您的 *.myshopify.com 店铺域名后跳转 Shopify 官方确认授权；系统将自动加密保存令牌并注册应用卸载同步 Webhook。"
                    />

                    {shopifyOAuthUnconfiguredMsg ? (
                      <Alert
                        type="warning"
                        showIcon
                        data-testid="shopify-oauth-503-fallback"
                        message="当前环境尚未开启 Shopify OAuth 2.0"
                        description={shopifyOAuthUnconfiguredMsg}
                        action={
                          <Button
                            size="small"
                            type="default"
                            data-testid="shopify-switch-to-custom-btn"
                            className="gm-brand-btn-nowrap"
                            onClick={() => {
                              setShopifyAuthMode('custom');
                              setShopifyOAuthUnconfiguredMsg(null);
                              setModalError(null);
                            }}
                          >
                            改用 Custom App Token
                          </Button>
                        }
                      />
                    ) : null}

                    <FormField label="Shopify 店铺域名（*.myshopify.com）">
                      <Input
                        aria-label="Shopify 店铺域名"
                        data-testid="shopify-oauth-shop-input"
                        placeholder="your-store.myshopify.com"
                        value={shopifyOAuthShop}
                        disabled={readOnly || shopifyOAuthStarting}
                        onChange={(e) => setShopifyOAuthShop(e.target.value)}
                      />
                    </FormField>

                    {!editingConn ? (
                      <>
                        <FormField label="连接名称（可选，默认使用店铺域名）">
                          <Input
                            aria-label="OAuth 连接名称"
                            maxLength={80}
                            placeholder="例如：北美主站 Shopify 博客"
                            value={displayName}
                            disabled={readOnly || shopifyOAuthStarting}
                            onChange={(e) => setDisplayName(e.target.value)}
                          />
                        </FormField>

                        <FormField label="目标语种（可选）">
                          <Select<SupportedLocale>
                            allowClear
                            aria-label="OAuth 目标语种"
                            className="gm-brand-w-full"
                            placeholder="不限定语种（通用）"
                            disabled={readOnly || shopifyOAuthStarting}
                            value={targetLocale ?? undefined}
                            options={marketLocaleOptions}
                            onChange={(next) => setTargetLocale(next ?? null)}
                          />
                        </FormField>
                      </>
                    ) : null}

                    <div>
                      <Button
                        type={editingConn ? 'default' : 'primary'}
                        data-testid="shopify-oauth-start-btn"
                        loading={shopifyOAuthStarting}
                        disabled={readOnly}
                        className="gm-brand-btn-nowrap"
                        onClick={() => void handleStartShopifyOAuth()}
                      >
                        {editingConn ? '重新发起 Shopify OAuth 授权' : '前往 Shopify 一键授权'}
                      </Button>
                    </div>
                  </div>
                ),
              },
              {
                key: 'custom',
                label: 'Custom App Token',
                children: (
                  <div data-testid="shopify-custom-tab-panel" className="gm-brand-conn-custom-note">
                    使用 Shopify Admin Custom App 手动填入 Access Token 接入；适合自托管或尚未配置
                    OAuth Client 的环境。
                  </div>
                ),
              },
            ]}
          />
        ) : null}

        {!isShopifyCreateOAuthTab ? (
          <>
            <FormField label="连接名称">
              <Input
                aria-label="连接名称"
                maxLength={80}
                placeholder={
                  provider === 'WECHAT_OFFICIAL'
                    ? '例如：品牌官方服务号草稿箱'
                    : '例如：海外官方 Shopify 博客'
                }
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </FormField>

            <FormField label="站点地址" help={providerSiteHint(provider)}>
              <Input
                aria-label="站点地址"
                placeholder={providerSitePlaceholder(provider)}
                value={siteBaseUrl}
                onChange={(e) => setSiteBaseUrl(e.target.value)}
              />
            </FormField>

            <FormField label="目标语种（可选，留空表示通用连接）">
              <Select<SupportedLocale>
                allowClear
                aria-label="目标语种"
                data-testid="channel-connection-locale-select"
                className="gm-brand-w-full"
                placeholder="不限定语种（通用）"
                value={targetLocale ?? undefined}
                options={marketLocaleOptions}
                onChange={(next) => setTargetLocale(next ?? null)}
              />
            </FormField>
          </>
        ) : null}

        {/* Provider-Specific Credentials & Targets */}
        {provider === 'SHOPIFY' && !isShopifyCreateOAuthTab ? (
          <>
            {shopifyAuthMode === 'custom' ? (
              <FormField label="Shopify Admin API Access Token">
                <Input.Password
                  aria-label="Shopify Access Token"
                  autoComplete="off"
                  placeholder={
                    editingConn ? '留空则保留现有加密凭据' : '例如：shpat_xxxxxxxxxxxxxxxx'
                  }
                  value={shopifyAccessToken}
                  onChange={(e) => setShopifyAccessToken(e.target.value)}
                />
              </FormField>
            ) : null}

            <FormField label="目标 Blog（测试连接后自动拉取列表，也可手动填写 Blog ID）">
              <div className="gm-brand-field-stack">
                {remoteTargets.length > 0 ? (
                  <Select
                    allowClear
                    aria-label="Shopify 目标 Blog 选择"
                    className="gm-brand-w-full"
                    placeholder="选择要推送的 Shopify Blog"
                    value={blogId || undefined}
                    options={remoteTargets.map((t) => ({
                      value: t.id,
                      label: t.handle ? `${t.name} (${t.handle})` : t.name,
                    }))}
                    onChange={(next) => {
                      const nextId = typeof next === 'string' ? next : '';
                      setBlogId(nextId);
                      const matched = remoteTargets.find((t) => t.id === nextId);
                      setBlogHandle(matched?.handle ?? '');
                    }}
                  />
                ) : null}
                <Input
                  aria-label="Shopify Blog ID"
                  placeholder="可选，例如 gid://shopify/Blog/123456"
                  value={blogId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setBlogId(nextId);
                    const matched = remoteTargets.find((t) => t.id === nextId.trim());
                    setBlogHandle(matched?.handle ?? '');
                  }}
                />
              </div>
            </FormField>
          </>
        ) : null}

        {provider === 'WORDPRESS' ? (
          <>
            <div className="gm-brand-form-grid-2">
              <FormField label="WordPress 用户名">
                <Input
                  aria-label="WordPress 用户名"
                  autoComplete="off"
                  placeholder={editingConn ? '留空则保留现有加密凭据' : '例如：editor'}
                  value={wpUsername}
                  onChange={(e) => setWpUsername(e.target.value)}
                />
              </FormField>
              <FormField label="Application Password">
                <Input.Password
                  aria-label="WordPress Application Password"
                  autoComplete="off"
                  placeholder={editingConn ? '留空则保留现有加密凭据' : '输入应用专用密码'}
                  value={wpAppPassword}
                  onChange={(e) => setWpAppPassword(e.target.value)}
                />
              </FormField>
            </div>

            <FormField label="默认文章分类（测试连接后自动拉取 WordPress 分类）">
              <Select
                mode="multiple"
                allowClear
                aria-label="WordPress 默认分类"
                className="gm-brand-w-full"
                placeholder="测试连接后选择分类"
                value={categoryIds.map(String)}
                options={[
                  ...remoteTargets.map((t) => ({
                    value: String(t.id),
                    label: t.handle ? `${t.name} (${t.handle})` : t.name,
                  })),
                  ...categoryIds
                    .filter((id) => !remoteTargets.some((t) => Number(t.id) === id))
                    .map((id) => ({ value: String(id), label: `分类 #${id}` })),
                ]}
                onChange={(vals: string[]) => {
                  const numeric = vals
                    .map((v) => Number(v))
                    .filter((n) => Number.isInteger(n) && n > 0);
                  setCategoryIds([...new Set(numeric)]);
                }}
              />
            </FormField>
          </>
        ) : null}

        {provider === 'WEBFLOW' ? (
          <>
            <FormField label="Webflow Data API v2 Token">
              <Input.Password
                aria-label="Webflow API Token"
                autoComplete="off"
                placeholder={editingConn ? '留空则保留现有加密凭据' : '输入 Webflow API Token'}
                value={webflowApiToken}
                onChange={(e) => setWebflowApiToken(e.target.value)}
              />
            </FormField>

            <div className="gm-brand-form-grid-2">
              <FormField label="Webflow Site ID">
                <div className="gm-brand-field-stack">
                  {webflowSiteTargets.length > 0 ? (
                    <Select
                      allowClear
                      aria-label="Webflow Site 选择"
                      className="gm-brand-w-full"
                      placeholder="选择 Webflow 站点"
                      value={siteId || undefined}
                      options={webflowSiteTargets.map((s) => ({
                        value: s.id,
                        label: s.handle ? `${s.name} (${s.handle})` : s.name,
                      }))}
                      onChange={(next) => {
                        const nextSiteId = typeof next === 'string' ? next : '';
                        setSiteId(nextSiteId);
                        setCollectionId('');
                        setCollectionSlug('');
                        if (editingConn && nextSiteId) {
                          void runModalTest(editingConn.id, 'WEBFLOW', {
                            siteId: nextSiteId,
                            collectionId: '',
                          });
                        }
                      }}
                    />
                  ) : null}
                  <Input
                    aria-label="Webflow Site ID"
                    placeholder="测试连接后自动获取，或手动填写"
                    value={siteId}
                    onChange={(e) => setSiteId(e.target.value)}
                  />
                </div>
              </FormField>

              <FormField label="Webflow Collection ID">
                <div className="gm-brand-field-stack">
                  {webflowCollectionTargets.length > 0 ? (
                    <Select
                      allowClear
                      aria-label="Webflow Collection 选择"
                      className="gm-brand-w-full"
                      placeholder="选择目标 CMS Collection"
                      value={collectionId || undefined}
                      options={webflowCollectionTargets.map((c) => ({
                        value: c.id,
                        label: c.handle ? `${c.name} (${c.handle})` : c.name,
                      }))}
                      onChange={(next) => {
                        const nextColId = typeof next === 'string' ? next : '';
                        setCollectionId(nextColId);
                        const matched = webflowCollectionTargets.find((c) => c.id === nextColId);
                        setCollectionSlug(
                          typeof matched?.meta?.collectionSlug === 'string'
                            ? matched.meta.collectionSlug
                            : (matched?.handle ?? ''),
                        );
                        if (editingConn && nextColId) {
                          void runModalTest(editingConn.id, 'WEBFLOW', {
                            siteId: siteId || undefined,
                            collectionId: nextColId,
                          });
                        }
                      }}
                    />
                  ) : null}
                  <Input
                    aria-label="Webflow Collection ID"
                    placeholder="发布时必填，测试连接后可下拉选择"
                    value={collectionId}
                    onChange={(e) => setCollectionId(e.target.value)}
                  />
                </div>
              </FormField>
            </div>

            <div className="gm-brand-conn-group-box">
              <div className="gm-brand-conn-group-title">CMS 字段映射（fieldMap）</div>
              <div className="gm-brand-form-grid-compact">
                {renderWebflowFieldControl('title', '标题字段（title）', 'name')}
                {renderWebflowFieldControl('slug', '短链字段（slug）', 'slug')}
                {renderWebflowFieldControl('bodyHtml', '正文字段（bodyHtml）', 'post-body')}
                {renderWebflowFieldControl('metaDesc', '摘要字段（metaDesc）', 'meta-description')}
                {renderWebflowFieldControl('jsonLd', 'JSON-LD 字段（可选）', '留空则内联正文')}
              </div>
            </div>
          </>
        ) : null}

        {provider === 'WEBHOOK' ? (
          <FormField label="Webhook 签名密钥（HMAC-SHA256，至少 8 位）">
            <div className="gm-brand-field-stack">
              <Input.Password
                aria-label="Webhook 签名密钥"
                autoComplete="off"
                placeholder={editingConn ? '留空则保留现有加密凭据' : '点击下方随机生成或手动输入'}
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
              />
              <Space wrap size={8}>
                <Button
                  size="small"
                  data-testid="webhook-generate-secret-btn"
                  className="gm-brand-btn-nowrap"
                  onClick={() => {
                    const nextSecret = generateSecureWebhookSecret();
                    setWebhookSecret(nextSecret);
                    feedback.notifySuccess('已生成 32 位随机签名密钥，请在保存前复制妥善保管');
                  }}
                >
                  随机生成密钥
                </Button>
                <Button
                  size="small"
                  data-testid="webhook-copy-secret-btn"
                  disabled={!webhookSecret.trim()}
                  className="gm-brand-btn-nowrap"
                  onClick={() => {
                    void copyTextToClipboard(webhookSecret.trim()).then((ok) => {
                      if (ok) feedback.notifySuccess('已复制签名密钥到剪贴板');
                      else feedback.notifyError('复制失败，请手动复制');
                    });
                  }}
                >
                  复制密钥
                </Button>
              </Space>
            </div>
          </FormField>
        ) : null}

        {provider === 'GHOST' ? (
          <>
            <FormField label="Ghost Admin API Key（格式 id:hex_secret，偶数长度十六进制）">
              <Input.Password
                aria-label="Ghost Admin API Key"
                autoComplete="off"
                placeholder={
                  editingConn ? '留空则保留现有加密凭据' : '例如：64a1b2c3:0123456789abcdef...'
                }
                value={ghostAdminApiKey}
                onChange={(e) => setGhostAdminApiKey(e.target.value)}
              />
            </FormField>
            <FormField label="默认标签（逗号分隔，可选）">
              <Input
                aria-label="Ghost 默认标签"
                placeholder="例如：geo, product-guide"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
              />
            </FormField>
          </>
        ) : null}

        {provider === 'DEVTO' ? (
          <>
            <FormField label="Dev.to API Key">
              <Input.Password
                aria-label="Dev.to API Key"
                autoComplete="off"
                placeholder={editingConn ? '留空则保留现有加密凭据' : '输入 Dev.to Forem API Key'}
                value={devtoApiKey}
                onChange={(e) => setDevtoApiKey(e.target.value)}
              />
            </FormField>
            <FormField label="默认标签（最多 4 个小写英文标签，逗号分隔，可选）">
              <Input
                aria-label="Dev.to 默认标签"
                placeholder="例如：devops, selfhosted, homelab"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
              />
            </FormField>
          </>
        ) : null}

        {provider === 'HASHNODE' ? (
          <>
            <FormField label="Hashnode Personal Access Token">
              <Input.Password
                aria-label="Hashnode Personal Access Token"
                autoComplete="off"
                placeholder={
                  editingConn ? '留空则保留现有加密凭据' : '输入 Hashnode Personal Access Token'
                }
                value={hashnodeApiToken}
                onChange={(e) => setHashnodeApiToken(e.target.value)}
              />
            </FormField>
            <FormField label="Hashnode Publication ID（可选，测试连接时自动发现并回填）">
              <div className="gm-brand-field-stack">
                {remoteTargets.length > 0 ? (
                  <Select
                    allowClear
                    aria-label="Hashnode Publication 选择"
                    className="gm-brand-w-full"
                    placeholder="选择发现的 Hashnode Publication"
                    value={publicationId || undefined}
                    options={remoteTargets.map((t) => ({
                      value: t.id,
                      label: t.handle ? `${t.name} (${t.handle})` : t.name,
                    }))}
                    onChange={(next) => setPublicationId(typeof next === 'string' ? next : '')}
                  />
                ) : null}
                <Input
                  aria-label="Hashnode Publication ID"
                  placeholder="留空可在测试连接时自动发现"
                  value={publicationId}
                  onChange={(e) => setPublicationId(e.target.value)}
                />
              </div>
            </FormField>
          </>
        ) : null}

        {provider === 'GITHUB_MDX' ? (
          <>
            <FormField label="GitHub Personal Access Token（需具备 repo contents & pull requests 权限）">
              <Input.Password
                aria-label="GitHub Personal Access Token"
                autoComplete="off"
                placeholder={editingConn ? '留空则保留现有加密凭据' : '例如：ghp_xxxxxxxxxxxx'}
                value={githubToken}
                onChange={(e) => setGithubToken(e.target.value)}
              />
            </FormField>

            {remoteTargets.length > 0 ? (
              <FormField label="已发现仓库（点击自动填充 Owner / Repo / Branch）">
                <Select
                  allowClear
                  aria-label="GitHub 仓库选择"
                  className="gm-brand-w-full"
                  placeholder="选择仓库"
                  value={repoOwner && repoName ? `${repoOwner}/${repoName}` : undefined}
                  options={remoteTargets.map((t) => ({
                    value: t.id,
                    label: t.handle ? `${t.name} (${t.handle})` : t.name,
                  }))}
                  onChange={(next) => {
                    if (typeof next !== 'string' || !next.includes('/')) return;
                    const [owner, name] = next.split('/', 2);
                    if (owner && name) {
                      setRepoOwner(owner);
                      setRepoName(name);
                    }
                    const matched = remoteTargets.find((t) => t.id === next);
                    if (matched?.handle) setRepoBranch(matched.handle);
                  }}
                />
              </FormField>
            ) : null}

            <div className="gm-brand-form-grid-2">
              <FormField label="仓库所有者（repoOwner）">
                <Input
                  aria-label="GitHub 仓库所有者"
                  placeholder="例如：acme-org"
                  value={repoOwner}
                  onChange={(e) => setRepoOwner(e.target.value)}
                />
              </FormField>
              <FormField label="仓库名称（repoName）">
                <Input
                  aria-label="GitHub 仓库名称"
                  placeholder="例如：docs-site"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                />
              </FormField>
            </div>

            <div className="gm-brand-form-grid-3">
              <FormField label="目标分支（branch）">
                <Input
                  aria-label="GitHub 目标分支"
                  placeholder="默认 main"
                  value={repoBranch}
                  onChange={(e) => setRepoBranch(e.target.value)}
                />
              </FormField>
              <FormField label="内容目录（contentDir）">
                <Input
                  aria-label="GitHub 内容目录"
                  placeholder="默认 content/blog"
                  value={contentDir}
                  onChange={(e) => setContentDir(e.target.value)}
                />
              </FormField>
              <FormField label="文件后缀（fileExtension）">
                <Select<'mdx' | 'md'>
                  aria-label="GitHub 文件后缀"
                  className="gm-brand-w-full"
                  value={fileExtension}
                  options={[
                    { value: 'mdx', label: '.mdx' },
                    { value: 'md', label: '.md' },
                  ]}
                  onChange={setFileExtension}
                />
              </FormField>
            </div>

            <div className="gm-brand-form-grid-2">
              <FormField label="公网链接模板（publicUrlTemplate，可选）">
                <Input
                  aria-label="公网链接模板"
                  placeholder="例如：https://docs.example.com/blog/{{slug}}"
                  value={publicUrlTemplate}
                  onChange={(e) => setPublicUrlTemplate(e.target.value)}
                />
              </FormField>
              <FormField label="主站域名（primaryDomain，可选）">
                <Input
                  aria-label="主站域名"
                  placeholder="例如：docs.example.com"
                  value={primaryDomain}
                  onChange={(e) => setPrimaryDomain(e.target.value)}
                />
              </FormField>
            </div>
          </>
        ) : null}

        {provider === 'WECHAT_OFFICIAL' ? (
          <>
            <Alert
              type="info"
              showIcon
              data-testid="wechat-modal-draft-notice"
              message={WECHAT_DRAFT_ONLY_NOTICE}
              description={WECHAT_IP_WHITELIST_NOTICE}
            />
            <div className="gm-brand-form-grid-2">
              <FormField label="微信公众号 AppID">
                <Input
                  aria-label="微信公众号 AppID"
                  autoComplete="off"
                  placeholder={editingConn ? '留空则保留现有加密凭据' : '例如：wx1234567890abcdef'}
                  value={wechatAppId}
                  onChange={(e) => setWechatAppId(e.target.value)}
                />
              </FormField>
              <FormField label="微信公众号 AppSecret">
                <Input.Password
                  aria-label="微信公众号 AppSecret"
                  autoComplete="off"
                  placeholder={editingConn ? '留空则保留现有加密凭据' : '输入开发者密钥 AppSecret'}
                  value={wechatAppSecret}
                  onChange={(e) => setWechatAppSecret(e.target.value)}
                />
              </FormField>
            </div>
            <div className="gm-brand-form-grid-2">
              <FormField label="默认作者名（可选，最多 16 字符）">
                <Input
                  aria-label="公众号默认作者名"
                  maxLength={16}
                  placeholder="例如：品牌编辑部"
                  value={wechatAuthor}
                  onChange={(e) => setWechatAuthor(e.target.value)}
                />
              </FormField>
              <FormField label="默认封面素材 media_id（可选）">
                <Input
                  aria-label="公众号默认封面 media_id"
                  placeholder="留空则使用正文首图或默认封面"
                  value={wechatCoverMediaId}
                  onChange={(e) => setWechatCoverMediaId(e.target.value)}
                />
              </FormField>
            </div>
            <div className="gm-brand-conn-group-box">
              <div className="gm-brand-switch-row">
                <div>
                  <div className="gm-brand-switch-title">草稿默认开启留言</div>
                  <div className="gm-brand-switch-desc">
                    对应微信公众号草稿接口 need_open_comment 字段。
                  </div>
                </div>
                <Switch
                  aria-label="公众号草稿开启留言"
                  checked={wechatNeedOpenComment}
                  onChange={setWechatNeedOpenComment}
                />
              </div>
            </div>
          </>
        ) : null}

        {/* Common Delivery Toggles & Optional IndexNow */}
        {!isShopifyCreateOAuthTab && provider !== 'WECHAT_OFFICIAL' ? (
          <div className="gm-brand-conn-group-box">
            <div className="gm-brand-switch-row">
              <div>
                <div className="gm-brand-switch-title">
                  {provider === 'GITHUB_MDX'
                    ? '默认创建 Draft PR（推荐）'
                    : '默认推送为草稿（推荐）'}
                </div>
                <div className="gm-brand-switch-desc">
                  {provider === 'GITHUB_MDX'
                    ? '开启后新建分支提交 MDX 并生成 Draft PR 审阅；关闭则直接提交至目标分支。'
                    : '开启后在写作台默认以草稿态推送至后台，审核无误后再正式上线。'}
                </div>
              </div>
              <Switch
                aria-label="默认推送为草稿"
                checked={defaultPublishAsDraft}
                onChange={setDefaultPublishAsDraft}
              />
            </div>

            <div className="gm-brand-switch-row">
              <div>
                <div className="gm-brand-switch-title">
                  {provider === 'WORDPRESS'
                    ? '内联注入 Gutenberg JSON-LD 区块'
                    : '内联注入 JSON-LD 结构化数据'}
                </div>
                <div className="gm-brand-switch-desc">
                  自动附带 Article / FAQPage / Product Schema，提升 AI 搜索引擎解析率。
                </div>
              </div>
              <Switch
                aria-label="内联注入 JSON-LD"
                checked={inlineJsonLd}
                onChange={setInlineJsonLd}
              />
            </div>

            <FormField label="IndexNow Key（可选，8–128 位；正式上线后自动通知 Bing / Yandex 收录）">
              <Input
                aria-label="IndexNow Key"
                maxLength={128}
                placeholder="留空则跳过 IndexNow 提交"
                value={indexNowKey}
                onChange={(e) => setIndexNowKey(e.target.value)}
              />
            </FormField>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
