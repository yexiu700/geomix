'use client';

import {
  SITE_NAME,
  formatShanghaiDate,
  formatShanghaiDateTime,
  isSafeDistributionHttpUrl,
  markdownToSanitizedHtml,
  sanitizeRichArticleHtml,
  type PublicPrPacketDto,
  type PublicPrPacketSubmitResultDto,
} from '@geomix/shared';
import { Alert, App, Button, ConfigProvider, Input, Skeleton, Tag } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import type { FormEvent, JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GM, GM_ANTD_THEME } from '../../lib/design-tokens';
import { fetchPublicPrPacket, submitPublicPrPacket } from '../../lib/distribution';
import { GatewayApiError } from '../../lib/envelope';
import { copyTextToClipboard } from '../../lib/studio';

export type PrSharePacketViewProps = {
  token: string;
};

type DraftViewMode = 'preview' | 'markdown' | 'html';

type LoadErrorKind = 'not_found' | 'rate_limited' | 'generic';

type CopyDict = {
  badgeLabel: string;
  readOnlyNotice: string;
  marketLabel: string;
  expiresPrefix: string;
  factSectionTitle: string;
  factSectionDesc: string;
  factColTitle: string;
  factColSummary: string;
  factEmpty: string;
  briefSectionTitle: string;
  briefSectionDesc: string;
  suggestedTitleLabel: string;
  targetPromptLabel: string;
  keyAnglesLabel: string;
  targetFanOutsLabel: string;
  draftSectionTitle: string;
  draftSectionDesc: string;
  tabPreview: string;
  tabMarkdown: string;
  tabHtml: string;
  copyMarkdown: string;
  copyHtml: string;
  copied: string;
  copyFailed: string;
  submitSectionTitle: string;
  submitSectionDesc: string;
  urlLabel: string;
  urlPlaceholder: string;
  noteLabel: string;
  notePlaceholder: string;
  submitBtn: string;
  submittingBtn: string;
  updateUrlHint: string;
  receiptTitle: string;
  receiptAlreadyRecordedTitle: string;
  receiptInitialTitle: string;
  receiptBody: string;
  receiptAlreadyRecordedBody: string;
  receiptInitialBody: string;
  receiptUrlLabel: string;
  receiptTimeLabel: string;
  errInvalidUrl: string;
  errBadRequestUrl: string;
  errExpiredDuringSubmit: string;
  errRateLimitedSubmit: string;
  errGenericSubmit: string;
};

const EN_COPY: CopyDict = {
  badgeLabel: 'PR / KOL Collaboration Brief',
  readOnlyNotice: 'Read-only media kit · No sign-in required',
  marketLabel: 'GLOBAL',
  expiresPrefix: 'Valid through',
  factSectionTitle: 'Brand Overview & Verified Core Facts',
  factSectionDesc:
    'Please treat the verified facts below as the single source of truth for specifications, metrics, and claims.',
  factColTitle: 'Fact Item',
  factColSummary: 'Verified Details',
  factEmpty: 'No verified fact rows are attached to this packet yet.',
  briefSectionTitle: 'Topic Brief & Suggested Angles',
  briefSectionDesc: 'Recommended framing and sub-questions to improve AI answer coverage.',
  suggestedTitleLabel: 'Suggested Headline',
  targetPromptLabel: 'Target User Query',
  keyAnglesLabel: 'Key Editorial Angles',
  targetFanOutsLabel: 'Target Sub-Questions',
  draftSectionTitle: 'Reference Draft Body',
  draftSectionDesc:
    'Review the formatted reference draft or copy clean Markdown / HTML directly into your publishing workflow.',
  tabPreview: 'Preview',
  tabMarkdown: 'Markdown',
  tabHtml: 'HTML',
  copyMarkdown: 'Copy Markdown',
  copyHtml: 'Copy HTML',
  copied: 'Copied',
  copyFailed: 'Copy failed — please select text manually.',
  submitSectionTitle: 'Submit Published URL',
  submitSectionDesc:
    'Once your article is live, paste the public article URL below so the brand team can verify indexing and track AI visibility.',
  urlLabel: 'Published Article URL',
  urlPlaceholder: 'https://publication.example.com/articles/brand-review',
  noteLabel: 'Optional Note',
  notePlaceholder: 'Optional note (e.g., author byline, section, or publication timing)',
  submitBtn: 'Submit Published URL',
  submittingBtn: 'Submitting…',
  updateUrlHint: 'Need to register a revised URL? You can submit an updated public link below.',
  receiptTitle: 'Published URL Recorded',
  receiptAlreadyRecordedTitle: 'Published URL Already Recorded',
  receiptInitialTitle: 'Previously Submitted URL',
  receiptBody:
    'Thank you! Your published URL has been registered for automatic indexing and visibility tracking.',
  receiptAlreadyRecordedBody:
    'This exact URL was already recorded earlier — no duplicate submission is needed.',
  receiptInitialBody:
    'A published URL is already on file for this collaboration brief. You may submit another public link below if the final URL changed.',
  receiptUrlLabel: 'Registered URL',
  receiptTimeLabel: 'Recorded At',
  errInvalidUrl: 'Please enter a valid public http:// or https:// article URL.',
  errBadRequestUrl:
    'This URL cannot be accepted. Please provide a publicly accessible http:// or https:// web page URL.',
  errExpiredDuringSubmit:
    'This collaboration link has expired or been revoked. Please contact the brand team for a new link.',
  errRateLimitedSubmit: 'Too many submissions in a short period. Please wait a moment and retry.',
  errGenericSubmit: 'Unable to submit the published URL right now. Please try again shortly.',
};

const CN_COPY: CopyDict = {
  badgeLabel: 'PR / KOL 外部协作包',
  readOnlyNotice: '只读对外媒体素材包 · 无需登录账号',
  marketLabel: '国内市场（CN）',
  expiresPrefix: '链接有效期至',
  factSectionTitle: '品牌概览与已验证核心事实参数表',
  factSectionDesc: '以下核心事实卡为本次合作的唯一事实基准，请引用参数与卖点时保持一致。',
  factColTitle: '核心事实项',
  factColSummary: '核验详情',
  factEmpty: '当前协作包暂未附带结构化事实卡条目。',
  briefSectionTitle: '选题 Brief 与核心切入角度',
  briefSectionDesc: '围绕目标用户提问与关键细分问题组织评测或报道内容，有助于提升 AI 检索引用率。',
  suggestedTitleLabel: '建议标题',
  targetPromptLabel: '目标用户提问',
  keyAnglesLabel: '核心角度建议',
  targetFanOutsLabel: '覆盖子问题标签',
  draftSectionTitle: '参考成稿正文',
  draftSectionDesc: '可切换排版预览或源码视图，支持一键复制 Markdown 或 HTML 正文。',
  tabPreview: '排版预览',
  tabMarkdown: 'Markdown',
  tabHtml: 'HTML',
  copyMarkdown: '复制 Markdown',
  copyHtml: '复制 HTML',
  copied: '已复制',
  copyFailed: '复制失败，请手动选中文本复制。',
  submitSectionTitle: '提交上线文章链接',
  submitSectionDesc:
    '文章正式上线后，请回填公开可访问的文章 URL，系统将自动关联收录体检与效果追踪。',
  urlLabel: '上线文章链接',
  urlPlaceholder: 'https://media.example.com/articles/brand-review',
  noteLabel: '补充说明（选填）',
  notePlaceholder: '选填说明（如作者署名、发布专栏或上线补充信息）',
  submitBtn: '提交上线链接',
  submittingBtn: '提交中…',
  updateUrlHint: '如正式上线链接有变更，可在下方重新提交新的公开文章链接。',
  receiptTitle: '上线链接已登记成功',
  receiptAlreadyRecordedTitle: '该上线链接已登记过',
  receiptInitialTitle: '已登记的上线文章链接',
  receiptBody: '感谢配合！系统已自动登记该上线链接，并启动后续收录与可见度追踪。',
  receiptAlreadyRecordedBody: '该链接此前已成功登记，无需重复提交。',
  receiptInitialBody: '该协作包已有已登记的上线链接；如文章地址有更新，可在下方提交新链接。',
  receiptUrlLabel: '已登记链接',
  receiptTimeLabel: '登记时间',
  errInvalidUrl: '请输入有效的 http:// 或 https:// 公开文章链接。',
  errBadRequestUrl: '提交的链接无法通过校验，请提供公开可访问的 http:// 或 https:// 网页地址。',
  errExpiredDuringSubmit: '该协作链接已过期或已被撤销，请联系品牌方重新获取分享链接。',
  errRateLimitedSubmit: '提交过于频繁，请稍候片刻后再试。',
  errGenericSubmit: '提交上线链接失败，请稍后重试。',
};

function classifyLoadError(err: unknown): LoadErrorKind {
  if (err instanceof GatewayApiError) {
    if (err.status === 404) return 'not_found';
    if (err.status === 429) return 'rate_limited';
  }
  return 'generic';
}

export function PrSharePacketView({ token }: PrSharePacketViewProps): JSX.Element {
  const [packet, setPacket] = useState<PublicPrPacketDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadErrorKind | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [viewMode, setViewMode] = useState<DraftViewMode>('preview');
  const [copiedTarget, setCopiedTarget] = useState<'markdown' | 'html' | null>(null);
  const [copyFeedbackError, setCopyFeedbackError] = useState<string | null>(null);

  const [publishedUrl, setPublishedUrl] = useState('');
  const [note, setNote] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitReceipt, setSubmitReceipt] = useState<PublicPrPacketSubmitResultDto | null>(null);

  const tokenEpochRef = useRef(0);
  const submittingRef = useRef(false);
  const submitCtrlRef = useRef<AbortController | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isGlobal = packet ? packet.market === 'GLOBAL' : true;
  const copy = isGlobal ? EN_COPY : CN_COPY;

  useEffect(() => {
    tokenEpochRef.current += 1;
    submitCtrlRef.current?.abort();
    submitCtrlRef.current = null;
    submittingRef.current = false;
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }

    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);
    setSubmitReceipt(null);
    setSubmitError(null);
    setSubmitting(false);
    setPublishedUrl('');
    setNote('');
    setViewMode('preview');
    setCopiedTarget(null);
    setCopyFeedbackError(null);

    void (async () => {
      try {
        const data = await fetchPublicPrPacket(token, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        setPacket(data);
        setLoadError(null);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setPacket(null);
        setLoadError(classifyLoadError(err));
      } finally {
        if (!ctrl.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => {
      tokenEpochRef.current += 1;
      ctrl.abort();
      submitCtrlRef.current?.abort();
      submitCtrlRef.current = null;
      submittingRef.current = false;
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, [token, reloadNonce]);

  // Update document title and lang attribute dynamically based on packet market, restoring on unmount
  useEffect(() => {
    if (!packet || typeof document === 'undefined') return;
    const prevTitle = document.title;
    const prevLang = document.documentElement.lang;
    const nextLang = packet.market === 'GLOBAL' ? 'en' : 'zh-CN';
    const nextTitle =
      packet.market === 'GLOBAL'
        ? `${packet.brandName} · PR / KOL Media Brief · ${SITE_NAME}`
        : `${packet.brandName} · PR / KOL 协作包 · ${SITE_NAME}`;
    document.title = nextTitle;
    document.documentElement.lang = nextLang;
    return () => {
      document.title = prevTitle;
      document.documentElement.lang = prevLang;
    };
  }, [packet]);

  const safeDraftHtml = useMemo(() => {
    if (!packet) return '';
    if (packet.draftHtml && packet.draftHtml.trim().length > 0) {
      return sanitizeRichArticleHtml(packet.draftHtml).contentHtml;
    }
    return markdownToSanitizedHtml(packet.draftMarkdown);
  }, [packet]);

  const handleCopy = useCallback(
    async (target: 'markdown' | 'html') => {
      if (!packet) return;
      const epoch = tokenEpochRef.current;
      const text = target === 'markdown' ? packet.draftMarkdown : safeDraftHtml;
      setCopyFeedbackError(null);
      const ok = await copyTextToClipboard(text);
      if (epoch !== tokenEpochRef.current) return;
      if (!ok) {
        setCopyFeedbackError(copy.copyFailed);
        return;
      }
      setCopiedTarget(target);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        if (epoch === tokenEpochRef.current) {
          setCopiedTarget(null);
        }
      }, 2200);
    },
    [packet, safeDraftHtml, copy.copyFailed],
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!packet || submittingRef.current) return;
    const trimmedUrl = publishedUrl.trim();
    const trimmedNote = note.trim();

    if (!isSafeDistributionHttpUrl(trimmedUrl)) {
      setSubmitError(copy.errInvalidUrl);
      return;
    }

    const epoch = tokenEpochRef.current;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    submitCtrlRef.current?.abort();
    const ctrl = new AbortController();
    submitCtrlRef.current = ctrl;

    try {
      const result = await submitPublicPrPacket(
        token,
        trimmedNote
          ? { publishedUrl: trimmedUrl, note: trimmedNote }
          : { publishedUrl: trimmedUrl },
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || epoch !== tokenEpochRef.current) return;
      setSubmitReceipt(result);
      setPacket((prev) =>
        prev
          ? {
              ...prev,
              submittedUrl: result.publishedUrl,
              status: 'PUBLISHED',
            }
          : prev,
      );
      setPublishedUrl('');
      setNote('');
    } catch (err) {
      if (ctrl.signal.aborted || epoch !== tokenEpochRef.current) return;
      if (err instanceof GatewayApiError) {
        if (err.status === 400) {
          setSubmitError(copy.errBadRequestUrl);
        } else if (err.status === 404) {
          setSubmitError(copy.errExpiredDuringSubmit);
        } else if (err.status === 429) {
          setSubmitError(copy.errRateLimitedSubmit);
        } else {
          setSubmitError(copy.errGenericSubmit);
        }
      } else {
        setSubmitError(copy.errGenericSubmit);
      }
    } finally {
      if (submitCtrlRef.current === ctrl) {
        submitCtrlRef.current = null;
      }
      if (epoch === tokenEpochRef.current) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  const activeReceiptUrl = submitReceipt?.publishedUrl ?? packet?.submittedUrl ?? null;
  const safeReceiptHref =
    activeReceiptUrl && isSafeDistributionHttpUrl(activeReceiptUrl) ? activeReceiptUrl : undefined;

  return (
    <ConfigProvider
      locale={isGlobal ? enUS : zhCN}
      theme={GM_ANTD_THEME}
      button={{ autoInsertSpace: false }}
    >
      <App>
        <main
          data-testid="pr-share-page"
          style={{
            minHeight: '100vh',
            background: 'var(--gm-bg-base, #0A0C0B)',
            color: 'var(--gm-fg-1, #E8ECEA)',
            padding: '28px 20px 64px',
            boxSizing: 'border-box',
            overflowX: 'hidden',
          }}
        >
          <div
            style={{
              maxWidth: 1040,
              margin: '0 auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
              minWidth: 0,
            }}
          >
            {loading ? (
              <section
                className="gm-panel"
                aria-busy="true"
                data-testid="pr-share-loading"
                style={{
                  padding: 24,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 20,
                }}
              >
                <Skeleton active title={{ width: '42%' }} paragraph={{ rows: 2 }} />
                <Skeleton active title={{ width: '28%' }} paragraph={{ rows: 4 }} />
                <Skeleton active title={{ width: '32%' }} paragraph={{ rows: 5 }} />
              </section>
            ) : loadError || !packet ? (
              <section
                className="gm-panel"
                data-testid="pr-share-error-state"
                style={{
                  padding: '36px 28px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 14,
                  maxWidth: 680,
                  margin: '40px auto 0',
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              >
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    color: GM.fg.f3,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                  }}
                >
                  <span>{SITE_NAME}</span>
                  <span>·</span>
                  <span>PR / KOL Media Brief</span>
                </div>

                {loadError === 'not_found' ? (
                  <>
                    <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: GM.fg.f1 }}>
                      Collaboration Link Unavailable · 协作链接已失效
                    </h1>
                    <p style={{ margin: 0, color: GM.fg.f2, lineHeight: 1.65 }}>
                      This collaboration link is invalid, expired, or has been revoked by the brand
                      team. Please request a fresh share link from your contact.
                    </p>
                    <p style={{ margin: 0, color: GM.fg.f3, lineHeight: 1.65 }}>
                      该外部协作链接不存在、已过期或已被品牌方撤销。请联系品牌对接人重新生成分享链接。
                    </p>
                  </>
                ) : loadError === 'rate_limited' ? (
                  <>
                    <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: GM.fg.f1 }}>
                      Too Many Requests · 访问过于频繁
                    </h1>
                    <p style={{ margin: 0, color: GM.fg.f2, lineHeight: 1.65 }}>
                      We received too many requests in a short period. Please wait a moment and try
                      reloading this media brief.
                    </p>
                    <p style={{ margin: 0, color: GM.fg.f3, lineHeight: 1.65 }}>
                      当前访问频率过高，请稍候片刻后点击下方按钮重新加载。
                    </p>
                    <Button
                      type="primary"
                      onClick={() => setReloadNonce((n) => n + 1)}
                      style={{ marginTop: 4 }}
                    >
                      Retry / 重新加载
                    </Button>
                  </>
                ) : (
                  <>
                    <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: GM.fg.f1 }}>
                      Unable to Load Media Brief · 暂时无法加载协作包
                    </h1>
                    <p style={{ margin: 0, color: GM.fg.f2, lineHeight: 1.65 }}>
                      We encountered a temporary issue while loading this brief. Please check your
                      network connection and try again.
                    </p>
                    <p style={{ margin: 0, color: GM.fg.f3, lineHeight: 1.65 }}>
                      加载外部协作包时遇到临时网络异常，请稍后重试。
                    </p>
                    <Button
                      type="primary"
                      onClick={() => setReloadNonce((n) => n + 1)}
                      style={{ marginTop: 4 }}
                    >
                      Retry / 重新加载
                    </Button>
                  </>
                )}
              </section>
            ) : (
              <>
                {/* 1. Header Card */}
                <header
                  className="gm-panel"
                  style={{
                    padding: '22px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 14,
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        gap: 8,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: GM.phosphor,
                          letterSpacing: '0.04em',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {SITE_NAME}
                      </span>
                      <span style={{ color: GM.fg.f4 }}>·</span>
                      <span style={{ fontSize: 12, color: GM.fg.f2, whiteSpace: 'nowrap' }}>
                        {copy.badgeLabel}
                      </span>
                      <Tag
                        color={isGlobal ? 'blue' : 'cyan'}
                        style={{ margin: 0, whiteSpace: 'nowrap' }}
                      >
                        {copy.marketLabel}
                      </Tag>
                      {packet.channelLabel ? (
                        <Tag color="geekblue" style={{ margin: 0, whiteSpace: 'nowrap' }}>
                          {packet.channelLabel}
                        </Tag>
                      ) : null}
                    </div>

                    <div
                      style={{
                        fontSize: 12,
                        color: GM.fg.f3,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {copy.expiresPrefix}:{' '}
                      <span className="gm-num" style={{ color: GM.fg.f2 }}>
                        {formatShanghaiDate(packet.expiresAt)}
                      </span>
                    </div>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 12,
                      minWidth: 0,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: '1 1 320px' }}>
                      <h1
                        style={{
                          margin: 0,
                          fontSize: 24,
                          fontWeight: 600,
                          color: GM.fg.f1,
                          lineHeight: 1.3,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {packet.brandName}
                      </h1>
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 13,
                          color: GM.fg.f2,
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 10,
                          alignItems: 'center',
                        }}
                      >
                        {packet.category ? (
                          <>
                            <span>{packet.category}</span>
                            <span style={{ color: GM.fg.f4 }}>•</span>
                          </>
                        ) : null}
                        <span style={{ color: GM.fg.f3 }}>{copy.readOnlyNotice}</span>
                      </div>
                    </div>
                  </div>
                </header>

                {/* 2. Verified Core Fact Spec Table */}
                <section
                  className="gm-panel"
                  aria-label={copy.factSectionTitle}
                  style={{
                    padding: '20px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    minWidth: 0,
                  }}
                >
                  <div>
                    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: GM.fg.f1 }}>
                      {copy.factSectionTitle}
                    </h2>
                    <p style={{ margin: '4px 0 0', fontSize: 13, color: GM.fg.f3 }}>
                      {copy.factSectionDesc}
                    </p>
                  </div>

                  {packet.verifiedFacts.length === 0 ? (
                    <div
                      data-testid="pr-share-fact-table"
                      style={{
                        padding: '14px 16px',
                        borderRadius: 8,
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        color: GM.fg.f3,
                        fontSize: 13,
                      }}
                    >
                      {copy.factEmpty}
                    </div>
                  ) : (
                    <div
                      style={{
                        width: '100%',
                        overflowX: 'auto',
                        borderRadius: 8,
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                      }}
                    >
                      <table
                        data-testid="pr-share-fact-table"
                        style={{
                          width: '100%',
                          borderCollapse: 'collapse',
                          fontSize: 13,
                          textAlign: 'left',
                        }}
                      >
                        <thead>
                          <tr
                            style={{
                              background: 'var(--gm-bg-elevated, #171B1A)',
                              borderBottom: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                            }}
                          >
                            <th
                              style={{
                                padding: '10px 14px',
                                fontWeight: 600,
                                color: GM.fg.f2,
                                width: '28%',
                                minWidth: 160,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {copy.factColTitle}
                            </th>
                            <th
                              style={{
                                padding: '10px 14px',
                                fontWeight: 600,
                                color: GM.fg.f2,
                              }}
                            >
                              {copy.factColSummary}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {packet.verifiedFacts.map((fact, idx) => (
                            <tr
                              key={`${fact.title}-${idx}`}
                              style={{
                                borderBottom:
                                  idx < packet.verifiedFacts.length - 1
                                    ? '1px solid var(--gm-line-1, rgba(255,255,255,0.06))'
                                    : undefined,
                              }}
                            >
                              <td
                                style={{
                                  padding: '10px 14px',
                                  fontWeight: 500,
                                  color: GM.fg.f1,
                                  verticalAlign: 'top',
                                  overflowWrap: 'anywhere',
                                }}
                              >
                                {fact.title}
                              </td>
                              <td
                                style={{
                                  padding: '10px 14px',
                                  color: GM.fg.f2,
                                  lineHeight: 1.6,
                                  verticalAlign: 'top',
                                  overflowWrap: 'anywhere',
                                }}
                              >
                                {fact.summary}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* 3. Topic Brief & Suggested Angles */}
                <section
                  className="gm-panel"
                  aria-label={copy.briefSectionTitle}
                  style={{
                    padding: '20px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 14,
                    minWidth: 0,
                  }}
                >
                  <div>
                    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: GM.fg.f1 }}>
                      {copy.briefSectionTitle}
                    </h2>
                    <p style={{ margin: '4px 0 0', fontSize: 13, color: GM.fg.f3 }}>
                      {copy.briefSectionDesc}
                    </p>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                      gap: 14,
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        padding: '12px 14px',
                        borderRadius: 8,
                        background: 'var(--gm-bg-elevated, #171B1A)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: 12, color: GM.fg.f3, marginBottom: 6 }}>
                        {copy.suggestedTitleLabel}
                      </div>
                      <div
                        style={{
                          fontSize: 15,
                          fontWeight: 600,
                          color: GM.fg.f1,
                          lineHeight: 1.45,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {packet.suggestedTitle}
                      </div>
                    </div>

                    <div
                      style={{
                        padding: '12px 14px',
                        borderRadius: 8,
                        background: 'var(--gm-bg-elevated, #171B1A)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: 12, color: GM.fg.f3, marginBottom: 6 }}>
                        {copy.targetPromptLabel}
                      </div>
                      <div
                        style={{
                          fontSize: 14,
                          color: GM.fg.f2,
                          lineHeight: 1.5,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {packet.targetPrompt}
                      </div>
                    </div>
                  </div>

                  {packet.keyAngles.length > 0 ? (
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: GM.fg.f2,
                          marginBottom: 8,
                        }}
                      >
                        {copy.keyAnglesLabel}
                      </div>
                      <ul
                        style={{
                          margin: 0,
                          paddingLeft: 18,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          color: GM.fg.f2,
                          fontSize: 13,
                          lineHeight: 1.6,
                        }}
                      >
                        {packet.keyAngles.map((angle, idx) => (
                          <li key={`${angle}-${idx}`} style={{ overflowWrap: 'anywhere' }}>
                            {angle}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {packet.targetFanOuts.length > 0 ? (
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: GM.fg.f2,
                          marginBottom: 8,
                        }}
                      >
                        {copy.targetFanOutsLabel}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {packet.targetFanOuts.map((fanOut, idx) => (
                          <Tag
                            key={`${fanOut}-${idx}`}
                            style={{
                              margin: 0,
                              whiteSpace: 'normal',
                              overflowWrap: 'anywhere',
                              lineHeight: 1.45,
                              padding: '2px 10px',
                            }}
                          >
                            {fanOut}
                          </Tag>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </section>

                {/* 4. Reference Draft Body */}
                <section
                  className="gm-panel"
                  aria-label={copy.draftSectionTitle}
                  style={{
                    padding: '20px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 14,
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      minWidth: 0,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: GM.fg.f1 }}>
                        {copy.draftSectionTitle}
                      </h2>
                      <p style={{ margin: '4px 0 0', fontSize: 13, color: GM.fg.f3 }}>
                        {copy.draftSectionDesc}
                      </p>
                    </div>

                    <div
                      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}
                    >
                      <div
                        role="tablist"
                        aria-label={copy.draftSectionTitle}
                        style={{ display: 'inline-flex', gap: 4 }}
                      >
                        {(
                          [
                            ['preview', copy.tabPreview],
                            ['markdown', copy.tabMarkdown],
                            ['html', copy.tabHtml],
                          ] as const
                        ).map(([mode, label]) => (
                          <Button
                            key={mode}
                            size="small"
                            type={viewMode === mode ? 'primary' : 'default'}
                            role="tab"
                            aria-selected={viewMode === mode}
                            onClick={() => setViewMode(mode)}
                            style={{ whiteSpace: 'nowrap' }}
                          >
                            {label}
                          </Button>
                        ))}
                      </div>

                      <Button
                        size="small"
                        onClick={() => void handleCopy('markdown')}
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        {copiedTarget === 'markdown' ? copy.copied : copy.copyMarkdown}
                      </Button>
                      <Button
                        size="small"
                        onClick={() => void handleCopy('html')}
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        {copiedTarget === 'html' ? copy.copied : copy.copyHtml}
                      </Button>
                    </div>
                  </div>

                  {copyFeedbackError ? (
                    <Alert type="warning" showIcon message={copyFeedbackError} />
                  ) : null}

                  {viewMode === 'preview' ? (
                    <div
                      data-testid="pr-share-draft-preview"
                      style={{
                        padding: '18px 20px',
                        borderRadius: 8,
                        background: 'var(--gm-bg-elevated, #171B1A)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        color: GM.fg.f1,
                        lineHeight: 1.75,
                        fontSize: 14,
                        overflowWrap: 'anywhere',
                        minWidth: 0,
                      }}
                      dangerouslySetInnerHTML={{ __html: safeDraftHtml }}
                    />
                  ) : (
                    <pre
                      data-testid={
                        viewMode === 'markdown' ? 'pr-share-draft-markdown' : 'pr-share-draft-html'
                      }
                      style={{
                        margin: 0,
                        padding: '16px 18px',
                        borderRadius: 8,
                        background: 'var(--gm-bg-elevated, #171B1A)',
                        border: '1px solid var(--gm-line-1, rgba(255,255,255,0.06))',
                        color: GM.fg.f2,
                        fontSize: 12.5,
                        lineHeight: 1.65,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        overflowX: 'auto',
                        fontFamily: 'var(--gm-font-mono, monospace)',
                      }}
                    >
                      {viewMode === 'markdown' ? packet.draftMarkdown : safeDraftHtml}
                    </pre>
                  )}
                </section>

                {/* 5. Submit Published URL Card */}
                <section
                  className="gm-panel"
                  aria-label={copy.submitSectionTitle}
                  data-testid="pr-share-submit-form"
                  style={{
                    padding: '22px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 16,
                    minWidth: 0,
                  }}
                >
                  <div>
                    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: GM.fg.f1 }}>
                      {copy.submitSectionTitle}
                    </h2>
                    <p style={{ margin: '4px 0 0', fontSize: 13, color: GM.fg.f3 }}>
                      {copy.submitSectionDesc}
                    </p>
                  </div>

                  {activeReceiptUrl ? (
                    <div
                      data-testid="pr-share-receipt"
                      style={{
                        padding: '14px 16px',
                        borderRadius: 8,
                        background: 'rgba(61, 224, 200, 0.08)',
                        border: '1px solid rgba(61, 224, 200, 0.3)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        minWidth: 0,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <Tag color="green" style={{ margin: 0, whiteSpace: 'nowrap' }}>
                          {submitReceipt
                            ? submitReceipt.alreadyRecorded
                              ? copy.receiptAlreadyRecordedTitle
                              : copy.receiptTitle
                            : copy.receiptInitialTitle}
                        </Tag>
                        {submitReceipt?.submittedAt ? (
                          <span style={{ fontSize: 12, color: GM.fg.f3 }}>
                            {copy.receiptTimeLabel}:{' '}
                            <span className="gm-num" style={{ color: GM.fg.f2 }}>
                              {formatShanghaiDateTime(submitReceipt.submittedAt)}
                            </span>
                          </span>
                        ) : null}
                      </div>

                      <div style={{ fontSize: 13, color: GM.fg.f2, lineHeight: 1.55 }}>
                        {submitReceipt
                          ? submitReceipt.alreadyRecorded
                            ? copy.receiptAlreadyRecordedBody
                            : copy.receiptBody
                          : copy.receiptInitialBody}
                      </div>

                      <div
                        style={{
                          fontSize: 13,
                          color: GM.fg.f2,
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 6,
                          alignItems: 'baseline',
                          minWidth: 0,
                        }}
                      >
                        <span style={{ color: GM.fg.f3, whiteSpace: 'nowrap' }}>
                          {copy.receiptUrlLabel}:
                        </span>
                        {safeReceiptHref ? (
                          <a
                            href={safeReceiptHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: GM.sig.cited,
                              textDecoration: 'underline',
                              overflowWrap: 'anywhere',
                            }}
                          >
                            {activeReceiptUrl}
                          </a>
                        ) : (
                          <span style={{ overflowWrap: 'anywhere' }}>{activeReceiptUrl}</span>
                        )}
                      </div>
                    </div>
                  ) : null}

                  <form
                    onSubmit={(e) => void handleSubmit(e)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      minWidth: 0,
                    }}
                  >
                    {activeReceiptUrl ? (
                      <div style={{ fontSize: 12, color: GM.fg.f3 }}>{copy.updateUrlHint}</div>
                    ) : null}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label
                        htmlFor="pr-share-url-input"
                        style={{ fontSize: 13, fontWeight: 500, color: GM.fg.f1 }}
                      >
                        {copy.urlLabel}
                      </label>
                      <Input
                        id="pr-share-url-input"
                        data-testid="pr-share-url-input"
                        aria-label={copy.urlLabel}
                        placeholder={copy.urlPlaceholder}
                        value={publishedUrl}
                        disabled={submitting}
                        status={submitError ? 'error' : undefined}
                        onChange={(e) => {
                          setPublishedUrl(e.target.value);
                          if (submitError) setSubmitError(null);
                        }}
                      />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label
                        htmlFor="pr-share-note-input"
                        style={{ fontSize: 13, fontWeight: 500, color: GM.fg.f2 }}
                      >
                        {copy.noteLabel}
                      </label>
                      <Input.TextArea
                        id="pr-share-note-input"
                        data-testid="pr-share-note-input"
                        aria-label={copy.noteLabel}
                        placeholder={copy.notePlaceholder}
                        rows={2}
                        maxLength={300}
                        value={note}
                        disabled={submitting}
                        onChange={(e) => setNote(e.target.value)}
                      />
                    </div>

                    {submitError ? (
                      <Alert type="error" showIcon message={submitError} role="alert" />
                    ) : null}

                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Button
                        type="primary"
                        htmlType="submit"
                        data-testid="pr-share-submit-btn"
                        loading={submitting}
                        disabled={submitting}
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        {submitting ? copy.submittingBtn : copy.submitBtn}
                      </Button>
                    </div>
                  </form>
                </section>
              </>
            )}
          </div>
        </main>
      </App>
    </ConfigProvider>
  );
}
