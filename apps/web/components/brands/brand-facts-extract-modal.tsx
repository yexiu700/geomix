'use client';

import type { ExtractedBrandFactDraft, FactSourceType } from '@geomix/shared';
import { Alert, Button, Input, Modal, Radio } from 'antd';
import { BRAND_FACT_SLOT_SHORT } from '../../lib/short-labels';
import { CostChip } from '../ui';
import { FACT_EXTRACT_ACCEPT } from './brand-form-helpers';

export type ExtractSourceMode = 'URL_EXTRACT' | 'MANUAL' | 'DOC_UPLOAD';

export type BrandFactsExtractModalProps = {
  open: boolean;
  extractMode: ExtractSourceMode;
  extractUrl: string;
  extractText: string;
  extractFile: File | null;
  extracting: boolean;
  extractError: string | null;
  extractResult: {
    sourceType: FactSourceType;
    sourceUrl: string | null;
    facts: ExtractedBrandFactDraft[];
    warnings?: string[];
  } | null;
  applyMode: 'replace' | 'append';
  onCancel: () => void;
  onModeChange: (mode: ExtractSourceMode) => void;
  onUrlChange: (url: string) => void;
  onTextChange: (text: string) => void;
  onFileChange: (file: File | null) => void;
  onApplyModeChange: (mode: 'replace' | 'append') => void;
  onRunExtract: () => void;
  onApplyExtracted: () => void;
};

/**
 * 品牌事实卡 AI 提炼弹窗。
 */
export function BrandFactsExtractModal({
  open,
  extractMode,
  extractUrl,
  extractText,
  extractFile,
  extracting,
  extractError,
  extractResult,
  applyMode,
  onCancel,
  onModeChange,
  onUrlChange,
  onTextChange,
  onFileChange,
  onApplyModeChange,
  onRunExtract,
  onApplyExtracted,
}: BrandFactsExtractModalProps) {
  return (
    <Modal
      open={open}
      title="AI 提炼"
      width={640}
      onCancel={() => {
        if (!extracting) onCancel();
      }}
      keyboard={!extracting}
      maskClosable={!extracting}
      destroyOnHidden
      footer={null}
    >
      <div className="gm-brand-extract-step">
        <div className="gm-brand-mode-tabs" role="tablist" aria-label="选择事实资料来源">
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
            disabled={extracting}
            placeholder="https://example.com/product"
            onChange={(event) => onUrlChange(event.target.value)}
          />
        ) : extractMode === 'MANUAL' ? (
          <Input.TextArea
            aria-label="粘贴产品资料"
            rows={5}
            value={extractText}
            disabled={extracting}
            placeholder="粘贴官网介绍、产品规格书、评测参数或客户案例文本（至少 10 字）"
            onChange={(event) => onTextChange(event.target.value)}
          />
        ) : (
          <div className="gm-brand-file-picker">
            <input
              type="file"
              accept={FACT_EXTRACT_ACCEPT}
              aria-label="上传品牌资料文档"
              disabled={extracting}
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

        {extractError ? (
          <Alert type="error" showIcon message={extractError} className="gm-brand-mt-sm" />
        ) : null}

        {extractResult ? (
          <div className="gm-brand-draft-list">
            {extractResult.warnings && extractResult.warnings.length > 0 ? (
              <Alert
                type="info"
                showIcon
                message={extractResult.warnings.join(' ')}
                className="gm-brand-mb-sm"
              />
            ) : null}
            <div className="gm-brand-apply-mode">
              <span>写入方式：</span>
              <Radio.Group
                value={applyMode}
                onChange={(event) => onApplyModeChange(event.target.value as 'replace' | 'append')}
              >
                <Radio value="replace">覆盖</Radio>
                <Radio value="append">追加</Radio>
              </Radio.Group>
            </div>
            {extractResult.facts.map((item) => (
              <div key={item.slot} className="gm-brand-draft-item">
                <div className="gm-brand-draft-head">
                  <strong>{BRAND_FACT_SLOT_SHORT[item.slot]}</strong>
                </div>
                <p className="gm-brand-draft-preview">{item.content || '（原文未提及）'}</p>
              </div>
            ))}
          </div>
        ) : null}

        <div className="gm-brand-modal-footer">
          <Button autoInsertSpace={false} disabled={extracting} onClick={onCancel}>
            关闭
          </Button>
          <CostChip points={0} />
          <Button
            type={extractResult ? 'default' : 'primary'}
            data-testid="fact-extract-run-btn"
            loading={extracting}
            onClick={onRunExtract}
          >
            开始提炼
          </Button>
          {extractResult ? (
            <Button
              type="primary"
              autoInsertSpace={false}
              data-testid="fact-extract-apply-btn"
              onClick={onApplyExtracted}
            >
              应用
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
