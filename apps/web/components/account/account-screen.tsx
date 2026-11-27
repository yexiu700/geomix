'use client';

import type { PointListQuery } from '@geomix/shared';
import { Tabs } from 'antd';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { readCachedAccount } from '../../lib/account-cache';
import type { LedgerPage, PointItem, RightsView } from '../../lib/account-client';
import { ExtensionPairingPanel } from '../brands/extension-pairing-panel';
import { useConsoleContext } from '../shell/console-context';
import { PointsScreen } from './points-screen';
import { RightsScreen } from './rights-screen';

export const ACCOUNT_TABS = ['points', 'rights', 'extension'] as const;
export type AccountTabKey = (typeof ACCOUNT_TABS)[number];

export function resolveAccountTab(raw: string | null | undefined): AccountTabKey {
  if (raw === 'rights') return 'rights';
  if (raw === 'extension') return 'extension';
  return 'points';
}

export type AccountScreenProps = {
  initialTab?: AccountTabKey;
  readOnly?: boolean;
  loadPoints?: (query: PointListQuery) => Promise<LedgerPage<PointItem>>;
  loadSummary?: () => Promise<RightsView>;
  exportPoints?: (
    query: PointListQuery,
    format: 'csv' | 'xlsx',
  ) => Promise<{ filename: string; mime: string; body: Uint8Array }>;
  loadRights?: () => Promise<RightsView>;
};

export function AccountScreen({
  initialTab,
  readOnly,
  loadPoints,
  loadSummary,
  exportPoints,
  loadRights,
}: AccountScreenProps = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const consoleCtx = useConsoleContext();

  const tabParam = searchParams?.get('tab') ?? null;
  const [activeTab, setActiveTab] = useState<AccountTabKey>(
    () => initialTab ?? resolveAccountTab(tabParam),
  );

  useEffect(() => {
    if (initialTab !== undefined) return;
    setActiveTab(resolveAccountTab(tabParam));
  }, [initialTab, tabParam]);

  const effectiveReadOnly =
    readOnly ??
    consoleCtx?.readOnly ??
    (typeof window !== 'undefined'
      ? (readCachedAccount(window.sessionStorage)?.tenant.readOnly ?? false)
      : false);

  const handleTabChange = (key: string) => {
    const nextKey = resolveAccountTab(key);
    setActiveTab(nextKey);
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('tab', nextKey);
    const basePath = pathname || '/account';
    router.replace(`${basePath}?${params.toString()}`, { scroll: false });
  };

  return (
    <section className="gm-account-shell" aria-label="点数与权益">
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={[
          {
            key: 'points',
            label: '点数明细',
            children: (
              <PointsScreen
                title="点数明细"
                active={activeTab === 'points'}
                load={loadPoints}
                loadSummary={loadSummary}
                exportFile={exportPoints}
              />
            ),
          },
          {
            key: 'rights',
            label: '账号权益',
            children: (
              <RightsScreen title="账号权益" active={activeTab === 'rights'} load={loadRights} />
            ),
          },
          {
            key: 'extension',
            label: '扩展配对',
            children: (
              <ExtensionPairingPanel
                variant="account"
                readOnly={effectiveReadOnly}
                active={activeTab === 'extension'}
              />
            ),
          },
        ]}
      />
    </section>
  );
}
