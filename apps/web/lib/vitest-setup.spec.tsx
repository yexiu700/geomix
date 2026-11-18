// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

describe('vitest JSDOM setup optimization', () => {
  it('skips CSSOM rule parsing for rc-util dynamic style tags while preserving innerHTML reads', () => {
    const rcStyle = document.createElement('style');
    rcStyle.setAttribute('data-rc-order', 'prependQueue');
    rcStyle.innerHTML = '.ant-btn { color: rgb(22, 119, 255); }';
    document.head.appendChild(rcStyle);

    try {
      expect(rcStyle.innerHTML).toBe('.ant-btn { color: rgb(22, 119, 255); }');
      expect(rcStyle.sheet?.cssRules.length ?? 0).toBe(0);
    } finally {
      rcStyle.remove();
    }
  });

  it('preserves standard <style> parsing and native hidden/inline computed styles', () => {
    const customStyle = document.createElement('style');
    customStyle.innerHTML = '.gm-setup-probe { display: none; }';
    document.head.appendChild(customStyle);

    const styledEl = document.createElement('div');
    styledEl.className = 'gm-setup-probe';
    const hiddenEl = document.createElement('div');
    hiddenEl.hidden = true;
    const visibleEl = document.createElement('div');

    document.body.append(styledEl, hiddenEl, visibleEl);

    try {
      expect(window.getComputedStyle(styledEl).display).toBe('none');
      expect(window.getComputedStyle(hiddenEl).display).toBe('none');
      expect(window.getComputedStyle(visibleEl).display).toBe('block');
    } finally {
      customStyle.remove();
      styledEl.remove();
      hiddenEl.remove();
      visibleEl.remove();
    }
  });
});
