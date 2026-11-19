'use client';

import {
  AI_TASK_IMAGE_MAX,
  AI_TASK_IMAGE_MIN,
  AI_TASK_NAME_MAX,
  AI_TASK_TARGET_MAX,
  AI_TASK_TARGET_MIN,
  UX_TERMS,
  type AiTaskCreateInput,
  type AiTaskDetailRecord,
  type AiTaskResultStatus,
} from '@geomix/shared';
import { Alert, Button, Input, InputNumber, Radio, Slider, Space, Typography } from 'antd';
import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import type { AiTaskFormOptions, AiTaskGateway } from '../../lib/ai-tasks';
import { NATIVE_SELECT_STYLE } from '../../lib/select-styles';
import { useTabFreshness } from '../../lib/tab-freshness';
import type { ShellAction } from '../../lib/tab-stack';
import {
  buildAiTaskCreatePayload,
  computeAiTaskQuote,
  defaultCreateDraft,
  filterUsableSystemArticlePrompts,
  isGalleryRequiredError,
  isManualSlotTemplateBlocked,
  resolveTaskErrorMessage,
  validateCreateDraft,
  type CreateDraft,
  type CreateEditorState,
} from './ai-task-helpers';

const FORM_GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: '10px 16px',
  alignItems: 'start',
};

const LABEL_STYLE: CSSProperties = {
  display: 'block',
  marginBottom: 4,
};

const SLIDER_MARKS: Record<number, string> = {
  0: '0张',
  1: '1张',
  2: '2张',
  3: '3张',
  4: '4张',
  5: '5张',
};

export type UseAiTaskCreateModalOptions = {
  client: Pick<AiTaskGateway, 'loadFormOptions'>;
  active: boolean;
  initialKeywordId?: string;
  onLoadError: (message: string) => void;
};

export type AiTaskCreateModalController = {
  formOptions: AiTaskFormOptions | null;
  optionsLoading: boolean;
  editor: CreateEditorState | null;
  setEditor: Dispatch<SetStateAction<CreateEditorState | null>>;
  refreshFormOptions: () => Promise<AiTaskFormOptions | null>;
  openCreateModal: (preferredKeywordId?: string) => Promise<void>;
};

export function useAiTaskCreateModal({
  client,
  active,
  initialKeywordId,
  onLoadError,
}: UseAiTaskCreateModalOptions): AiTaskCreateModalController {
  const [formOptions, setFormOptions] = useState<AiTaskFormOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [editor, setEditor] = useState<CreateEditorState | null>(null);

  const onLoadErrorRef = useRef(onLoadError);
  onLoadErrorRef.current = onLoadError;

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const optionsSeqRef = useRef(0);
  const latestAppliedSeqRef = useRef(0);
  const openReqIdRef = useRef(0);

  const refreshFormOptions = useCallback(async (): Promise<AiTaskFormOptions | null> => {
    const seq = ++optionsSeqRef.current;
    try {
      const opts = await client.loadFormOptions();
      if (mountedRef.current && seq >= latestAppliedSeqRef.current) {
        latestAppliedSeqRef.current = seq;
        setFormOptions(opts);
      }
      return opts;
    } catch {
      return null;
    }
  }, [client]);

  useTabFreshness({
    active,
    domains: ['keywords', 'questions', 'gallery', 'knowledge', 'prompts', 'categories', 'points'],
    onRefresh: () => {
      void refreshFormOptions();
    },
  });

  const openCreateModal = useCallback(
    async (preferredKeywordId?: string) => {
      const openReqId = ++openReqIdRef.current;
      const seq = ++optionsSeqRef.current;
      setOptionsLoading(true);
      try {
        const opts = await client.loadFormOptions();
        if (!mountedRef.current || openReqId !== openReqIdRef.current) return;
        if (seq >= latestAppliedSeqRef.current) {
          latestAppliedSeqRef.current = seq;
          setFormOptions(opts);
        }
        const init = defaultCreateDraft(opts, preferredKeywordId ?? initialKeywordId);
        setEditor({
          initial: init,
          draft: init,
          minimized: false,
          maximized: false,
        });
      } catch (err: unknown) {
        if (!mountedRef.current || openReqId !== openReqIdRef.current) return;
        onLoadErrorRef.current(resolveTaskErrorMessage(err, '加载表单选项失败'));
      } finally {
        if (mountedRef.current && openReqId === openReqIdRef.current) {
          setOptionsLoading(false);
        }
      }
    },
    [client, initialKeywordId],
  );

  return {
    formOptions,
    optionsLoading,
    editor,
    setEditor,
    refreshFormOptions,
    openCreateModal,
  };
}

export type AiTaskCreateModalProps = {
  editor: CreateEditorState | null;
  formOptions: AiTaskFormOptions | null;
  readOnly: boolean;
  tabId: string;
  onEditorChange: Dispatch<SetStateAction<CreateEditorState | null>>;
  onRefreshOptions: () => Promise<AiTaskFormOptions | null> | void;
  onSubmitCreate: (payload: AiTaskCreateInput) => Promise<AiTaskDetailRecord>;
  onCreated: (created: AiTaskDetailRecord) => void;
  onDispatch?: (action: ShellAction) => void;
};

export function AiTaskCreateModal({
  editor,
  formOptions,
  readOnly,
  tabId,
  onEditorChange,
  onRefreshOptions,
  onSubmitCreate,
  onCreated,
  onDispatch,
}: AiTaskCreateModalProps) {
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setFormError(null);
  }, [editor?.initial]);

  const quote = useMemo(
    () => computeAiTaskQuote(editor?.draft, formOptions),
    [editor?.draft, formOptions],
  );
  const usableSystemArticlePrompts = useMemo(
    () => filterUsableSystemArticlePrompts(formOptions),
    [formOptions],
  );
  const manualSlotBlocked = useMemo(
    () => isManualSlotTemplateBlocked(formOptions, editor?.draft.contentTplId ?? ''),
    [formOptions, editor?.draft.contentTplId],
  );

  const updateDraft = useCallback(
    (patch: Partial<CreateDraft>) => {
      onEditorChange((curr) => (curr ? { ...curr, draft: { ...curr.draft, ...patch } } : curr));
    },
    [onEditorChange],
  );

  async function handleSubmitCreate() {
    if (!editor || submitting) return;
    const errors = validateCreateDraft(editor.draft, formOptions);
    if (errors.length > 0) {
      setFormError(errors.join('；'));
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const created = await onSubmitCreate(buildAiTaskCreatePayload(editor.draft));
      onEditorChange(null);
      onCreated(created);
    } catch (err: unknown) {
      setFormError(resolveTaskErrorMessage(err, '创建写作任务失败'));
    } finally {
      setSubmitting(false);
    }
  }

  const userArticlePrompts = formOptions?.articlePrompts.user ?? [];
  const userTitlePrompts = formOptions?.titlePrompts.user ?? [];
  const systemTitlePrompts = formOptions?.titlePrompts.system ?? [];
  const demoNotice = formOptions?.generationMode.bodySimulated
    ? '本次任务会生成示例正文，供预览写作流程。'
    : formOptions?.generationMode.titleSimulated && editor?.draft.titleTplId
      ? '选用标题创作指令后，本次任务会生成示例标题。'
      : null;

  return (
    <CrudModal
      open={editor !== null}
      title="新建 AI 写作任务"
      minimized={editor?.minimized ?? false}
      maximized={editor?.maximized ?? false}
      confirmLoading={submitting}
      error={formError}
      onMinimize={() => onEditorChange((curr) => (curr ? { ...curr, minimized: true } : curr))}
      onRestore={() => {
        onEditorChange((curr) => (curr ? { ...curr, minimized: false } : curr));
        void onRefreshOptions();
      }}
      onMaximize={() =>
        onEditorChange((curr) => (curr ? { ...curr, maximized: !curr.maximized } : curr))
      }
      onClose={() => {
        setFormError(null);
        onEditorChange(null);
      }}
      onReset={() => {
        setFormError(null);
        onEditorChange((curr) => (curr ? { ...curr, draft: curr.initial } : curr));
      }}
      ok={
        <Button
          type="primary"
          aria-label={quote.submitLabel}
          loading={submitting}
          disabled={readOnly || manualSlotBlocked}
          onClick={() => void handleSubmitCreate()}
        >
          {quote.submitLabel}
        </Button>
      }
    >
      {editor ? (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {demoNotice ? (
            <Alert type="info" showIcon message="演示模式" description={demoNotice} />
          ) : null}
          <div style={FORM_GRID_STYLE}>
            {/* 1. 任务名称 */}
            <div>
              <label htmlFor="gm-aitask-name" style={LABEL_STYLE}>
                <span style={{ color: 'var(--gm-danger)' }}>*</span> 任务名称
              </label>
              <Input
                id="gm-aitask-name"
                aria-label="任务名称"
                maxLength={AI_TASK_NAME_MAX}
                placeholder="请输入任务名称，例如：产品选购科普专题"
                value={editor.draft.name}
                onChange={(e) => updateDraft({ name: e.target.value })}
              />
            </div>

            {/* 2. 文章分类 */}
            <div>
              <label htmlFor="gm-aitask-category" style={LABEL_STYLE}>
                文章分类
              </label>
              <select
                id="gm-aitask-category"
                aria-label="文章分类"
                style={NATIVE_SELECT_STYLE}
                value={editor.draft.categoryId}
                onChange={(e) => updateDraft({ categoryId: e.target.value })}
              >
                <option value="">不选择（按任务名称自动创建同名分类）</option>
                {(formOptions?.categories ?? []).map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}（现有 {cat.total} 篇）
                  </option>
                ))}
              </select>
            </div>

            {/* 3. 主关键词 */}
            <div>
              <label htmlFor="gm-aitask-keyword" style={LABEL_STYLE}>
                <span style={{ color: 'var(--gm-danger)' }}>*</span> {UX_TERMS.mainKeyword}
              </label>
              <select
                id="gm-aitask-keyword"
                aria-label={UX_TERMS.mainKeyword}
                style={NATIVE_SELECT_STYLE}
                value={editor.draft.keywordId}
                onChange={(e) => updateDraft({ keywordId: e.target.value })}
              >
                <option value="" disabled>
                  请选择{UX_TERMS.mainKeyword}
                </option>
                {(formOptions?.keywords ?? []).map((kw) => (
                  <option key={kw.id} value={kw.id}>
                    {kw.main}（{kw.questionCount} 条问题）
                  </option>
                ))}
              </select>
            </div>

            {/* 4. 画像图库 */}
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <label htmlFor="gm-aitask-gallery" style={{ margin: 0 }}>
                  {editor.draft.imageCount > 0 ? (
                    <>
                      <span style={{ color: 'var(--gm-danger)' }}>*</span> 画像图库
                    </>
                  ) : (
                    '画像图库（0 张配图时无需选择）'
                  )}
                </label>
                <Button
                  type="link"
                  size="small"
                  aria-label="去新建图库"
                  style={{ padding: 0, height: 'auto' }}
                  onClick={() => {
                    onEditorChange((curr) => (curr ? { ...curr, minimized: true } : curr));
                    onDispatch?.({
                      type: 'open',
                      href: '/material/gallery',
                      sourceId: tabId,
                    });
                  }}
                >
                  去新建图库
                </Button>
              </div>
              <select
                id="gm-aitask-gallery"
                aria-label="画像图库"
                disabled={editor.draft.imageCount === 0}
                style={{
                  ...NATIVE_SELECT_STYLE,
                  ...(editor.draft.imageCount === 0
                    ? { opacity: 0.55, cursor: 'not-allowed' }
                    : undefined),
                }}
                value={editor.draft.imageCount === 0 ? '' : editor.draft.mediaCategoryId}
                onChange={(e) => updateDraft({ mediaCategoryId: e.target.value })}
              >
                <option value="" disabled={editor.draft.imageCount > 0}>
                  {editor.draft.imageCount === 0 ? '0 张配图无需选择图库' : '请选择画像图库'}
                </option>
                {(formOptions?.mediaCategories ?? []).map((gal) => (
                  <option key={gal.id} value={gal.id}>
                    {gal.name}（{gal.assetCount} 张图片）
                  </option>
                ))}
              </select>
            </div>

            {/* 5. 文章配图 */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                <span>文章配图（每篇插图数）</span>
                <Typography.Text strong>{editor.draft.imageCount} 张/篇</Typography.Text>
              </div>
              <Slider
                min={AI_TASK_IMAGE_MIN}
                max={AI_TASK_IMAGE_MAX}
                step={1}
                marks={SLIDER_MARKS}
                value={editor.draft.imageCount}
                onChange={(val) => {
                  if (val === 0 && isGalleryRequiredError(formError)) {
                    setFormError(null);
                  }
                  updateDraft({ imageCount: val });
                }}
              />
            </div>

            {/* 6. 企业知识库 */}
            <div>
              <label htmlFor="gm-aitask-kb" style={LABEL_STYLE}>
                企业知识库（选用附加 +{quote.kbAddonPoints} 点/篇）
              </label>
              <select
                id="gm-aitask-kb"
                aria-label="企业知识库"
                style={NATIVE_SELECT_STYLE}
                value={editor.draft.kbId}
                onChange={(e) => updateDraft({ kbId: e.target.value })}
              >
                <option value="">不使用知识库（基础 {quote.basePoints} 点/篇）</option>
                {(formOptions?.knowledgeBases ?? []).map((kb) => {
                  const indexing = kb.indexStatus === 'INDEXING';
                  const failed = kb.indexStatus === 'FAILED';
                  const statusSuffix = indexing ? ' - 索引中暂不可用' : failed ? ' - 索引异常' : '';
                  return (
                    <option key={kb.id} value={kb.id} disabled={indexing || failed}>
                      {kb.name}（+{quote.kbAddonPoints} 点/篇{statusSuffix}）
                    </option>
                  );
                })}
              </select>
            </div>

            {/* 7. 内容创作指令（严格仅 ARTICLE） */}
            <div>
              <label htmlFor="gm-aitask-content-tpl" style={LABEL_STYLE}>
                内容创作指令
              </label>
              <select
                id="gm-aitask-content-tpl"
                aria-label="内容创作指令"
                style={NATIVE_SELECT_STYLE}
                value={editor.draft.contentTplId}
                onChange={(e) => updateDraft({ contentTplId: e.target.value })}
              >
                <option value="">随机生成文章（按随机池均衡轮转）</option>
                {userArticlePrompts.length > 0 ? (
                  <optgroup label="我的文章指令">
                    {userArticlePrompts.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {usableSystemArticlePrompts.length > 0 ? (
                  <optgroup label="系统默认文章指令">
                    {usableSystemArticlePrompts.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </div>

            {/* 8. 标题创作指令（严格仅 TITLE） */}
            <div>
              <label htmlFor="gm-aitask-title-tpl" style={LABEL_STYLE}>
                标题创作指令
              </label>
              <select
                id="gm-aitask-title-tpl"
                aria-label="标题创作指令"
                style={NATIVE_SELECT_STYLE}
                value={editor.draft.titleTplId}
                onChange={(e) => updateDraft({ titleTplId: e.target.value })}
              >
                <option value="">不重写标题（直接使用所抽取的问题作为标题）</option>
                {userTitlePrompts.length > 0 ? (
                  <optgroup label="我的标题指令">
                    {userTitlePrompts.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {systemTitlePrompts.length > 0 ? (
                  <optgroup label="系统默认标题指令">
                    {systemTitlePrompts.map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </div>

            {/* 9. 文章结果状态 */}
            <div>
              <span style={{ display: 'block', marginBottom: 6 }}>文章结果状态</span>
              <Radio.Group
                value={editor.draft.resultStatus}
                onChange={(e) =>
                  updateDraft({ resultStatus: e.target.value as AiTaskResultStatus })
                }
              >
                <Radio value="PENDING">待人工审核</Radio>
                <Radio value="NORMAL">正常（计入剩余量）</Radio>
              </Radio.Group>
            </div>

            {/* 10. AI 创作数量 */}
            <div>
              <label htmlFor="gm-aitask-target" style={LABEL_STYLE}>
                <span style={{ color: 'var(--gm-danger)' }}>*</span> AI 创作数量（1–100 篇）
              </label>
              <InputNumber
                id="gm-aitask-target"
                aria-label="AI 创作数量"
                min={AI_TASK_TARGET_MIN}
                max={AI_TASK_TARGET_MAX}
                precision={0}
                style={{ width: '100%' }}
                value={editor.draft.target}
                onChange={(val) => updateDraft({ target: typeof val === 'number' ? val : 1 })}
              />
            </div>
          </div>

          {manualSlotBlocked ? (
            <Alert
              type="warning"
              showIcon
              message="所选内容创作指令仍含【品牌1】等手工槽位，请先前往「写作指令」填写具体对比品牌后再选用。"
            />
          ) : null}

          <Alert
            type={editor.draft.kbId ? 'warning' : 'info'}
            showIcon
            data-testid="ai-task-freeze-banner"
            message={quote.freezeText}
          />
        </Space>
      ) : null}
    </CrudModal>
  );
}
