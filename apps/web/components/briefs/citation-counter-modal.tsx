'use client';

import type { GeoBriefRecord, GeoMarket } from '@geomix/shared';
import { Alert, Button, Input, Modal } from 'antd';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createBriefFromCitationUrl, isCitationCounterFallbackError } from '../../lib/briefs';
import { GatewayApiError } from '../../lib/envelope';
import { FormField } from '../ui';

export type CitationCounterModalProps = {
  open: boolean;
  brandId: string;
  market: GeoMarket;
  readOnly: boolean;
  /** 'url' for /studio fresh entry; 'fallback' for /visibility Tab 3 422/42201 recovery */
  mode: 'url' | 'fallback';
  initialUrl?: string;
  initialTitle?: string;
  initialTargetPrompt?: string;
  initialErrorMessage?: string | null;
  onClose: () => void;
  onCreated: (brief: GeoBriefRecord) => void;
};

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function CitationCounterModal({
  open,
  brandId,
  market,
  readOnly,
  mode,
  initialUrl = '',
  initialTitle = '',
  initialTargetPrompt = '',
  initialErrorMessage = null,
  onClose,
  onCreated,
}: CitationCounterModalProps): JSX.Element {
  const [urlInput, setUrlInput] = useState(initialUrl);
  const [targetPromptInput, setTargetPromptInput] = useState(initialTargetPrompt);
  const [showFallback, setShowFallback] = useState(mode === 'fallback');
  const [pastedTitle, setPastedTitle] = useState(initialTitle);
  const [pastedContent, setPastedContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(initialErrorMessage);

  const ctrlRef = useRef<AbortController | null>(null);
  const sessionSeqRef = useRef(0);
  const submittingRef = useRef(false);

  useEffect(() => {
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    sessionSeqRef.current += 1;
    submittingRef.current = false;

    if (!open) {
      setSubmitting(false);
      return;
    }

    setUrlInput(initialUrl);
    setTargetPromptInput(initialTargetPrompt);
    setShowFallback(mode === 'fallback');
    setPastedTitle(initialTitle);
    setPastedContent('');
    setSubmitting(false);
    setErrorMsg(initialErrorMessage);

    return () => {
      ctrlRef.current?.abort();
      ctrlRef.current = null;
      submittingRef.current = false;
    };
  }, [
    open,
    brandId,
    market,
    mode,
    initialUrl,
    initialTitle,
    initialTargetPrompt,
    initialErrorMessage,
  ]);

  const handleClose = () => {
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    submittingRef.current = false;
    onClose();
  };

  const handleSubmit = async () => {
    if (readOnly || submittingRef.current || !brandId) return;

    const trimmedUrl = urlInput.trim();
    const trimmedPrompt = targetPromptInput.trim();
    const trimmedTitle = pastedTitle.trim();
    const trimmedContent = pastedContent.trim();

    if (showFallback) {
      if (trimmedContent.length < 20) {
        setErrorMsg('请粘贴至少 20 字的参考正文内容');
        return;
      }
      if (trimmedUrl && !isValidHttpUrl(trimmedUrl)) {
        setErrorMsg('目标链接仅支持以 http:// 或 https:// 开头的公开网页地址');
        return;
      }
    } else {
      if (!trimmedUrl || !isValidHttpUrl(trimmedUrl)) {
        setErrorMsg('请输入以 http:// 或 https:// 开头的公开竞品网页链接');
        return;
      }
    }

    submittingRef.current = true;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const seq = sessionSeqRef.current;

    setSubmitting(true);
    setErrorMsg(null);

    try {
      const created = await createBriefFromCitationUrl(
        brandId,
        {
          market,
          ...(trimmedUrl ? { citationUrl: trimmedUrl } : {}),
          ...(trimmedPrompt ? { targetPrompt: trimmedPrompt.slice(0, 300) } : {}),
          ...(showFallback
            ? {
                ...(trimmedTitle ? { pastedTitle: trimmedTitle.slice(0, 120) } : {}),
                pastedContent: trimmedContent,
              }
            : {}),
        },
        { signal: ctrl.signal },
      );

      if (ctrl.signal.aborted || seq !== sessionSeqRef.current) return;
      onCreated(created);
    } catch (err) {
      if (ctrl.signal.aborted || isAbortError(err) || seq !== sessionSeqRef.current) return;
      if (isCitationCounterFallbackError(err)) {
        setShowFallback(true);
        setErrorMsg(
          err instanceof GatewayApiError && err.message
            ? err.message
            : '目标页面触发反爬、登录拦截或抓取超时，请复制原文粘贴至下方继续生成反制意见',
        );
      } else {
        setErrorMsg(
          err instanceof GatewayApiError && err.message
            ? err.message
            : err instanceof Error && err.message
              ? err.message
              : '生成竞品反制意见失败，请稍后重试',
        );
      }
    } finally {
      if (ctrlRef.current === ctrl) {
        ctrlRef.current = null;
      }
      if (seq === sessionSeqRef.current) {
        submittingRef.current = false;
        if (!ctrl.signal.aborted) {
          setSubmitting(false);
        }
      }
    }
  };

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      title={showFallback ? '竞品高引用反制 · 粘贴参考正文' : '竞品高引用 URL 反制'}
      width={620}
      destroyOnHidden
      footer={[
        <Button key="cancel" onClick={handleClose} disabled={submitting}>
          取消
        </Button>,
        <Button
          key="submit"
          type="primary"
          loading={submitting}
          disabled={readOnly}
          data-testid="counter-submit-btn"
          onClick={() => void handleSubmit()}
        >
          {showFallback ? '提交参考正文并生成（0 点）' : '生成反制意见（0 点）'}
        </Button>,
      ]}
    >
      <div className="gm-counter-modal-body" data-testid="citation-counter-modal">
        <div className="gm-counter-desc">
          输入被 AI
          高频引用的竞品或第三方评测链接，系统自动解析议题骨架并强制注入当前品牌事实卡，生成「高引用信源超越稿」意见卡（0
          点免费）。
        </div>

        {errorMsg ? (
          <Alert type="warning" showIcon message={errorMsg} data-testid="counter-error-alert" />
        ) : null}

        <FormField label="竞品高引用链接" htmlFor="gm-counter-url-input">
          <Input
            id="gm-counter-url-input"
            aria-label="竞品高引用链接"
            data-testid="counter-url-input"
            placeholder="https://example.com/competitor-review"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            disabled={readOnly || submitting}
          />
        </FormField>

        <FormField label="目标攻克问题（选填）" htmlFor="gm-counter-prompt-input">
          <Input
            id="gm-counter-prompt-input"
            aria-label="目标攻克问题"
            placeholder={
              market === 'GLOBAL'
                ? 'Optional target buyer query (auto-derived if omitted)'
                : '选填，留空将依据目标页面标题自动提炼'
            }
            maxLength={300}
            value={targetPromptInput}
            onChange={(e) => setTargetPromptInput(e.target.value)}
            disabled={readOnly || submitting}
          />
        </FormField>

        {!showFallback ? (
          <div className="gm-counter-toggle-row">
            <Button
              size="small"
              type="link"
              className="gm-counter-link-btn"
              data-testid="counter-toggle-fallback-btn"
              onClick={() => setShowFallback(true)}
            >
              页面无法抓取？改用粘贴参考正文
            </Button>
          </div>
        ) : (
          <div className="gm-counter-fallback-box" data-testid="counter-pasted-fallback">
            <div className="gm-counter-fallback-head">
              <strong className="gm-counter-fallback-title">粘贴参考正文</strong>
              {mode === 'url' ? (
                <Button
                  size="small"
                  type="link"
                  className="gm-counter-link-btn"
                  onClick={() => {
                    setShowFallback(false);
                    setErrorMsg(null);
                  }}
                >
                  切回自动抓取链接
                </Button>
              ) : null}
            </div>
            <Input
              size="small"
              aria-label="参考文章标题"
              placeholder="参考文章标题（选填）"
              maxLength={120}
              value={pastedTitle}
              onChange={(e) => setPastedTitle(e.target.value)}
              disabled={readOnly || submitting}
            />
            <Input.TextArea
              rows={6}
              aria-label="粘贴参考正文"
              data-testid="counter-pasted-content"
              placeholder="请将竞品或第三方评测页面的正文与小标题粘贴至此（至少 20 字），系统将跳过远程抓取并直接提取议题骨架生成超越版意见卡。"
              maxLength={50_000}
              value={pastedContent}
              onChange={(e) => setPastedContent(e.target.value)}
              disabled={readOnly || submitting}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
