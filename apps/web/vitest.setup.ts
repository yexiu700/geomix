import { afterAll } from 'vitest';

if (typeof window !== 'undefined') {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  const RealMessageChannel = globalThis.MessageChannel;

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  window.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  window.HTMLElement.prototype.scrollIntoView = () => undefined;

  const rawStyleInnerHtml = Object.getOwnPropertyDescriptor(window.Element.prototype, 'innerHTML');
  if (rawStyleInnerHtml?.get && rawStyleInnerHtml.set) {
    const rcCssStore = new WeakMap<HTMLStyleElement, string>();
    Object.defineProperty(window.HTMLStyleElement.prototype, 'innerHTML', {
      configurable: true,
      get(this: HTMLStyleElement): string {
        if (this.hasAttribute('data-rc-order')) {
          return rcCssStore.get(this) ?? '';
        }
        return rawStyleInnerHtml.get!.call(this) as string;
      },
      set(this: HTMLStyleElement, value: string) {
        if (this.hasAttribute('data-rc-order')) {
          rcCssStore.set(this, String(value));
          return;
        }
        rawStyleInnerHtml.set!.call(this, value);
      },
    });
  }

  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((element: Element, pseudoElt?: string | null) => {
    if (pseudoElt) return { getPropertyValue: () => '' } as unknown as CSSStyleDeclaration;
    return computed(element);
  }) as typeof window.getComputedStyle;

  afterAll(async () => {
    if (typeof RealMessageChannel !== 'undefined') {
      await new Promise<void>((resolve) => {
        const channel = new RealMessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          channel.port2.close();
          resolve();
        };
        channel.port2.postMessage(undefined);
      });
    }
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 0);
    });
  });
}
