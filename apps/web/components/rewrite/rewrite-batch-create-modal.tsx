'use client';

import {
  REWRITE_BATCH_LINK_LIST_MAX,
  REWRITE_BATCH_MAX_COUNT_MAX,
  REWRITE_BATCH_MAX_COUNT_MIN,
  REWRITE_BATCH_NAME_MAX,
  REWRITE_BATCH_URL_AS_KEYWORD_MSG,
  REWRITE_RESULT_STATUS_LABELS,
  type RewriteBatchDetailResponse,
  type RewriteBatchSourceType,
  type RewriteResultStatusName,
} from '@geomix/shared';
import { Alert, Button, Input, InputNumber, Radio, Space, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import { useUxFeedback } from '../crud/ux-feedback';
import type { RewriteBatchFormOptions, RewriteBatchGateway } from '../../lib/rewrite-batches';
import { NATIVE_SELECT_STYLE } from '../../lib/select-styles';
import { UX_TERMS } from '../../lib/ux-foundation';
import {
  BATCH_STYLES,
  NO_IMAGE_GALLERY_VALUE,
  applyDraftNameChange,
  buildInitialDraft,
  computeEstimatedFreezePoints,
  hasKeywordUrlWarning,
  isCreateDraftDirty,
  previewDraftLinkList,
  validateCreateDraft,
  type CreateDraft,
} from './rewrite-batch-helpers';

export type RewriteBatchCreateModalProps = {
  open: boolean;
  initialOptions: RewriteBatchFormOptions | null;
  formOptions: RewriteBatchFormOptions | null;
  unitPoints: number;
  remoteSearchEnabled: boolean;
  busy?: boolean;
  gateway: Pick<RewriteBatchGateway, 'create'>;
  onClose: () => void;
  onCreated: (detail: RewriteBatchDetailResponse) => void | Promise<void>;
  onRefreshOptions?: () => Promise<unknown> | void;
  onNavigate?: (href: string) => void;
};

export function RewriteBatchCreateModal({
  open,
  initialOptions,
  formOptions,
  unitPoints,
  remoteSearchEnabled,
  busy = false,
  gateway,
  onClose,
  onCreated,
  onRefreshOptions,
  onNavigate,
}: RewriteBatchCreateModalProps) {
  const feedback = useUxFeedback();
  const [initialDraft] = useState<CreateDraft>(() => buildInitialDraft(initialOptions));
  const [draft, setDraft] = useState<CreateDraft>(() => buildInitialDraft(initialOptions));
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const activeOptions = formOptions ?? initialOptions;
  const confirmLoading = busy || submitting;

  const draftLinkAnalysis = useMemo(() => previewDraftLinkList(draft), [draft]);
  const keywordIsUrlWarning = useMemo(() => hasKeywordUrlWarning(draft.keyword), [draft.keyword]);
  const isDirty = useMemo(() => isCreateDraftDirty(draft, initialDraft), [draft, initialDraft]);

  const mediaCategoriesWithImages = useMemo(
    () => (activeOptions?.mediaCategories ?? []).filter((cat) => cat.assetCount > 0),
    [activeOptions],
  );

  const selectedMediaCat = useMemo(
    () =>
      (activeOptions?.mediaCategories ?? []).find((cat) => cat.id === draft.mediaCategoryId) ??
      null,
    [activeOptions, draft.mediaCategoryId],
  );

  const estimatedFreezePoints = computeEstimatedFreezePoints(draft.maxCount, unitPoints);

  const requestCloseModal = () => {
    if (!isDirty) {
      setModalError(null);
      onClose();
      return;
    }
    feedback.confirm({
      title: '放弃未提交的批量复刻草稿？',
      content: '已填写的任务配置与链接清单尚未提交，确定关闭吗？',
      okText: '放弃并关闭',
      cancelText: '继续编辑',
      onOk: () => {
        setModalError(null);
        onClose();
      },
    });
  };

  const handleRestore = () => {
    setMinimized(false);
    void onRefreshOptions?.();
  };

  const handleSubmitCreate = async () => {
    setModalError(null);
    const validation = validateCreateDraft(draft, {
      remoteSearchEnabled,
      mediaCategories: activeOptions?.mediaCategories,
    });
    if (!validation.ok) {
      setModalError(validation.errorMessage);
      return;
    }

    setSubmitting(true);
    try {
      const created = await gateway.create(validation.payload);
      await onCreated(created);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '创建批量复刻任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const modalNode = (
    <CrudModal
      open
      title="新建批量爆文复刻任务"
      minimized={minimized}
      maximized={maximized}
      confirmLoading={confirmLoading}
      error={modalError}
      ok={
        <Button type="primary" loading={confirmLoading} onClick={() => void handleSubmitCreate()}>
          {`开始批量复刻（${unitPoints}点数/篇，预冻 ${estimatedFreezePoints} 点）`}
        </Button>
      }
      onClose={requestCloseModal}
      onReset={() => {
        setModalError(null);
        setDraft(initialDraft);
      }}
      onMinimize={() => setMinimized(true)}
      onRestore={handleRestore}
      onMaximize={() => setMaximized((prev) => !prev)}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={BATCH_STYLES.modalPricingBanner}>
          <div>
            <div className="gm-num" style={{ fontWeight: 600, color: 'var(--gm-info)' }}>
              计费标准：{unitPoints} 点数/篇 · 本次上限 {draft.maxCount} 篇
            </div>
            <div style={{ fontSize: 12, color: 'var(--gm-fg-2)', marginTop: 2 }}>
              按成功生成篇数逐篇结算；单链失败、防爬拦截、超时无响应或凑满即停时，剩余点数自动全额退回账户，不占用
              AI 写作配额。
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <div>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>
              任务名称 <span style={{ color: 'var(--gm-danger)' }}>*</span>
            </div>
            <Input
              aria-label="任务名称"
              placeholder="例如：行业技术干货批量复刻"
              maxLength={REWRITE_BATCH_NAME_MAX}
              value={draft.name}
              onChange={(e) => setDraft((prev) => applyDraftNameChange(prev, e.target.value))}
            />
          </div>
          <div>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>
              最大改写量（凑满即停） <span style={{ color: 'var(--gm-danger)' }}>*</span>
            </div>
            <InputNumber
              aria-label="最大改写量"
              min={REWRITE_BATCH_MAX_COUNT_MIN}
              max={REWRITE_BATCH_MAX_COUNT_MAX}
              precision={0}
              style={{ width: '100%' }}
              value={draft.maxCount}
              onChange={(val) =>
                setDraft((prev) => ({ ...prev, maxCount: typeof val === 'number' ? val : 1 }))
              }
            />
          </div>
        </div>

        <div>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>候选寻源方式</div>
          <Radio.Group
            value={draft.sourceType}
            onChange={(e) => {
              const nextType = e.target.value as RewriteBatchSourceType;
              if (nextType === 'remote' && !remoteSearchEnabled) {
                return;
              }
              setModalError(null);
              setDraft((prev) => ({ ...prev, sourceType: nextType }));
            }}
          >
            <Radio.Button value="link_list">
              粘贴公开文章链接清单（默认推荐，最多 {REWRITE_BATCH_LINK_LIST_MAX} 条）
            </Radio.Button>
            <Radio.Button value="remote" disabled={!remoteSearchEnabled}>
              {remoteSearchEnabled ? '关键词全网搜索' : '关键词全网搜索（暂未开通）'}
            </Radio.Button>
          </Radio.Group>
          {!remoteSearchEnabled && (
            <Typography.Text
              type="secondary"
              style={{ display: 'block', fontSize: 12, marginTop: 6 }}
            >
              当前环境未配置第三方搜索源，「关键词全网搜索」暂未开通，请使用「粘贴公开文章链接清单」。
            </Typography.Text>
          )}
        </div>

        {draft.sourceType === 'link_list' ? (
          <>
            <div>
              <div style={BATCH_STYLES.fieldLabelRow}>
                <span style={{ fontWeight: 500 }}>
                  公开文章链接清单（一行一条） <span style={{ color: 'var(--gm-danger)' }}>*</span>
                </span>
                {draftLinkAnalysis && (
                  <span className="gm-num" style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
                    有效候选 <b>{draftLinkAnalysis.candidates.length}</b> 条
                    {draftLinkAnalysis.duplicateLines.length > 0
                      ? ` · 去重 ${draftLinkAnalysis.duplicateLines.length} 条`
                      : ''}
                    {draftLinkAnalysis.excludedLines.length > 0
                      ? ` · 自动排除视频/商品页 ${draftLinkAnalysis.excludedLines.length} 条`
                      : ''}
                    {draftLinkAnalysis.invalidLines.length > 0
                      ? ` · 异常链接 ${draftLinkAnalysis.invalidLines.length} 条`
                      : ''}
                  </span>
                )}
              </div>
              <Input.TextArea
                aria-label="公开文章链接清单"
                rows={5}
                placeholder={
                  'https://mp.weixin.qq.com/s/example-article-1\nhttps://zhuanlan.zhihu.com/p/12345678\n（一行一条公开技术/行业文章链接，单次最多 50 条；若候选多于最大改写量，成功凑满后立即停止）'
                }
                value={draft.linksText}
                onChange={(e) => setDraft((prev) => ({ ...prev, linksText: e.target.value }))}
              />
              {draftLinkAnalysis?.firstInvalidWarning && (
                <Alert
                  style={{ marginTop: 8 }}
                  type="warning"
                  showIcon
                  message={draftLinkAnalysis.firstInvalidWarning}
                />
              )}
            </div>

            <div>
              <div style={{ fontWeight: 500, marginBottom: 6 }}>主题标签 / 备注词（选填）</div>
              <Input
                aria-label="主题标签"
                placeholder="选填，便于在列表中按关键词检索归类（切勿在此填入 URL）"
                value={draft.keyword}
                onChange={(e) => setDraft((prev) => ({ ...prev, keyword: e.target.value }))}
              />
              {keywordIsUrlWarning && (
                <Alert
                  style={{ marginTop: 8 }}
                  type="error"
                  showIcon
                  message={REWRITE_BATCH_URL_AS_KEYWORD_MSG}
                />
              )}
            </div>
          </>
        ) : (
          <div>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>
              流量关键词 <span style={{ color: 'var(--gm-danger)' }}>*</span>
            </div>
            <Input
              aria-label="流量关键词"
              placeholder="请输入行业或产品关键词（例如：企业数字化转型方案），切勿填写网页链接"
              value={draft.keyword}
              onChange={(e) => setDraft((prev) => ({ ...prev, keyword: e.target.value }))}
            />
            {keywordIsUrlWarning && (
              <Alert
                style={{ marginTop: 8 }}
                type="error"
                showIcon
                message={REWRITE_BATCH_URL_AS_KEYWORD_MSG}
              />
            )}
            {!remoteSearchEnabled && !keywordIsUrlWarning && (
              <Alert
                style={{ marginTop: 8 }}
                type="info"
                showIcon
                message="当前工作区默认使用「粘贴公开文章链接清单」寻源（未配置第三方全网搜索密钥），建议切换回链接清单模式直接粘贴目标文章 URL。"
              />
            )}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div style={BATCH_STYLES.fieldLabelRow}>
              <span style={{ fontWeight: 500 }}>
                文章配图（{UX_TERMS.gallery}）
                {!draft.noImage ? (
                  <>
                    {' '}
                    <span style={{ color: 'var(--gm-danger)' }}>*</span>
                  </>
                ) : null}
              </span>
              {onNavigate ? (
                <Button
                  type="link"
                  size="small"
                  htmlType="button"
                  style={BATCH_STYLES.inlineNavLink}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNavigate('/material/gallery');
                  }}
                >
                  管理图库
                </Button>
              ) : null}
            </div>
            <select
              aria-label="文章配图图库分类"
              style={NATIVE_SELECT_STYLE}
              value={draft.noImage ? NO_IMAGE_GALLERY_VALUE : draft.mediaCategoryId}
              onChange={(e) => {
                const val = e.target.value;
                if (val === NO_IMAGE_GALLERY_VALUE) {
                  setDraft((prev) => ({ ...prev, mediaCategoryId: '', noImage: true }));
                  return;
                }
                setDraft((prev) => ({ ...prev, mediaCategoryId: val, noImage: false }));
              }}
            >
              <option value="">不选择</option>
              <option value={NO_IMAGE_GALLERY_VALUE}>不配图（0 张，不使用来源站原图）</option>
              {(activeOptions?.mediaCategories ?? []).map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}（{cat.assetCount} 张可用）
                </option>
              ))}
            </select>
            {mediaCategoriesWithImages.length === 0 ? (
              <Alert
                style={{ marginTop: 6 }}
                type="warning"
                showIcon
                message={
                  <span>
                    当前暂无含图片的{UX_TERMS.gallery}
                    分类，已默认设为「不配图（0 张）」可直接提交，或
                    {onNavigate ? (
                      <Button
                        type="link"
                        size="small"
                        htmlType="button"
                        style={{ padding: '0 4px', height: 'auto' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onNavigate('/material/gallery');
                        }}
                      >
                        前往上传配图
                      </Button>
                    ) : null}
                  </span>
                }
              />
            ) : (
              <div style={{ fontSize: 12, color: 'var(--gm-fg-3)', marginTop: 4 }}>
                {draft.noImage
                  ? '已选择不配图（0 张）：正文不插入图片且严禁使用来源站原图。'
                  : '按原文篇幅自动插图（<600字 1 张 / 600字以上 2 张），严禁使用来源站原图。'}
                {!draft.noImage && selectedMediaCat && selectedMediaCat.assetCount === 0 && (
                  <span style={{ color: 'var(--gm-danger)', marginLeft: 4 }}>
                    当前{UX_TERMS.gallery}分类暂无图片，请先上传图片或选择「不配图（0 张）」！
                  </span>
                )}
              </div>
            )}
          </div>

          <div>
            <div style={BATCH_STYLES.fieldLabelRow}>
              <span style={{ fontWeight: 500 }}>
                爆文改写指令（仅流量复刻类型） <span style={{ color: 'var(--gm-danger)' }}>*</span>
              </span>
              {onNavigate ? (
                <Button
                  type="link"
                  size="small"
                  htmlType="button"
                  style={BATCH_STYLES.inlineNavLink}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNavigate('/writing/prompts');
                  }}
                >
                  管理指令
                </Button>
              ) : null}
            </div>
            <select
              aria-label="爆文改写指令"
              style={NATIVE_SELECT_STYLE}
              value={draft.templateId}
              onChange={(e) => setDraft((prev) => ({ ...prev, templateId: e.target.value }))}
            >
              <option value="">不选择</option>
              {(activeOptions?.rewriteTemplates ?? []).map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.isSystem ? `[系统] ${tpl.name}` : tpl.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div>
            <div style={BATCH_STYLES.fieldLabelRow}>
              <span style={{ fontWeight: 500 }}>归档文章分类</span>
              {onNavigate ? (
                <Button
                  type="link"
                  size="small"
                  htmlType="button"
                  style={BATCH_STYLES.inlineNavLink}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNavigate('/writing/categories');
                  }}
                >
                  管理分类
                </Button>
              ) : null}
            </div>
            <select
              aria-label="归档文章分类"
              style={NATIVE_SELECT_STYLE}
              value={draft.categoryId}
              onChange={(e) => setDraft((prev) => ({ ...prev, categoryId: e.target.value }))}
            >
              <option value="">自动新建（{draft.autoCategoryName}）</option>
              {(activeOptions?.categories ?? []).map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>自然融入品牌词（选填）</div>
            <Input
              aria-label="品牌词融入"
              placeholder="选填：重组时自然提及，不替换原文推荐品牌"
              maxLength={40}
              value={draft.brand}
              onChange={(e) => setDraft((prev) => ({ ...prev, brand: e.target.value }))}
            />
          </div>

          <div>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>
              {UX_TERMS.postGenerateArticleStatus}
            </div>
            <select
              aria-label={UX_TERMS.postGenerateArticleStatus}
              style={NATIVE_SELECT_STYLE}
              value={draft.resultStatus}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  resultStatus: e.target.value as RewriteResultStatusName,
                }))
              }
            >
              <option value="PENDING">{REWRITE_RESULT_STATUS_LABELS.PENDING}</option>
              <option value="NORMAL">{REWRITE_RESULT_STATUS_LABELS.NORMAL}</option>
            </select>
          </div>
        </div>
      </div>
    </CrudModal>
  );

  if (minimized) {
    return (
      <>
        <Alert
          type="info"
          showIcon
          message={`已最小化草稿：${draft.name || '未命名批量复刻任务'}（预冻 ${estimatedFreezePoints} 点数）`}
          action={
            <Space>
              <Button size="small" type="primary" onClick={handleRestore}>
                恢复窗口
              </Button>
              <Button size="small" onClick={requestCloseModal}>
                关闭草稿
              </Button>
            </Space>
          }
        />
        {modalNode}
      </>
    );
  }

  return modalNode;
}
