import {
  VISIBILITY_ENGINES,
  VISIBILITY_ENGINE_LABELS,
  type CitationSourceKind,
  type VisibilityEngineKey,
  type VisibilityObservationRecord,
} from '@geomix/shared';

export type TraceEdgeTone = 'cited' | 'competitor' | 'absent';
export interface TraceGraph {
  prompts: Array<{ id: string; label: string; firstObservationId: string; isMore?: boolean }>;
  engines: Array<{ id: string; label: string }>;
  domains: Array<{
    id: string;
    label: string;
    sourceKind: CitationSourceKind;
    count: number;
    isMore?: boolean;
  }>;
  edgesPE: Array<{
    id: string;
    promptId: string;
    engine: string;
    count: number;
    tone: TraceEdgeTone;
    observationIds: string[];
  }>;
  edgesED: Array<{
    id: string;
    engine: string;
    domainId: string;
    count: number;
    sourceKind: CitationSourceKind;
    observationIds: string[];
  }>;
}

const ENGINE_ORDER = new Map<string, number>(VISIBILITY_ENGINES.map((e, i) => [e.key, i]));
const obsTone = (o: VisibilityObservationRecord): TraceEdgeTone =>
  o.brandMentioned ? 'cited' : o.competitorHits.some((c) => c.mentioned) ? 'competitor' : 'absent';
const mergeTone = (a: TraceEdgeTone, b: TraceEdgeTone): TraceEdgeTone =>
  a === 'cited' || b === 'cited'
    ? 'cited'
    : a === 'competitor' || b === 'competitor'
      ? 'competitor'
      : 'absent';

export function buildTraceGraph(observations: readonly VisibilityObservationRecord[]): TraceGraph {
  const ok = observations.filter((o) => o.status === 'SUCCESS');
  const pOrder: Array<{ text: string; firstId: string }> = [];
  const pIdx = new Map<string, number>();
  const engSet = new Set<string>();
  const dCount = new Map<string, number>();
  const dKinds = new Map<string, Map<CitationSourceKind, number>>();

  for (const o of ok) {
    if (!pIdx.has(o.promptText)) {
      pIdx.set(o.promptText, pOrder.length);
      pOrder.push({ text: o.promptText, firstId: o.id });
    }
    engSet.add(o.engine);
    for (const c of o.citations) {
      dCount.set(c.domain, (dCount.get(c.domain) ?? 0) + 1);
      const km = dKinds.get(c.domain) ?? new Map<CitationSourceKind, number>();
      km.set(c.sourceKind, (km.get(c.sourceKind) ?? 0) + 1);
      dKinds.set(c.domain, km);
    }
  }

  const prompts: TraceGraph['prompts'] = pOrder
    .slice(0, 12)
    .map((p, i) => ({ id: `prompt-${i}`, label: p.text, firstObservationId: p.firstId }));
  if (pOrder.length > 12) {
    prompts.push({
      id: '__more_prompts',
      label: `+${pOrder.length - 12} 个 Prompt`,
      firstObservationId: pOrder[12]!.firstId,
      isMore: true,
    });
  }
  const pid = (t: string) => ((pIdx.get(t) ?? 0) < 12 ? `prompt-${pIdx.get(t)}` : '__more_prompts');

  const engines = [...engSet]
    .sort((a, b) => (ENGINE_ORDER.get(a) ?? 999) - (ENGINE_ORDER.get(b) ?? 999))
    .map((k) => ({ id: k, label: VISIBILITY_ENGINE_LABELS[k as VisibilityEngineKey] ?? k }));

  const sortedD = [...dCount.entries()].sort((a, b) => b[1] - a[1]);
  const topSet = new Set(sortedD.slice(0, 10).map(([d]) => d));
  const domains: TraceGraph['domains'] = sortedD.slice(0, 10).map(([domain, count]) => {
    let sourceKind: CitationSourceKind = 'OTHER';
    let best = -1;
    for (const [k, v] of dKinds.get(domain) ?? []) {
      if (v > best) [sourceKind, best] = [k, v];
    }
    return { id: domain, label: domain, sourceKind, count };
  });
  if (sortedD.length > 10) {
    domains.push({
      id: '__more_domains',
      label: `其他 ${sortedD.length - 10} 个域名`,
      sourceKind: 'OTHER',
      count: sortedD.slice(10).reduce((s, [, c]) => s + c, 0),
      isMore: true,
    });
  }

  const kindMap = new Map(domains.map((d) => [d.id, d.sourceKind]));
  const peMap = new Map<string, TraceGraph['edgesPE'][number]>();
  const edMap = new Map<string, TraceGraph['edgesED'][number]>();
  for (const o of ok) {
    const promptId = pid(o.promptText);
    const peKey = `${promptId}::${o.engine}`;
    const pe = peMap.get(peKey);
    if (pe) {
      pe.count += 1;
      pe.tone = mergeTone(pe.tone, obsTone(o));
      if (!pe.observationIds.includes(o.id)) pe.observationIds.push(o.id);
    } else {
      peMap.set(peKey, {
        id: peKey,
        promptId,
        engine: o.engine,
        count: 1,
        tone: obsTone(o),
        observationIds: [o.id],
      });
    }
    for (const c of o.citations) {
      const domainId = topSet.has(c.domain) ? c.domain : '__more_domains';
      const edKey = `${o.engine}::${domainId}`;
      const ed = edMap.get(edKey);
      if (ed) {
        ed.count += 1;
        if (!ed.observationIds.includes(o.id)) ed.observationIds.push(o.id);
      } else {
        edMap.set(edKey, {
          id: edKey,
          engine: o.engine,
          domainId,
          count: 1,
          sourceKind: kindMap.get(domainId) ?? 'OTHER',
          observationIds: [o.id],
        });
      }
    }
  }
  return { prompts, engines, domains, edgesPE: [...peMap.values()], edgesED: [...edMap.values()] };
}
