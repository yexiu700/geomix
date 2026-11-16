import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<{ tenantId: string }>();

export function currentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

export function runInTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}
