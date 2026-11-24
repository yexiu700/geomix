'use client';

import type { GeoMarket } from '@geomix/shared';
import { createContext, useContext, type ReactNode } from 'react';
import type { WalletSummary } from '../../lib/account-client';
import type { AccountProfile } from '../../lib/api';

export type ConsoleContextValue = {
  account: AccountProfile;
  readOnly: boolean;
  wallet: WalletSummary | null;
  walletLoading: boolean;
  urlSearch?: string;
  openCreateBrandModal: () => void;
  openEnableMarketModal: (market: GeoMarket) => void;
  refreshWallet: () => Promise<void>;
  navigateWorkspace: (href: string) => void;
};

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

export function ConsoleProvider({
  value,
  children,
}: {
  value: ConsoleContextValue;
  children: ReactNode;
}) {
  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsoleContext(): ConsoleContextValue | null {
  return useContext(ConsoleContext);
}
