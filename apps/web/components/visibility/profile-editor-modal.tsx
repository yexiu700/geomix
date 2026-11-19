'use client';

import {
  VISIBILITY_BRAND_NAME_MAX,
  VISIBILITY_MAX_COMPETITORS,
  VISIBILITY_PROFILE_NAME_MAX,
  type VisibilityPrefillSources,
  type VisibilityProfileRecord,
} from '@geomix/shared';
import { Button, Input, Space, Switch, Tooltip, Typography } from 'antd';
import { useState, type CSSProperties } from 'react';
import { NATIVE_SELECT_STYLE } from '../../lib/select-styles';
import type { VisibilityGateway } from '../../lib/visibility';
import { CrudModal } from '../crud/crud-modal';
import { SignalEmpty, SignalPill, TruncText } from '../geo/primitives';
import {
  PROFILE_GRID_STYLE,
  applyKbPrefillToDraft,
  applyKeywordPrefillToDraft,
  buildEditProfileDraft,
  buildEmptyProfileDraft,
  buildProfileCardStyle,
  normalizeProfileDomainsAndCompetitors,
  splitTagList,
  validateProfileBrandName,
  validateProfileName,
  type CompetitorDraftRow,
  type ProfileModalState,
} from './monitors-helpers';

const PREFILL_PANEL_STYLE: CSSProperties = {
  padding: 12,
  marginBottom: 14,
  borderRadius: 8,
  border: '1px solid var(--gm-line-2)',
  background: 'var(--gm-bg-surface)',
};
const PREFILL_GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 10,
};
const COMP_ROW_BOX_STYLE: CSSProperties = {
  padding: 10,
  borderRadius: 8,
  border: '1px solid var(--gm-line-1)',
  background: 'var(--gm-bg-surface)',
};
const REMOVE_COMP_BTN_STYLE: CSSProperties = {
  width: 32,
  height: 32,
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const FLEX_BETWEEN_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginBottom: 8,
};
const CARD_HEADER_ROW_STYLE: CSSProperties = { ...FLEX_BETWEEN_ROW_STYLE, gap: 6 };
const BRAND_ROW_STYLE: CSSProperties = {
  marginBottom: 8,
  fontSize: 13,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};
const FIELD_ERROR_STYLE: CSSProperties = { margin: '4px 0 0', fontSize: 12 };

export type ProfileSavedMeta = { mode: 'create' | 'edit'; isDefault: boolean };

export type ProfileEditorModalProps = {
  open: boolean;
  session: number;
  mode: 'create' | 'edit';
  editingProfile: VisibilityProfileRecord | null;
  initialIsDefault: boolean;
  isFirstProfile: boolean;
  prefillSources: VisibilityPrefillSources;
  client: VisibilityGateway;
  readOnly?: boolean;
  onRefreshMeta: () => void;
  onClose: () => void;
  onSaved: (saved: VisibilityProfileRecord, meta: ProfileSavedMeta) => void;
};

export function ProfileEditorModal({
  open,
  session,
  mode,
  editingProfile,
  initialIsDefault,
  isFirstProfile,
  prefillSources,
  client,
  readOnly = false,
  onRefreshMeta,
  onClose,
  onSaved,
}: ProfileEditorModalProps) {
  const sessionKey = open ? `${session}:${mode}:${editingProfile?.id ?? 'new'}` : null;

  const computeInitialDraft = () =>
    mode === 'edit' && editingProfile
      ? buildEditProfileDraft(editingProfile, initialIsDefault)
      : buildEmptyProfileDraft(initialIsDefault);

  const [activeSessionKey, setActiveSessionKey] = useState<string | null>(sessionKey);
  const [modalState, setModalState] = useState<ProfileModalState>(() => {
    const initial = computeInitialDraft();
    return { initial, draft: initial, minimized: false, maximized: false };
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; brandName?: string }>({});
  const [touched, setTouched] = useState<{ name?: boolean; brandName?: boolean }>({});
  const [submitting, setSubmitting] = useState(false);

  if (sessionKey !== activeSessionKey) {
    setActiveSessionKey(sessionKey);
    if (sessionKey !== null) {
      const initial = computeInitialDraft();
      setModalState({ initial, draft: initial, minimized: false, maximized: false });
      setError(null);
      setFieldErrors({});
      setTouched({});
      setSubmitting(false);
    }
  }

  const { draft } = modalState;

  function patchCompetitor(idx: number, patch: Partial<CompetitorDraftRow>) {
    setModalState((curr) => ({
      ...curr,
      draft: {
        ...curr.draft,
        competitors: curr.draft.competitors.map((row, i) =>
          i === idx ? { ...row, ...patch } : row,
        ),
      },
    }));
  }

  function applyPrefillResult(nextDraft: typeof draft, cleared: boolean) {
    setModalState((curr) => ({ ...curr, draft: nextDraft }));
    if (cleared) {
      setFieldErrors((prev) => ({
        ...prev,
        ...(touched.brandName ? { brandName: validateProfileBrandName(nextDraft) } : {}),
      }));
    } else if (nextDraft !== draft) {
      setFieldErrors({
        name: validateProfileName(nextDraft.name),
        brandName: validateProfileBrandName(nextDraft),
      });
    }
  }

  async function handleSave() {
    if (!open || readOnly) return;
    setError(null);
    setTouched({ name: true, brandName: true });

    const nameError = validateProfileName(draft.name);
    const brandError = validateProfileBrandName(draft);
    if (nameError || brandError) {
      setFieldErrors({
        ...(nameError ? { name: nameError } : {}),
        ...(brandError ? { brandName: brandError } : {}),
      });
      if (nameError) {
        setError(nameError);
        return;
      }
      if (brandError) {
        setError(
          draft.mode === 'create' &&
            (prefillSources.keywords.length > 0 || prefillSources.knowledgeBases.length > 0)
            ? '请填写主品牌名称，或选择关键词/企业知识库快捷导入'
            : brandError,
        );
        return;
      }
    }
    setFieldErrors({});

    const name = draft.name.trim();
    const brandName = draft.brandName.trim();

    const normalized = normalizeProfileDomainsAndCompetitors(draft);
    if (!normalized.ok) {
      setError(normalized.error);
      return;
    }
    const { ownedDomains, competitors } = normalized;
    const brandAliases = splitTagList(draft.brandAliasesText);

    setSubmitting(true);
    try {
      const saved =
        draft.mode === 'edit' && draft.editId
          ? await client.updateProfile(draft.editId, {
              name,
              brandName,
              brandAliases,
              ownedDomains,
              competitors,
            })
          : await client.createProfile({
              name,
              ...(brandName ? { brandName } : {}),
              brandAliases,
              ownedDomains,
              competitors,
              ...(draft.importFromKeywordId
                ? { importFromKeywordId: draft.importFromKeywordId }
                : {}),
              ...(draft.importFromKbId ? { importFromKbId: draft.importFromKbId } : {}),
            });

      onSaved(saved, { mode: draft.mode, isDefault: draft.isDefault });
      setFieldErrors({});
      setTouched({});
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存监测档案失败');
    } finally {
      setSubmitting(false);
    }
  }

  const aliasPreviewTags = splitTagList(draft.brandAliasesText);

  return (
    <CrudModal
      open={open}
      title={draft.mode === 'edit' ? '编辑品牌与竞品档案' : '新建品牌与竞品档案'}
      minimized={modalState.minimized}
      maximized={modalState.maximized}
      confirmLoading={submitting}
      error={error}
      onMinimize={() => setModalState((curr) => ({ ...curr, minimized: true }))}
      onRestore={() => {
        setModalState((curr) => ({ ...curr, minimized: false }));
        onRefreshMeta();
      }}
      onMaximize={() => setModalState((curr) => ({ ...curr, maximized: !curr.maximized }))}
      onClose={() => {
        if (submitting) return;
        setError(null);
        setFieldErrors({});
        setTouched({});
        onClose();
      }}
      onReset={() => {
        setError(null);
        setFieldErrors({});
        setTouched({});
        setModalState((curr) => ({ ...curr, draft: curr.initial }));
      }}
      ok={
        <Button
          type="primary"
          aria-label="保存品牌档案"
          loading={submitting}
          onClick={() => void handleSave()}
        >
          保存档案
        </Button>
      }
    >
      {open ? (
        <div className="gm-profile-modal-body">
          {draft.mode === 'create' &&
          (prefillSources.keywords.length > 0 || prefillSources.knowledgeBases.length > 0) ? (
            <div style={PREFILL_PANEL_STYLE}>
              <Typography.Text strong style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>
                快捷预填品牌信息（可选）
              </Typography.Text>
              <div style={PREFILL_GRID_STYLE}>
                {prefillSources.keywords.length > 0 ? (
                  <label style={{ marginBottom: 0 }}>
                    <span style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
                      从训练主词导入品牌词
                    </span>
                    <select
                      aria-label="从关键词快捷预填"
                      style={NATIVE_SELECT_STYLE}
                      value={draft.importFromKeywordId}
                      onChange={(e) =>
                        applyPrefillResult(
                          applyKeywordPrefillToDraft(
                            draft,
                            e.target.value,
                            prefillSources.keywords,
                          ),
                          !e.target.value,
                        )
                      }
                    >
                      <option value="">不导入主词</option>
                      {prefillSources.keywords.map((kw) => (
                        <option key={kw.id} value={kw.id}>
                          {kw.main}
                          {kw.brands.length > 0 ? `（品牌：${kw.brands.join(' / ')}）` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {prefillSources.knowledgeBases.length > 0 ? (
                  <label style={{ marginBottom: 0 }}>
                    <span style={{ fontSize: 12, color: 'var(--gm-fg-2)' }}>
                      从企业知识库导入品牌词
                    </span>
                    <select
                      aria-label="从知识库快捷预填"
                      style={NATIVE_SELECT_STYLE}
                      value={draft.importFromKbId}
                      onChange={(e) =>
                        applyPrefillResult(
                          applyKbPrefillToDraft(
                            draft,
                            e.target.value,
                            prefillSources.knowledgeBases,
                          ),
                          !e.target.value,
                        )
                      }
                    >
                      <option value="">不导入知识库</option>
                      {prefillSources.knowledgeBases.map((kb) => (
                        <option key={kb.id} value={kb.id}>
                          {kb.name}
                          {kb.brandShort ? `（${kb.brandShort}）` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            </div>
          ) : null}

          <div style={{ marginBottom: 12 }}>
            <label style={{ marginBottom: 0 }}>
              <span>
                <span className="gm-required-mark" style={{ color: 'var(--gm-danger)' }}>
                  *{' '}
                </span>
                档案名称
              </span>
              <Input
                aria-label="档案名称"
                aria-invalid={Boolean(fieldErrors.name) || undefined}
                status={fieldErrors.name ? 'error' : undefined}
                placeholder="例如：星图办公硬件-便携显示器监测档案"
                maxLength={VISIBILITY_PROFILE_NAME_MAX}
                value={draft.name}
                onBlur={(e) => {
                  const msg = validateProfileName(e.target.value);
                  setTouched((curr) => ({ ...curr, name: true }));
                  setFieldErrors((curr) => ({ ...curr, name: msg }));
                }}
                onChange={(e) => {
                  const nextVal = e.target.value;
                  setModalState((curr) => ({ ...curr, draft: { ...curr.draft, name: nextVal } }));
                  if (touched.name || fieldErrors.name || error) {
                    const msg = validateProfileName(nextVal);
                    setFieldErrors((curr) => ({ ...curr, name: msg }));
                    if (!msg && error === '请填写档案名称') setError(null);
                  }
                }}
              />
            </label>
            {fieldErrors.name ? (
              <p
                className="gm-form-error"
                data-testid="profile-name-error"
                role="alert"
                style={FIELD_ERROR_STYLE}
              >
                {fieldErrors.name}
              </p>
            ) : null}
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ marginBottom: 0 }}>
              <span>
                <span className="gm-required-mark" style={{ color: 'var(--gm-danger)' }}>
                  *{' '}
                </span>
                主品牌名称
              </span>
              <Input
                aria-label="主品牌名称"
                aria-invalid={Boolean(fieldErrors.brandName) || undefined}
                status={fieldErrors.brandName ? 'error' : undefined}
                placeholder="例如：星图显示"
                maxLength={VISIBILITY_BRAND_NAME_MAX}
                value={draft.brandName}
                onBlur={() => {
                  setTouched((curr) => ({ ...curr, brandName: true }));
                  setFieldErrors((curr) => ({
                    ...curr,
                    brandName: validateProfileBrandName(draft),
                  }));
                }}
                onChange={(e) => {
                  const nextDraft = { ...draft, brandName: e.target.value };
                  setModalState((curr) => ({ ...curr, draft: nextDraft }));
                  if (touched.brandName || fieldErrors.brandName || error) {
                    const msg = validateProfileBrandName(nextDraft);
                    setFieldErrors((curr) => ({ ...curr, brandName: msg }));
                    if (!msg && error && error.startsWith('请填写主品牌名称')) setError(null);
                  }
                }}
              />
            </label>
            {fieldErrors.brandName ? (
              <p
                className="gm-form-error"
                data-testid="profile-brand-error"
                role="alert"
                style={FIELD_ERROR_STYLE}
              >
                {fieldErrors.brandName}
              </p>
            ) : null}
          </div>

          <label>
            <span>品牌别名（支持逗号或换行分隔，自动识别中英文简称）</span>
            <Input.TextArea
              aria-label="品牌别名"
              rows={2}
              placeholder="例如：StarView, 星图便携屏, 星图触控显示器"
              value={draft.brandAliasesText}
              onChange={(e) =>
                setModalState((curr) => ({
                  ...curr,
                  draft: { ...curr.draft, brandAliasesText: e.target.value },
                }))
              }
            />
            {aliasPreviewTags.length > 0 ? (
              <Space size={[4, 4]} wrap>
                {aliasPreviewTags.map((tag) => (
                  <span key={tag} className="gm-engine-chip">
                    {tag}
                  </span>
                ))}
              </Space>
            ) : null}
          </label>

          <label>
            <span>自有官网与文档域名（支持逗号或换行分隔，用于统计自有信源引用率）</span>
            <Input.TextArea
              aria-label="自有官网域名"
              rows={2}
              placeholder="例如：starview.cn, docs.starview.cn"
              value={draft.ownedDomainsText}
              onChange={(e) =>
                setModalState((curr) => ({
                  ...curr,
                  draft: { ...curr.draft, ownedDomainsText: e.target.value },
                }))
              }
            />
          </label>

          <div style={{ marginBottom: 14 }}>
            <div style={FLEX_BETWEEN_ROW_STYLE}>
              <Typography.Text strong>
                同赛道监测竞品（{draft.competitors.length}/{VISIBILITY_MAX_COMPETITORS}）
              </Typography.Text>
              <Button
                size="small"
                aria-label="添加监测竞品"
                disabled={draft.competitors.length >= VISIBILITY_MAX_COMPETITORS}
                onClick={() =>
                  setModalState((curr) => {
                    if (curr.draft.competitors.length >= VISIBILITY_MAX_COMPETITORS) return curr;
                    const nextRow: CompetitorDraftRow = {
                      key: `comp_${Date.now()}_${curr.draft.competitors.length}`,
                      name: '',
                      aliasesText: '',
                      domainsText: '',
                    };
                    return {
                      ...curr,
                      draft: { ...curr.draft, competitors: [...curr.draft.competitors, nextRow] },
                    };
                  })
                }
              >
                添加竞品
              </Button>
            </div>

            {draft.competitors.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                添加同品类竞品后，看板将自动计算本品牌与各竞品的声量占比（Share of
                Voice）与竞品官网引用占比。
              </Typography.Text>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {draft.competitors.map((comp, idx) => (
                  <div key={comp.key} style={COMP_ROW_BOX_STYLE}>
                    <div className="gm-competitor-grid">
                      <Input
                        aria-label={`竞品名称-${idx + 1}`}
                        placeholder="竞品名称（必填）"
                        value={comp.name}
                        onChange={(e) => patchCompetitor(idx, { name: e.target.value })}
                      />
                      <Input
                        aria-label={`竞品别名-${idx + 1}`}
                        placeholder="竞品别名（逗号分隔）"
                        value={comp.aliasesText}
                        onChange={(e) => patchCompetitor(idx, { aliasesText: e.target.value })}
                      />
                      <Input
                        aria-label={`竞品域名-${idx + 1}`}
                        placeholder="竞品域名（如 rival.cn）"
                        value={comp.domainsText}
                        onChange={(e) => patchCompetitor(idx, { domainsText: e.target.value })}
                      />
                      <Button
                        size="small"
                        type="text"
                        danger
                        aria-label={`移除竞品-${idx + 1}`}
                        style={REMOVE_COMP_BTN_STYLE}
                        onClick={() =>
                          setModalState((curr) => ({
                            ...curr,
                            draft: {
                              ...curr.draft,
                              competitors: curr.draft.competitors.filter((_, i) => i !== idx),
                            },
                          }))
                        }
                      >
                        ×
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Switch
              aria-label="设为默认档案"
              checked={draft.isDefault}
              onChange={(checked) =>
                setModalState((curr) => ({ ...curr, draft: { ...curr.draft, isDefault: checked } }))
              }
            />
            <span>
              {draft.mode === 'create' && isFirstProfile
                ? '设为默认监测档案（当前为首个档案，创建后将自动设为默认）'
                : '设为默认监测档案（进入数据看板与新建监测时默认选中）'}
            </span>
          </div>
        </div>
      ) : null}
    </CrudModal>
  );
}

export type VisibilityProfilesTabProps = {
  profiles: VisibilityProfileRecord[];
  effectiveDefaultProfileId: string;
  readOnly?: boolean;
  onCreateProfile: () => void;
  onEditProfile: (profile: VisibilityProfileRecord) => void;
  onDeleteProfile: (profile: VisibilityProfileRecord) => void;
  onSetDefault: (profile: VisibilityProfileRecord) => void;
  onStartRunForProfile: (profileId: string) => void;
  onOpenOverviewForProfile: (profileId: string) => void;
};

type CardActProps = {
  label: string;
  text: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

function CardActBtn({ label, text, primary, danger, disabled, onClick }: CardActProps) {
  return (
    <Button
      size="small"
      type={primary ? 'primary' : 'default'}
      danger={danger}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {text}
    </Button>
  );
}

export function VisibilityProfilesTab({
  profiles,
  effectiveDefaultProfileId,
  readOnly = false,
  onCreateProfile,
  onEditProfile,
  onDeleteProfile,
  onSetDefault,
  onStartRunForProfile,
  onOpenOverviewForProfile,
}: VisibilityProfilesTabProps) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...FLEX_BETWEEN_ROW_STYLE, marginBottom: 12 }}>
        <Typography.Text type="secondary">
          每个档案定义主品牌名称、常见中英文别名、自有官网域名及最多 {VISIBILITY_MAX_COMPETITORS}{' '}
          个同赛道竞品，用于自动识别提及顺位与引用信源分类。
        </Typography.Text>
        <Button
          type="primary"
          aria-label="新增品牌与竞品档案"
          disabled={readOnly}
          onClick={onCreateProfile}
        >
          新增档案
        </Button>
      </div>

      {profiles.length === 0 ? (
        <div className="gm-panel">
          <SignalEmpty
            title="暂无品牌与竞品监测档案"
            description="您可以直接录入主品牌与官网域名，或从已有「关键词 / 企业知识库」一键预填品牌词。"
            actionText={readOnly ? undefined : '立即创建首个品牌档案'}
            onAction={onCreateProfile}
          />
        </div>
      ) : (
        <div style={PROFILE_GRID_STYLE}>
          {profiles.map((prof) => {
            const isDefault = prof.id === effectiveDefaultProfileId;
            const shownCompetitors = prof.competitors.slice(0, 3);
            const hiddenCompetitors = prof.competitors.slice(3);
            return (
              <div
                key={prof.id}
                data-testid={`profile-card-${prof.id}`}
                style={buildProfileCardStyle(isDefault)}
              >
                <div>
                  <div style={CARD_HEADER_ROW_STYLE}>
                    <Typography.Text strong style={{ fontSize: 16, color: 'var(--gm-fg-1)' }}>
                      {prof.name}
                    </Typography.Text>
                    <Space size={4} wrap>
                      {isDefault ? <SignalPill tone="cited">默认档案</SignalPill> : null}
                      <SignalPill tone="neutral">
                        <span className="gm-num">{prof.runCount ?? 0}</span> 次任务
                      </SignalPill>
                    </Space>
                  </div>

                  <div style={BRAND_ROW_STYLE}>
                    <span style={{ color: 'var(--gm-fg-3)' }}>主品牌：</span>
                    <SignalPill tone="info">{prof.brandName}</SignalPill>
                  </div>

                  <div style={{ marginBottom: 8, fontSize: 13 }}>
                    <span style={{ color: 'var(--gm-fg-3)' }}>品牌别名：</span>
                    {prof.brandAliases.length > 0 ? (
                      <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                        {prof.brandAliases.map((alias) => (
                          <span key={alias} className="gm-engine-chip">
                            {alias}
                          </span>
                        ))}
                      </Space>
                    ) : (
                      <span style={{ color: 'var(--gm-fg-3)' }}>未设置别名</span>
                    )}
                  </div>

                  <div style={{ marginBottom: 8, fontSize: 13 }}>
                    <span style={{ color: 'var(--gm-fg-3)' }}>自有官网域名：</span>
                    {prof.ownedDomains.length > 0 ? (
                      <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                        {prof.ownedDomains.map((dom) => (
                          <span key={dom} className="gm-engine-chip">
                            <TruncText text={dom} mono middle />
                          </span>
                        ))}
                      </Space>
                    ) : (
                      <span style={{ color: 'var(--gm-fg-3)' }}>未配置域名</span>
                    )}
                  </div>

                  <div style={{ fontSize: 13 }}>
                    <span style={{ color: 'var(--gm-fg-3)' }}>
                      监测竞品（{prof.competitors.length}/{VISIBILITY_MAX_COMPETITORS}）：
                    </span>
                    {prof.competitors.length > 0 ? (
                      <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
                        {shownCompetitors.map((comp) => (
                          <SignalPill key={comp.name} tone="competitor">
                            {comp.name}
                          </SignalPill>
                        ))}
                        {hiddenCompetitors.length > 0 ? (
                          <Tooltip title={hiddenCompetitors.map((c) => c.name).join('、')}>
                            <span className="gm-engine-more gm-num">
                              +{hiddenCompetitors.length}
                            </span>
                          </Tooltip>
                        ) : null}
                      </Space>
                    ) : (
                      <span style={{ color: 'var(--gm-fg-3)' }}>未添加竞品</span>
                    )}
                  </div>
                </div>

                <div
                  className="gm-profile-card-actions"
                  data-testid={`profile-card-actions-${prof.id}`}
                >
                  <div className="gm-profile-card-actions-row">
                    <CardActBtn
                      primary
                      label={`发起监测-${prof.name}`}
                      text="发起监测"
                      disabled={readOnly}
                      onClick={() => onStartRunForProfile(prof.id)}
                    />
                    <CardActBtn
                      label={`档案看板-${prof.name}`}
                      text="看板分析"
                      onClick={() => onOpenOverviewForProfile(prof.id)}
                    />
                  </div>
                  <div className="gm-profile-card-actions-row">
                    {!isDefault ? (
                      <CardActBtn
                        label={`设为默认-${prof.name}`}
                        text="设为默认"
                        disabled={readOnly}
                        onClick={() => onSetDefault(prof)}
                      />
                    ) : null}
                    <CardActBtn
                      label={`编辑档案-${prof.name}`}
                      text="编辑"
                      disabled={readOnly}
                      onClick={() => onEditProfile(prof)}
                    />
                    <CardActBtn
                      danger
                      label={`删除档案-${prof.name}`}
                      text="删除"
                      disabled={readOnly}
                      onClick={() => onDeleteProfile(prof)}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
