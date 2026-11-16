'use client';

import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ReactNode } from 'react';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }}>
      {children}
    </ConfigProvider>
  );
}
