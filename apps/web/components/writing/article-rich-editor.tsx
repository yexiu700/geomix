'use client';

import { countArticleWords, sanitizeRichArticleHtml } from '@geomix/shared';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export type RichEditorCommand = 'p' | 'h2' | 'h3' | 'bold' | 'ul' | 'blockquote';

export type ArticleRichEditorHandle = {
  applyFormat: (cmd: RichEditorCommand) => void;
  focus: () => void;
};

const COMMAND_FALLBACK_BLOCKS: Record<RichEditorCommand, string> = {
  p: '<p>正文段落内容</p>',
  h2: '<h2>二级小标题</h2>',
  h3: '<h3>三级小标题</h3>',
  bold: '<p><strong>重点加粗内容</strong></p>',
  ul: '<ul><li>要点一</li><li>要点二</li></ul>',
  blockquote: '<blockquote><p>核心结论引用说明</p></blockquote>',
};

type ArticleRichEditorProps = {
  value: string;
  onChange: (nextHtml: string) => void;
  ariaLabel?: string;
  placeholder?: string;
};

export const ArticleRichEditor = forwardRef<ArticleRichEditorHandle, ArticleRichEditorProps>(
  function ArticleRichEditor(
    {
      value,
      onChange,
      ariaLabel = '文章富文本内容',
      placeholder = '请输入文章正文，支持直接排版编辑或使用上方工具栏设置标题、加粗、列表与引用...',
    },
    ref,
  ) {
    const editableRef = useRef<HTMLDivElement | null>(null);
    const lastEmittedRef = useRef<string | null>(null);

    useEffect(() => {
      const el = editableRef.current;
      if (!el) return;
      if (value === lastEmittedRef.current) return;
      const trimmed = value.trim();
      const { contentHtml } = trimmed ? sanitizeRichArticleHtml(trimmed) : { contentHtml: '' };
      if (el.innerHTML !== contentHtml) {
        el.innerHTML = contentHtml;
      }
      lastEmittedRef.current = value;
    }, [value]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          editableRef.current?.focus();
        },
        applyFormat: (cmd: RichEditorCommand) => {
          const el = editableRef.current;
          if (!el) return;
          el.focus();

          const sel = typeof window !== 'undefined' ? window.getSelection() : null;
          const selectionInside = Boolean(
            sel && sel.rangeCount > 0 && sel.anchorNode && el.contains(sel.anchorNode),
          );

          if (selectionInside && typeof document.execCommand === 'function') {
            let applied = false;
            try {
              if (cmd === 'p') applied = document.execCommand('formatBlock', false, 'p');
              else if (cmd === 'h2') applied = document.execCommand('formatBlock', false, 'h2');
              else if (cmd === 'h3') applied = document.execCommand('formatBlock', false, 'h3');
              else if (cmd === 'bold') applied = document.execCommand('bold');
              else if (cmd === 'ul') applied = document.execCommand('insertUnorderedList');
              else if (cmd === 'blockquote') {
                applied = document.execCommand('formatBlock', false, 'blockquote');
              }
            } catch {
              applied = false;
            }
            if (applied) {
              const nextHtml = el.innerHTML;
              lastEmittedRef.current = nextHtml;
              onChange(nextHtml);
              return;
            }
          }

          const current = el.innerHTML.trim();
          const block = COMMAND_FALLBACK_BLOCKS[cmd];
          const nextHtml = current ? `${current}\n${block}` : block;
          el.innerHTML = nextHtml;
          lastEmittedRef.current = nextHtml;
          onChange(nextHtml);
        },
      }),
      [onChange],
    );

    const isEmpty = !/<img\b/i.test(value) && countArticleWords(value) === 0;

    return (
      <div style={{ position: 'relative', background: 'var(--gm-bg-surface)' }}>
        <style>{`
          .gm-rich-editor-surface {
            min-height: 180px;
            max-height: 320px;
            overflow-y: auto;
            padding: 12px 14px;
            outline: none;
            color: var(--gm-fg-1);
            font-size: 14px;
            line-height: 1.75;
            word-break: break-word;
          }
          .gm-rich-editor-surface h2 {
            font-size: 18px;
            font-weight: 600;
            margin: 14px 0 8px;
            line-height: 1.4;
          }
          .gm-rich-editor-surface h3 {
            font-size: 16px;
            font-weight: 600;
            margin: 12px 0 6px;
            line-height: 1.4;
          }
          .gm-rich-editor-surface p {
            margin: 0 0 8px;
          }
          .gm-rich-editor-surface ul,
          .gm-rich-editor-surface ol {
            padding-left: 22px;
            margin: 6px 0 10px;
          }
          .gm-rich-editor-surface blockquote {
            margin: 8px 0;
            padding: 6px 12px;
            border-left: 3px solid var(--gm-phosphor);
            background: var(--gm-bg-elevated);
            color: var(--gm-fg-2);
          }
          .gm-rich-editor-surface img {
            max-width: 100%;
            height: auto;
            border-radius: 6px;
            margin: 6px 0;
          }
        `}</style>
        {isEmpty ? (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 12,
              left: 14,
              right: 14,
              color: 'var(--gm-fg-3)',
              fontSize: 14,
              lineHeight: 1.75,
              pointerEvents: 'none',
            }}
          >
            {placeholder}
          </div>
        ) : null}
        <div
          ref={editableRef}
          className="gm-rich-editor-surface"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          onFocus={() => {
            try {
              if (typeof document.execCommand === 'function') {
                document.execCommand('defaultParagraphSeparator', false, 'p');
              }
            } catch {
              // ignore unsupported browsers
            }
          }}
          onInput={(e) => {
            const raw = e.currentTarget.innerHTML;
            const normalized =
              raw === '<br>' || raw === '<p><br></p>' || raw === '<div><br></div>' ? '' : raw;
            lastEmittedRef.current = normalized;
            onChange(normalized);
          }}
        />
      </div>
    );
  },
);
