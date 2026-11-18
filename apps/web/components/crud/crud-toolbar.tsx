'use client';

import { Button, Space } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

export interface CrudToolbarProps {
  /** 是否展示主创建按钮（默认 true） */
  showCreate?: boolean;
  /** 主创建按钮文案（默认 '添加'，可传 '新建单篇复刻'、'新建批量复刻' 等） */
  createLabel?: string;
  /** 主创建按钮无障碍名称（默认与 createLabel 一致） */
  createAriaLabel?: string;
  /** 主创建按钮禁用态 */
  createDisabled?: boolean;
  /** 主创建按钮加载态 */
  createLoading?: boolean;
  /** 点击主创建按钮 */
  onCreate?: () => void;

  /** 刷新按钮文案（默认 '刷新'，可传 '刷新列表' 等） */
  refreshLabel?: string;
  /** 刷新按钮无障碍名称（默认与 refreshLabel 一致） */
  refreshAriaLabel?: string;
  /** 刷新按钮禁用态 */
  refreshDisabled?: boolean;
  /** 刷新按钮加载态 */
  refreshLoading?: boolean;
  /** 点击刷新按钮 */
  onRefresh: () => void;

  /** 是否展示删除按钮（默认 true） */
  showDelete?: boolean;
  /** 删除按钮展示内容（默认 '删除'，支持 '删除（2）'、'批量删除' 等） */
  deleteLabel?: ReactNode;
  /** 删除按钮无障碍名称（默认当 deleteLabel 为字符串时取其值，否则 '删除'） */
  deleteAriaLabel?: string;
  /** 删除按钮禁用态 */
  deleteDisabled?: boolean;
  /** 删除按钮加载态 */
  deleteLoading?: boolean;
  /** 点击删除按钮 */
  onDelete?: () => void;

  /** 左侧在标准 [主创建] [刷新] [删除] 之后的附加动作（如批量启用/停用、返回上一级） */
  extraLeft?: ReactNode;
  /** 右侧视图切换、列配置、导出与搜索/筛选展开控件 */
  right?: ReactNode;
  /** 工具栏容器补充样式 */
  style?: CSSProperties;
}

/**
 * 全站列表页统一工具栏底座（Issue #260）：
 * 左侧固定遵循 `[主创建（添加/新建）] -> [刷新] -> [删除] -> [附加批量/导航动作]` 顺序，
 * 消除各业务模块手动拼装导致的「主按钮与刷新左右互换」误触风险。
 */
export function CrudToolbar({
  showCreate = true,
  createLabel = '添加',
  createAriaLabel,
  createDisabled = false,
  createLoading = false,
  onCreate,
  refreshLabel = '刷新',
  refreshAriaLabel,
  refreshDisabled = false,
  refreshLoading = false,
  onRefresh,
  showDelete = true,
  deleteLabel = '删除',
  deleteAriaLabel,
  deleteDisabled = false,
  deleteLoading = false,
  onDelete,
  extraLeft,
  right,
  style,
}: CrudToolbarProps) {
  const resolvedCreateAriaLabel = createAriaLabel ?? createLabel;
  const resolvedRefreshAriaLabel = refreshAriaLabel ?? refreshLabel;
  const resolvedDeleteAriaLabel =
    deleteAriaLabel ?? (typeof deleteLabel === 'string' ? deleteLabel : '删除');

  return (
    <div className="gm-crud-toolbar" style={style}>
      <Space wrap>
        {showCreate ? (
          <Button
            key="create"
            type="primary"
            aria-label={resolvedCreateAriaLabel}
            disabled={createDisabled}
            loading={createLoading}
            onClick={onCreate}
          >
            {createLabel}
          </Button>
        ) : null}
        <Button
          key="refresh"
          aria-label={resolvedRefreshAriaLabel}
          disabled={refreshDisabled}
          loading={refreshLoading}
          onClick={onRefresh}
        >
          {refreshLabel}
        </Button>
        {showDelete ? (
          <Button
            key="delete"
            danger
            aria-label={resolvedDeleteAriaLabel}
            disabled={deleteDisabled}
            loading={deleteLoading}
            onClick={onDelete}
          >
            {deleteLabel}
          </Button>
        ) : null}
        {extraLeft}
      </Space>
      {right ? <Space wrap>{right}</Space> : null}
    </div>
  );
}
