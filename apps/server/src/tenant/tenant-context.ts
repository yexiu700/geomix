import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<{ tenantId: string }>();

export function currentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function runInTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ tenantId }, () => {
    const result = fn();
    if (isThenable(result)) {
      return new Promise((resolve, reject) => {
        result.then(resolve, reject);
      }) as unknown as T;
    }
    return result;
  });
}
