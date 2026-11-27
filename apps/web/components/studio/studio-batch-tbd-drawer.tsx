'use client';

import { BRAND_FACT_CORE_SLOTS, type BrandFactSlot } from '@geomix/shared';
import { Button, Checkbox, Drawer, Input } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { BRAND_FACT_SLOT_SHORT } from '../../lib/short-labels';
import { Explain, StatusBadge } from '../ui';
import type { MissingFactSlotGroup } from './studio-batch-tbd-helpers';

export type BatchTbdSubmitEntry = {
  group: MissingFactSlotGroup;
  value: string;
};

export type StudioBatchTbdDrawerProps = {
  open: boolean;
  articleId: string | null;
  groups: readonly MissingFactSlotGroup[];
  readOnly: boolean;
  onClose: () => void;
  onSubmit: (
    entries: readonly BatchTbdSubmitEntry[],
    options: { syncToFact: boolean; factSlot: BrandFactSlot },
  ) => Promise<void>;
};

export function StudioBatchTbdDrawer({
  open,
  articleId,
  groups,
  readOnly,
  onClose,
  onSubmit,
}: StudioBatchTbdDrawerProps) {
  const [valuesByKey, setValuesByKey] = useState<Record<string, string>>({});
  const [syncToFact, setSyncToFact] = useState(true);
  const [targetFactSlot, setTargetFactSlot] = useState<BrandFactSlot>('PRODUCT_SPECS');
  const [submitting, setSubmitting] = useState(false);

  const groupsSignature = useMemo(
    () => groups.map((g) => `${g.key}:${g.slots.length}`).join('|'),
    [groups],
  );

  useEffect(() => {
    if (!open) return;
    setValuesByKey({});
    setSyncToFact(true);
    setTargetFactSlot('PRODUCT_SPECS');
    setSubmitting(false);
  }, [open, articleId, groupsSignature]);

  const filledEntries = useMemo<BatchTbdSubmitEntry[]>(() => {
    const out: BatchTbdSubmitEntry[] = [];
    for (const group of groups) {
      const value = (valuesByKey[group.key] ?? '').trim();
      if (value.length > 0) {
        out.push({ group, value });
      }
    }
    return out;
  }, [groups, valuesByKey]);

  const totalOccurrences = useMemo(
    () => groups.reduce((sum, g) => sum + g.slots.length, 0),
    [groups],
  );

  const handleConfirm = async () => {
    if (readOnly || submitting || filledEntries.length === 0) return;
    setSubmitting(true);
    try {
      await onSubmit(filledEntries, { syncToFact, factSlot: targetFactSlot });
    } catch {
      // Error feedback is handled by parent caller
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      placement="right"
      width={480}
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      destroyOnHidden
      keyboard={!submitting}
      maskClosable={!submitting}
      title="批量补填"
      footer={
        <div className="gm-studio-batch-tbd-footer">
          <Button autoInsertSpace={false} disabled={submitting} onClick={onClose}>
            取消
          </Button>
          <Button
            type="primary"
            data-testid="batch-tbd-submit-btn"
            loading={submitting}
            disabled={readOnly || filledEntries.length === 0}
            onClick={() => void handleConfirm()}
          >
            全部保存
          </Button>
        </div>
      }
    >
      <div className="gm-studio-batch-tbd-body" data-testid="studio-batch-tbd-drawer">
        <div className="gm-studio-explain-row gm-studio-text-secondary">
          <span>
            共 {groups.length} 组 · {totalOccurrences} 处
          </span>
          <Explain
            text={`已自动合并正文中的同名占位符：共 ${groups.length} 组待补事实（覆盖 ${totalOccurrences} 处正文位置）。可按需部分或全部填写，留空项会保持原占位不变。`}
          />
        </div>

        <div className="gm-studio-batch-tbd-list">
          {groups.map((group) => (
            <div
              key={group.key}
              className="gm-studio-batch-tbd-item"
              data-testid={`batch-tbd-group-${group.key}`}
            >
              <div className="gm-studio-batch-tbd-head">
                <strong className="gm-studio-batch-tbd-hint">{group.hint}</strong>
                {group.slots.length > 1 ? (
                  <StatusBadge tone="warning" label={`出现 ${group.slots.length} 处`} />
                ) : null}
              </div>

              <div className="gm-studio-batch-tbd-contexts">
                {group.contexts.slice(0, 3).map((ctx, idx) => (
                  <div key={`${group.key}-ctx-${idx}`} className="gm-studio-batch-tbd-context">
                    {ctx}
                  </div>
                ))}
              </div>

              <Input
                aria-label={group.hint}
                placeholder="输入真实实测数值或参数"
                value={valuesByKey[group.key] ?? ''}
                disabled={readOnly || submitting}
                onChange={(event) => {
                  const nextVal = event.target.value;
                  setValuesByKey((prev) => ({ ...prev, [group.key]: nextVal }));
                }}
              />
            </div>
          ))}
        </div>

        <div className="gm-studio-batch-tbd-sync-box">
          <Checkbox
            data-testid="batch-tbd-sync-checkbox"
            checked={syncToFact}
            disabled={readOnly || submitting}
            onChange={(event) => setSyncToFact(event.target.checked)}
          >
            同步事实
          </Checkbox>
          {syncToFact ? (
            <label className="gm-studio-batch-tbd-slot-row">
              <span className="gm-studio-text-secondary">写入分类</span>
              <select
                aria-label="反哺事实卡分类"
                className="gm-select"
                value={targetFactSlot}
                disabled={readOnly || submitting}
                onChange={(event) => setTargetFactSlot(event.target.value as BrandFactSlot)}
              >
                {BRAND_FACT_CORE_SLOTS.map((slot) => (
                  <option key={slot} value={slot}>
                    {BRAND_FACT_SLOT_SHORT[slot]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>
    </Drawer>
  );
}
