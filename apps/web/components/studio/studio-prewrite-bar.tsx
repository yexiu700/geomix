'use client';

import {
  GEO_RECIPES,
  GEO_RECIPE_LABELS,
  GEO_TARGET_FORMAT_LABELS,
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
import { Alert, Button, Input, InputNumber, Tag } from 'antd';
import type { JSX } from 'react';
import { useState } from 'react';
import { StatusBadge } from '../ui';

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
  wordCountTarget: number | undefined;
  onWordCountTargetChange: (value: number | undefined) => void;
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
  wordCountTarget,
  onWordCountTargetChange,
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
            <span className="gm-studio-meta-pill">{GEO_RECIPE_LABELS[summaryRecipe]}</span>
            <span className="gm-studio-meta-pill">{GEO_TARGET_FORMAT_LABELS[summaryFormat]}</span>
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
            className="gm-studio-nowrap"
            data-testid="studio-prewrite-expand-btn"
            onClick={onToggleCollapsed}
          >
            配置 / 重写 ▾
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
          <span className="gm-studio-nowrap">1. 目标问题与大纲上下文</span>
          <span className="gm-studio-row gm-studio-row--wrap">
            {linkedBrief ? (
              <>
                <StatusBadge tone="active" className="gm-studio-tag-wrap">
                  来自意见卡 · {linkedBrief.suggestedTitle.slice(0, 28)}
                </StatusBadge>
                {linkedBrief.sourceCitationUrl &&
                /^https?:\/\//i.test(linkedBrief.sourceCitationUrl) ? (
                  <StatusBadge
                    tone="warning"
                    title={linkedBrief.sourceCitationUrl}
                    className="gm-studio-tag-wrap"
                  >
                    {linkedBrief.sourceType === 'NEAR_MISS_BOOST' ? '补强页面 · ' : '反制信源 · '}
                    {linkedBrief.sourceCitationUrl.length > 36
                      ? `${linkedBrief.sourceCitationUrl.slice(0, 36)}…`
                      : linkedBrief.sourceCitationUrl}
                  </StatusBadge>
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
                className="gm-studio-nowrap"
                data-testid="studio-prewrite-collapse-btn"
                onClick={onToggleCollapsed}
              >
                收起配置 ▴
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
        <span className="gm-studio-section-label">2. GEO 文体配方与目标阵地形态</span>
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
              {GEO_RECIPE_LABELS[item]}
            </button>
          ))}
        </div>
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
              {GEO_TARGET_FORMAT_LABELS[fmt]}
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
            <span className="gm-studio-section-label">目标写作语种</span>
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
            {prefsOpen ? '▾ 高级偏好（已展开）' : '▸ 高级偏好'}
          </button>

          <div className="gm-studio-row gm-studio-row--wrap">
            {streaming ? (
              <Button danger data-testid="studio-abort-btn" onClick={onAbortStream}>
                停止生成（退还点数）
              </Button>
            ) : null}
            <Button
              type="primary"
              data-testid="studio-stream-btn"
              loading={streaming}
              disabled={readOnly || streaming || targetPrompt.trim().length < 2}
              onClick={onStartStream}
            >
              立即生成（{GEO_WRITE_DEFAULT_UNIT_POINTS} 点）
            </Button>
          </div>
        </div>

        {prefsOpen ? (
          <div className="gm-studio-prefs-box" data-testid="studio-advanced-prefs-panel">
            <div className="gm-studio-stack gm-studio-stack--sm">
              <span className="gm-studio-section-label">自定义风格指令</span>
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
              <span className="gm-studio-section-label">
                租户自定义禁词（CN / GLOBAL 双轨生效）
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
                  <Button size="small" onClick={handleAddForbiddenWord}>
                    添加禁词
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="gm-studio-cta-row">
              <div className="gm-studio-row">
                <span className="gm-studio-text-secondary">目标字数偏好：</span>
                <InputNumber
                  size="small"
                  min={600}
                  max={4000}
                  step={200}
                  placeholder="默认"
                  value={wordCountTarget ?? null}
                  onChange={(v) => onWordCountTargetChange(typeof v === 'number' ? v : undefined)}
                  disabled={readOnly}
                />
              </div>
              {!readOnly ? (
                <Button
                  size="small"
                  type="default"
                  loading={prefsSaving}
                  onClick={() => void handleSavePrefs()}
                  data-testid="studio-save-prefs-btn"
                >
                  保存默认偏好
                </Button>
              ) : null}
            </div>
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
