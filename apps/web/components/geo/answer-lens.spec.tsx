// @vitest-environment jsdom

import type { VisibilityCitationRecord } from '@geomix/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnswerLens, buildLensSegments } from './answer-lens';

afterEach(() => {
  cleanup();
});

function makeCitation(position: number, id = `cite_${position}`): VisibilityCitationRecord {
  return {
    id,
    url: `https://example.com/doc-${position}`,
    domain: 'example.com',
    title: `参考文档 ${position}`,
    snippet: '摘要内容',
    sourceKind: 'AUTHORITY',
    position,
    createdAt: '2026-11-18T00:00:00Z',
  };
}

describe('buildLensSegments', () => {
  it('parses brand, text, competitor, text, citation in exact 5-segment sequence', () => {
    const segs = buildLensSegments(
      'GeoMix 比 AcmeX 更好[1]',
      { name: 'GeoMix', aliases: [] },
      [{ name: 'AcmeX', aliases: [] }],
      [makeCitation(1)],
    );

    expect(segs).toHaveLength(5);
    expect(segs.map((s) => s.kind)).toEqual(['brand', 'text', 'competitor', 'text', 'citation']);
    expect(segs[0]?.text).toBe('GeoMix');
    expect(segs[2]?.text).toBe('AcmeX');
    expect(segs[4]?.text).toBe('[1]');
  });

  it('keeps brand when brand and competitor intervals overlap', () => {
    const segs = buildLensSegments(
      '推荐使用 GeoMix Pro 方案',
      { name: 'GeoMix Pro', aliases: [] },
      [{ name: 'GeoMix', aliases: ['Pro'] }],
      [],
    );

    const hits = segs.filter((s) => s.kind === 'brand' || s.kind === 'competitor');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'brand', text: 'GeoMix Pro' });
  });

  it('outputs unmatched citation marker [9] as plain text', () => {
    const segs = buildLensSegments(
      '参考资料[9]和[1]',
      { name: 'GeoMix', aliases: [] },
      [],
      [makeCitation(1)],
    );

    const citations = segs.filter((s) => s.kind === 'citation');
    expect(citations).toHaveLength(1);
    expect(citations[0]?.text).toBe('[1]');
    expect(segs.some((s) => s.kind === 'text' && s.text.includes('[9]'))).toBe(true);
  });

  it('supports Chinese full-width citation brackets 【1】 and whole-word boundaries', () => {
    const segs = buildLensSegments(
      'place 中不应命中，但 ace 应命中【1】',
      { name: 'ace', aliases: [] },
      [],
      [makeCitation(1)],
    );

    const brands = segs.filter((s) => s.kind === 'brand');
    const citations = segs.filter((s) => s.kind === 'citation');
    expect(brands).toHaveLength(1);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.text).toBe('【1】');
  });

  it('returns empty array for empty text', () => {
    expect(buildLensSegments('', { name: 'GeoMix', aliases: [] }, [], [])).toEqual([]);
  });
});

describe('AnswerLens component', () => {
  it('renders highlights, toggles chips, navigates hits, and triggers citation callback', () => {
    const onCitationClick = vi.fn();
    render(
      <AnswerLens
        answerText={'第一段介绍 GeoMix 的优势[1]。\n\n第二段对比 AcmeX 的不足。'}
        brandPassage="第一段介绍 GeoMix 的优势"
        brand={{ name: 'GeoMix', aliases: [] }}
        competitors={[{ name: 'AcmeX', aliases: [] }]}
        citations={[makeCitation(1, 'cite_abc')]}
        status="SUCCESS"
        error={null}
        onCitationClick={onCitationClick}
      />,
    );

    expect(screen.getByText('0 / 2')).toBeTruthy();
    expect(document.querySelectorAll('mark[data-hit="brand"]')).toHaveLength(1);
    expect(document.querySelectorAll('mark[data-hit="competitor"]')).toHaveLength(1);

    // Navigate next hit (chevron icon buttons instead of raw [ ] brackets)
    const nextBtn = screen.getByLabelText('下一个命中');
    const prevBtn = screen.getByLabelText('上一个命中');
    expect(nextBtn.textContent?.trim()).toBe('');
    expect(prevBtn.textContent?.trim()).toBe('');
    expect(nextBtn.querySelector('svg')).not.toBeNull();
    expect(prevBtn.querySelector('svg')).not.toBeNull();

    fireEvent.click(nextBtn);
    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(document.querySelectorAll('mark.gm-lens-hit-active')).toHaveLength(1);

    // Navigate prev hit wraps to 2 / 2
    fireEvent.click(prevBtn);
    expect(screen.getByText('2 / 2')).toBeTruthy();

    // Jump via heatmap tick
    fireEvent.click(screen.getByLabelText('跳转到命中-0'));
    expect(screen.getByText('1 / 2')).toBeTruthy();

    // Click citation chip
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    expect(onCitationClick).toHaveBeenCalledWith('cite_abc');

    // Toggle brand off
    fireEvent.click(screen.getByRole('button', { name: /品牌/ }));
    expect(document.querySelectorAll('mark[data-hit="brand"]')).toHaveLength(0);
    expect(screen.getByText('0 / 1')).toBeTruthy();
  });

  it('renders loading, skipped, failed, and zero-hit edge states', () => {
    const { rerender } = render(
      <AnswerLens
        answerText={null}
        brandPassage={null}
        brand={{ name: 'GeoMix', aliases: [] }}
        competitors={[]}
        citations={[]}
        status="RUNNING"
        error={null}
        onCitationClick={vi.fn()}
      />,
    );
    expect(screen.getByText('AI 回答采集中…')).toBeTruthy();
    expect(screen.getByText('0 / 0')).toBeTruthy();
    expect((screen.getByLabelText('上一个命中') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('下一个命中') as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <AnswerLens
        answerText={null}
        brandPassage={null}
        brand={{ name: 'GeoMix', aliases: [] }}
        competitors={[]}
        citations={[]}
        status="SKIPPED"
        error={null}
        onCitationClick={vi.fn()}
      />,
    );
    expect(screen.getByText('该观测已跳过')).toBeTruthy();

    rerender(
      <AnswerLens
        answerText={null}
        brandPassage={null}
        brand={{ name: 'GeoMix', aliases: [] }}
        competitors={[]}
        citations={[]}
        status="FAILED"
        error="上游超时"
        onCitationClick={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('上游超时');
  });

  it('caps total hit display at 99+ when more than 99 hits exist', () => {
    const many = Array.from({ length: 105 }, () => 'GeoMix').join(' ');
    render(
      <AnswerLens
        answerText={many}
        brandPassage={null}
        brand={{ name: 'GeoMix', aliases: [] }}
        competitors={[]}
        citations={[]}
        status="SUCCESS"
        error={null}
        onCitationClick={vi.fn()}
      />,
    );
    expect(screen.getByText('0 / 99+')).toBeTruthy();
  });
});
