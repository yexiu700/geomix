'use client';

import { App, ConfigProvider, unstableSetRender } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { GM_ANTD_THEME } from '../lib/design-tokens';
import { UxFeedbackProvider } from './crud/ux-feedback';

type ContainerWithRoot = (Element | DocumentFragment) & {
  _reactRoot?: ReturnType<typeof createRoot>;
};

unstableSetRender((node, container) => {
  const host = container as ContainerWithRoot;
  host._reactRoot ??= createRoot(container);
  const root = host._reactRoot;
  root.render(node);
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    root.unmount();
    delete host._reactRoot;
  };
});

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider locale={zhCN} theme={GM_ANTD_THEME} button={{ autoInsertSpace: false }}>
      <App>
        <UxFeedbackProvider>{children}</UxFeedbackProvider>
      </App>
    </ConfigProvider>
  );
}
