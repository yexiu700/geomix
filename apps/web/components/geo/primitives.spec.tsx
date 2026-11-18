// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EngineChip,
  EngineChipList,
  SentimentDot,
  SignalEmpty,
  SignalError,
  SignalKpiCard,
  SignalPill,
  SignalSkeleton,
  SourceKindChip,
  StatusPill,
  TruncText,
} from './primitives';

afterEach(() => {
  cleanup();
});

describe('geo/primitives', () => {
  it('sets --gm-kpi-ratio to 75% for numerator=3, denominator=4 and marks numbers with gm-num', () => {
    render(
      <SignalKpiCard
        label="品牌提及率"
        value="75.0%"
        numerator={3}
        denominator={4}
        testId="kpi-vis"
      />,
    );
    const card = screen.getByTestId('kpi-vis');
    expect(card.style.getPropertyValue('--gm-kpi-ratio')).toBe('75%');
    const numNodes = card.querySelectorAll('.gm-num');
    expect(numNodes.length).toBeGreaterThanOrEqual(3);
  });

  it('sets --gm-kpi-ratio to 0% when value is em-dash or denominator is missing', () => {
    render(<SignalKpiCard label="平均顺位" value="—" testId="kpi-empty" />);
    expect(screen.getByTestId('kpi-empty').style.getPropertyValue('--gm-kpi-ratio')).toBe('0%');
  });

  it('triggers onClick on Enter and Space for clickable SignalKpiCard', () => {
    const onClick = vi.fn();
    render(<SignalKpiCard label="声量占比" value="42.0%" onClick={onClick} testId="kpi-click" />);
    const card = screen.getByTestId('kpi-click');
    expect(card.getAttribute('role')).toBe('button');
    expect(card.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('renders EngineChipList with 5 engines and max=3 as 3 chips plus +2', () => {
    const { container } = render(
      <EngineChipList engines={['deepseek', 'doubao', 'kimi', 'chatgpt', 'claude']} max={3} />,
    );
    expect(container.querySelectorAll('.gm-engine-chip').length).toBe(3);
    expect(screen.getByText('+2').classList.contains('gm-num')).toBe(true);
  });

  it('renders EngineChip with label or raw unknown key', () => {
    render(
      <>
        <EngineChip engine="deepseek" />
        <EngineChip engine="custom_engine" />
      </>,
    );
    expect(screen.getByText('DeepSeek')).toBeTruthy();
    expect(screen.getByText('custom_engine')).toBeTruthy();
  });

  it('renders SentimentDot with em-dash for null and label for non-null', () => {
    render(
      <>
        <SentimentDot sentiment={null} />
        <SentimentDot sentiment="positive" />
      </>,
    );
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('正面')).toBeTruthy();
  });

  it('renders SignalPill, SourceKindChip, and StatusPill labels', () => {
    render(
      <>
        <SignalPill tone="cited">已引用</SignalPill>
        <SourceKindChip kind="OWNED" />
        <StatusPill status="RUNNING" kind="task" />
        <StatusPill status="SUCCESS" kind="item" />
      </>,
    );
    expect(screen.getByText('已引用')).toBeTruthy();
    expect(screen.getByText('自有阵地')).toBeTruthy();
    expect(screen.getByText('监测中')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('renders SignalSkeleton variants, SignalEmpty, SignalError, and TruncText', () => {
    const onRetry = vi.fn();
    const onAction = vi.fn();
    const { container } = render(
      <>
        <SignalSkeleton variant="kpi" />
        <SignalSkeleton variant="row" rows={2} />
        <SignalSkeleton variant="block" height={120} />
        <SignalEmpty
          title="暂无数据"
          description="请先发起一次诊断"
          actionText="去创建"
          onAction={onAction}
        />
        <SignalError message="加载失败" onRetry={onRetry} />
        <TruncText text={'a'.repeat(80)} middle mono />
      </>,
    );
    expect(container.querySelectorAll('.gm-skeleton-row').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: '去创建' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.gm-mono')?.textContent?.length).toBe(56);
  });
});
