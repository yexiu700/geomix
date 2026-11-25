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
import { Alert, Button, Checkbox, Dropdown, Input, Popover, Segmented, type MenuProps } from 'antd';
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  SyntheticEvent,
} from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { resolveMediaUrl } from '../../lib/brands';
import { rewritePreviewRelativeMediaUrls } from '../../lib/studio';
import { hasOpenFloatingOverlay } from '../../lib/ux-foundation';
import { SignalEmpty } from '../geo/primitives';
import { groupMissingFactSlots } from './studio-batch-tbd-helpers';

const PreviewHtmlContent = memo(function PreviewHtmlContent({ html }: { html: string }) {
  const markup = useMemo(() => ({ __html: html }), [html]);
  return <div dangerouslySetInnerHTML={markup} />;
});

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
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  isNarrowDrawerViewport?: boolean;
  onOpenLeftDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  onOpenBatchMissingFact?: () => void;
};

type ViewMode = 'preview' | 'edit' | 'split';

type SelectionBubbleState = {
  text: string;
  top: number;
  left: number;
};

const BUBBLE_ACTION_LABELS: Readonly<Record<GeoRewriteAction, string>> = {
  DE_AD: '更客观',
  TO_TABLE: '转表格',
  ADD_EVIDENCE: '补数据',
  CONCISE_ANSWER: '精简直答',
};

const HTML_MISSING_FACT_RE =
  /(?:\[(?:待补充|TBD|To be verified)(?:[:：]\s*[^\]\n]{1,720})?\](?:\([^)\n]{1,1200}\))?|【(?:待补充|TBD|To be verified)(?:[:：]\s*[^】\n]{1,720})?】|［(?:待补充|TBD|To be verified)(?:[:：]\s*[^］\n]{1,720})?］)/gi;

function decodeStandardHtmlEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|#x27);/gi, (entity, name: string) => {
    switch (name.toLowerCase()) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case '#39':
      case '#x27':
        return "'";
      default:
        return entity;
    }
  });
}

function extractDecodedTagTokens(fragment: string): string[] {
  const re = new RegExp(HTML_MISSING_FACT_RE.source, 'gi');
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(fragment)) !== null) {
    tokens.push(decodeStandardHtmlEntities(match[0]));
  }
  return tokens;
}

function isStudioEditorTextarea(el: EventTarget | Element | null): el is HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement && el.classList.contains('gm-studio-markdown-textarea');
}

/**
 * Splits sanitized HTML strictly on tag boundaries (`<[^>]+>`) so attributes and tags
 * are never altered, wrapping only text-node `[TBD: ...]` / `[待补充：...]` tokens
 * while tracking consumed slots in Markdown source order (`[label](href)` and `![alt](src)`)
 * so `data-tbd-index` never desyncs.
 */
function highlightMissingFactHtml(
  sanitizedHtml: string,
  missingSlots: readonly MissingFactSlot[],
): string {
  if (!sanitizedHtml || missingSlots.length === 0) return sanitizedHtml;
  const parts = sanitizedHtml.split(/(<[^>]+>)/g);
  const consumed = new Set<number>();
  const pendingAnchorTokens: string[][] = [];
  let slotCursor = 0;

  const advanceSlotCursor = () => {
    while (slotCursor < missingSlots.length && consumed.has(slotCursor)) {
      slotCursor += 1;
    }
  };

  const consumeAttributeTokens = (tokens: readonly string[]) => {
    for (const decoded of tokens) {
      if (slotCursor >= missingSlots.length) break;
      for (let k = slotCursor; k < missingSlots.length; k += 1) {
        if (!consumed.has(k) && missingSlots[k]?.raw === decoded) {
          consumed.add(k);
          advanceSlotCursor();
          break;
        }
      }
    }
  };

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || slotCursor >= missingSlots.length) continue;

    if (i % 2 === 1) {
      if (/^<a\b/i.test(part)) {
        pendingAnchorTokens.push(extractDecodedTagTokens(part));
      } else if (/^<\/a\s*>/i.test(part)) {
        const deferred = pendingAnchorTokens.pop();
        if (deferred && deferred.length > 0) {
          consumeAttributeTokens(deferred);
        }
      } else if (/^<img\b/i.test(part)) {
        const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(part);
        if (altMatch) {
          const altValue = altMatch[1] ?? altMatch[2] ?? '';
          const altTokens = extractDecodedTagTokens(altValue);
          const withoutAlt =
            part.slice(0, altMatch.index) + part.slice(altMatch.index + altMatch[0].length);
          const restTokens = extractDecodedTagTokens(withoutAlt);
          consumeAttributeTokens([...altTokens, ...restTokens]);
        } else {
          consumeAttributeTokens(extractDecodedTagTokens(part));
        }
      } else {
        consumeAttributeTokens(extractDecodedTagTokens(part));
      }
      continue;
    }

    const re = new RegExp(HTML_MISSING_FACT_RE.source, 'gi');
    parts[i] = part.replace(re, (matched) => {
      const decoded = decodeStandardHtmlEntities(matched);
      let matchedIdx = -1;
      for (let k = slotCursor; k < missingSlots.length; k += 1) {
        if (!consumed.has(k) && missingSlots[k]?.raw === decoded) {
          matchedIdx = k;
          break;
        }
      }
      if (matchedIdx < 0) {
        return matched;
      }
      const slot = missingSlots[matchedIdx]!;
      consumed.add(matchedIdx);
      slotCursor = matchedIdx + 1;
      advanceSlotCursor();
      return `<span class="gm-studio-tbd-inline" data-tbd-index="${slot.index}" role="button" tabindex="0">${matched}</span>`;
    });
  }
  return parts.join('');
}

function clampBubbleCoords(rawLeft: number, rawTop: number): { left: number; top: number } {
  if (typeof window === 'undefined') {
    return { left: rawLeft, top: rawTop };
  }
  const vpW = window.innerWidth || 1280;
  const vpH = window.innerHeight || 800;
  const minLeft = Math.min(156, vpW / 2);
  const maxLeft = Math.max(minLeft, vpW - 156);
  const clampedLeft = Math.min(Math.max(rawLeft, minLeft), maxLeft);
  const clampedTop = Math.min(Math.max(rawTop, 56), Math.max(56, vpH - 20));
  return { left: Math.round(clampedLeft), top: Math.round(clampedTop) };
}

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
  focusMode = false,
  onToggleFocusMode,
  isNarrowDrawerViewport = false,
  onOpenLeftDrawer,
  onOpenRightDrawer,
  onOpenBatchMissingFact,
}: StudioEditorCanvasProps): JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [openSlotKey, setOpenSlotKey] = useState<string | null>(null);
  const [slotInputValue, setSlotInputValue] = useState('');
  const [syncToFact, setSyncToFact] = useState(true);
  const [targetFactSlot, setTargetFactSlot] = useState<BrandFactSlot>('PRODUCT_SPECS');
  const [slotSubmitting, setSlotSubmitting] = useState(false);

  const [selectedText, setSelectedText] = useState('');
  const [bubbleState, setBubbleState] = useState<SelectionBubbleState | null>(null);
  const [rewritingAction, setRewritingAction] = useState<GeoRewriteAction | null>(null);
  const [rewritePreview, setRewritePreview] = useState<{
    original: string;
    rewritten: string;
    action: GeoRewriteAction;
  } | null>(null);

  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const missingBarRef = useRef<HTMLDivElement | null>(null);

  const missingSlots = useMemo(
    () => (streaming ? [] : extractMissingFactSlots(draftMarkdown)),
    [draftMarkdown, streaming],
  );
  const missingSlotGroupCount = useMemo(
    () =>
      missingSlots.length === 0 ? 0 : groupMissingFactSlots(draftMarkdown, missingSlots).length,
    [draftMarkdown, missingSlots],
  );

  const effectiveMarkdown = streaming ? streamMarkdown : draftMarkdown;
  const renderedHtml = useMemo(() => {
    const sanitized = rewritePreviewRelativeMediaUrls(
      markdownToSanitizedHtml(effectiveMarkdown),
      resolveMediaUrl,
    );
    return streaming ? sanitized : highlightMissingFactHtml(sanitized, missingSlots);
  }, [effectiveMarkdown, missingSlots, streaming]);

  const activeArticleIdRef = useRef<string | null>(article?.id ?? null);
  const streamingRef = useRef<boolean>(streaming);
  const readOnlyRef = useRef<boolean>(readOnly);
  activeArticleIdRef.current = article?.id ?? null;
  streamingRef.current = streaming;
  readOnlyRef.current = readOnly;

  useEffect(() => {
    setSelectedText('');
    setBubbleState(null);
    setRewritePreview(null);
    setOpenSlotKey(null);
    setSlotInputValue('');
    setRewritingAction(null);
  }, [article?.id, streaming]);

  useEffect(() => {
    if (viewMode === 'preview') {
      onCursorChange?.(null);
    }
    setBubbleState(null);
  }, [viewMode, article?.id, onCursorChange]);

  // Apply bubble fixed coordinates via ref (keeps component inline style count at 0)
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el || !bubbleState) return;
    el.style.top = `${bubbleState.top}px`;
    el.style.left = `${bubbleState.left}px`;
  }, [bubbleState]);

  const updatePreviewSelectionBubble = useCallback((fallbackClient?: { x: number; y: number }) => {
    if (
      typeof window === 'undefined' ||
      !activeArticleIdRef.current ||
      streamingRef.current ||
      readOnlyRef.current
    ) {
      setBubbleState(null);
      return;
    }
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    if (isStudioEditorTextarea(activeEl)) {
      return;
    }
    const container = previewBodyRef.current;
    if (!container) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      setBubbleState(null);
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 2) {
      setBubbleState(null);
      return;
    }
    const anchorInPreview = sel.anchorNode ? container.contains(sel.anchorNode) : false;
    const focusInPreview = sel.focusNode ? container.contains(sel.focusNode) : false;
    if (!anchorInPreview && !focusInPreview) {
      return;
    }

    const range = sel.getRangeAt(0);
    const rect =
      typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
    let rawLeft: number;
    let rawTop: number;
    if (rect && (rect.width > 0 || rect.height > 0)) {
      rawLeft = rect.left + rect.width / 2;
      rawTop = rect.top - 10;
    } else if (fallbackClient && (fallbackClient.x > 0 || fallbackClient.y > 0)) {
      rawLeft = fallbackClient.x;
      rawTop = fallbackClient.y - 12;
    } else {
      const box = container.getBoundingClientRect();
      rawLeft = box.left + box.width / 2 || 480;
      rawTop = Math.max(box.top + 32, 120);
    }

    const coords = clampBubbleCoords(rawLeft, rawTop);
    setSelectedText(text);
    setBubbleState({ text, ...coords });
  }, []);

  // Listen to document selectionchange for preview HTML selections (including synthetic Range events)
  useEffect(() => {
    if (typeof document === 'undefined' || !article || streaming || readOnly) return;
    const onSelectionChange = () => {
      updatePreviewSelectionBubble();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [article, readOnly, streaming, updatePreviewSelectionBubble]);

  // Dismiss Selection Bubble Toolbar on Escape (respecting hasOpenFloatingOverlay) & outside click
  useEffect(() => {
    if (!bubbleState || typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented || hasOpenFloatingOverlay()) return;
        setBubbleState(null);
        const sel = window.getSelection();
        const container = previewBodyRef.current;
        if (
          sel &&
          sel.rangeCount > 0 &&
          container &&
          ((sel.anchorNode && container.contains(sel.anchorNode)) ||
            (sel.focusNode && container.contains(sel.focusNode)))
        ) {
          sel.removeAllRanges();
        }
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (bubbleRef.current?.contains(target)) return;
      if (previewBodyRef.current?.contains(target)) return;
      if (isStudioEditorTextarea(target)) return;
      setBubbleState(null);
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [bubbleState]);

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

  const syncTextareaBubble = (
    target: HTMLTextAreaElement,
    fallbackClient?: { x: number; y: number },
  ) => {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    if (end <= start) {
      setBubbleState(null);
      return;
    }
    const picked = target.value.slice(start, end).trim();
    if (picked.length < 2) {
      setBubbleState(null);
      return;
    }
    setSelectedText(picked);
    if (!article || streaming || readOnly) return;
    let rawLeft: number;
    let rawTop: number;
    if (fallbackClient && (fallbackClient.x > 0 || fallbackClient.y > 0)) {
      rawLeft = fallbackClient.x;
      rawTop = fallbackClient.y - 12;
    } else {
      const rect = target.getBoundingClientRect();
      rawLeft = rect.left + rect.width / 2 || 480;
      rawTop = Math.max(rect.top + 36, 120);
    }
    const coords = clampBubbleCoords(rawLeft, rawTop);
    setBubbleState({ text: picked, ...coords });
  };

  const handleTextareaSelect = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    reportCursorOffset(target);
    syncTextareaBubble(target);
  };

  const handleTextareaMouseUp = (e: ReactMouseEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    reportCursorOffset(target);
    syncTextareaBubble(target, { x: e.clientX, y: e.clientY });
  };

  const handlePreviewMouseUp = (e: ReactMouseEvent<HTMLDivElement>) => {
    updatePreviewSelectionBubble({ x: e.clientX, y: e.clientY });
  };

  const openSlotByIndex = (slotIdx: number) => {
    const slot = missingSlots[slotIdx];
    if (!slot) return;
    const key = `${slot.index}-${slot.raw}`;
    setOpenSlotKey(key);
    setSlotInputValue('');
    if (missingBarRef.current && typeof missingBarRef.current.scrollIntoView === 'function') {
      missingBarRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const handlePreviewClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    const inlineTbd = target?.closest<HTMLElement>('.gm-studio-tbd-inline');
    if (!inlineTbd) return;
    const rawIdx = inlineTbd.getAttribute('data-tbd-index');
    if (rawIdx === null) return;
    const parsed = Number.parseInt(rawIdx, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      openSlotByIndex(parsed);
    }
  };

  const handlePreviewKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement | null;
    const inlineTbd = target?.closest<HTMLElement>('.gm-studio-tbd-inline');
    if (!inlineTbd) return;
    const rawIdx = inlineTbd.getAttribute('data-tbd-index');
    if (rawIdx === null) return;
    const parsed = Number.parseInt(rawIdx, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      e.preventDefault();
      openSlotByIndex(parsed);
    }
  };

  const handleTriggerRewrite = async (action: GeoRewriteAction, explicitSnippet?: string) => {
    const snippet = explicitSnippet?.trim() || selectedText.trim() || paragraphs[0] || '';
    if (!snippet || !article || streaming || readOnly) return;
    const targetArticleId = article.id;
    setSelectedText(snippet);
    setBubbleState(null);
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

  const rewriteDisabled =
    readOnly || Boolean(rewritingAction) || (!selectedText.trim() && paragraphs.length === 0);

  const rewriteMenu: MenuProps = {
    items: GEO_REWRITE_ACTIONS.map((action) => ({
      key: action,
      disabled: rewriteDisabled,
      label: (
        <span
          data-testid={
            action === 'DE_AD' ? 'studio-rewrite-menu-DE_AD' : `studio-rewrite-${action}`
          }
        >
          {GEO_REWRITE_ACTION_LABELS[action]}
        </span>
      ),
      onClick: () => {
        void handleTriggerRewrite(action);
      },
    })),
  };

  const hasContent = Boolean(article || streaming || effectiveMarkdown.trim());

  return (
    <div className="gm-studio-editor-shell">
      {/* Borderless Lightweight Editor Toolbar */}
      <div className="gm-studio-editor-toolbar">
        {isNarrowDrawerViewport ? (
          <div className="gm-studio-row">
            {onOpenLeftDrawer ? (
              <Button
                size="small"
                aria-label="打开选题与成稿队列"
                data-testid="studio-mobile-queue-btn"
                onClick={onOpenLeftDrawer}
              >
                队列
              </Button>
            ) : null}
            {onOpenRightDrawer ? (
              <Button
                size="small"
                aria-label="打开体检与交付面板"
                data-testid="studio-mobile-right-btn"
                onClick={onOpenRightDrawer}
              >
                体检
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="gm-studio-editor-title-wrap">
          <Input
            size="small"
            aria-label="文章标题"
            placeholder="成稿标题"
            value={draftTitle}
            onChange={(e) => onDraftTitleChange(e.target.value)}
            disabled={readOnly || streaming || !article}
          />
        </div>

        <div className="gm-studio-editor-actions">
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
          {article && !streaming ? (
            <>
              <Button
                size="small"
                type="text"
                data-testid="studio-rewrite-DE_AD"
                loading={rewritingAction === 'DE_AD'}
                disabled={rewriteDisabled}
                onClick={() => void handleTriggerRewrite('DE_AD')}
              >
                更客观去广告味
              </Button>
              <Dropdown
                menu={rewriteMenu}
                trigger={['click']}
                disabled={rewriteDisabled}
                destroyOnHidden
                transitionName=""
              >
                <Button
                  size="small"
                  data-testid="studio-rewrite-dropdown-btn"
                  loading={Boolean(rewritingAction)}
                  disabled={rewriteDisabled}
                >
                  ✨ AI 改写 ▾
                </Button>
              </Dropdown>
            </>
          ) : null}
          {!isNarrowDrawerViewport && onToggleFocusMode ? (
            <Button
              size="small"
              type="text"
              data-testid="studio-focus-mode-btn"
              aria-pressed={focusMode}
              onClick={onToggleFocusMode}
            >
              {focusMode ? '退出专注' : '专注编辑'}
            </Button>
          ) : null}
          {article && !readOnly ? (
            <Button
              size="small"
              type="default"
              className={dirty ? 'gm-studio-save-dirty' : undefined}
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

      {/* Independent Vertical Scroll Canvas Area */}
      <div
        className="gm-studio-canvas-scroll"
        onScroll={() => {
          if (bubbleState) setBubbleState(null);
        }}
      >
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
                <div className="gm-studio-stack gm-studio-stack--md">
                  <div className="gm-studio-text-secondary">{partialDraft.reason}</div>
                  {article ? (
                    <pre data-testid="studio-partial-draft-text" className="gm-studio-partial-pre">
                      {partialDraft.markdown}
                    </pre>
                  ) : null}
                  <div className="gm-studio-row gm-studio-row--wrap">
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
                        type="default"
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

          {/* Restrained Single-Line [TBD] Missing-Fact Bar */}
          {missingSlots.length > 0 ? (
            <div
              ref={missingBarRef}
              className="gm-studio-missing-bar"
              data-testid="studio-missing-fact-bar"
            >
              <span className="gm-studio-missing-bar-label">
                <span className="gm-studio-missing-dot" aria-hidden="true" />
                <span>待补充 {missingSlots.length} 处真实事实</span>
              </span>
              <div className="gm-studio-missing-slots-strip">
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
                        <div className="gm-studio-missing-popover">
                          <div className="gm-studio-missing-popover-title">
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
                          <div className="gm-studio-row gm-studio-row--end">
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
              {onOpenBatchMissingFact ? (
                <Button
                  size="small"
                  type="default"
                  data-testid="studio-missing-bar-batch-btn"
                  disabled={readOnly}
                  onClick={onOpenBatchMissingFact}
                >
                  批量补填（{missingSlotGroupCount} 组）
                </Button>
              ) : null}
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
                <div className="gm-studio-stack gm-studio-stack--md">
                  <pre className="gm-studio-rewrite-pre">{rewritePreview.rewritten}</pre>
                  <div className="gm-studio-row">
                    <Button
                      size="small"
                      type="default"
                      className="gm-studio-save-dirty"
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
            <div className="gm-studio-markdown-measure">
              <Input.TextArea
                aria-label="文章 Markdown 正文"
                className="gm-studio-markdown-textarea"
                rows={18}
                value={draftMarkdown}
                onChange={(e) => {
                  onDraftMarkdownChange(e.target.value);
                  reportCursorOffset(e.currentTarget);
                }}
                onSelect={handleTextareaSelect}
                onMouseUp={handleTextareaMouseUp}
                onClick={(e) => reportCursorOffset(e.currentTarget)}
                onKeyUp={(e) => reportCursorOffset(e.currentTarget)}
                disabled={readOnly}
              />
            </div>
          ) : viewMode === 'split' && !streaming ? (
            <div className="gm-studio-split-view">
              <Input.TextArea
                aria-label="文章 Markdown 正文"
                className="gm-studio-markdown-textarea"
                rows={18}
                value={draftMarkdown}
                onChange={(e) => {
                  onDraftMarkdownChange(e.target.value);
                  reportCursorOffset(e.currentTarget);
                }}
                onSelect={handleTextareaSelect}
                onMouseUp={handleTextareaMouseUp}
                onClick={(e) => reportCursorOffset(e.currentTarget)}
                onKeyUp={(e) => reportCursorOffset(e.currentTarget)}
                disabled={readOnly}
              />
              <div
                ref={previewBodyRef}
                className="gm-studio-preview-body"
                data-testid="studio-preview-body"
                onMouseUp={handlePreviewMouseUp}
                onClick={handlePreviewClick}
                onKeyDown={handlePreviewKeyDown}
              >
                <PreviewHtmlContent html={renderedHtml} />
              </div>
            </div>
          ) : (
            <div
              ref={previewBodyRef}
              className="gm-studio-preview-body"
              data-testid="studio-preview-body"
              onMouseUp={handlePreviewMouseUp}
              onClick={handlePreviewClick}
              onKeyDown={handlePreviewKeyDown}
            >
              <PreviewHtmlContent html={renderedHtml} />
              {streaming ? (
                <span className="gm-studio-stream-cursor" aria-label="正在流式生成" />
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* Floating Selection Bubble Toolbar */}
      {bubbleState && article && !streaming && !readOnly ? (
        <div
          ref={bubbleRef}
          className="gm-studio-selection-bubble"
          data-testid="studio-selection-bubble"
          role="toolbar"
          aria-label="划词 AI 改写工具栏"
        >
          {GEO_REWRITE_ACTIONS.map((action) => (
            <button
              key={action}
              type="button"
              className="gm-studio-bubble-btn"
              disabled={Boolean(rewritingAction)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void handleTriggerRewrite(action, bubbleState.text)}
            >
              {BUBBLE_ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
