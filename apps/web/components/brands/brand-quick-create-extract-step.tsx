'use client';

import {
  BRAND_FACT_SLOT_LABELS,
  BRAND_TRUTH_CHECKBOX_LABEL,
  type BrandFactCoreSlot,
  type ExtractedBrandFactDraft,
} from '@geomix/shared';
import { Alert, Button, Checkbox, Input } from 'antd';
import { BRAND_FACT_SLOT_SHORT } from '../../lib/short-labels';
import { CostChip, Explain } from '../ui';
import { FACT_EXTRACT_ACCEPT } from './brand-form-helpers';
import type { ExtractSourceMode } from './brand-facts-extract-modal';

export type BrandQuickCreateExtractStepProps = {
  brandName: string;
  extractMode: ExtractSourceMode;
  extractUrl: string;
  extractText: string;
  extractFile: File | null;
  extracting: boolean;
  savingFacts: boolean;
  busy: boolean;
  drafts: ExtractedBrandFactDraft[] | null;
  truthAgreed: boolean;
  extractError: string | null;
  onModeChange: (mode: ExtractSourceMode) => void;
  onUrlChange: (url: string) => void;
  onTextChange: (text: string) => void;
  onFileChange: (file: File | null) => void;
  onDraftChange: (slot: BrandFactCoreSlot, content: string) => void;
  onTruthAgreedChange: (agreed: boolean) => void;
  onOpenTerms: () => void;
  onClose: () => void;
  onRunExtract: () => void;
  onSaveExtractedFacts: () => void;
};

/**
 * 极速建档向导第 2 步：可选 AI 提炼 4 块品牌事实卡。
 */
export function BrandQuickCreateExtractStep({
  brandName,
  extractMode,
  extractUrl,
  extractText,
  extractFile,
  extracting,
  savingFacts,
  busy,
  drafts,
  truthAgreed,
  extractError,
  onModeChange,
  onUrlChange,
  onTextChange,
  onFileChange,
  onDraftChange,
  onTruthAgreedChange,
  onOpenTerms,
  onClose,
  onRunExtract,
  onSaveExtractedFacts,
}: BrandQuickCreateExtractStepProps) {
  return (
    <div className="gm-brand-extract-step">
      <Alert
        type="success"
        showIcon
        message={
          <span className="gm-brand-alert-title-row">
            <span>品牌已创建</span>
            <Explain
              text={`品牌「${brandName}」已创建。贴入官网链接或上传产品资料（TXT / MD / PDF），AI 自动帮您提炼 4 块结构化品牌事实卡（免费，0 点）。`}
            />
          </span>
        }
        className="gm-brand-inline-alert"
      />

      <div className="gm-brand-mode-tabs" role="tablist" aria-label="资料来源方式">
        {(
          [
            ['URL_EXTRACT', '官网链接'],
            ['MANUAL', '粘贴资料'],
            ['DOC_UPLOAD', '上传文档'],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={extractMode === mode}
            className={extractMode === mode ? 'gm-brand-mode-btn is-active' : 'gm-brand-mode-btn'}
            onClick={() => onModeChange(mode)}
          >
            {label}
          </button>
        ))}
      </div>

      {extractMode === 'URL_EXTRACT' ? (
        <Input
          aria-label="官网链接"
          value={extractUrl}
          disabled={extracting || savingFacts}
          placeholder="https://example.com/product"
          onChange={(event) => onUrlChange(event.target.value)}
        />
      ) : extractMode === 'MANUAL' ? (
        <Input.TextArea
          aria-label="粘贴产品资料"
          rows={4}
          value={extractText}
          disabled={extracting || savingFacts}
          placeholder="粘贴产品参数表、核心卖点、资质证书或客户案例文本（至少 10 字）"
          onChange={(event) => onTextChange(event.target.value)}
        />
      ) : (
        <div className="gm-brand-file-picker">
          <input
            type="file"
            accept={FACT_EXTRACT_ACCEPT}
            aria-label="上传品牌资料文档"
            disabled={extracting || savingFacts}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              onFileChange(file);
            }}
          />
          {extractFile ? (
            <span className="gm-brand-file-name">已选文件：{extractFile.name}</span>
          ) : null}
        </div>
      )}

      {drafts ? (
        <div className="gm-brand-draft-list">
          {drafts.map((item) => (
            <div key={item.slot} className="gm-brand-draft-item">
              <div className="gm-brand-draft-head">
                <strong>{BRAND_FACT_SLOT_SHORT[item.slot]}</strong>
              </div>
              <Input.TextArea
                aria-label={`提炼草稿 ${BRAND_FACT_SLOT_LABELS[item.slot]}`}
                rows={3}
                value={item.content}
                disabled={savingFacts}
                onChange={(event) => onDraftChange(item.slot, event.target.value)}
              />
            </div>
          ))}

          <div className="gm-brand-truth-bar">
            <Checkbox
              checked={truthAgreed}
              disabled={savingFacts}
              onChange={(event) => onTruthAgreedChange(event.target.checked)}
            >
              确认属实
            </Checkbox>
            <Explain text={BRAND_TRUTH_CHECKBOX_LABEL} />
            <Button type="link" size="small" autoInsertSpace={false} onClick={onOpenTerms}>
              协议
            </Button>
          </div>
        </div>
      ) : null}

      {extractError ? (
        <Alert
          type="error"
          showIcon
          message={extractError}
          className="gm-brand-mt-sm gm-brand-mb-xs"
        />
      ) : null}

      <div className="gm-brand-modal-footer">
        <Button
          autoInsertSpace={false}
          data-testid="brand-quick-create-skip-btn"
          disabled={busy}
          onClick={onClose}
        >
          跳过
        </Button>
        <CostChip points={0} />
        <Button
          type={drafts ? 'default' : 'primary'}
          data-testid="brand-quick-create-extract-btn"
          loading={extracting}
          disabled={savingFacts}
          onClick={onRunExtract}
        >
          AI 提炼
        </Button>
        {drafts ? (
          <Button
            type="primary"
            autoInsertSpace={false}
            data-testid="brand-quick-create-save-facts-btn"
            loading={savingFacts}
            disabled={extracting}
            onClick={onSaveExtractedFacts}
          >
            完成
          </Button>
        ) : null}
      </div>
    </div>
  );
}
