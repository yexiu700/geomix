'use client';

import { useEffect, useRef, useState } from 'react';
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
  const activeTabRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

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
    <div
      className="gm-tabs"
      role="tablist"
      aria-label="已打开的页面"
      data-testid="tab-stack"
      style={{
        height: 36,
        padding: '0 12px',
        gap: 4,
        borderBottom: '1px solid var(--gm-line-1)',
        background: 'var(--gm-bg-base)',
        overflowX: 'auto',
        scrollbarWidth: 'none',
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <style>{`
        .gm-tabs::-webkit-scrollbar { display: none; }
        .gm-tabs .gm-tab {
          height: 26px;
          padding: 0 8px 0 10px;
          border-radius: 6px;
          font-size: 12px;
          color: var(--gm-fg-3);
          border: 1px solid transparent;
          background: transparent;
          gap: 4px;
          transition: background-color var(--gm-dur-fast) var(--gm-ease-out), border-color var(--gm-dur-fast) var(--gm-ease-out), color var(--gm-dur-fast) var(--gm-ease-out);
        }
        .gm-tabs .gm-tab:hover {
          color: var(--gm-fg-1);
          background: var(--gm-bg-hover);
        }
        .gm-tabs .gm-tab.active {
          color: var(--gm-fg-1);
          background: var(--gm-bg-surface);
          border-color: var(--gm-line-2);
        }
        .gm-tabs .gm-tab button[role='tab'] {
          padding: 0;
          color: inherit;
          font-size: inherit;
          max-width: 160px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .gm-tabs .gm-tab-close {
          width: 14px;
          height: 14px;
          padding: 0;
          border-radius: 4px;
          color: var(--gm-fg-3);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          line-height: 1;
        }
        .gm-tabs .gm-tab-close:hover {
          background: rgba(255, 255, 255, 0.08);
          color: var(--gm-fg-1);
        }
      `}</style>
      {tabs.map((tab) => (
        <div key={tab.id} className={tab.id === activeId ? 'gm-tab active' : 'gm-tab'}>
          <button
            ref={tab.id === activeId ? activeTabRef : undefined}
            type="button"
            role="tab"
            title={tab.title}
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
