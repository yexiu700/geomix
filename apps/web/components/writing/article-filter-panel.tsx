'use client';

import { ARTICLE_STATUSES, ARTICLE_STATUS_LABEL } from '@geomix/shared';
import { Button, Input } from 'antd';
import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import type { ArticleFormOptions } from '../../lib/articles';
import { NATIVE_SELECT_STYLE } from '../../lib/select-styles';
import type { FilterDraft } from './article-manage-helpers';

const FIELD_LABEL_STYLE: CSSProperties = {
  fontSize: 12,
  color: 'var(--gm-fg-2)',
  marginBottom: 4,
};

export type ArticleFilterPanelProps = {
  filterDraft: FilterDraft;
  setFilterDraft: Dispatch<SetStateAction<FilterDraft>>;
  formOptions: ArticleFormOptions | null;
  onApply: () => void;
  onReset: () => void;
};

/** 7 项筛选栏：分类、AI 任务、标题、发送次数、转视频次数、状态、创建时间 */
export function ArticleFilterPanel({
  filterDraft,
  setFilterDraft,
  formOptions,
  onApply,
  onReset,
}: ArticleFilterPanelProps) {
  const patch = (next: Partial<FilterDraft>) => setFilterDraft((cur) => ({ ...cur, ...next }));

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))',
        gap: 10,
        padding: 12,
        marginBottom: 12,
        borderRadius: 8,
        background: 'var(--gm-bg-surface)',
        border: '1px solid var(--gm-line-1)',
      }}
    >
      <div>
        <div style={FIELD_LABEL_STYLE}>分类</div>
        <select
          aria-label="分类筛选"
          style={NATIVE_SELECT_STYLE}
          value={filterDraft.categoryId}
          onChange={(e) => patch({ categoryId: e.target.value })}
        >
          <option value="">全部分类</option>
          {(formOptions?.categories ?? []).map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}（{cat.total}）
            </option>
          ))}
        </select>
      </div>

      <div>
        <div style={FIELD_LABEL_STYLE}>AI 任务</div>
        <select
          aria-label="AI 任务筛选"
          style={NATIVE_SELECT_STYLE}
          value={filterDraft.taskId}
          onChange={(e) => patch({ taskId: e.target.value })}
        >
          <option value="">全部任务</option>
          {(formOptions?.tasks ?? []).map((task) => (
            <option key={task.id} value={task.id}>
              {task.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div style={FIELD_LABEL_STYLE}>标题</div>
        <Input
          aria-label="标题筛选"
          placeholder="输入标题关键词"
          value={filterDraft.keyword}
          onChange={(e) => patch({ keyword: e.target.value })}
          onPressEnter={onApply}
        />
      </div>

      <div>
        <div style={FIELD_LABEL_STYLE}>发送次数</div>
        <Input
          aria-label="发送次数筛选"
          placeholder="例如 0"
          value={filterDraft.sendCount}
          onChange={(e) => patch({ sendCount: e.target.value })}
        />
      </div>

      <div>
        <div style={FIELD_LABEL_STYLE}>转视频次数</div>
        <Input
          aria-label="转视频次数筛选"
          placeholder="例如 0"
          value={filterDraft.videoCount}
          onChange={(e) => patch({ videoCount: e.target.value })}
        />
      </div>

      <div>
        <div style={FIELD_LABEL_STYLE}>状态</div>
        <select
          aria-label="状态筛选"
          style={NATIVE_SELECT_STYLE}
          value={filterDraft.status}
          onChange={(e) => patch({ status: e.target.value })}
        >
          <option value="">全部状态</option>
          {ARTICLE_STATUSES.map((st) => (
            <option key={st} value={st}>
              {ARTICLE_STATUS_LABEL[st]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div style={FIELD_LABEL_STYLE}>创建开始日期</div>
        <Input
          type="date"
          aria-label="创建开始日期"
          value={filterDraft.createdFrom}
          onChange={(e) => patch({ createdFrom: e.target.value })}
        />
      </div>

      <div>
        <div style={FIELD_LABEL_STYLE}>创建结束日期</div>
        <Input
          type="date"
          aria-label="创建结束日期"
          value={filterDraft.createdTo}
          onChange={(e) => patch({ createdTo: e.target.value })}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <Button type="primary" aria-label="查询" onClick={onApply}>
          查询
        </Button>
        <Button aria-label="重置筛选" onClick={onReset}>
          重置筛选
        </Button>
      </div>
    </div>
  );
}
