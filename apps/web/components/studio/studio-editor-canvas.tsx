'use client';

import {
  BRAND_FACT_CORE_SLOTS,
  BRAND_FACT_SLOT_LABELS,
  GEO_REWRITE_ACTIONS,
  GEO_REWRITE_ACTION_LABELS,
  extractMissingFactSlots,
  markdownToSanitizedHtml,
  type BrandFactSlot,
  type GeoArticleRecord,
  type GeoRewriteAction,
  type MissingFactSlot,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Input, Popover, Segmented } from 'antd';
import type { JSX, ReactNode, SyntheticEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveMediaUrl } from '../../lib/brands';
import { rewritePreviewRelativeMediaUrls } from '../../lib/studio';
import { SignalEmpty } from '../geo/primitives';

export type PartialStreamDraft = {
  markdown: string;
  reason: string;
  refunded: boolean;
};

export type StudioEditorCanvasProps = {
  article: GeoArticleRecord | null;
  streaming: boolean;
  streamMarkdown: string;
  partialDraft?: PartialStreamDraft | null;
  onCopyPartialDraft?: () => void;
  onRetryPartialDraft?: () => void;
  onDismissPartialDraft?: () => void;
  draftTitle: string;
  draftMarkdown: string;
  dirty: boolean;
  saving: boolean;
  onDraftTitleChange: (title: string) => void;
  onDraftMarkdownChange: (markdown: string) => void;
  onSaveArticle: () => Promise<void>;
  onBackfillMissingFact: (
    slot: MissingFactSlot,
    value: string,
    options: { syncToFact: boolean; factSlot: BrandFactSlot },
  ) => Promise<void>;
  onRewriteSection: (
    selectedText: string,
    action: GeoRewriteAction,
  ) => Promise<{ rewrittenText: string } | null>;
  onApplyRewrittenText: (original: string, rewritten: string) => Promise<boolean | void>;
  onCursorChange?: (offset: number | null) => void;
  readOnly: boolean;
  mediaToolbarSlot?: ReactNode;
};

type ViewMode = 'preview' | 'edit' | 'split';

export function StudioEditorCanvas({
  article,
  streaming,
  streamMarkdown,
  partialDraft = null,
  onCopyPartialDraft,
  onRetryPartialDraft,
  onDismissPartialDraft,
  draftTitle,
  draftMarkdown,
  dirty,
  saving,
  onDraftTitleChange,
  onDraftMarkdownChange,
  onSaveArticle,
  onBackfillMissingFact,
  onRewriteSection,
  onApplyRewrittenText,
  onCursorChange,
  readOnly,
  mediaToolbarSlot,
}: StudioEditorCanvasProps): JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [openSlotKey, setOpenSlotKey] = useState<string | null>(null);
  const [slotInputValue, setSlotInputValue] = useState('');
  const [syncToFact, setSyncToFact] = useState(true);
  const [targetFactSlot, setTargetFactSlot] = useState<BrandFactSlot>('PRODUCT_SPECS');
  const [slotSubmitting, setSlotSubmitting] = useState(false);

  const [selectedText, setSelectedText] = useState('');
  const [rewritingAction, setRewritingAction] = useState<GeoRewriteAction | null>(null);
  const [rewritePreview, setRewritePreview] = useState<{
    original: string;
    rewritten: string;
    action: GeoRewriteAction;
  } | null>(null);

  const effectiveMarkdown = streaming ? streamMarkdown : draftMarkdown;
  const renderedHtml = useMemo(
    () =>
      rewritePreviewRelativeMediaUrls(markdownToSanitizedHtml(effectiveMarkdown), resolveMediaUrl),
    [effectiveMarkdown],
  );
  const missingSlots = useMemo(
    () => (streaming ? [] : extractMissingFactSlots(draftMarkdown)),
    [draftMarkdown, streaming],
  );

  const activeArticleIdRef = useRef<string | null>(article?.id ?? null);
  const streamingRef = useRef<boolean>(streaming);
  activeArticleIdRef.current = article?.id ?? null;
  streamingRef.current = streaming;

  useEffect(() => {
    setSelectedText('');
    setRewritePreview(null);
    setOpenSlotKey(null);
    setSlotInputValue('');
    setRewritingAction(null);
  }, [article?.id, streaming]);

  useEffect(() => {
    if (viewMode === 'preview') {
      onCursorChange?.(null);
    }
  }, [viewMode, article?.id, onCursorChange]);

  const paragraphs = useMemo(
    () =>
      draftMarkdown
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length >= 10 && !p.startsWith('#')),
    [draftMarkdown],
  );

  const reportCursorOffset = (target: HTMLTextAreaElement) => {
    const start = target.selectionStart;
    onCursorChange?.(typeof start === 'number' ? start : null);
  };

  const handleTextareaSelect = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    reportCursorOffset(target);
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    if (end > start) {
      const picked = target.value.slice(start, end).trim();
      if (picked) setSelectedText(picked);
    }
  };

  const handlePreviewMouseUp = () => {
    if (typeof window === 'undefined') return;
    const sel = window.getSelection()?.toString().trim() ?? '';
    if (sel) setSelectedText(sel);
  };

  const handleTriggerRewrite = async (action: GeoRewriteAction) => {
    const snippet = selectedText.trim() || paragraphs[0] || '';
    if (!snippet || !article || streaming || readOnly) return;
    const targetArticleId = article.id;
    setSelectedText(snippet);
    setRewritingAction(action);
    try {
      const res = await onRewriteSection(snippet, action);
      if (res && activeArticleIdRef.current === targetArticleId && !streamingRef.current) {
        setRewritePreview({ original: snippet, rewritten: res.rewrittenText, action });
      }
    } finally {
      if (activeArticleIdRef.current === targetArticleId) {
        setRewritingAction(null);
      }
    }
  };

  const handleConfirmSlot = async (slot: MissingFactSlot) => {
    const cleanVal = slotInputValue.trim();
    if (!cleanVal) return;
    setSlotSubmitting(true);
    try {
      await onBackfillMissingFact(slot, cleanVal, {
        syncToFact,
        factSlot: targetFactSlot,
      });
      setOpenSlotKey(null);
      setSlotInputValue('');
    } catch {
      // Parent notifies user; keep popover open for retry without unhandled rejection
    } finally {
      setSlotSubmitting(false);
    }
  };

  const hasContent = Boolean(article || streaming || effectiveMarkdown.trim());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {/* Editor Toolbar */}
      <div className="gm-studio-editor-toolbar">
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <Input
            size="small"
            aria-label="文章标题"
            placeholder="成稿标题"
            value={draftTitle}
            onChange={(e) => onDraftTitleChange(e.target.value)}
            disabled={readOnly || streaming || !article}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Segmented
            size="small"
            value={viewMode}
            onChange={(val) => setViewMode(val as ViewMode)}
            options={[
              { label: '实时预览', value: 'preview' },
              { label: '编辑 Markdown', value: 'edit' },
              { label: '分栏', value: 'split' },
            ]}
          />
          {mediaToolbarSlot}
          {article && !readOnly ? (
            <Button
              size="small"
              type={dirty ? 'primary' : 'default'}
              loading={saving}
              disabled={streaming || !dirty}
              onClick={() => void onSaveArticle()}
              data-testid="studio-save-article-btn"
            >
              保存修改
            </Button>
          ) : null}
        </div>
      </div>

      {/* Inline Section Rewrite Toolbar */}
      {article && !streaming ? (
        <div className="gm-studio-rewrite-bar" data-testid="studio-rewrite-toolbar">
          <span style={{ fontSize: 12, color: 'var(--gm-fg-2)', fontWeight: 500 }}>
            行内局部改写（免费）：
          </span>
          {GEO_REWRITE_ACTIONS.map((action) => (
            <Button
              key={action}
              size="small"
              data-testid={`studio-rewrite-${action}`}
              loading={rewritingAction === action}
              disabled={
                readOnly ||
                Boolean(rewritingAction) ||
                (!selectedText.trim() && paragraphs.length === 0)
              }
              onClick={() => void handleTriggerRewrite(action)}
            >
              {GEO_REWRITE_ACTION_LABELS[action]}
            </Button>
          ))}
          {selectedText.trim() ? (
            <span style={{ fontSize: 11, color: 'var(--gm-fg-3)' }}>
              已选 {selectedText.trim().length} 字
            </span>
          ) : paragraphs.length > 0 ? (
            <span style={{ fontSize: 11, color: 'var(--gm-fg-3)' }}>
              划选段落后点击，或直接改写首段
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Main Canvas Body */}
      <div className="gm-studio-canvas-body">
        {/* Preserved Partial Stream Draft Banner (#336) */}
        {!streaming && partialDraft ? (
          <Alert
            type="warning"
            showIcon
            data-testid="studio-partial-draft-banner"
            message={
              partialDraft.refunded
                ? '未完成草稿 · 已退还 10 点（已保留已流式输出的正文片段）'
                : '未完成草稿 · 流式生成已中断（已保留已输出的正文片段）'
            }
            description={
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                <div style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>{partialDraft.reason}</div>
                {article ? (
                  <pre
                    data-testid="studio-partial-draft-text"
                    style={{
                      margin: 0,
                      maxHeight: 200,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      fontSize: 12,
                      background: 'var(--gm-bg-elevated)',
                      padding: 8,
                      borderRadius: 6,
                    }}
                  >
                    {partialDraft.markdown}
                  </pre>
                ) : null}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {onCopyPartialDraft ? (
                    <Button
                      size="small"
                      data-testid="studio-copy-partial-draft-btn"
                      onClick={onCopyPartialDraft}
                    >
                      复制已生成片段
                    </Button>
                  ) : null}
                  {onRetryPartialDraft && !readOnly ? (
                    <Button
                      size="small"
                      type="primary"
                      data-testid="studio-retry-partial-draft-btn"
                      onClick={onRetryPartialDraft}
                    >
                      重新生成
                    </Button>
                  ) : null}
                  {onDismissPartialDraft ? (
                    <Button size="small" onClick={onDismissPartialDraft}>
                      清除草稿提示
                    </Button>
                  ) : null}
                </div>
              </div>
            }
          />
        ) : null}

        {/* Clickable [待补充：...] Missing-Fact Pills Bar (ALWAYS visible in edit & preview modes!) */}
        {missingSlots.length > 0 ? (
          <div className="gm-studio-missing-bar" data-testid="studio-missing-fact-bar">
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gm-warning)' }}>
              检测到 {missingSlots.length}{' '}
              处待补充真实事实（点击胶囊行内回填，支持一键反哺品牌事实卡）：
            </div>
            <div className="gm-studio-chip-group">
              {missingSlots.map((slot) => {
                const key = `${slot.index}-${slot.raw}`;
                const isOpen = openSlotKey === key;
                const displayRaw = slot.raw.replace(/\([^)\n]{1,200}\)$/, '');
                return (
                  <Popover
                    key={key}
                    trigger="click"
                    open={isOpen}
                    onOpenChange={(nextOpen) => {
                      if (nextOpen) {
                        setOpenSlotKey(key);
                        setSlotInputValue('');
                      } else if (openSlotKey === key) {
                        setOpenSlotKey(null);
                      }
                    }}
                    content={
                      <div
                        style={{
                          width: 280,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 600 }}>
                          补充缺失事实：{slot.hint}
                        </div>
                        {/* CRITICAL: Value textarea MUST be the very first input/textarea inside popover */}
                        <Input.TextArea
                          rows={2}
                          aria-label={`补充-${slot.hint}`}
                          placeholder="输入真实实测数值或参数"
                          value={slotInputValue}
                          onChange={(e) => setSlotInputValue(e.target.value)}
                          disabled={readOnly || slotSubmitting}
                        />
                        <Checkbox
                          checked={syncToFact}
                          onChange={(e) => setSyncToFact(e.target.checked)}
                          disabled={readOnly || slotSubmitting}
                        >
                          同步存入品牌事实卡
                        </Checkbox>
                        {syncToFact ? (
                          <select
                            aria-label="写入事实卡分类"
                            className="gm-select"
                            value={targetFactSlot}
                            onChange={(e) => setTargetFactSlot(e.target.value as BrandFactSlot)}
                            disabled={readOnly || slotSubmitting}
                          >
                            {BRAND_FACT_CORE_SLOTS.map((factSlot) => (
                              <option key={factSlot} value={factSlot}>
                                {BRAND_FACT_SLOT_LABELS[factSlot]}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                          <Button size="small" onClick={() => setOpenSlotKey(null)}>
                            取消
                          </Button>
                          <Button
                            size="small"
                            type="primary"
                            loading={slotSubmitting}
                            disabled={readOnly || !slotInputValue.trim()}
                            onClick={() => void handleConfirmSlot(slot)}
                          >
                            确认填入
                          </Button>
                        </div>
                      </div>
                    }
                  >
                    <button
                      type="button"
                      className="gm-studio-missing-pill"
                      data-testid="missing-fact-pill"
                    >
                      {displayRaw}
                    </button>
                  </Popover>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Inline Rewrite Preview Diff Bar */}
        {rewritePreview ? (
          <Alert
            type="info"
            showIcon
            data-testid="studio-rewrite-preview"
            message={`局部改写预览 · ${GEO_REWRITE_ACTION_LABELS[rewritePreview.action]}`}
            description={
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    fontSize: 12,
                    background: 'var(--gm-bg-elevated)',
                    padding: 8,
                    borderRadius: 6,
                  }}
                >
                  {rewritePreview.rewritten}
                </pre>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    size="small"
                    type="primary"
                    onClick={async () => {
                      const applied = await onApplyRewrittenText(
                        rewritePreview.original,
                        rewritePreview.rewritten,
                      );
                      if (applied !== false) {
                        setRewritePreview(null);
                        setSelectedText('');
                      }
                    }}
                  >
                    应用替换
                  </Button>
                  <Button size="small" onClick={() => setRewritePreview(null)}>
                    放弃
                  </Button>
                </div>
              </div>
            }
          />
        ) : null}

        {/* Editor / Live Preview Area */}
        {!hasContent ? (
          <SignalEmpty
            title="选择意见卡或输入问题开始流式精写"
            description="系统自动注入当前品牌事实卡与市场合规规则，点击「立即生成」实时吐字成稿。"
          />
        ) : viewMode === 'edit' && !streaming ? (
          <Input.TextArea
            aria-label="文章 Markdown 正文"
            rows={18}
            value={draftMarkdown}
            onChange={(e) => {
              onDraftMarkdownChange(e.target.value);
              reportCursorOffset(e.currentTarget);
            }}
            onSelect={handleTextareaSelect}
            onClick={(e) => reportCursorOffset(e.currentTarget)}
            onKeyUp={(e) => reportCursorOffset(e.currentTarget)}
            disabled={readOnly}
            style={{ fontFamily: 'var(--gm-font-mono)', fontSize: 13 }}
          />
        ) : viewMode === 'split' && !streaming ? (
          <div className="gm-studio-split-view">
            <Input.TextArea
              aria-label="文章 Markdown 正文"
              rows={18}
              value={draftMarkdown}
              onChange={(e) => {
                onDraftMarkdownChange(e.target.value);
                reportCursorOffset(e.currentTarget);
              }}
              onSelect={handleTextareaSelect}
              onClick={(e) => reportCursorOffset(e.currentTarget)}
              onKeyUp={(e) => reportCursorOffset(e.currentTarget)}
              disabled={readOnly}
              style={{ fontFamily: 'var(--gm-font-mono)', fontSize: 13 }}
            />
            <div
              className="gm-studio-preview-body"
              data-testid="studio-preview-body"
              onMouseUp={handlePreviewMouseUp}
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          </div>
        ) : (
          <div
            className="gm-studio-preview-body"
            data-testid="studio-preview-body"
            onMouseUp={handlePreviewMouseUp}
          >
            <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />
            {streaming ? (
              <span className="gm-studio-stream-cursor" aria-label="正在流式生成" />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
