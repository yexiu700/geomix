'use client';

import { Drawer, Switch } from 'antd';
import type { LayoutPrefs, ShellAction } from '../../lib/tab-stack';

const FIELDS: { key: keyof LayoutPrefs; label: string; hint: string }[] = [
  { key: 'multiTab', label: '多标签', hint: '关闭后每次只保留当前页' },
  { key: 'menuCollapsed', label: '折叠菜单', hint: '收起左侧分组菜单' },
  { key: 'submenusAlwaysVisible', label: '常显子菜单', hint: '分组里的二级菜单保持展开' },
  { key: 'autoExpand', label: '自动展开', hint: '打开页面时展开它所在的分组' },
  { key: 'multiLevel', label: '多级菜单', hint: '关闭后菜单改成单层列表' },
];

export function LayoutPanel({
  open,
  prefs,
  onClose,
  onDispatch,
}: {
  open: boolean;
  prefs: LayoutPrefs;
  onClose: () => void;
  onDispatch: (action: ShellAction) => void;
}) {
  return (
    <Drawer title="布局设置" placement="right" open={open} onClose={onClose} width={320}>
      <p className="gm-panel-lead">这些开关保存在这台浏览器里。多标签默认开启。</p>
      <ul className="gm-pref-list">
        {FIELDS.map((field) => (
          <li key={field.key}>
            <label>
              <span>
                <span>{field.label}</span>
                <p>{field.hint}</p>
              </span>
              <Switch
                aria-label={field.label}
                checked={prefs[field.key]}
                onChange={(checked) =>
                  onDispatch({ type: 'prefs', patch: { [field.key]: checked } })
                }
              />
            </label>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}
