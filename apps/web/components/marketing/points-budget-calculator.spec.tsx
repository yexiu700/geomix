// @vitest-environment jsdom

import { PUBLIC_PRICING_FALLBACK, calculateMonthlyPointsEstimate } from '@geomix/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { extractCalculatorUnitPoints } from '../../lib/marketing-api';
import { PointsBudgetCalculator } from './points-budget-calculator';

afterEach(() => {
  cleanup();
});

const DEFAULT_UNITS = extractCalculatorUnitPoints(PUBLIC_PRICING_FALLBACK);

describe('PointsBudgetCalculator (EN & ZH)', () => {
  it('renders default 464 pts estimate (TRIAL), itemized breakdown, and EN /demo handoff link', () => {
    render(
      <PointsBudgetCalculator
        locale="en"
        unitPoints={DEFAULT_UNITS}
        demoTrial={PUBLIC_PRICING_FALLBACK.demoTrial}
      />,
    );

    const expected = calculateMonthlyPointsEstimate({ unitPoints: DEFAULT_UNITS });
    expect(expected.totalMonthlyPoints).toBe(464);

    const totalEl = screen.getByTestId('calculator-total-points');
    expect(totalEl.textContent).toBe('464');
    expect(totalEl.getAttribute('data-total-points')).toBe('464');
    expect(totalEl.getAttribute('data-recommended-tier')).toBe('TRIAL');

    expect(screen.getByTestId('calculator-writing-points').textContent).toContain('80');
    expect(screen.getByTestId('calculator-variant-points').textContent).toContain('32');
    expect(screen.getByTestId('calculator-baseline-points').textContent).toContain('160');
    expect(screen.getByTestId('calculator-retest-points').textContent).toContain('192');

    const cta = screen.getByTestId('calculator-demo-cta');
    const href = cta.getAttribute('href') ?? '';
    expect(href.startsWith('/demo?')).toBe(true);
    const params = new URLSearchParams(href.split('?')[1] ?? '');
    expect(params.get('estimatedPts')).toBe('464');
    const goal = params.get('monthlyGoal') ?? '';
    expect(goal.length).toBeGreaterThan(0);
    expect(goal.length).toBeLessThanOrEqual(160);
    expect(goal).not.toMatch(/[$¥￥€£]|\b(USD|CNY)\b/i);
  });

  it('recomputes dynamically when sliders, sampling radio, and auto-retest toggle change', () => {
    render(
      <PointsBudgetCalculator
        locale="en"
        unitPoints={DEFAULT_UNITS}
        demoTrial={PUBLIC_PRICING_FALLBACK.demoTrial}
      />,
    );

    // Toggle 3x sampling -> 80 + 32 + 480 + 576 = 1168 (GROWTH)
    fireEvent.click(screen.getByLabelText(/3x High-Confidence Sampling/i));
    expect(screen.getByTestId('calculator-total-points').textContent).toBe('1,168');
    expect(
      screen.getByTestId('calculator-total-points').getAttribute('data-recommended-tier'),
    ).toBe('GROWTH');

    // Disable auto-retest -> 80 + 32 + 480 + 0 = 592 (TRIAL)
    fireEvent.click(screen.getByLabelText(/Enable T\+7 \/ T\+14 \/ T\+30 Auto-Retest/i));
    expect(screen.getByTestId('calculator-total-points').textContent).toBe('592');
    expect(screen.getByTestId('calculator-retest-points').textContent).toContain('0');

    // Crank up sliders to maximum defaults -> 500 + 400 + 3000 + 4500 = 8400 (GROWTH)
    fireEvent.change(screen.getByLabelText(/Master GEO Articles/i), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/Channel Variants per Article/i), {
      target: { value: '4' },
    });
    fireEvent.change(screen.getByLabelText(/Tracked Core Prompts/i), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/Monitored AI Engines/i), { target: { value: '5' } });
    fireEvent.click(screen.getByLabelText(/Enable T\+7 \/ T\+14 \/ T\+30 Auto-Retest/i));

    const expectedMaxDefault = calculateMonthlyPointsEstimate({
      monthlyArticles: 50,
      variantChannelsPerArticle: 4,
      trackedPrompts: 100,
      monitoredEngines: 5,
      samplesPerPrompt: 3,
      enableAutoRetest: true,
      unitPoints: DEFAULT_UNITS,
    });
    expect(expectedMaxDefault.totalMonthlyPoints).toBe(8400);
    expect(expectedMaxDefault.recommendedTier).toBe('GROWTH');
    expect(screen.getByTestId('calculator-total-points').getAttribute('data-total-points')).toBe(
      String(expectedMaxDefault.totalMonthlyPoints),
    );
    expect(
      screen.getByTestId('calculator-total-points').getAttribute('data-recommended-tier'),
    ).toBe('GROWTH');

    // Higher live visibility_check unit points pushes max cadence over 10,000 -> ENTERPRISE
    cleanup();
    render(
      <PointsBudgetCalculator
        locale="en"
        unitPoints={{ ...DEFAULT_UNITS, visibility_check: 3 }}
        demoTrial={PUBLIC_PRICING_FALLBACK.demoTrial}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Master GEO Articles/i), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/Channel Variants per Article/i), {
      target: { value: '4' },
    });
    fireEvent.change(screen.getByLabelText(/Tracked Core Prompts/i), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/Monitored AI Engines/i), { target: { value: '5' } });
    fireEvent.click(screen.getByLabelText(/3x High-Confidence Sampling/i));
    expect(screen.getByTestId('calculator-total-points').getAttribute('data-total-points')).toBe(
      '12150',
    );
    expect(
      screen.getByTestId('calculator-total-points').getAttribute('data-recommended-tier'),
    ).toBe('ENTERPRISE');
    expect(screen.getByTestId('calculator-recommended-tier').textContent).toBe(
      'Agency & Enterprise',
    );
  });

  it('respects live geo_variant=0 override and generates ZH /zh/demo handoff link under 160 chars', () => {
    render(
      <PointsBudgetCalculator
        locale="zh-CN"
        unitPoints={{ ...DEFAULT_UNITS, geo_variant: 0 }}
        demoTrial={PUBLIC_PRICING_FALLBACK.demoTrial}
      />,
    );

    // 80 + 0 + 160 + 192 = 432
    expect(screen.getByTestId('calculator-total-points').textContent).toBe('432');
    expect(screen.getByTestId('calculator-variant-points').textContent).toContain('0');

    const cta = screen.getByTestId('calculator-demo-cta');
    const href = cta.getAttribute('href') ?? '';
    expect(href.startsWith('/zh/demo?')).toBe(true);
    const params = new URLSearchParams(href.split('?')[1] ?? '');
    expect(params.get('estimatedPts')).toBe('432');
    const goal = params.get('monthlyGoal') ?? '';
    expect(goal.length).toBeGreaterThan(0);
    expect(goal.length).toBeLessThanOrEqual(160);
    expect(goal).not.toMatch(/[$¥￥€£]|\b(USD|CNY)\b/i);
  });
});
