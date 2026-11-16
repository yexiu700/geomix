'use client';

import { useEffect, useState } from 'react';
import type { ShellAction, ShellTab } from '../../lib/tab-stack';

export function TabBar({
  tabs,
  activeId,
  onDispatch,
}: {
  tabs: ShellTab[];
  activeId: string;
  onDispatch: (action: ShellAction) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const current = tabs.find((tab) => tab.id === menu?.id);

  return (
    <div className="gm-tabs" role="tablist" aria-label="已打开的页面" data-testid="tab-stack">
      {tabs.map((tab) => (
        <div key={tab.id} className={tab.id === activeId ? 'gm-tab active' : 'gm-tab'}>
          <button
            type="button"
            role="tab"
            aria-selected={tab.id === activeId}
            aria-label={tab.title}
            onClick={() => onDispatch({ type: 'activate', id: tab.id })}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, id: tab.id });
            }}
          >
            {tab.title}
          </button>
          {tab.pinned ? null : (
            <button
              type="button"
              className="gm-tab-close"
              aria-label={`关闭${tab.title}`}
              onClick={() => onDispatch({ type: 'close', id: tab.id })}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {menu && current ? (
        <div
          role="menu"
          aria-label="标签操作"
          className="gm-context"
          style={{ left: Math.max(8, menu.x), top: Math.max(8, menu.y) }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => run(onDispatch, setMenu, { type: 'refresh', id: current.id })}
          >
            刷新当前
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={current.pinned}
            onClick={() => run(onDispatch, setMenu, { type: 'close', id: current.id })}
          >
            关闭
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(onDispatch, setMenu, { type: 'close-others', id: current.id })}
          >
            关闭其他
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(onDispatch, setMenu, { type: 'close-right', id: current.id })}
          >
            关闭右侧
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(onDispatch, setMenu, { type: 'close-all' })}
          >
            关闭全部
          </button>
        </div>
      ) : null}
    </div>
  );
}

function run(
  onDispatch: (action: ShellAction) => void,
  setMenu: (value: null) => void,
  action: ShellAction,
) {
  onDispatch(action);
  setMenu(null);
}
