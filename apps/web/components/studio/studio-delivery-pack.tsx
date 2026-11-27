'use client';

import {
  buildCrawlerChecklist,
  buildGeoSchemaJsonLd,
  buildLlmsTxtSnippet,
  evaluateDistributionPreflight,
  htmlToExportMarkdown,
  markdownToSanitizedHtml,
  sanitizeRichArticleHtml,
  serializeJsonLdSafe,
  type GeoArticleRecord,
  type GeoBriefChannelRecommendation,
  type GeoEvaluationResult,
  type GeoMarket,
} from '@geomix/shared';
import { Button } from 'antd';
import type { JSX, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { GatewayApiError } from '../../lib/envelope';
import { copyTextToClipboard, exportArticleFile } from '../../lib/studio';
import { triggerBlobDownload } from '../../lib/ux-foundation';
import { useUxFeedback } from '../crud/ux-feedback';
import { Explain, StatusBadge } from '../ui';

export type StudioDeliveryPackProps = {
  activeMarket: GeoMarket;
  localBrandName: string;
  category?: string;
  localCategory?: string | null;
  ownedDomains?: readonly string[];
  brandNames?: readonly string[];
  matchedFactCount?: number;
  readOnly?: boolean;
  article: GeoArticleRecord | null;
  evaluation: GeoEvaluationResult | null;
  linkedBriefChannels?: readonly GeoBriefChannelRecommendation[];
  streaming: boolean;
  onOpenDistributionDrawer?: () => void;
};

const JSON_TOKEN_RE =
  /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|[{}\[\],:])/g;

function highlightJsonLines(jsonText: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let keyIdx = 0;
  let match: RegExpExecArray | null;
  JSON_TOKEN_RE.lastIndex = 0;

  while ((match = JSON_TOKEN_RE.exec(jsonText)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(jsonText.slice(lastIndex, match.index));
    }
    const token = match[0];
    let cls = 'gm-json-punct';
    if (token.startsWith('"')) {
      cls = token.endsWith(':') ? 'gm-json-key' : 'gm-json-str';
    } else if (token === 'true' || token === 'false' || token === 'null') {
      cls = 'gm-json-bool';
    } else if (/^-?\d/.test(token)) {
      cls = 'gm-json-num';
    }
    nodes.push(
      <span key={keyIdx++} className={cls}>
        {token}
      </span>,
    );
    lastIndex = match.index + token.length;
  }
  if (lastIndex < jsonText.length) {
    nodes.push(jsonText.slice(lastIndex));
  }
  return nodes;
}

export function StudioDeliveryPack({
  activeMarket,
  localBrandName,
  category,
  localCategory,
  ownedDomains,
  brandNames,
  matchedFactCount,
  article,
  evaluation,
  linkedBriefChannels: _linkedBriefChannels,
  streaming,
}: StudioDeliveryPackProps): JSX.Element {
  const feedback = useUxFeedback();
  const [downloadingDocx, setDownloadingDocx] = useState(false);
  const [showJsonLdPreview, setShowJsonLdPreview] = useState(activeMarket === 'GLOBAL');
  const downloadingDocxRef = useRef(false);
  const exportCtrlRef = useRef<AbortController | null>(null);
  const contextKeyRef = useRef(0);

  useEffect(() => {
    contextKeyRef.current += 1;
    exportCtrlRef.current?.abort();
    exportCtrlRef.current = null;
    downloadingDocxRef.current = false;
    setDownloadingDocx(false);
    setShowJsonLdPreview(activeMarket === 'GLOBAL');
    return () => {
      exportCtrlRef.current?.abort();
      exportCtrlRef.current = null;
      downloadingDocxRef.current = false;
    };
  }, [activeMarket, article?.id]);

  const schemaObj = useMemo<Record<string, unknown> | null>(() => {
    if (!article) return null;
    if (evaluation?.schemaJsonLd && '@context' in evaluation.schemaJsonLd) {
      return evaluation.schemaJsonLd;
    }
    if (article.schemaJsonLd && '@context' in article.schemaJsonLd) {
      return article.schemaJsonLd;
    }
    return buildGeoSchemaJsonLd({
      market: activeMarket,
      localBrandName: localBrandName || 'Brand',
      category,
      localCategory,
      title: article.title,
      targetPrompt: article.targetPrompt,
      contentMarkdown: article.contentMarkdown,
    });
  }, [activeMarket, article, category, evaluation?.schemaJsonLd, localBrandName, localCategory]);

  const safeJsonLdText = useMemo(
    () => (schemaObj ? serializeJsonLdSafe(schemaObj) : ''),
    [schemaObj],
  );

  const highlightedJsonNodes = useMemo(
    () => (showJsonLdPreview && safeJsonLdText ? highlightJsonLines(safeJsonLdText) : null),
    [safeJsonLdText, showJsonLdPreview],
  );

  const llmsTxt = useMemo<string | null>(() => {
    if (activeMarket !== 'GLOBAL' || !article) return null;
    if (evaluation?.llmsTxtSnippet) return evaluation.llmsTxtSnippet;
    if (article.llmsTxtSnippet) return article.llmsTxtSnippet;
    return buildLlmsTxtSnippet({
      market: 'GLOBAL',
      localBrandName: localBrandName || 'Brand',
      category,
      localCategory,
      ownedDomains,
      title: article.title,
      targetPrompt: article.targetPrompt,
      contentMarkdown: article.contentMarkdown,
    });
  }, [
    activeMarket,
    article,
    category,
    evaluation?.llmsTxtSnippet,
    localBrandName,
    localCategory,
    ownedDomains,
  ]);

  const crawlerChecklist = useMemo(
    () => evaluation?.crawlerChecklist ?? buildCrawlerChecklist(activeMarket),
    [activeMarket, evaluation?.crawlerChecklist],
  );

  const preflight = useMemo(
    () =>
      article
        ? evaluateDistributionPreflight({
            market: activeMarket,
            targetLocale: article.targetLocale ?? undefined,
            title: article.title,
            contentMarkdown: article.contentMarkdown,
            brandNames,
            complianceFlags: article.complianceFlags,
            geoScore: evaluation?.geoScore ?? article.geoScore,
            matchedFactCount,
          })
        : null,
    [activeMarket, article, brandNames, evaluation?.geoScore, matchedFactCount],
  );

  const runWithPlaceholderGuard = (actionLabel: string, proceed: () => void): void => {
    if (!preflight) {
      proceed();
      return;
    }
    if (!preflight.ok) {
      const summary = preflight.blockers.map((item) => item.message).join('；');
      if (activeMarket === 'GLOBAL') {
        feedback.confirm({
          title: '发布前体检存在阻断项',
          content: `${summary}。建议先在中栏补填真实数据或清理异常字符；确定仍要继续${actionLabel}吗？`,
          okText: `仍然${actionLabel}`,
          cancelText: '返回补填',
          okButtonProps: { danger: true },
          onOk: () => proceed(),
        });
        return;
      }
      feedback.notifyWarning(`发布前体检提示：${summary}`);
      proceed();
      return;
    }
    if (preflight.warnings.length > 0) {
      const warningSummary = preflight.warnings.map((item) => item.message).join('；');
      feedback.notifyWarning(`发布前优化提示：${warningSummary}`);
    }
    proceed();
  };

  const handleCopyMarkdown = () => {
    if (!article) return;
    runWithPlaceholderGuard('复制 Markdown', () => {
      const text = htmlToExportMarkdown({
        id: article.id,
        title: article.title,
        contentHtml: article.contentHtml,
        contentText: '',
        contentMarkdown: article.contentMarkdown,
      });
      void copyTextToClipboard(text).then((okCopy) => {
        if (okCopy) feedback.notifySuccess('已复制纯净 Markdown');
        else feedback.notifyError('复制失败，请检查浏览器剪贴板权限');
      });
    });
  };

  const handleCopyHtml = () => {
    if (!article) return;
    runWithPlaceholderGuard('复制 HTML', () => {
      const rawHtmlSource = article.contentHtml.trim()
        ? article.contentHtml
        : markdownToSanitizedHtml(
            htmlToExportMarkdown({
              id: article.id,
              title: '',
              contentHtml: '',
              contentText: '',
              contentMarkdown: article.contentMarkdown,
            }),
          );
      const safeHtml = sanitizeRichArticleHtml(rawHtmlSource).contentHtml;
      void copyTextToClipboard(safeHtml).then((okCopy) => {
        if (okCopy) feedback.notifySuccess('已复制富文本 HTML');
        else feedback.notifyError('复制失败，请检查浏览器剪贴板权限');
      });
    });
  };

  const executeDownloadDocx = async () => {
    if (!article || downloadingDocxRef.current) return;
    downloadingDocxRef.current = true;
    const seq = contextKeyRef.current;
    exportCtrlRef.current?.abort();
    const ctrl = new AbortController();
    exportCtrlRef.current = ctrl;
    setDownloadingDocx(true);
    try {
      const file = await exportArticleFile(article.id, 'docx', { signal: ctrl.signal });
      if (ctrl.signal.aborted || seq !== contextKeyRef.current) return;
      triggerBlobDownload({ filename: file.filename, mime: file.mime, body: file.blob });
      feedback.notifySuccess(`已开始下载 ${file.filename}`);
    } catch (err) {
      if (ctrl.signal.aborted || seq !== contextKeyRef.current) return;
      const msg = err instanceof GatewayApiError ? err.message : '导出 .docx 失败';
      feedback.notifyError(msg);
    } finally {
      if (exportCtrlRef.current === ctrl) {
        exportCtrlRef.current = null;
      }
      if (seq === contextKeyRef.current) {
        downloadingDocxRef.current = false;
        setDownloadingDocx(false);
      }
    }
  };

  const handleDownloadDocx = () => {
    if (!article || downloadingDocxRef.current) return;
    runWithPlaceholderGuard('下载 .docx', () => {
      void executeDownloadDocx();
    });
  };

  const handleCopyJsonLd = async () => {
    if (!safeJsonLdText) return;
    const okCopy = await copyTextToClipboard(safeJsonLdText);
    if (okCopy) feedback.notifySuccess('已复制校验通过的 JSON-LD Schema');
    else feedback.notifyError('复制 JSON-LD 失败');
  };

  const handleCopyLlmsTxt = async () => {
    if (!llmsTxt) return;
    const okCopy = await copyTextToClipboard(llmsTxt);
    if (okCopy) feedback.notifySuccess('已复制 llms.txt 片段');
    else feedback.notifyError('复制 llms.txt 失败');
  };

  const jsonLdBlock = (
    <div className="gm-studio-delivery-subblock" data-testid="delivery-jsonld-block">
      <div className="gm-studio-delivery-subhead">
        <span className="gm-studio-section-label">Schema</span>
        <StatusBadge tone="success">已校验</StatusBadge>
      </div>

      <div className="gm-studio-export-actions">
        <Button
          size="small"
          type="default"
          data-testid="delivery-copy-jsonld"
          disabled={!article || streaming || !safeJsonLdText}
          onClick={() => void handleCopyJsonLd()}
        >
          复制 Schema
        </Button>
        <Button
          size="small"
          type="link"
          autoInsertSpace={false}
          className="gm-studio-link-compact"
          data-testid="delivery-toggle-jsonld-preview"
          disabled={!article || !safeJsonLdText}
          onClick={() => setShowJsonLdPreview((prev) => !prev)}
        >
          {showJsonLdPreview ? '收起预览' : '预览'}
        </Button>
      </div>

      {showJsonLdPreview && safeJsonLdText ? (
        <pre className="gm-studio-code-pre" data-testid="delivery-jsonld-preview">
          <code>{highlightedJsonNodes}</code>
        </pre>
      ) : null}
    </div>
  );

  const globalLlmsAndCrawlerBlock =
    activeMarket === 'GLOBAL' ? (
      <>
        <div className="gm-studio-delivery-subblock" data-testid="delivery-llmstxt-block">
          <div className="gm-studio-delivery-subhead">
            <span className="gm-studio-section-label">llms.txt</span>
            <Button
              size="small"
              data-testid="delivery-copy-llmstxt"
              disabled={!article || streaming || !llmsTxt}
              onClick={() => void handleCopyLlmsTxt()}
            >
              复制切片
            </Button>
          </div>
          {llmsTxt ? <pre className="gm-studio-code-pre">{llmsTxt}</pre> : null}
        </div>

        <div className="gm-studio-delivery-subblock" data-testid="delivery-crawler-checklist">
          <div className="gm-studio-delivery-subhead">
            <span className="gm-studio-section-label">爬虫清单</span>
            <Explain text="AI 爬虫放行检查清单（robots.txt）：确保 GPTBot 与 PerplexityBot 等主流 AI 检索爬虫未被屏蔽。" />
          </div>
          <div className="gm-studio-crawler-list">
            {crawlerChecklist.map((item) => (
              <div key={item.bot} className="gm-studio-crawler-row">
                <div className="gm-studio-crawler-head">
                  <code className="gm-studio-crawler-bot">{item.bot}</code>
                  <StatusBadge tone={item.recommended ? 'success' : 'neutral'}>
                    {item.recommended ? '建议放行' : '按需配置'}
                  </StatusBadge>
                  <Explain text={item.purpose} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </>
    ) : null;

  return (
    <div className="gm-studio-delivery-pack" data-testid="studio-delivery-pack">
      <div className="gm-studio-delivery-subhead">
        <span className="gm-studio-section-label">导出交付</span>
        <Explain text="生成或选择成稿后即可一键导出 MD / HTML / .docx 与 Schema。" />
      </div>

      {!article ? (
        <div className="gm-studio-item-meta">请先选择或生成成稿。</div>
      ) : (
        <>
          <div className="gm-studio-export-actions">
            <Button
              size="small"
              data-testid="delivery-copy-md"
              disabled={streaming}
              onClick={() => void handleCopyMarkdown()}
            >
              复制 MD
            </Button>
            <Button
              size="small"
              data-testid="delivery-copy-html"
              disabled={streaming}
              onClick={() => void handleCopyHtml()}
            >
              复制 HTML
            </Button>
            <Button
              size="small"
              data-testid="delivery-download-docx"
              loading={downloadingDocx}
              disabled={streaming}
              onClick={() => void handleDownloadDocx()}
            >
              下载 Word
            </Button>
          </div>

          {activeMarket === 'CN' ? (
            jsonLdBlock
          ) : (
            <>
              {jsonLdBlock}
              {globalLlmsAndCrawlerBlock}
            </>
          )}
        </>
      )}
    </div>
  );
}
