'use client';

import { Skeleton } from 'antd';
import type { JSX } from 'react';

export function ConsoleBootSkeleton(): JSX.Element {
  return (
    <main
      className="gm-boot-shell"
      aria-busy="true"
      aria-label="正在确认登录"
      data-testid="console-boot-skeleton"
    >
      <aside className="gm-boot-sider" aria-hidden="true">
        <div className="gm-boot-sider-brand">
          <Skeleton.Avatar active size="small" shape="circle" />
          <Skeleton.Input active size="small" style={{ width: 96, height: 18 }} />
        </div>
        <div className="gm-boot-sider-nav">
          <Skeleton.Input active size="small" block style={{ height: 32 }} />
          <Skeleton.Input active size="small" block style={{ height: 32 }} />
          <Skeleton.Input active size="small" block style={{ height: 32 }} />
          <Skeleton.Input active size="small" block style={{ height: 32 }} />
        </div>
        <div className="gm-boot-sider-footer">
          <Skeleton.Avatar active size="small" shape="circle" />
          <Skeleton.Input active size="small" style={{ width: 120, height: 22 }} />
        </div>
      </aside>

      <div className="gm-boot-main">
        <header className="gm-boot-header" aria-hidden="true">
          <div className="gm-boot-header-group">
            <Skeleton.Input active size="small" style={{ width: 148, height: 28 }} />
            <Skeleton.Button active size="small" style={{ width: 112, height: 28 }} />
          </div>
          <div className="gm-boot-header-group">
            <Skeleton.Button active size="small" style={{ width: 72, height: 26 }} />
          </div>
        </header>

        <div className="gm-boot-content">
          <div className="gm-panel gm-boot-panel">
            <Skeleton active title={{ width: '28%' }} paragraph={{ rows: 2 }} />
          </div>
          <div className="gm-panel gm-boot-panel">
            <Skeleton active title={{ width: '36%' }} paragraph={{ rows: 4 }} />
          </div>
          <p className="gm-boot-status" role="status">
            正在确认登录
          </p>
        </div>
      </div>
    </main>
  );
}
