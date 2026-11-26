'use client';

import { useEffect, useRef } from 'react';

export type FreshnessDomain =
  | 'brands'
  | 'product-lines'
  | 'brand-facts'
  | 'brand-media'
  | 'channel-connections'
  | 'visibility-runs'
  | 'briefs'
  | 'articles'
  | 'distributions'
  | 'publish-records'
  | 'points'
  | 'roi-reports'
  | 'extension-tokens';

export type FreshnessRefreshReason = 'activated' | 'invalidated';

const domainVersions = new Map<FreshnessDomain, number>();
const listeners = new Set<(domains: ReadonlySet<FreshnessDomain>) => void>();

export function getFreshnessVersion(domain: FreshnessDomain): number {
  return domainVersions.get(domain) ?? 0;
}

export function invalidateFreshness(...domains: FreshnessDomain[]): void {
  if (domains.length === 0) return;
  const changed = new Set<FreshnessDomain>();
  for (const domain of domains) {
    domainVersions.set(domain, (domainVersions.get(domain) ?? 0) + 1);
    changed.add(domain);
  }
  for (const listener of listeners) {
    listener(changed);
  }
}

export function subscribeFreshness(
  listener: (domains: ReadonlySet<FreshnessDomain>) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetFreshnessForTests(): void {
  domainVersions.clear();
  listeners.clear();
}

/**
 * 统一的多标签页保鲜 Hook（#215）：
 * 1. 当已挂载页签从后台切回激活态（`active: false -> true`）时触发刷新；
 * 2. 当其他页签通过 `invalidateFreshness` 广播依赖域变更时，若当前页签处于后台则记为脏，
 *    切回激活时立即刷新；若当前页签正处于激活态（如分栏/单页/弹窗还原），立即触发刷新；
 * 3. 初次挂载时不触发额外重复请求（保持各模块首屏加载逻辑不变）。
 */
export function useTabFreshness({
  active = true,
  domains,
  onRefresh,
  refreshOnActivate = true,
}: {
  active?: boolean;
  domains: readonly FreshnessDomain[];
  onRefresh: (reason: FreshnessRefreshReason) => void;
  refreshOnActivate?: boolean;
}): void {
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const activeRef = useRef(active);
  activeRef.current = active;

  const wasActiveRef = useRef(active);
  const dirtyRef = useRef(false);
  const domainsKey = domains.join('|');
  const domainsRef = useRef(domains);
  domainsRef.current = domains;

  const seenVersionsRef = useRef<Map<FreshnessDomain, number> | null>(null);
  if (!seenVersionsRef.current) {
    const initial = new Map<FreshnessDomain, number>();
    for (const domain of domains) {
      initial.set(domain, getFreshnessVersion(domain));
    }
    seenVersionsRef.current = initial;
  }

  useEffect(() => {
    const syncSeen = () => {
      const seen = seenVersionsRef.current!;
      let changed = false;
      for (const domain of domainsRef.current) {
        const current = getFreshnessVersion(domain);
        if (seen.get(domain) !== current) {
          seen.set(domain, current);
          changed = true;
        }
      }
      return changed;
    };

    const unsubscribe = subscribeFreshness((changedDomains) => {
      const hits = domainsRef.current.some((domain) => changedDomains.has(domain));
      if (!hits) return;
      syncSeen();
      if (activeRef.current) {
        dirtyRef.current = false;
        onRefreshRef.current('invalidated');
      } else {
        dirtyRef.current = true;
      }
    });

    return unsubscribe;
  }, [domainsKey]);

  useEffect(() => {
    const seen = seenVersionsRef.current!;
    for (const domain of domainsRef.current) {
      const current = getFreshnessVersion(domain);
      if (seen.get(domain) !== current) {
        seen.set(domain, current);
        dirtyRef.current = true;
      }
    }

    const becameActive = !wasActiveRef.current && active;
    wasActiveRef.current = active;

    if (becameActive && (refreshOnActivate || dirtyRef.current)) {
      dirtyRef.current = false;
      onRefreshRef.current('activated');
      return;
    }

    if (active && dirtyRef.current) {
      dirtyRef.current = false;
      onRefreshRef.current('invalidated');
    }
  }, [active, refreshOnActivate, domainsKey]);
}
