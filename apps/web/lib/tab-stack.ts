import { matchRoute } from './routes';

/** 同时打开的标签上限。首页固定，超出时关掉最早可关闭的那个。 */
export const MAX_OPEN_TABS = 15;
export const HOME_HREF = '/dashboard';
export const SHELL_STORAGE_KEY = 'geomix.shell.v2';

export type ShellTab = {
  id: string;
  href: string;
  title: string;
  pinned: boolean;
  sourceId?: string;
};

export type LayoutPrefs = {
  multiTab: boolean;
  menuCollapsed: boolean;
  submenusAlwaysVisible: boolean;
  autoExpand: boolean;
  multiLevel: boolean;
};

export const defaultPrefs = (): LayoutPrefs => ({
  multiTab: true,
  menuCollapsed: false,
  submenusAlwaysVisible: false,
  autoExpand: true,
  multiLevel: true,
});

export type ShellSnapshot = {
  tabs: ShellTab[];
  activeId: string;
  prefs: LayoutPrefs;
  drafts: Record<string, string>;
  reloadNonce: Record<string, number>;
};

export type ShellAction =
  | { type: 'open'; href: string; sourceId?: string }
  | { type: 'activate'; id: string }
  | { type: 'close'; id: string }
  | { type: 'close-others'; id: string }
  | { type: 'close-right'; id: string }
  | { type: 'close-all' }
  | { type: 'refresh'; id: string }
  | { type: 'draft'; id: string; value: string }
  | { type: 'retitle'; id: string; title: string }
  | { type: 'navigate'; id: string; href: string }
  | { type: 'back'; id: string }
  | { type: 'prefs'; patch: Partial<LayoutPrefs> };

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const COALESCED_TAB_PATHS = new Set(['/material/questions']);

function tabFromMatch(
  match: NonNullable<ReturnType<typeof matchRoute>>,
  sourceId?: string,
): ShellTab {
  const source = canonicalSource(sourceId, match.href);
  return {
    id: match.href,
    href: match.href,
    title: match.title,
    pinned: match.pinned,
    ...(source ? { sourceId: source } : {}),
  };
}

export function tabFromHref(href: string, sourceId?: string): ShellTab | null {
  const match = matchRoute(href);
  if (!match) return null;
  return tabFromMatch(match, sourceId);
}

export function initialSnapshot(): ShellSnapshot {
  const home = tabFromHref(HOME_HREF);
  if (!home) throw new Error('home route is missing');
  return {
    tabs: [home],
    activeId: home.id,
    prefs: defaultPrefs(),
    drafts: {},
    reloadNonce: {},
  };
}

export function reduceShell(state: ShellSnapshot, action: ShellAction): ShellSnapshot {
  switch (action.type) {
    case 'open':
      return openTab(state, action.href, action.sourceId);
    case 'activate':
      return activateTab(state, action.id);
    case 'close':
      return closeTab(state, action.id);
    case 'close-others':
      return closeOthers(state, action.id);
    case 'close-right':
      return closeRight(state, action.id);
    case 'close-all':
      return closeAll(state);
    case 'refresh':
      return refreshTab(state, action.id);
    case 'draft':
      return setDraft(state, action.id, action.value);
    case 'retitle':
      return retitleTab(state, action.id, action.title);
    case 'navigate':
      return navigateTab(state, action.id, action.href);
    case 'back':
      return goBack(state, action.id);
    case 'prefs':
      return patchPrefs(state, action.patch);
    default:
      return state;
  }
}

export function openTab(state: ShellSnapshot, href: string, sourceId?: string): ShellSnapshot {
  const match = matchRoute(href);
  if (!match) return state;
  const created = tabFromMatch(match, sourceId);
  const existing = state.tabs.find((tab) => tab.id === created.id);
  if (existing) return activateTab(state, existing.id);

  const samePathTab = COALESCED_TAB_PATHS.has(match.path)
    ? state.tabs.find((tab) => matchRoute(tab.href)?.path === match.path)
    : undefined;
  const inheritedSource =
    samePathTab && !created.sourceId && created.href !== match.path
      ? canonicalSource(samePathTab.sourceId, created.href)
      : undefined;
  const replacement: ShellTab =
    samePathTab && inheritedSource ? { ...created, sourceId: inheritedSource } : created;

  if (!state.prefs.multiTab) {
    const draft =
      state.drafts[replacement.id] ?? (samePathTab ? state.drafts[samePathTab.id] : undefined);
    return {
      ...state,
      tabs: [replacement],
      activeId: replacement.id,
      drafts: draft ? { [replacement.id]: draft } : {},
    };
  }

  if (samePathTab) {
    const tabs = state.tabs.map((tab) => (tab.id === samePathTab.id ? replacement : tab));
    return {
      ...state,
      tabs,
      activeId: replacement.id,
      drafts: migrateDraft(state.drafts, samePathTab.id, replacement.id),
    };
  }

  const tabs = evictOldest([...state.tabs, replacement], replacement.id);
  return {
    ...state,
    tabs,
    activeId: replacement.id,
    drafts: pickDrafts(
      state.drafts,
      tabs.map((tab) => tab.id),
    ),
  };
}

export function setMultiTab(state: ShellSnapshot, enabled: boolean): ShellSnapshot {
  if (state.prefs.multiTab === enabled) return state;
  if (enabled) return { ...state, prefs: { ...state.prefs, multiTab: true } };
  const active = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];
  if (!active) return { ...state, prefs: { ...state.prefs, multiTab: false } };
  const draft = state.drafts[active.id];
  return {
    ...state,
    prefs: { ...state.prefs, multiTab: false },
    tabs: [active],
    activeId: active.id,
    drafts: draft ? { [active.id]: draft } : {},
  };
}

export function serializeShell(state: ShellSnapshot): string {
  return JSON.stringify({
    tabs: state.tabs.map((tab) => ({
      href: tab.href,
      ...(tab.sourceId ? { sourceId: tab.sourceId } : {}),
    })),
    activeId: state.activeId,
    prefs: state.prefs,
  });
}

export function loadShell(storage: KeyValueStorage): ShellSnapshot {
  const parsed = parseShell(storage.getItem(SHELL_STORAGE_KEY));
  if (!parsed) return initialSnapshot();
  return { ...parsed, drafts: {}, reloadNonce: {} };
}

export function saveShell(storage: KeyValueStorage, state: ShellSnapshot): void {
  storage.setItem(SHELL_STORAGE_KEY, serializeShell(state));
}

export function parseShell(
  raw: string | null,
): Pick<ShellSnapshot, 'tabs' | 'activeId' | 'prefs'> | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tabs)) return null;

  const requested = typeof record.activeId === 'string' ? record.activeId : '';
  const tabs: ShellTab[] = [];
  for (const item of record.tabs) {
    if (!item || typeof item !== 'object') continue;
    const href = (item as { href?: unknown }).href;
    const source = (item as { sourceId?: unknown }).sourceId;
    if (typeof href !== 'string') continue;
    const match = matchRoute(href);
    if (!match) continue;
    const tab = tabFromMatch(match, typeof source === 'string' ? source : undefined);
    if (tabs.some((existing) => existing.id === tab.id)) continue;
    if (COALESCED_TAB_PATHS.has(match.path)) {
      const dupIdx = tabs.findIndex((existing) => matchRoute(existing.href)?.path === match.path);
      if (dupIdx >= 0) {
        if (tab.id === requested) tabs[dupIdx] = tab;
        continue;
      }
    }
    tabs.push(tab);
    if (tabs.length === MAX_OPEN_TABS) break;
  }

  const home = tabFromHref(HOME_HREF);
  if (!home) return null;
  if (!tabs.some((tab) => tab.id === home.id)) {
    tabs.unshift(home);
    if (tabs.length > MAX_OPEN_TABS) tabs.pop();
  }
  if (tabs.length === 0) return null;
  const activeId = tabs.some((tab) => tab.id === requested) ? requested : (tabs[0]?.id ?? home.id);
  return { tabs, activeId, prefs: parsePrefs(record.prefs) };
}

function activateTab(state: ShellSnapshot, id: string): ShellSnapshot {
  if (!state.tabs.some((tab) => tab.id === id) || state.activeId === id) return state;
  return { ...state, activeId: id };
}

function closeTab(state: ShellSnapshot, id: string): ShellSnapshot {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  const tab = index >= 0 ? state.tabs[index] : undefined;
  if (!tab || tab.pinned) return state;
  const tabs = state.tabs.filter((item) => item.id !== id);
  const ensured = ensureHome(tabs);
  let activeId = state.activeId;
  if (activeId === id) {
    const neighbor = state.tabs[index + 1] ?? state.tabs[index - 1];
    activeId =
      neighbor && neighbor.id !== id && ensured.some((item) => item.id === neighbor.id)
        ? neighbor.id
        : (ensured[0]?.id ?? HOME_HREF);
  }
  if (!ensured.some((item) => item.id === activeId)) activeId = ensured[0]?.id ?? HOME_HREF;
  return { ...state, tabs: ensured, activeId, drafts: omitDraft(state.drafts, id) };
}

function closeOthers(state: ShellSnapshot, id: string): ShellSnapshot {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  const removed = state.tabs.filter((tab) => !tab.pinned && tab.id !== id).map((tab) => tab.id);
  if (removed.length === 0) return state;
  const tabs = ensureHome(state.tabs.filter((tab) => tab.pinned || tab.id === id));
  const activeId = tabs.some((tab) => tab.id === id) ? id : (tabs[0]?.id ?? HOME_HREF);
  return { ...state, tabs, activeId, drafts: omitDrafts(state.drafts, removed) };
}

function closeRight(state: ShellSnapshot, id: string): ShellSnapshot {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const removed = state.tabs
    .filter((tab, tabIndex) => tabIndex > index && !tab.pinned)
    .map((tab) => tab.id);
  if (removed.length === 0) return state;
  const removedSet = new Set(removed);
  const tabs = state.tabs.filter((tab) => !removedSet.has(tab.id));
  const activeId = removedSet.has(state.activeId) ? id : state.activeId;
  return { ...state, tabs, activeId, drafts: omitDrafts(state.drafts, removed) };
}

function closeAll(state: ShellSnapshot): ShellSnapshot {
  const tabs = ensureHome(state.tabs.filter((tab) => tab.pinned));
  const activeId = tabs.some((tab) => tab.id === state.activeId)
    ? state.activeId
    : (tabs[0]?.id ?? HOME_HREF);
  const keep = new Set(tabs.map((tab) => tab.id));
  return {
    ...state,
    tabs,
    activeId,
    drafts: pickDrafts(state.drafts, [...keep]),
  };
}

function refreshTab(state: ShellSnapshot, id: string): ShellSnapshot {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  return {
    ...state,
    drafts: omitDraft(state.drafts, id),
    reloadNonce: { ...state.reloadNonce, [id]: (state.reloadNonce[id] ?? 0) + 1 },
  };
}

function setDraft(state: ShellSnapshot, id: string, value: string): ShellSnapshot {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  if (!value) {
    if (!(id in state.drafts)) return state;
    return { ...state, drafts: omitDraft(state.drafts, id) };
  }
  if (state.drafts[id] === value) return state;
  return { ...state, drafts: { ...state.drafts, [id]: value } };
}

function retitleTab(state: ShellSnapshot, id: string, title: string): ShellSnapshot {
  const nextTitle = title.trim();
  if (!nextTitle) return state;
  const idx = state.tabs.findIndex((tab) => tab.id === id);
  if (idx < 0 || state.tabs[idx]?.title === nextTitle) return state;
  const tabs = state.tabs.map((tab, i) => (i === idx ? { ...tab, title: nextTitle } : tab));
  return { ...state, tabs };
}

function navigateTab(state: ShellSnapshot, id: string, href: string): ShellSnapshot {
  const idx = state.tabs.findIndex((tab) => tab.id === id);
  const current = idx >= 0 ? state.tabs[idx] : undefined;
  if (!current || current.pinned) return state;
  const replacement = tabFromHref(href, current.sourceId);
  if (!replacement || replacement.id === current.id) return state;

  // 若目标路由已有独立标签，关闭当前带筛选参数的标签并激活目标标签
  const collision = state.tabs.find((tab, i) => i !== idx && tab.id === replacement.id);
  if (collision) {
    const closed = closeTab(state, id);
    return activateTab(closed, collision.id);
  }

  const tabs = state.tabs.map((tab, i) => (i === idx ? replacement : tab));
  const drafts = { ...state.drafts };
  if (id in drafts) {
    drafts[replacement.id] = drafts[id]!;
    delete drafts[id];
  }
  return {
    ...state,
    tabs,
    activeId: state.activeId === id ? replacement.id : state.activeId,
    drafts,
  };
}

function goBack(state: ShellSnapshot, id: string): ShellSnapshot {
  const tab = state.tabs.find((item) => item.id === id);
  if (!tab || tab.pinned) return state;
  const source =
    tab.sourceId && state.tabs.some((item) => item.id === tab.sourceId)
      ? tab.sourceId
      : matchRoute(tab.href)?.parent;
  const closed = closeTab(state, id);
  if (!source) return closed;
  if (closed.tabs.some((item) => item.id === source)) return { ...closed, activeId: source };
  return openTab(closed, source);
}

function patchPrefs(state: ShellSnapshot, patch: Partial<LayoutPrefs>): ShellSnapshot {
  const { multiTab, ...rest } = patch;
  let next = state;
  if (multiTab !== undefined) next = setMultiTab(next, multiTab);
  if (Object.keys(rest).length === 0) return next;
  const prefs = { ...next.prefs, ...rest };
  if (samePrefs(prefs, next.prefs)) return next;
  return { ...next, prefs };
}

function evictOldest(tabs: ShellTab[], keepId: string): ShellTab[] {
  const next = [...tabs];
  while (next.length > MAX_OPEN_TABS) {
    const index = next.findIndex((tab) => !tab.pinned && tab.id !== keepId);
    if (index < 0) break;
    next.splice(index, 1);
  }
  return next;
}

function ensureHome(tabs: ShellTab[]): ShellTab[] {
  const home = tabFromHref(HOME_HREF);
  if (!home) return tabs;
  if (tabs.some((tab) => tab.id === home.id)) return tabs;
  const next = [home, ...tabs];
  return next.length > MAX_OPEN_TABS ? next.slice(0, MAX_OPEN_TABS) : next;
}

function canonicalSource(sourceId: string | undefined, href: string): string | undefined {
  if (!sourceId || sourceId === href) return undefined;
  const match = matchRoute(sourceId);
  if (!match || match.href === href) return undefined;
  return match.href;
}

function parsePrefs(value: unknown): LayoutPrefs {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const prefs = defaultPrefs();
  for (const key of Object.keys(prefs) as (keyof LayoutPrefs)[]) {
    const value = record[key];
    if (typeof value === 'boolean') prefs[key] = value;
  }
  return prefs;
}

function samePrefs(left: LayoutPrefs, right: LayoutPrefs): boolean {
  return (Object.keys(left) as (keyof LayoutPrefs)[]).every((key) => left[key] === right[key]);
}

function pickDrafts(drafts: Record<string, string>, ids: string[]): Record<string, string> {
  const keep = new Set(ids);
  const next: Record<string, string> = {};
  for (const [id, value] of Object.entries(drafts)) {
    if (keep.has(id) && value) next[id] = value;
  }
  return next;
}

function migrateDraft(
  drafts: Record<string, string>,
  fromId: string,
  toId: string,
): Record<string, string> {
  if (fromId === toId || !(fromId in drafts)) return drafts;
  const next = { ...drafts };
  next[toId] = next[fromId]!;
  delete next[fromId];
  return next;
}

function omitDraft(drafts: Record<string, string>, id: string): Record<string, string> {
  if (!(id in drafts)) return drafts;
  const next = { ...drafts };
  delete next[id];
  return next;
}

function omitDrafts(drafts: Record<string, string>, ids: string[]): Record<string, string> {
  const drop = new Set(ids);
  const next: Record<string, string> = {};
  for (const [id, value] of Object.entries(drafts)) {
    if (!drop.has(id)) next[id] = value;
  }
  return next;
}
