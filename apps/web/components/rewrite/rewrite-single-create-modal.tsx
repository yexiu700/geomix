'use client';

import {
  REWRITE_IMAGE_DEFAULT,
  REWRITE_IMAGE_MAX,
  REWRITE_IMAGE_MIN,
  REWRITE_MIN_SOURCE_CHARS,
  REWRITE_RESULT_STATUS_LABELS,
  countSourceNonWhitespaceChars,
  type RewriteSingleCreateResponse,
} from '@geomix/shared';
import { Alert, Button, Input, Slider, Switch, Typography } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { CrudModal } from '../crud/crud-modal';
import type { RewriteFormOptions, RewriteSingleGateway } from '../../lib/rewrites';
import { NATIVE_SELECT_STYLE } from '../../lib/select-styles';
import { UX_TERMS } from '../../lib/ux-foundation';
import {
  NO_IMAGE_GALLERY_VALUE,
  isCheckableUrl,
  toCreateSingleInput,
  validateCreateDraft,
  type CreateDraft,
} from './rewrite-single-helpers';

export type RewriteSingleCreateModalProps = {
  open: boolean;
  /** 打开时的初始草稿（含「粘贴原文重试」等 seed 预填）；挂载后作为「重置」基准 */
  initial: CreateDraft;
  formOptions: RewriteFormOptions | null;
  unitPoints: number;
  gateway: Pick<RewriteSingleGateway, 'createSingle' | 'checkUrl'>;
  onClose: () => void;
  /** 复刻成功：由父组件关闭弹窗、展示横幅并刷新列表 */
  onCreated: (result: RewriteSingleCreateResponse) => void | Promise<void>;
  /** 复刻失败：失败记录可能以 0 扣点入库，父组件后台刷新列表 */
  onFailed?: () => void;
  /** 从最小化恢复时刷新表单选项（分类/图库/指令） */
  onRefreshOptions?: () => Promise<unknown> | void;
  /** 跳转管理页；未提供时隐藏「管理图库/管理指令/管理分类/前往上传配图」入口 */
  onNavigate?: (href: string) => void;
};

/**
 * 单篇复刻创建弹窗：内聚草稿、URL 失焦 24h 查重、最小化/最大化与提交中/错误态。
 * 父组件按「打开会话」以 key 重新挂载，从而在每次打开时重置内部状态。
 */
export function RewriteSingleCreateModal({
  open,
  initial,
  formOptions,
  unitPoints,
  gateway,
  onClose,
  onCreated,
  onFailed,
  onRefreshOptions,
  onNavigate,
}: RewriteSingleCreateModalProps) {
  const [initialDraft] = useState<CreateDraft>(initial);
  const [draft, setDraft] = useState<CreateDraft>(initial);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [urlWarning, setUrlWarning] = useState<string | null>(null);

  const updateDraft = useCallback((patch: Partial<CreateDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleCheckUrlOnBlur = useCallback(
    async (rawUrl: string) => {
      if (!isCheckableUrl(rawUrl)) {
        setUrlWarning(null);
        return;
      }
      try {
        const res = await gateway.checkUrl(rawUrl.trim());
        setUrlWarning(res.duplicateRecent ? res.warning : null);
      } catch {
        setUrlWarning(null);
      }
    },
    [gateway],
  );

  const handleSubmit = useCallback(async () => {
    setModalError(null);
    const validationError = validateCreateDraft(draft);
    if (validationError) {
      setModalError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      const result = await gateway.createSingle(toCreateSingleInput(draft));
      await onCreated(result);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '复刻失败，请稍后重试');
      onFailed?.();
    } finally {
      setSubmitting(false);
    }
  }, [draft, gateway, onCreated, onFailed]);

  const pastedCharCount = useMemo(
    () => countSourceNonWhitespaceChars(draft.pastedContent),
    [draft.pastedContent],
  );

  const mediaCategoriesWithImages = useMemo(
    () => (formOptions?.mediaCategories ?? []).filter((c) => c.assetCount > 0),
    [formOptions],
  );

  return (
    <CrudModal
      open={open}
      title="单篇爆文复刻"
      minimized={minimized}
      maximized={maximized}
      confirmLoading={submitting}
      error={modalError}
      onMinimize={() => setMinimized(true)}
      onRestore={() => {
        setMinimized(false);
        void onRefreshOptions?.();
      }}
      onMaximize={() => setMaximized((prev) => !prev)}
      onClose={() => {
        if (!submitting) onClose();
      }}
      onReset={() => setDraft(initialDraft)}
      ok={
        <Button
          type="primary"
          loading={submitting}
          aria-label={`复刻文章（${unitPoints}点数/篇）`}
          onClick={() => void handleSubmit()}
        >
          {`复刻文章（${unitPoints}点数/篇）`}
        </Button>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        {/* Source URL vs Pasted Text Switch */}
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
            }}
          >
            <span style={{ fontWeight: 500 }}>
              {draft.pastedText ? '粘贴源文内容（兜底模式） *' : '公开文章链接 *'}
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
              }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                粘贴原文（源站反爬时开启）
              </Typography.Text>
              <Switch
                size="small"
                aria-label="粘贴原文开关"
                checked={draft.pastedText}
                onChange={(checked) => {
                  const hadError = Boolean(modalError);
                  setModalError(null);
                  updateDraft(
                    checked && hadError
                      ? { pastedText: checked, url: '' }
                      : { pastedText: checked },
                  );
                }}
              />
            </span>
          </div>

          {!draft.pastedText ? (
            <div style={{ display: 'grid', gap: 6 }}>
              <Input
                aria-label="文章链接"
                placeholder="请输入微信公众号、知乎专栏或公开资讯文章链接（https://...）"
                value={draft.url}
                onChange={(e) => updateDraft({ url: e.target.value })}
                onBlur={(e) => void handleCheckUrlOnBlur(e.target.value)}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                仅支持公开可访问的网页长文（有效正文不少于 {REWRITE_MIN_SOURCE_CHARS}{' '}
                字）；内网/私有地址自动拦截。
              </Typography.Text>
              {urlWarning ? <Alert type="warning" showIcon message={urlWarning} /> : null}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Input
                  aria-label="粘贴源文标题"
                  placeholder="源文章标题（选填，留空自动提取首行）"
                  value={draft.pastedTitle}
                  onChange={(e) => updateDraft({ pastedTitle: e.target.value })}
                />
                <Input
                  aria-label="参考源链接"
                  placeholder="参考源链接 https://...（选填，便于溯源查重）"
                  value={draft.url}
                  onChange={(e) => updateDraft({ url: e.target.value })}
                />
              </div>
              <Input.TextArea
                aria-label="粘贴原文正文"
                rows={5}
                placeholder={`请粘贴需要参考重写的完整源文正文（至少 ${REWRITE_MIN_SOURCE_CHARS} 字，系统将自动剥离残留标签与外链配图）`}
                value={draft.pastedContent}
                onChange={(e) => updateDraft({ pastedContent: e.target.value })}
              />
              <Typography.Text
                type={pastedCharCount >= REWRITE_MIN_SOURCE_CHARS ? 'secondary' : 'danger'}
                style={{ fontSize: 12 }}
              >
                当前有效字数：{pastedCharCount} 字（最低要求 {REWRITE_MIN_SOURCE_CHARS} 字，超过
                8000 字自动截断保留核心前段）
              </Typography.Text>
            </div>
          )}

          {modalError && !draft.pastedText ? (
            <div style={{ marginTop: 6 }}>
              <Button
                size="small"
                type="dashed"
                onClick={() => {
                  setModalError(null);
                  updateDraft({ pastedText: true });
                }}
              >
                切换为「粘贴原文」手工补充正文
              </Button>
            </div>
          ) : null}
        </div>

        {/* Gallery Category + 0..3 Image Slider */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 14 }}>
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                marginBottom: 6,
              }}
            >
              <span style={{ fontWeight: 500 }}>
                文章配图（{UX_TERMS.gallery}）
                {draft.imageCount > 0 ? (
                  <span style={{ color: 'var(--gm-danger)' }}> *</span>
                ) : null}
              </span>
              {onNavigate ? (
                <Button
                  type="link"
                  size="small"
                  htmlType="button"
                  style={{ padding: 0, height: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNavigate('/material/gallery');
                  }}
                >
                  管理图库
                </Button>
              ) : null}
            </div>
            {mediaCategoriesWithImages.length > 0 ? (
              <select
                aria-label="文章配图图库"
                style={NATIVE_SELECT_STYLE}
                value={
                  draft.imageCount === 0 && !draft.mediaCategoryId
                    ? NO_IMAGE_GALLERY_VALUE
                    : draft.mediaCategoryId
                }
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === NO_IMAGE_GALLERY_VALUE) {
                    updateDraft({ mediaCategoryId: '', imageCount: 0 });
                    return;
                  }
                  const pickedCat = mediaCategoriesWithImages.find((mc) => mc.id === val);
                  const nextCount =
                    val && draft.imageCount === 0
                      ? Math.min(
                          REWRITE_IMAGE_DEFAULT,
                          pickedCat?.assetCount ?? REWRITE_IMAGE_DEFAULT,
                        )
                      : pickedCat && draft.imageCount > pickedCat.assetCount
                        ? Math.max(1, pickedCat.assetCount)
                        : draft.imageCount;
                  updateDraft({
                    mediaCategoryId: val,
                    imageCount: nextCount,
                  });
                }}
              >
                <option value="" disabled>
                  请选择文章配图（或选不配图）
                </option>
                <option value={NO_IMAGE_GALLERY_VALUE}>不配图（0 张，不使用来源站原图）</option>
                {mediaCategoriesWithImages.map((mc) => (
                  <option key={mc.id} value={mc.id}>
                    {mc.name}（{mc.assetCount} 张可用）
                  </option>
                ))}
              </select>
            ) : (
              <Alert
                type="warning"
                showIcon
                message={
                  <span>
                    当前暂无含图片的{UX_TERMS.gallery}分类，可直接以「不配图（0 张）」提交，或
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
            )}
          </div>

          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontWeight: 500,
                marginBottom: 4,
              }}
            >
              <span>正文中混排配图张数</span>
              <Typography.Text strong>{draft.imageCount} 张</Typography.Text>
            </div>
            <Slider
              min={REWRITE_IMAGE_MIN}
              max={REWRITE_IMAGE_MAX}
              step={1}
              marks={{ 0: '0张', 1: '1张', 2: '2张', 3: '3张' }}
              value={draft.imageCount}
              onChange={(val) =>
                updateDraft({
                  imageCount: val,
                  ...(val === 0 ? { mediaCategoryId: '' } : undefined),
                })
              }
            />
          </div>
        </div>

        {/* Prompt Template (REWRITE only) + Optional Brand */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 14 }}>
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                marginBottom: 6,
              }}
            >
              <span style={{ fontWeight: 500 }}>
                爆文改写指令（仅流量复刻类型） <span style={{ color: 'var(--gm-danger)' }}>*</span>
              </span>
              {onNavigate ? (
                <Button
                  type="link"
                  size="small"
                  htmlType="button"
                  style={{ padding: 0, height: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }}
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
              onChange={(e) => updateDraft({ templateId: e.target.value })}
            >
              <option value="" disabled>
                请选择爆文改写指令
              </option>
              {(formOptions?.rewriteTemplates ?? []).map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.isSystem ? `[系统] ${tpl.name}` : tpl.name}
                </option>
              ))}
            </select>
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, display: 'block', marginTop: 4 }}
            >
              此处仅展示「流量复刻」类型指令；如需新建自定义改写指令，请点击右侧「管理指令」。
            </Typography.Text>
          </div>

          <div>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>自然融入品牌词（选填）</div>
            <Input
              aria-label="融入品牌词"
              placeholder="选填：重组时自然提及，不替换原文推荐品牌"
              maxLength={40}
              value={draft.brand}
              onChange={(e) => updateDraft({ brand: e.target.value })}
            />
          </div>
        </div>

        {/* Category Selection / Editable Timestamped Auto Category + Result Status */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 14 }}>
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                marginBottom: 6,
              }}
            >
              <span style={{ fontWeight: 500 }}>归属文章分类</span>
              {onNavigate ? (
                <Button
                  type="link"
                  size="small"
                  htmlType="button"
                  style={{ padding: 0, height: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }}
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
              aria-label="归属文章分类"
              style={NATIVE_SELECT_STYLE}
              value={draft.categoryId}
              onChange={(e) => updateDraft({ categoryId: e.target.value })}
            >
              <option value="">自动新建带时间戳分类（可改名）</option>
              {(formOptions?.categories ?? []).map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
            {!draft.categoryId ? (
              <div style={{ marginTop: 6 }}>
                <Input
                  aria-label="新建分类名称"
                  placeholder="自动新建的分类名称（可自由修改）"
                  maxLength={40}
                  value={draft.autoCategoryName}
                  onChange={(e) => updateDraft({ autoCategoryName: e.target.value })}
                />
              </div>
            ) : null}
          </div>

          <div>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>
              {UX_TERMS.postGenerateArticleStatus}
            </div>
            <div
              role="radiogroup"
              aria-label={UX_TERMS.postGenerateArticleStatus}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                minHeight: 32,
                flexWrap: 'wrap',
              }}
            >
              {(['PENDING', 'NORMAL'] as const).map((statusKey) => (
                <label
                  key={statusKey}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: 'pointer',
                    fontWeight: 400,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <input
                    type="radio"
                    name="rewriteResultStatus"
                    value={statusKey}
                    checked={draft.resultStatus === statusKey}
                    onChange={() => updateDraft({ resultStatus: statusKey })}
                  />
                  <span>{REWRITE_RESULT_STATUS_LABELS[statusKey]}</span>
                </label>
              ))}
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              建议默认设为「待审核」，确认标题与措辞后再批量设为「正常」。
            </Typography.Text>
          </div>
        </div>

        <Alert
          type="info"
          showIcon
          message="合规与扣点保障：系统自动剥离源文全部原图、二维码与导流信息，参考事实重新组织结构；抓取拦截或源文不足 200 字将全额退回冻结点数，且复刻文章不占用「AI写作数量」配额。"
        />
      </div>
    </CrudModal>
  );
}
