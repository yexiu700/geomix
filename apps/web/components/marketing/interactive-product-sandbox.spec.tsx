// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HeroEngineStrip, InteractiveProductSandbox } from './interactive-product-sandbox';

afterEach(() => {
  cleanup();
});

describe('HeroEngineStrip', () => {
  it('switches between GLOBAL and CN AI engine matrices', () => {
    render(<HeroEngineStrip locale="en" />);

    expect(screen.getByText('ChatGPT')).toBeTruthy();
    expect(screen.getByText('Perplexity')).toBeTruthy();
    expect(screen.getByText('Google AI Overviews')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'CN' }));
    expect(screen.getByText('豆包')).toBeTruthy();
    expect(screen.getByText('DeepSeek')).toBeTruthy();
    expect(screen.queryByText('Kimi')).toBeNull();
    expect(screen.getByText('元宝')).toBeTruthy();
    expect(screen.getByText('通义')).toBeTruthy();
  });
});

describe('InteractiveProductSandbox', () => {
  it('supports ARIA tab switching via click and keyboard arrows (ArrowRight/ArrowLeft/Home/End) with valid aria-controls targets', () => {
    const { container } = render(<InteractiveProductSandbox locale="en" />);

    const assertValidAriaControls = (
      expectedActiveTab: HTMLElement,
      inactiveTabs: HTMLElement[],
    ) => {
      const panel = screen.getByRole('tabpanel');
      expect(expectedActiveTab.getAttribute('aria-controls')).toBe(panel.id);
      for (const tab of inactiveTabs) {
        expect(tab.getAttribute('aria-controls')).toBeNull();
      }
      const controlledEls = Array.from(container.querySelectorAll('[aria-controls]'));
      expect(controlledEls.length).toBeGreaterThan(0);
      for (const el of controlledEls) {
        const targetId = el.getAttribute('aria-controls');
        expect(targetId).toBeTruthy();
        expect(document.getElementById(targetId!)).not.toBeNull();
      }
    };

    const [tab0, tab1, tab2] = screen.getAllByRole('tab');
    if (!tab0 || !tab1 || !tab2) throw new Error('Expected 3 sandbox tabs');
    expect(tab0.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('sandbox-panel-diagnosis')).toBeTruthy();
    assertValidAriaControls(tab0, [tab1, tab2]);

    // ArrowRight moves to Tab 2
    fireEvent.keyDown(tab0, { key: 'ArrowRight' });
    expect(tab1.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('sandbox-panel-preflight')).toBeTruthy();
    assertValidAriaControls(tab1, [tab0, tab2]);

    // End moves to Tab 3
    fireEvent.keyDown(tab1, { key: 'End' });
    expect(tab2.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('sandbox-panel-distribution')).toBeTruthy();
    assertValidAriaControls(tab2, [tab0, tab1]);

    // Home returns to Tab 1
    fireEvent.keyDown(tab2, { key: 'Home' });
    expect(tab0.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('sandbox-panel-diagnosis')).toBeTruthy();
    assertValidAriaControls(tab0, [tab1, tab2]);

    // ArrowLeft wraps to Tab 3
    fireEvent.keyDown(tab0, { key: 'ArrowLeft' });
    expect(tab2.getAttribute('aria-selected')).toBe('true');
    assertValidAriaControls(tab2, [tab0, tab1]);
  });

  it('toggles GLOBAL (NordicAudio) and CN (北境声学) citation diagnosis breakdown in Tab 1', () => {
    render(<InteractiveProductSandbox locale="en" />);

    expect(screen.getByText('NordicAudio')).toBeTruthy();
    expect(screen.getByText(/Owned-Domain Citation Share: 44%/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'CN · 北境声学' }));
    expect(screen.getByText('北境声学')).toBeTruthy();
    expect(screen.getByText(/Owned-Domain Citation Share: 41%/)).toBeTruthy();
    const cnPcts = ['CITED', 'MENTIONED', 'COMPETITOR', 'ABSENT'].map((key) =>
      Number.parseInt(screen.getByTestId(`sandbox-kpi-pct-${key}`).textContent ?? '0', 10),
    );
    expect(cnPcts.reduce((sum, v) => sum + v, 0)).toBe(100);
  });

  it('runs real @geomix/shared preflight & 0-100 GEO audit across all 3 toggles in GLOBAL and CN modes', () => {
    render(<InteractiveProductSandbox locale="en" />);

    const [, tab1] = screen.getAllByRole('tab');
    if (!tab1) throw new Error('Expected Tab 2');
    fireEvent.click(tab1);

    // Clean GLOBAL state: score 100, PASS
    expect(screen.getByTestId('sandbox-geo-score').textContent).toBe('100');
    expect(screen.getByTestId('sandbox-gate-status').textContent).toContain('PASS');

    // Toggle 1: [TBD: runtime] -> score 93, BLOCKED with MISSING_FACT_SLOTS
    const tbdBtn = screen.getByTestId('sandbox-toggle-tbd');
    fireEvent.click(tbdBtn);
    expect(screen.getByTestId('sandbox-geo-score').textContent).toBe('93');
    expect(screen.getByTestId('sandbox-gate-status').textContent).toContain('BLOCKED');
    expect(screen.getByTestId('sandbox-preflight-findings').textContent).toContain(
      'MISSING_FACT_SLOTS',
    );
    expect(screen.getByTestId('sandbox-preflight-findings').textContent).toContain(
      '[TBD: runtime]',
    );

    // Toggle 2: Exaggerated/prohibited claim -> triggers BOTH COMPLIANCE_BLOCKED and GLOBAL_CLAIM_WARNING + score drop (93 -> 89)
    const hypeBtn = screen.getByTestId('sandbox-toggle-hype');
    fireEvent.click(hypeBtn);
    expect(screen.getByTestId('sandbox-geo-score').textContent).toBe('89');
    const findingsText = screen.getByTestId('sandbox-preflight-findings').textContent ?? '';
    expect(findingsText).toContain('COMPLIANCE_BLOCKED');
    expect(findingsText).toContain('GLOBAL_CLAIM_WARNING');
    // EN page must NOT leak raw Chinese preflight system messages
    expect(/[\u4e00-\u9fff]/.test(findingsText)).toBe(false);

    // Toggle 3: CJK leak -> adds GLOBAL_CJK_LEAK blocker
    const cjkBtn = screen.getByTestId('sandbox-toggle-cjk');
    fireEvent.click(cjkBtn);
    expect(screen.getByTestId('sandbox-preflight-findings').textContent).toContain(
      'GLOBAL_CJK_LEAK',
    );

    // Switch to CN mode: CJK toggle becomes disabled (GLOBAL track only), TBD & CN prohibited claim still block
    fireEvent.click(screen.getByRole('button', { name: 'CN · WordPress' }));
    expect((screen.getByTestId('sandbox-toggle-cjk') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('sandbox-gate-status').textContent).toContain('BLOCKED');
    const cnFindings = screen.getByTestId('sandbox-preflight-findings').textContent ?? '';
    expect(cnFindings).toContain('MISSING_FACT_SLOTS');
    expect(cnFindings).toContain('COMPLIANCE_BLOCKED');
    expect(cnFindings).toContain('CN_AD_LAW_WARNING');
    expect(cnFindings).not.toContain('GLOBAL_CJK_LEAK');

    // Fix TBD & hype claim -> back to 100 PASS
    fireEvent.click(tbdBtn);
    fireEvent.click(hypeBtn);
    expect(screen.getByTestId('sandbox-geo-score').textContent).toBe('100');
    expect(screen.getByTestId('sandbox-gate-status').textContent).toContain('PASS');
  });

  it('localizes Tab 2 CN track badge and COMPLIANCE_BLOCKED findings cleanly on locale="en"', () => {
    render(<InteractiveProductSandbox locale="en" />);

    const [, tab1] = screen.getAllByRole('tab');
    if (!tab1) throw new Error('Expected Tab 2');
    fireEvent.click(tab1);

    fireEvent.click(screen.getByRole('button', { name: 'CN · WordPress' }));
    const trackBadge = screen.getByTestId('sandbox-preflight-track-badge');
    expect(trackBadge.textContent).toBe('ZH · CN Ad Law / Dual-Track');
    expect(trackBadge.textContent).not.toContain('广告法');

    fireEvent.click(screen.getByTestId('sandbox-toggle-hype'));
    const findingsText = screen.getByTestId('sandbox-preflight-findings').textContent ?? '';
    expect(findingsText).toContain('COMPLIANCE_BLOCKED');
    expect(findingsText).toContain('CN_AD_LAW_WARNING');
    expect(findingsText).toContain('Prohibited claim blocked:');
    expect(findingsText).toContain('全网第一');
    expect(findingsText).not.toContain('命中禁做行业词');
    expect(findingsText).not.toMatch(/命中|禁做|广告法/);
  });

  it('switches 1->N distribution channel previews and renders T+1 CrawlProbe & SVG attribution chart in Tab 3', () => {
    render(<InteractiveProductSandbox locale="en" />);

    const [, , tab2] = screen.getAllByRole('tab');
    if (!tab2) throw new Error('Expected Tab 3');
    fireEvent.click(tab2);

    expect(screen.getByText(/SHOPIFY_BLOG/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Reddit Zero-Ban Checklist/i }));
    expect(screen.getByText(/r\/headphones/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Login-Free PR\/KOL Media Kit/i }));
    expect(screen.getByText(/\/share\/pr\/na_studio_pro4_kit/)).toBeTruthy();

    // T+1 CrawlProbe chips
    const probe = screen.getByTestId('sandbox-crawl-probe');
    expect(probe.textContent).toContain('HTTP 200');
    expect(probe.textContent).toContain('robots.txt');
    expect(probe.textContent).toContain('JSON-LD');

    // Hand-written SVG attribution chart + sr-only accessible table
    const svg = screen.getByRole('img', { name: /AI citation rate rising from 18% at T0 to 56%/i });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(screen.getAllByText('T+30').length).toBeGreaterThanOrEqual(2);
  });
});
