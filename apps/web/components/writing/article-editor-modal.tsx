/* eslint-disable @next/next/no-img-element */
'use client';

import {
  ARTICLE_STATUSES,
  ARTICLE_STATUS_LABEL,
  ARTICLE_TITLE_MAX,
  countArticleWords,
  sanitizeRichArticleHtml,
  type ArticleDetailRecord,
} from '@geomix/shared';
import { Alert, Button, Input, Space, Tag } from 'antd';
import type { ChangeEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import type { ArticleFormOptions, ArticleManageGateway } from '../../lib/articles';
import { resolveMediaUrl } from '../../lib/gallery';
import { NATIVE_SELECT_STYLE } from '../../lib/select-styles';
import type { ArticleEditorController } from './article-editor-controller';
import {
  RED_TYPOGRAPHY_TIP,
  SHORT_VIDEO_WORD_LIMIT,
  type ArticleEditorDraft,
  type EditorModalState,
} from './article-manage-helpers';
import {
  ArticleRichEditor,
  type ArticleRichEditorHandle,
  type RichEditorCommand,
} from './article-rich-editor';

const PLAIN_COPIED_RESET_MS = 2_000;

/** 富文本工具栏：可视化模式下调用编辑器命令，其他模式回退为追加 HTML 片段。 */
const FORMAT_BUTTONS: ReadonlyArray<{
  label: string;
  cmd: RichEditorCommand;
  snippet: string;
}> = [
  { label: '正文', cmd: 'p', snippet: '<p>正文段落内容</p>' },
  { label: 'H2', cmd: 'h2', snippet: '<h2>二级小标题</h2>' },
  { label: 'H3', cmd: 'h3', snippet: '<h3>三级小标题</h3>' },
  { label: '加粗', cmd: 'bold', snippet: '<p><strong>重点加粗内容</strong></p>' },
  { label: '列表', cmd: 'ul', snippet: '<ul><li>要点一</li><li>要点二</li></ul>' },
  { label: '引用', cmd: 'blockquote', snippet: '<blockquote>核心结论引用说明</blockquote>' },
];

const EDITOR_TABS: ReadonlyArray<{ key: EditorModalState['editorTab']; label: string }> = [
  { key: 'visual', label: '可视化编辑' },
  { key: 'preview', label: '排版预览' },
  { key: 'source', label: 'HTML 源码' },
];

export type ArticleEditorModalProps = {
  controller: ArticleEditorController;
  client: Pick<ArticleManageGateway, 'create' | 'update' | 'uploadCoverAsset'>;
  formOptions: ArticleFormOptions | null;
  refreshFormOptions: () => Promise<ArticleFormOptions | null>;
  onApprove: (articleId: string) => void;
  /** 保存成功后回调：`notice` 为列表页横幅提示文案。 */
  onSaved: (article: ArticleDetailRecord, notice: string) => void;
};

export function ArticleEditorModal({
  controller,
  client,
  formOptions,
  refreshFormOptions,
  onApprove,
  onSaved,
}: ArticleEditorModalProps) {
  const {
    editor,
    setEditor,
    formError,
    setFormError,
    galleryAssets,
    setGalleryAssets,
    galleryLoading,
    loadAssetsForMediaCategory,
  } = controller;

  const [submitting, setSubmitting] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [plainCopied, setPlainCopied] = useState(false);
  const coverFileInputRef = useRef<HTMLInputElement | null>(null);
  const richEditorRef = useRef<ArticleRichEditorHandle | null>(null);
  const plainCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (plainCopiedTimerRef.current !== null) {
        clearTimeout(plainCopiedTimerRef.current);
        plainCopiedTimerRef.current = null;
      }
    },
    [],
  );

  const patchDraft = (patch: Partial<ArticleEditorDraft>) =>
    setEditor((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...patch } } : cur));

  const editorWordCount = useMemo(
    () => (editor ? countArticleWords(editor.draft.contentHtml) : 0),
    [editor],
  );

  const sanitizedEditorContent = useMemo(
    () => (editor ? sanitizeRichArticleHtml(editor.draft.contentHtml) : null),
    [editor],
  );
  const sanitizedPreviewHtml = sanitizedEditorContent?.contentHtml ?? '';
  const editorPlainText = sanitizedEditorContent?.contentText ?? '';

  const appendRichBlock = (snippet: string) => {
    setEditor((cur) => {
      if (!cur) return cur;
      const base = cur.draft.contentHtml === '<p></p>' ? '' : cur.draft.contentHtml;
      return {
        ...cur,
        draft: {
          ...cur.draft,
          contentHtml: `${base}${base ? '\n' : ''}${snippet}`,
        },
      };
    });
  };

  const applyEditorCommand = (cmd: RichEditorCommand, fallbackSnippet: string) => {
    if (editor?.editorTab === 'visual' && richEditorRef.current) {
      richEditorRef.current.applyFormat(cmd);
      return;
    }
    appendRichBlock(fallbackSnippet);
  };

  const handleCoverUploadChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !editor) return;
    if (!editor.draft.mediaCategoryId) {
      setFormError('请先选择画像封面所属的图库分组再上传');
      return;
    }
    setUploadingCover(true);
    setFormError(null);
    try {
      const asset = await client.uploadCoverAsset(editor.draft.mediaCategoryId, file);
      setGalleryAssets((prev) => [asset, ...prev]);
      patchDraft({ coverUrl: asset.url });
      void refreshFormOptions();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : '上传封面图片失败');
    } finally {
      setUploadingCover(false);
    }
  };

  const handleSaveArticle = async () => {
    if (!editor) return;
    const trimmedTitle = editor.draft.title.trim();
    const wordCount = countArticleWords(editor.draft.contentHtml);
    const errors: string[] = [];
    if (!trimmedTitle) errors.push('请填写文章标题');
    if (!editor.draft.categoryId) errors.push('请选择归属分类');
    if (wordCount === 0) errors.push('请填写文章正文内容');
    if (errors.length > 0) {
      setFormError(errors.join('；'));
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      let saved: ArticleDetailRecord | null = null;
      let notice = '';
      if (editor.mode === 'create') {
        saved = await client.create({
          title: trimmedTitle,
          categoryId: editor.draft.categoryId,
          mediaCategoryId: editor.draft.mediaCategoryId || null,
          coverUrl: editor.draft.coverUrl,
          status: editor.draft.status,
          contentHtml: editor.draft.contentHtml,
        });
        notice = `手动文章「${trimmedTitle}」已创建（状态：${ARTICLE_STATUS_LABEL[editor.draft.status]}）`;
      } else if (editor.articleId) {
        saved = await client.update(editor.articleId, {
          title: trimmedTitle,
          categoryId: editor.draft.categoryId,
          coverUrl: editor.draft.coverUrl,
          status: editor.draft.status,
          contentHtml: editor.draft.contentHtml,
        });
        notice = `文章「${trimmedTitle}」已保存更新`;
      }
      setEditor(null);
      if (saved) onSaved(saved, notice);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : '保存文章失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyPlainText = async () => {
    const text = editorPlainText.trim();
    if (!text) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setPlainCopied(true);
      if (plainCopiedTimerRef.current !== null) clearTimeout(plainCopiedTimerRef.current);
      plainCopiedTimerRef.current = setTimeout(() => {
        plainCopiedTimerRef.current = null;
        setPlainCopied(false);
      }, PLAIN_COPIED_RESET_MS);
    } catch {
      setFormError('当前浏览器环境不支持自动复制，请切换预览后手动复制');
    }
  };

  return (
    <CrudModal
      open={Boolean(editor)}
      title={editor?.mode === 'edit' ? '编辑文章' : '手动添加文章'}
      minimized={editor?.minimized ?? false}
      maximized={editor?.maximized ?? false}
      confirmLoading={submitting}
      error={formError}
      onMinimize={() => setEditor((cur) => (cur ? { ...cur, minimized: true } : cur))}
      onRestore={() => {
        setEditor((cur) => (cur ? { ...cur, minimized: false } : cur));
        void refreshFormOptions();
      }}
      onMaximize={() => setEditor((cur) => (cur ? { ...cur, maximized: !cur.maximized } : cur))}
      onClose={() => {
        if (!submitting) setEditor(null);
      }}
      onReset={() => {
        setFormError(null);
        setEditor((cur) => (cur ? { ...cur, draft: cur.initial } : cur));
      }}
      ok={
        <Space>
          {editor?.mode === 'edit' && editor.articleId && editor.draft.status !== 'NORMAL' ? (
            <Button
              aria-label="弹窗设为正常"
              disabled={submitting}
              onClick={() => {
                if (editor.articleId) onApprove(editor.articleId);
              }}
            >
              设为正常
            </Button>
          ) : null}
          <Button
            type="primary"
            aria-label="保存文章"
            loading={submitting}
            onClick={() => void handleSaveArticle()}
          >
            保存文章
          </Button>
        </Space>
      }
    >
      {editor ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 10,
            }}
          >
            <div>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>
                <span style={{ color: 'var(--gm-danger)' }}>* </span>标题
              </div>
              <Input
                aria-label="文章标题"
                maxLength={ARTICLE_TITLE_MAX}
                placeholder="请输入文章标题"
                value={editor.draft.title}
                onChange={(e) => patchDraft({ title: e.target.value })}
              />
            </div>

            <div>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>
                <span style={{ color: 'var(--gm-danger)' }}>* </span>归属分类
              </div>
              <select
                aria-label="归属分类"
                style={NATIVE_SELECT_STYLE}
                value={editor.draft.categoryId}
                onChange={(e) => patchDraft({ categoryId: e.target.value })}
              >
                <option value="" disabled>
                  请选择归属分类
                </option>
                {(formOptions?.categories ?? []).map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}（共 {cat.total} 篇 / 剩余 {cat.remaining} 篇）
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>画像封面（图库分组）</div>
              <select
                aria-label="画像封面分组"
                style={NATIVE_SELECT_STYLE}
                value={editor.draft.mediaCategoryId}
                onChange={(e) => {
                  const nextMediaCatId = e.target.value;
                  patchDraft({ mediaCategoryId: nextMediaCatId });
                  void loadAssetsForMediaCategory(nextMediaCatId, true);
                }}
              >
                <option value="">不选择</option>
                {(formOptions?.mediaCategories ?? []).map((mc) => (
                  <option key={mc.id} value={mc.id}>
                    {mc.name}（{mc.assetCount} 张图片）
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>状态</div>
              <div
                role="radiogroup"
                aria-label="文章状态"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  minHeight: 32,
                  flexWrap: 'wrap',
                }}
              >
                {ARTICLE_STATUSES.map((st) => (
                  <label
                    key={st}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      margin: 0,
                      cursor: 'pointer',
                      fontSize: 14,
                    }}
                  >
                    <input
                      type="radio"
                      name="article-status"
                      value={st}
                      checked={editor.draft.status === st}
                      onChange={() => patchDraft({ status: st })}
                    />
                    <span>{ARTICLE_STATUS_LABEL[st]}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* 封面预览、图库候选带出、上传与移除 */}
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px dashed var(--gm-line-1)',
              background: 'var(--gm-bg-surface)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <Space size={8} wrap>
                <span style={{ fontSize: 13, fontWeight: 500 }}>当前封面：</span>
                {editor.draft.coverUrl ? (
                  <>
                    <Tag color="green">已设置封面</Tag>
                    <img
                      src={resolveMediaUrl(editor.draft.coverUrl)}
                      alt="已选文章封面"
                      style={{
                        width: 48,
                        height: 34,
                        objectFit: 'cover',
                        borderRadius: 4,
                        border: '2px solid var(--gm-phosphor)',
                      }}
                    />
                    <span style={{ display: 'none' }}>{editor.draft.coverUrl}</span>
                  </>
                ) : (
                  <Tag>未设置封面</Tag>
                )}
                {galleryLoading ? (
                  <span style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>加载图库图片中...</span>
                ) : null}
              </Space>
              <Space size={8}>
                <input
                  ref={coverFileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  aria-label="上传封面文件"
                  style={{ display: 'none' }}
                  onChange={(e) => void handleCoverUploadChange(e)}
                />
                <Button
                  size="small"
                  loading={uploadingCover}
                  disabled={!editor.draft.mediaCategoryId}
                  onClick={() => coverFileInputRef.current?.click()}
                >
                  上传新封面
                </Button>
                {editor.draft.coverUrl ? (
                  <Button
                    size="small"
                    danger
                    aria-label="移除封面"
                    onClick={() => patchDraft({ coverUrl: null })}
                  >
                    移除封面
                  </Button>
                ) : null}
              </Space>
            </div>

            {galleryAssets.length > 0 ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                  marginTop: 8,
                }}
              >
                <span style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>候选封面：</span>
                {galleryAssets.slice(0, 8).map((asset, idx) => {
                  const active = editor.draft.coverUrl === asset.url;
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      aria-label={`选择封面图 ${idx + 1}`}
                      onClick={() => patchDraft({ coverUrl: asset.url })}
                      style={{
                        padding: 0,
                        border: active
                          ? '2px solid var(--gm-phosphor)'
                          : '1px solid var(--gm-line-1)',
                        borderRadius: 4,
                        overflow: 'hidden',
                        cursor: 'pointer',
                        background: 'var(--gm-bg-surface)',
                      }}
                    >
                      <img
                        src={resolveMediaUrl(asset.thumbUrl || asset.url)}
                        alt={`图库候选 ${idx + 1}`}
                        style={{ width: 48, height: 34, objectFit: 'cover', display: 'block' }}
                      />
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          {/* 富文本编辑器（工具栏 + 红字排版提示 + 实时字数统计） */}
          <div>
            <div
              role="note"
              style={{
                color: 'var(--gm-danger)',
                background: 'rgba(240,96,93,0.08)',
                border: '1px solid rgba(240,96,93,0.32)',
                borderRadius: 6,
                padding: '5px 10px',
                fontSize: 12,
                marginBottom: 6,
              }}
            >
              {RED_TYPOGRAPHY_TIP}
            </div>

            {editorWordCount > SHORT_VIDEO_WORD_LIMIT ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 6 }}
                message={`当前正文字数已达 ${editorWordCount} 字，超过抖音、小红书建议的 ${SHORT_VIDEO_WORD_LIMIT} 字上限，建议精简篇幅或点击「复制纯文本」粘贴后按平台字数微调。`}
              />
            ) : null}

            <div
              style={{
                border: '1px solid var(--gm-line-1)',
                borderRadius: 6,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 6,
                  padding: '6px 10px',
                  background: 'var(--gm-bg-elevated)',
                  borderBottom: '1px solid var(--gm-line-1)',
                }}
              >
                {editor.editorTab === 'preview' ? (
                  <span style={{ fontSize: 12, color: 'var(--gm-fg-3)' }}>
                    当前为只读排版预览（切换「可视化编辑」可继续修改）
                  </span>
                ) : (
                  <Space size={4} wrap>
                    {FORMAT_BUTTONS.map((btn) => (
                      <Button
                        key={btn.cmd}
                        size="small"
                        onClick={() => applyEditorCommand(btn.cmd, btn.snippet)}
                      >
                        {btn.label}
                      </Button>
                    ))}
                  </Space>
                )}

                <Space size={8} wrap>
                  {EDITOR_TABS.map((tab) => (
                    <Button
                      key={tab.key}
                      size="small"
                      type={editor.editorTab === tab.key ? 'primary' : 'default'}
                      onClick={() =>
                        setEditor((cur) => (cur ? { ...cur, editorTab: tab.key } : cur))
                      }
                    >
                      {tab.label}
                    </Button>
                  ))}
                  <Button
                    size="small"
                    aria-label="复制纯文本"
                    disabled={!editorPlainText.trim()}
                    onClick={() => void handleCopyPlainText()}
                  >
                    {plainCopied ? '已复制纯文本' : '复制纯文本'}
                  </Button>
                  <span
                    className="gm-num"
                    aria-label="字数统计"
                    style={{
                      fontSize: 12,
                      color:
                        editorWordCount > SHORT_VIDEO_WORD_LIMIT
                          ? 'var(--gm-danger)'
                          : 'var(--gm-fg-2)',
                      fontWeight: 500,
                    }}
                  >
                    字数统计：{editorWordCount} 字
                  </span>
                </Space>
              </div>

              {editor.editorTab === 'visual' ? (
                <ArticleRichEditor
                  ref={richEditorRef}
                  value={editor.draft.contentHtml}
                  onChange={(nextHtml) => patchDraft({ contentHtml: nextHtml })}
                />
              ) : editor.editorTab === 'source' ? (
                <Input.TextArea
                  aria-label="HTML 源码内容"
                  rows={7}
                  style={{ border: 'none', borderRadius: 0 }}
                  placeholder="高级模式：可直接查看或编辑白名单 HTML 标签（如 <h2>、<p>、<strong>、<ul>）..."
                  value={editor.draft.contentHtml}
                  onChange={(e) => patchDraft({ contentHtml: e.target.value })}
                />
              ) : (
                <div
                  aria-label="富文本预览区"
                  style={{
                    minHeight: 180,
                    maxHeight: 320,
                    overflowY: 'auto',
                    padding: 12,
                    background: 'var(--gm-bg-surface)',
                  }}
                  dangerouslySetInnerHTML={{ __html: sanitizedPreviewHtml }}
                />
              )}
            </div>
          </div>
        </div>
      ) : null}
    </CrudModal>
  );
}
