'use client';

import { create } from 'zustand';
import { initialSnapshot, reduceShell, type ShellAction, type ShellSnapshot } from './tab-stack';

type ShellStore = ShellSnapshot & {
  hydrated: boolean;
  dispatch: (action: ShellAction) => void;
  markHydrated: (snapshot: ShellSnapshot) => void;
};

export const useShellStore = create<ShellStore>((set) => ({
  ...initialSnapshot(),
  hydrated: false,
  dispatch: (action) => set((state) => reduceShell(state, action)),
  markHydrated: (snapshot) => set({ ...snapshot, hydrated: true }),
}));
