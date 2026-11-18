'use client';

import {
  wholeWordPattern,
  type ItemStatusName,
  type VisibilityCitationRecord,
} from '@geomix/shared';
import { Tooltip } from 'antd';
import type { JSX } from 'react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SignalError } from './primitives';

export interface AnswerLensSubject {
  name: string;
  aliases: string[];
}

export type LensSegment =
  | { kind: 'text'; text: string; start: number; end: number }
  | { kind: 'brand'; text: string; start: number; end: number; label: string }
  | { kind: 'competitor'; text: string; start: number; end: number; label: string }
  | {
      kind: 'citation';
      text: string;
      start: number;
      end: number;
      position: number;
      citation: VisibilityCitationRecord;
    };

export interface AnswerLensHandle {
  prevHit: () => void;
  nextHit: () => void;
}

export interface AnswerLensProps {
  answerText: string | null;
  brandPassage: string | null;
  brand: AnswerLensSubject;
  competitors: AnswerLensSubject[];
  citations: VisibilityCitationRecord[];
  status: ItemStatusName;
  error: string | null;
  onCitationClick: (citationId: string) => void;
}

type RawHit = {
  start: number;
  end: number;
  kind: 'brand' | 'competitor';
  label: string;
};

type TokenSpan =
  | { kind: 'brand' | 'competitor'; start: number; end: number; label: string }
  | {
      kind: 'citation';
      start: number;
      end: number;
      position: number;
      citation: VisibilityCitationRecord;
    };

function collectSubjectHits(
  text: string,
  subject: AnswerLensSubject,
  kind: 'brand' | 'competitor',
): RawHit[] {
  const hits: RawHit[] = [];
  const seenTerms = new Set<string>();
  const terms = [subject.name, ...subject.aliases];
  for (const rawTerm of terms) {
    const cleaned = rawTerm.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seenTerms.has(key)) continue;
    seenTerms.add(key);

    const pattern = wholeWordPattern(cleaned);
    for (const match of text.matchAll(pattern)) {
      if (typeof match.index !== 'number' || match[0].length === 0) continue;
      hits.push({
        start: match.index,
        end: match.index + match[0].length,
        kind,
        label: subject.name,
      });
    }
  }
  return hits;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

export function buildLensSegments(
  text: string,
  brand: AnswerLensSubject,
  competitors: AnswerLensSubject[],
  citations: VisibilityCitationRecord[],
): LensSegment[] {
  if (!text) return [];

  const brandRaw = collectSubjectHits(text, brand, 'brand').sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
  );
  const keptBrands: RawHit[] = [];
  for (const hit of brandRaw) {
    if (!keptBrands.some((kept) => overlaps(kept, hit))) {
      keptBrands.push(hit);
    }
  }

  const compRaw = competitors
    .flatMap((comp) => collectSubjectHits(text, comp, 'competitor'))
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const keptComps: RawHit[] = [];
  for (const hit of compRaw) {
    if (
      !keptBrands.some((kept) => overlaps(kept, hit)) &&
      !keptComps.some((kept) => overlaps(kept, hit))
    ) {
      keptComps.push(hit);
    }
  }

  const entityTokens: TokenSpan[] = [...keptBrands, ...keptComps].map((h) => ({
    kind: h.kind,
    start: h.start,
    end: h.end,
    label: h.label,
  }));

  const citationTokens: TokenSpan[] = [];
  const citeRegex = /\[(\d{1,2})\]|【(\d{1,2})】/g;
  for (const match of text.matchAll(citeRegex)) {
    if (typeof match.index !== 'number') continue;
    const posStr = match[1] ?? match[2];
    if (!posStr) continue;
    const pos = Number.parseInt(posStr, 10);
    const citation = citations.find((c) => c.position === pos);
    if (!citation) continue;
    const span = { start: match.index, end: match.index + match[0].length };
    if (entityTokens.some((tok) => overlaps(tok, span))) continue;
    citationTokens.push({
      kind: 'citation',
      start: span.start,
      end: span.end,
      position: pos,
      citation,
    });
  }

  const allTokens = [...entityTokens, ...citationTokens].sort((a, b) => a.start - b.start);
  const segments: LensSegment[] = [];
  let cursor = 0;

  for (const tok of allTokens) {
    if (tok.start < cursor) continue;
    if (tok.start > cursor) {
      segments.push({
        kind: 'text',
        text: text.slice(cursor, tok.start),
        start: cursor,
        end: tok.start,
      });
    }
    const slice = text.slice(tok.start, tok.end);
    if (tok.kind === 'citation') {
      segments.push({
        kind: 'citation',
        text: slice,
        start: tok.start,
        end: tok.end,
        position: tok.position,
        citation: tok.citation,
      });
    } else {
      segments.push({
        kind: tok.kind,
        text: slice,
        start: tok.start,
        end: tok.end,
        label: tok.label,
      });
    }
    cursor = tok.end;
  }

  if (cursor < text.length) {
    segments.push({
      kind: 'text',
      text: text.slice(cursor),
      start: cursor,
      end: text.length,
    });
  }

  return segments;
}

type ParagraphChunk = {
  start: number;
  end: number;
  text: string;
  segments: LensSegment[];
};

function splitIntoParagraphs(text: string, segments: LensSegment[]): ParagraphChunk[] {
  const ranges: Array<{ start: number; end: number }> = [];
  const sepRegex = /\n{2,}/g;
  let lastEnd = 0;
  for (const match of text.matchAll(sepRegex)) {
    if (typeof match.index !== 'number') continue;
    if (match.index > lastEnd) {
      ranges.push({ start: lastEnd, end: match.index });
    }
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd < text.length) {
    ranges.push({ start: lastEnd, end: text.length });
  }
  if (ranges.length === 0 && text.length > 0) {
    ranges.push({ start: 0, end: text.length });
  }

  return ranges.map((range) => {
    const pSegs: LensSegment[] = [];
    for (const seg of segments) {
      if (seg.end <= range.start || seg.start >= range.end) continue;
      if (seg.kind === 'text') {
        const s = Math.max(seg.start, range.start);
        const e = Math.min(seg.end, range.end);
        if (e > s) {
          pSegs.push({
            kind: 'text',
            text: text.slice(s, e),
            start: s,
            end: e,
          });
        }
      } else {
        pSegs.push(seg);
      }
    }
    return {
      start: range.start,
      end: range.end,
      text: text.slice(range.start, range.end),
      segments: pSegs,
    };
  });
}

export const AnswerLens = forwardRef<AnswerLensHandle, AnswerLensProps>(function AnswerLens(
  { answerText, brandPassage, brand, competitors, citations, status, error, onCitationClick },
  ref,
): JSX.Element {
  const [showBrand, setShowBrand] = useState(true);
  const [showCompetitor, setShowCompetitor] = useState(true);
  const [showCitation, setShowCitation] = useState(true);
  const [activeHitIdx, setActiveHitIdx] = useState<number>(-1);

  const hitRefs = useRef<Map<number, HTMLElement>>(new Map());

  const segments = useMemo(() => {
    if (!answerText) return [];
    return buildLensSegments(answerText, brand, competitors, citations);
  }, [answerText, brand, competitors, citations]);

  const brandCount = useMemo(() => segments.filter((s) => s.kind === 'brand').length, [segments]);
  const competitorCount = useMemo(
    () => segments.filter((s) => s.kind === 'competitor').length,
    [segments],
  );
  const citationCount = useMemo(
    () => segments.filter((s) => s.kind === 'citation').length,
    [segments],
  );

  const activeHits = useMemo(() => {
    return segments.filter(
      (s): s is Extract<LensSegment, { kind: 'brand' | 'competitor' }> =>
        (s.kind === 'brand' && showBrand) || (s.kind === 'competitor' && showCompetitor),
    );
  }, [segments, showBrand, showCompetitor]);

  const hitIndexByStart = useMemo(() => {
    const map = new Map<number, number>();
    activeHits.forEach((h, idx) => map.set(h.start, idx));
    return map;
  }, [activeHits]);

  useEffect(() => {
    setActiveHitIdx(-1);
  }, [answerText, showBrand, showCompetitor]);

  const scrollHitIntoView = useCallback((idx: number) => {
    const el = hitRefs.current.get(idx);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, []);

  const prevHit = useCallback(() => {
    if (activeHits.length === 0) return;
    setActiveHitIdx((curr) => {
      const next = curr <= 0 ? activeHits.length - 1 : curr - 1;
      scrollHitIntoView(next);
      return next;
    });
  }, [activeHits.length, scrollHitIntoView]);

  const nextHit = useCallback(() => {
    if (activeHits.length === 0) return;
    setActiveHitIdx((curr) => {
      const next = curr < 0 || curr >= activeHits.length - 1 ? 0 : curr + 1;
      scrollHitIntoView(next);
      return next;
    });
  }, [activeHits.length, scrollHitIntoView]);

  const jumpToHit = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= activeHits.length) return;
      setActiveHitIdx(idx);
      scrollHitIntoView(idx);
    },
    [activeHits.length, scrollHitIntoView],
  );

  useImperativeHandle(
    ref,
    () => ({
      prevHit,
      nextHit,
    }),
    [prevHit, nextHit],
  );

  const paragraphs = useMemo(() => {
    if (!answerText) return [];
    return splitIntoParagraphs(answerText, segments);
  }, [answerText, segments]);

  const passagePrefix = brandPassage ? brandPassage.trim().slice(0, 24) : '';
  const totalHits = activeHits.length;
  const totalDisplay = totalHits > 99 ? '99+' : String(totalHits);
  const currentDisplay = totalHits === 0 ? '0' : activeHitIdx >= 0 ? String(activeHitIdx + 1) : '0';

  const renderBody = () => {
    if (status === 'FAILED') {
      return (
        <div className="gm-lens-body">
          <SignalError message={error ?? '采集失败'} />
        </div>
      );
    }
    if ((status === 'PENDING' || status === 'RUNNING') && answerText === null) {
      return (
        <div className="gm-lens-body">
          <div className="gm-lens-status">
            <span className="gm-lens-spinner" aria-hidden="true" />
            <span>AI 回答采集中…</span>
          </div>
        </div>
      );
    }
    if (status === 'SKIPPED' && answerText === null) {
      return (
        <div className="gm-lens-body">
          <div className="gm-lens-status">该观测已跳过</div>
        </div>
      );
    }
    if (!answerText) {
      return (
        <div className="gm-lens-body">
          <div className="gm-lens-status">暂无原始回答</div>
        </div>
      );
    }

    hitRefs.current.clear();

    return (
      <div className="gm-lens-body">
        {paragraphs.map((para) => {
          const isEvidence = Boolean(passagePrefix && para.text.includes(passagePrefix));
          return (
            <p
              key={para.start}
              className={`gm-lens-para${isEvidence ? ' gm-lens-para-evidence' : ''}`}
            >
              {para.segments.map((seg) => {
                if (seg.kind === 'brand') {
                  if (!showBrand) {
                    return <span key={seg.start}>{seg.text}</span>;
                  }
                  const hitIdx = hitIndexByStart.get(seg.start) ?? -1;
                  const isCurrent = hitIdx >= 0 && hitIdx === activeHitIdx;
                  return (
                    <mark
                      key={seg.start}
                      ref={(el) => {
                        if (el && hitIdx >= 0) hitRefs.current.set(hitIdx, el);
                      }}
                      data-hit="brand"
                      className={isCurrent ? 'gm-lens-hit-active' : undefined}
                    >
                      {seg.text}
                    </mark>
                  );
                }

                if (seg.kind === 'competitor') {
                  if (!showCompetitor) {
                    return <span key={seg.start}>{seg.text}</span>;
                  }
                  const hitIdx = hitIndexByStart.get(seg.start) ?? -1;
                  const isCurrent = hitIdx >= 0 && hitIdx === activeHitIdx;
                  return (
                    <mark
                      key={seg.start}
                      ref={(el) => {
                        if (el && hitIdx >= 0) hitRefs.current.set(hitIdx, el);
                      }}
                      data-hit="competitor"
                      className={isCurrent ? 'gm-lens-hit-active' : undefined}
                    >
                      {seg.text}
                    </mark>
                  );
                }

                if (seg.kind === 'citation') {
                  if (!showCitation) {
                    return <span key={seg.start}>{seg.text}</span>;
                  }
                  const tip = `${seg.citation.title ?? seg.citation.domain} · ${seg.citation.domain}`;
                  return (
                    <Tooltip key={seg.start} title={tip}>
                      <button
                        type="button"
                        className="gm-lens-cite-chip gm-num"
                        onClick={() => onCitationClick(seg.citation.id)}
                      >
                        {seg.position}
                      </button>
                    </Tooltip>
                  );
                }

                return <span key={seg.start}>{seg.text}</span>;
              })}
            </p>
          );
        })}
      </div>
    );
  };

  return (
    <div className="gm-lens-root">
      <div className="gm-lens-toolbar">
        <button
          type="button"
          className={`gm-lens-chip gm-lens-chip-brand${showBrand ? '' : ' gm-lens-chip-off'}`}
          aria-pressed={showBrand}
          onClick={() => setShowBrand((v) => !v)}
        >
          <span>品牌</span>
          <span className="gm-num">{brandCount}</span>
        </button>
        <button
          type="button"
          className={`gm-lens-chip gm-lens-chip-comp${showCompetitor ? '' : ' gm-lens-chip-off'}`}
          aria-pressed={showCompetitor}
          onClick={() => setShowCompetitor((v) => !v)}
        >
          <span>竞品</span>
          <span className="gm-num">{competitorCount}</span>
        </button>
        <button
          type="button"
          className={`gm-lens-chip gm-lens-chip-cite${showCitation ? '' : ' gm-lens-chip-off'}`}
          aria-pressed={showCitation}
          onClick={() => setShowCitation((v) => !v)}
        >
          <span>引用</span>
          <span className="gm-num">{citationCount}</span>
        </button>

        <div className="gm-lens-nav">
          <span className="gm-lens-heat-label">提及热区</span>
          <Tooltip title="上一处提及（快捷键 [）">
            <span className="gm-lens-nav-btn-wrap">
              <button
                type="button"
                className="gm-lens-nav-btn"
                aria-label="上一个命中"
                disabled={totalHits === 0}
                onClick={prevHit}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path
                    d="M7.5 2.5L4 6L7.5 9.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </span>
          </Tooltip>
          <Tooltip title="下一处提及（快捷键 ]）">
            <span className="gm-lens-nav-btn-wrap">
              <button
                type="button"
                className="gm-lens-nav-btn"
                aria-label="下一个命中"
                disabled={totalHits === 0}
                onClick={nextHit}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path
                    d="M4.5 2.5L8 6L4.5 9.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </span>
          </Tooltip>
          <span className="gm-lens-nav-count gm-num">
            {currentDisplay} / {totalDisplay}
          </span>
        </div>
      </div>

      {renderBody()}

      <div className="gm-lens-heatmap" aria-hidden={totalHits === 0}>
        {answerText && totalHits > 0
          ? activeHits.map((hit, idx) => (
              <button
                key={`${hit.kind}-${hit.start}`}
                type="button"
                className="gm-lens-heat-tick"
                aria-label={`跳转到命中-${idx}`}
                style={{
                  top: `calc(${(hit.start / Math.max(1, answerText.length)) * 100}%)`,
                  background:
                    hit.kind === 'brand' ? 'var(--gm-sig-cited)' : 'var(--gm-sig-competitor)',
                }}
                onClick={() => jumpToHit(idx)}
              />
            ))
          : null}
      </div>
    </div>
  );
});
