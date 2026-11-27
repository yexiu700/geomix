'use client';

import {
  GEO_RECIPES,
  GEO_WRITE_DEFAULT_UNIT_POINTS,
  SUPPORTED_LOCALES,
  targetFormatsForMarket,
  type GeoBriefRecord,
  type GeoMarket,
  type GeoOutlineHeading,
  type GeoRecipe,
  type GeoTargetFormat,
  type PromptPreferenceRecord,
  type SupportedLocale,
} from '@geomix/shared';
import { Alert, Button, Input, Tag } from 'antd';
import type { JSX } from 'react';
import { useState } from 'react';
import { GEO_RECIPE_SHORT, GEO_TARGET_FORMAT_SHORT } from '../../lib/short-labels';
import { CostChip, Explain, StatusBadge } from '../ui';

export type StudioPrewriteArticleSummary = {
  targetPrompt: string;
  recipe: GeoRecipe;
  targetFormat: GeoTargetFormat;
  targetLocale?: SupportedLocale | null;
};

export type StudioPrewriteBarProps = {
  activeMarket: GeoMarket;
  targetPrompt: string;
  onTargetPromptChange: (value: string) => void;
  linkedBrief: GeoBriefRecord | null;
  onClearLinkedBrief: () => void;
  outlineH2: readonly GeoOutlineHeading[];
  recipe: GeoRecipe;
  onRecipeChange: (next: GeoRecipe) => void;
  targetFormat: GeoTargetFormat;
  onTargetFormatChange: (next: GeoTargetFormat) => void;
  promptPreference: PromptPreferenceRecord;
  prefsSaving: boolean;
  onSavePromptPreference: (input: {
    customToneNote: string | null;
    customForbiddenWords: string[];
  }) => Promise<void>;
  streaming: boolean;
  streamError: string | null;
  onDismissStreamError: () => void;
  onStartStream: () => void;
  onAbortStream: () => void;
  readOnly: boolean;
  availableLocales?: readonly SupportedLocale[];
  targetLocale?: SupportedLocale;
  onTargetLocaleChange?: (next: SupportedLocale) => void;
  collapsed?: boolean;
  canCollapse?: boolean;
  onToggleCollapsed?: () => void;
  articleSummary?: StudioPrewriteArticleSummary | null;
  activeProductLineName?: string | null;
};

export function StudioPrewriteBar({
  activeMarket,
  targetPrompt,
  onTargetPromptChange,
  linkedBrief,
  onClearLinkedBrief,
  outlineH2,
  recipe,
  onRecipeChange,
  targetFormat,
  onTargetFormatChange,
  promptPreference,
  prefsSaving,
  onSavePromptPreference,
  streaming,
  streamError,
  onDismissStreamError,
  onStartStream,
  onAbortStream,
  readOnly,
  availableLocales,
  targetLocale,
  onTargetLocaleChange,
  collapsed = false,
  canCollapse = false,
  onToggleCollapsed,
  articleSummary = null,
  activeProductLineName = null,
}: StudioPrewriteBarProps): JSX.Element {
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [draftToneNote, setDraftToneNote] = useState<string | null>(null);
  const [draftForbiddenWords, setDraftForbiddenWords] = useState<string[] | null>(null);
  const [newWordInput, setNewWordInput] = useState('');

  const marketFormats = targetFormatsForMarket(activeMarket);
  const effectiveToneNote = draftToneNote ?? promptPreference.customToneNote ?? '';
  const effectiveForbiddenWords = draftForbiddenWords ?? promptPreference.customForbiddenWords;

  const handleTogglePrefs = () => {
    setPrefsOpen((prev) => {
      if (prev) {
        setDraftToneNote(null);
        setDraftForbiddenWords(null);
      }
      return !prev;
    });
  };

  const handleAddForbiddenWord = () => {
    const trimmed = newWordInput.trim();
    if (!trimmed) return;
    if (!effectiveForbiddenWords.includes(trimmed)) {
      setDraftForbiddenWords([...effectiveForbiddenWords, trimmed]);
    }
    setNewWordInput('');
  };

  const handleRemoveForbiddenWord = (word: string) => {
    setDraftForbiddenWords(effectiveForbiddenWords.filter((w) => w !== word));
  };

  const handleSavePrefs = async () => {
    await onSavePromptPreference({
      customToneNote: effectiveToneNote.trim() || null,
      customForbiddenWords: effectiveForbiddenWords,
    });
    setDraftToneNote(null);
    setDraftForbiddenWords(null);
  };

  if (collapsed) {
    const summaryPrompt =
      articleSummary?.targetPrompt?.trim() || targetPrompt.trim() || '未设置目标问题';
    const summaryRecipe = articleSummary?.recipe ?? recipe;
    const summaryFormat = articleSummary?.targetFormat ?? targetFormat;
    const summaryLocale = articleSummary?.targetLocale ?? targetLocale ?? null;
    const showCollapsedLocale = Boolean(
      summaryLocale &&
      ((availableLocales && availableLocales.length > 1) || activeMarket === 'GLOBAL'),
    );
    const summaryLocaleMeta = summaryLocale ? SUPPORTED_LOCALES[summaryLocale] : null;

    return (
      <div className="gm-studio-prewrite-collapsed" data-testid="studio-prewrite-collapsed-bar">
        <div className="gm-studio-prewrite-collapsed-summary">
          <span className="gm-studio-prewrite-collapsed-prompt" title={summaryPrompt}>
            {summaryPrompt}
          </span>
          <span className="gm-studio-prewrite-collapsed-meta">
            {activeProductLineName ? (
              <span
                className="gm-studio-meta-pill"
                data-testid="studio-collapsed-product-line-pill"
              >
                {activeProductLineName}
              </span>
            ) : null}
            <span className="gm-studio-meta-pill">{GEO_RECIPE_SHORT[summaryRecipe]}</span>
            <span className="gm-studio-meta-pill">{GEO_TARGET_FORMAT_SHORT[summaryFormat]}</span>
            {showCollapsedLocale && summaryLocale ? (
              <span className="gm-studio-meta-pill" data-testid="studio-collapsed-locale-pill">
                {summaryLocaleMeta
                  ? `${summaryLocaleMeta.nativeLabel} · ${summaryLocale}`
                  : summaryLocale}
              </span>
            ) : null}
          </span>
        </div>
        {onToggleCollapsed ? (
          <Button
            size="small"
            type="text"
            autoInsertSpace={false}
            aria-label="配置与重写"
            className="gm-studio-nowrap"
            data-testid="studio-prewrite-expand-btn"
            onClick={onToggleCollapsed}
          >
            配置
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="gm-studio-prewrite" data-testid="studio-prewrite-bar">
      {/* Item 1: Target Prompt + Linked Brief Badge */}
      <div className="gm-studio-stack">
        <div className="gm-studio-section-label gm-studio-section-label--wrap">
          <span className="gm-studio-nowrap">目标问题</span>
          <span className="gm-studio-row gm-studio-row--wrap">
            {activeProductLineName ? (
              <StatusBadge
                tone="active"
                className="gm-studio-tag-wrap"
                data-testid="studio-prewrite-product-line-badge"
                label={`产品线 · ${activeProductLineName}`}
              />
            ) : null}
            {linkedBrief ? (
              <>
                <span className="gm-studio-explain-row">
                  <StatusBadge tone="active" className="gm-studio-tag-wrap" label="意见卡" />
                  <Explain text={linkedBrief.suggestedTitle} />
                </span>
                {linkedBrief.sourceCitationUrl &&
                /^https?:\/\//i.test(linkedBrief.sourceCitationUrl) ? (
                  <StatusBadge
                    tone="warning"
                    title={linkedBrief.sourceCitationUrl}
                    className="gm-studio-tag-wrap"
                    label={linkedBrief.sourceType === 'NEAR_MISS_BOOST' ? '补强页面' : '反制信源'}
                  />
                ) : null}
                <Button
                  size="small"
                  type="link"
                  className="gm-studio-link-compact"
                  onClick={onClearLinkedBrief}
                >
                  解除关联
                </Button>
              </>
            ) : null}
            {canCollapse && onToggleCollapsed && !streaming ? (
              <Button
                size="small"
                type="text"
                autoInsertSpace={false}
                aria-label="收起配置"
                className="gm-studio-nowrap"
                data-testid="studio-prewrite-collapse-btn"
                onClick={onToggleCollapsed}
              >
                收起
              </Button>
            ) : null}
          </span>
        </div>
        <Input.TextArea
          aria-label="目标问题"
          placeholder={
            activeMarket === 'GLOBAL'
              ? '输入海外目标问题（如 Best 4-bay quiet home NAS 2026），或从左侧点击意见卡自动预填'
              : '输入要攻克的用户问题，或从左侧点击意见卡自动预填'
          }
          autoSize={{ minRows: 2, maxRows: 3 }}
          value={targetPrompt}
          onChange={(e) => onTargetPromptChange(e.target.value)}
          disabled={streaming}
        />
        {outlineH2.length > 0 ? (
          <div className="gm-studio-chip-group">
            {outlineH2.map((item, idx) => (
              <Tag key={`${item.heading}-${idx}`} className="gm-studio-tag-reset">
                H2: {item.heading}
              </Tag>
            ))}
          </div>
        ) : null}
      </div>

      {/* Item 2: 4 GEO Recipes + Market-Linked 2-Way Target Format */}
      <div className="gm-studio-stack">
        <span className="gm-studio-section-label">文体</span>
        <div className="gm-studio-chip-group" role="group" aria-label="GEO 文体配方">
          {GEO_RECIPES.map((item) => (
            <button
              key={item}
              type="button"
              className="gm-studio-chip"
              data-testid={`studio-recipe-${item}`}
              aria-pressed={recipe === item}
              disabled={streaming}
              onClick={() => onRecipeChange(item)}
            >
              {GEO_RECIPE_SHORT[item]}
            </button>
          ))}
        </div>
        <span className="gm-studio-section-label gm-studio-explain-row">
          <span>阵地</span>
          <Explain
            text={
              activeMarket === 'CN'
                ? '深度长文适配头条/公众号/值得买，社区问答适配知乎/小红书'
                : '独立长文含 Schema 适配官网/Shopify/WordPress，社区讨论适配 Reddit/Quora'
            }
          />
        </span>
        <div className="gm-studio-chip-group" role="group" aria-label="目标阵地形态">
          {marketFormats.map((fmt) => (
            <button
              key={fmt}
              type="button"
              className="gm-studio-chip"
              data-testid={`studio-format-${fmt}`}
              aria-pressed={targetFormat === fmt}
              disabled={streaming}
              onClick={() => onTargetFormatChange(fmt)}
            >
              {GEO_TARGET_FORMAT_SHORT[fmt]}
            </button>
          ))}
        </div>
        {activeMarket === 'GLOBAL' &&
        availableLocales &&
        availableLocales.length > 1 &&
        onTargetLocaleChange ? (
          <div
            data-testid="studio-target-locale-selector"
            className="gm-studio-stack gm-studio-stack--sm"
          >
            <span className="gm-studio-section-label">语种</span>
            <div className="gm-studio-chip-group" role="group" aria-label="目标写作语种">
              {availableLocales.map((code) => {
                const meta = SUPPORTED_LOCALES[code];
                return (
                  <button
                    key={code}
                    type="button"
                    className="gm-studio-chip"
                    data-testid={`studio-locale-${code}`}
                    aria-pressed={targetLocale === code}
                    disabled={streaming}
                    onClick={() => onTargetLocaleChange(code)}
                  >
                    {meta ? `${meta.nativeLabel} (${code})` : code}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {/* Item 3: Collapsed Advanced Preferences (PromptPreference) */}
      <div className="gm-studio-stack gm-studio-stack--md">
        <div className="gm-studio-cta-row">
          <button
            type="button"
            className="gm-studio-chip"
            data-testid="studio-advanced-prefs"
            aria-expanded={prefsOpen}
            onClick={handleTogglePrefs}
          >
            高级偏好
          </button>

          <div className="gm-studio-row gm-studio-row--wrap">
            {streaming ? (
              <span className="gm-studio-explain-row">
                <Button
                  danger
                  autoInsertSpace={false}
                  data-testid="studio-abort-btn"
                  onClick={onAbortStream}
                >
                  停止
                </Button>
                <Explain text="停止流式生成并自动退还本次冻结点数" />
              </span>
            ) : null}
            <CostChip
              points={GEO_WRITE_DEFAULT_UNIT_POINTS}
              data-testid="studio-stream-cost-chip"
            />
            <Button
              type="primary"
              autoInsertSpace={false}
              data-testid="studio-stream-btn"
              loading={streaming}
              disabled={readOnly || streaming || targetPrompt.trim().length < 2}
              onClick={onStartStream}
            >
              生成
            </Button>
          </div>
        </div>

        {prefsOpen ? (
          <div className="gm-studio-prefs-box" data-testid="studio-advanced-prefs-panel">
            <div className="gm-studio-stack gm-studio-stack--sm">
              <span className="gm-studio-section-label">风格指令</span>
              {promptPreference.customToneNote ? (
                <div className="gm-studio-text-secondary" data-testid="studio-saved-tone-summary">
                  当前生效口径：{promptPreference.customToneNote}
                </div>
              ) : null}
              <Input.TextArea
                aria-label="自定义风格指令"
                rows={2}
                placeholder="例如：保持客观技术评测口吻，优先引用实测数据对比"
                value={effectiveToneNote}
                onChange={(e) => setDraftToneNote(e.target.value)}
                disabled={readOnly}
              />
            </div>

            <div className="gm-studio-stack">
              <span className="gm-studio-section-label gm-studio-explain-row">
                <span>禁词</span>
                <Explain text="CN / GLOBAL 双轨生效，保存后作为租户默认偏好自动注入。" />
              </span>
              <div className="gm-studio-chip-group">
                {effectiveForbiddenWords.map((word) => (
                  <Tag
                    key={word}
                    closable={!readOnly}
                    onClose={() => handleRemoveForbiddenWord(word)}
                  >
                    {word}
                  </Tag>
                ))}
              </div>
              {!readOnly ? (
                <div className="gm-studio-row">
                  <Input
                    size="small"
                    placeholder="输入自定义禁词后回车或点击添加"
                    aria-label="添加自定义禁词"
                    value={newWordInput}
                    onChange={(e) => setNewWordInput(e.target.value)}
                    onPressEnter={handleAddForbiddenWord}
                  />
                  <Button size="small" autoInsertSpace={false} onClick={handleAddForbiddenWord}>
                    添加
                  </Button>
                </div>
              ) : null}
            </div>

            {!readOnly ? (
              <div className="gm-studio-cta-row">
                <Button
                  size="small"
                  type="default"
                  loading={prefsSaving}
                  onClick={() => void handleSavePrefs()}
                  data-testid="studio-save-prefs-btn"
                >
                  存为默认
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {streamError ? (
        <Alert
          type="error"
          showIcon
          closable
          onClose={onDismissStreamError}
          message={streamError}
          data-testid="studio-stream-error"
        />
      ) : null}
    </div>
  );
}
