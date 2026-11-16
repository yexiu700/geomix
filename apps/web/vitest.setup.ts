if (typeof window !== 'undefined') {
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
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((element: Element, pseudoElt?: string | null) => {
    if (pseudoElt) return { getPropertyValue: () => '' } as unknown as CSSStyleDeclaration;
    return computed(element);
  }) as typeof window.getComputedStyle;
}
