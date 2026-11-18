// @vitest-environment jsdom

import type { VisibilityCitationRecord, VisibilityObservationRecord } from '@geomix/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTraceGraph, CitationTrace } from './citation-trace';

afterEach(() => {
  cleanup();
});

function makeCitation(
  domain: string,
  sourceKind: VisibilityCitationRecord['sourceKind'] = 'AUTHORITY',
  id = `cite-${domain}`,
): VisibilityCitationRecord {
  return {
    id,
    url: `https://${domain}/doc`,
    domain,
    title: domain,
    snippet: null,
    sourceKind,
    position: 1,
    createdAt: '2026-11-18T00:00:00Z',
  };
}

function makeObs(
  overrides: Partial<VisibilityObservationRecord> & { id: string },
): VisibilityObservationRecord {
  return {
    runId: 'run-1',
    profileId: 'prof-1',
    questionId: null,
    promptText: 'GeoMix 如何做 AI 可见度监测？',
    engine: 'deepseek',
    status: 'SUCCESS',
    collectorKind: 'API',
    answerText: '示例回答',
    brandMentioned: false,
    brandPosition: null,
    brandSentiment: null,
    brandPassage: null,
    competitorHits: [],
    fanOutQueries: [],
    judgeModel: null,
    tokensIn: null,
    tokensOut: null,
    error: null,
    checkedAt: '2026-11-18T00:00:00Z',
    createdAt: '2026-11-18T00:00:00Z',
    citations: [],
    ...overrides,
  };
}

describe('buildTraceGraph', () => {
  it('builds graph for 3 observations with 2 prompts, 1 engine, and cited/absent tones', () => {
    const obs = [
      makeObs({ id: 'o1', promptText: 'Prompt A', engine: 'deepseek', brandMentioned: true }),
      makeObs({ id: 'o2', promptText: 'Prompt A', engine: 'deepseek', brandMentioned: false }),
      makeObs({ id: 'o3', promptText: 'Prompt B', engine: 'deepseek', brandMentioned: false }),
    ];
    const graph = buildTraceGraph(obs);
    expect(graph.prompts).toHaveLength(2);
    expect(graph.engines).toHaveLength(1);
    expect(graph.edgesPE).toHaveLength(2);
    expect(graph.edgesPE[0]?.tone).toBe('cited');
    expect(graph.edgesPE[1]?.tone).toBe('absent');
  });

  it('caps prompts at 12 and adds __more_prompts for 15 distinct prompts', () => {
    const obs = Array.from({ length: 15 }, (_, i) =>
      makeObs({ id: `o-${i}`, promptText: `Prompt ${i + 1}`, engine: 'deepseek' }),
    );
    const graph = buildTraceGraph(obs);
    expect(graph.prompts).toHaveLength(13);
    expect(graph.prompts[12]?.id).toBe('__more_prompts');
    expect(graph.prompts[12]?.label).toBe('+3 个 Prompt');
  });

  it('caps domains at 10 and adds __more_domains for 12 domains', () => {
    const citations = Array.from({ length: 12 }, (_, i) =>
      makeCitation(`d${i}.example.com`, i === 0 ? 'OWNED' : 'OTHER', `c-${i}`),
    );
    const graph = buildTraceGraph([makeObs({ id: 'o1', citations })]);
    expect(graph.domains).toHaveLength(11);
    expect(graph.domains[10]?.id).toBe('__more_domains');
  });
});

describe('CitationTrace component', () => {
  it('calls onSelectObservation with first observation id when clicking prompt node', () => {
    const onSelectObservation = vi.fn();
    const obs = [
      makeObs({
        id: 'obs-first',
        promptText: '品牌对比评测',
        engine: 'deepseek',
        brandMentioned: true,
      }),
      makeObs({
        id: 'obs-second',
        promptText: '品牌对比评测',
        engine: 'kimi',
        brandMentioned: false,
      }),
    ];
    render(<CitationTrace observations={obs} onSelectObservation={onSelectObservation} />);
    const node = screen.getByRole('button', { name: '链路节点-品牌对比评测' });
    fireEvent.click(node);
    expect(onSelectObservation).toHaveBeenCalledWith('obs-first');
  });

  it('renders absent edge with stroke-dasharray 3 3 and no gm-draw animation', () => {
    const obs = [
      makeObs({ id: 'o1', promptText: '未提及问题', engine: 'deepseek', brandMentioned: false }),
    ];
    const { container } = render(
      <CitationTrace observations={obs} onSelectObservation={vi.fn()} />,
    );
    const path = container.querySelector('svg path') as SVGPathElement | null;
    expect(path).not.toBeNull();
    expect(path?.style.strokeDasharray).toBe('3 3');
    expect(path?.style.animation).toBe('');
  });

  it('renders empty state when no SUCCESS observations and no-citations text when citations empty', () => {
    const { rerender } = render(
      <CitationTrace
        observations={[makeObs({ id: 'o-fail', status: 'FAILED' })]}
        onSelectObservation={vi.fn()}
      />,
    );
    expect(screen.getByText('暂无可绘制的引用链路')).toBeTruthy();

    rerender(
      <CitationTrace
        observations={[makeObs({ id: 'o-ok', citations: [] })]}
        onSelectObservation={vi.fn()}
      />,
    );
    expect(screen.getByText('本批回答未附带信源链接')).toBeTruthy();
  });

  it('renders Chinese 监测问题 header and full engine names without 4-char truncation (#191)', () => {
    const obs = [
      makeObs({ id: 'o-ds', promptText: '便携屏对比', engine: 'deepseek', brandMentioned: true }),
      makeObs({
        id: 'o-gaio',
        promptText: '便携屏对比',
        engine: 'google_aio',
        brandMentioned: false,
      }),
    ];
    const { container } = render(
      <CitationTrace observations={obs} onSelectObservation={vi.fn()} />,
    );
    expect(screen.getByText('监测问题')).toBeTruthy();
    expect(screen.queryByText('PROMPT')).toBeNull();
    const svgTexts = [...container.querySelectorAll('svg text')].map((el) => el.textContent);
    expect(svgTexts).toContain('DeepSeek');
    expect(svgTexts).toContain('Google AI Overviews');
    const rects = container.querySelectorAll('svg rect');
    expect(rects.length).toBeGreaterThanOrEqual(2);
    expect(Number(rects[0]?.getAttribute('width'))).toBeGreaterThanOrEqual(120);
  });
});
