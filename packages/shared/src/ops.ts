import { z } from 'zod';
import { formatLlmTenantDisplayName } from './account-costs-ux';
import { FAKE_TOKEN_COST_MICRO, LLM_SCENES, type LlmScene } from './adapters';
import { toCsv } from './crud';
import { toShanghaiDateKey } from './dashboard';

/**
 * 部署与运维（Issue #24）共享常量、LLM 成本费率解析与按日聚合纯函数。
 *
 * 设计要点：
 * - 时间口径统一采用 Asia/Shanghai（UTC+8）自然日，与首页和账本口径一致；
 * - 默认费率采用占位微元（1 微元 = 10^-6 元），运维可通过 LLM_COST_RATES_JSON 按模型覆盖输入/输出千 token 微元单价；
 * - LLM 成本统计与租户点数钱包解耦，不改变默认 SHADOW 计费策略。
 */

export const ADMIN_LLM_COSTS_ROUTE = '/admin/llm-costs' as const;
export const LLM_COST_AUDIT_ACTION = 'llm_cost' as const;
export const LLM_COST_DEFAULT_DAYS = 14 as const;
export const LLM_COST_MAX_DAYS = 90 as const;
export const LLM_COST_DAY_OPTIONS = [7, 14, 30] as const;

export const LLM_SCENE_LABELS: Record<string, string> = {
  distill: '主词蒸馏',
  title: '标题创作',
  body: '文章正文',
  rewrite: '爆文复刻',
  image_prompt: '生图提示词优化',
  visibility_judge: '可见度裁判',
};

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LlmModelRate = {
  /** 每 1000 输入 token 的微元单价（1 元 = 1,000,000 微元） */
  inputMicroPer1k: number;
  /** 每 1000 输出 token 的微元单价（1 元 = 1,000,000 微元） */
  outputMicroPer1k: number;
};

export type LlmCostRateMap = Record<string, LlmModelRate>;

const modelRateSchema = z.object({
  inputMicroPer1k: z.number().nonnegative().max(1_000_000_000),
  outputMicroPer1k: z.number().nonnegative().max(1_000_000_000),
});

export function parseLlmCostRates(raw: string | undefined): LlmCostRateMap {
  if (!raw || raw.trim() === '' || raw.trim() === '{}') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('LLM_COST_RATES_JSON 必须是合法 JSON 对象');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM_COST_RATES_JSON 必须是合法 JSON 对象');
  }
  const out: LlmCostRateMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const k = key.trim();
    if (!k) continue;
    const rate = modelRateSchema.parse(value);
    out[k] = {
      inputMicroPer1k: rate.inputMicroPer1k,
      outputMicroPer1k: rate.outputMicroPer1k,
    };
  }
  return out;
}

export function estimateLlmCallCostMicro(input: {
  provider: string;
  model: string;
  fake: boolean;
  tokensIn: number;
  tokensOut: number;
  rates?: LlmCostRateMap;
}): { costMicro: number; costBasis: 'configured' | 'placeholder' } {
  const tokensIn = Math.max(0, Math.floor(input.tokensIn));
  const tokensOut = Math.max(0, Math.floor(input.tokensOut));
  if (!input.fake && input.rates) {
    const matched =
      input.rates[`${input.provider}/${input.model}`] ??
      input.rates[input.model] ??
      input.rates[input.provider] ??
      input.rates['*'];
    if (matched) {
      const micro = Math.round(
        (tokensIn * matched.inputMicroPer1k + tokensOut * matched.outputMicroPer1k) / 1000,
      );
      return { costMicro: micro, costBasis: 'configured' };
    }
  }
  return {
    costMicro: (tokensIn + tokensOut) * FAKE_TOKEN_COST_MICRO,
    costBasis: 'placeholder',
  };
}

export function formatMicroToYuan(costMicro: number): string {
  const safe = Number.isFinite(costMicro) ? Math.max(0, costMicro) : 0;
  return (safe / 1_000_000).toFixed(4);
}

export type LlmCostQuery = {
  days: number;
  includeFake: boolean;
  tenantId?: string;
};

export function parseLlmCostQuery(raw: Record<string, unknown>): LlmCostQuery {
  const rawDays = firstString(raw.days);
  let days: number = LLM_COST_DEFAULT_DAYS;
  if (rawDays !== undefined && rawDays.trim() !== '') {
    if (!/^[0-9]{1,3}$/.test(rawDays.trim())) {
      throw new Error('统计天数不正确');
    }
    const n = Number(rawDays.trim());
    if (!Number.isInteger(n) || n < 1 || n > LLM_COST_MAX_DAYS) {
      throw new Error(`统计天数需在 1–${LLM_COST_MAX_DAYS} 之间`);
    }
    days = n;
  }

  const rawFake = firstString(raw.includeFake)?.trim().toLowerCase();
  const includeFake =
    rawFake === undefined || rawFake === ''
      ? true
      : rawFake === 'true' || rawFake === '1' || rawFake === 'yes';

  const rawTenant = firstString(raw.tenantId)?.trim();
  if (rawTenant && !/^[A-Za-z0-9_-]{1,64}$/.test(rawTenant)) {
    throw new Error('租户编号不正确');
  }

  return {
    days,
    includeFake,
    ...(rawTenant ? { tenantId: rawTenant } : {}),
  };
}

export function shanghaiDayWindowUtc(
  days: number,
  now: Date = new Date(),
): {
  keys: string[];
  startUtc: Date;
  endUtc: Date;
} {
  const clampedDays = Math.min(LLM_COST_MAX_DAYS, Math.max(1, Math.floor(days)));
  const shiftedNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const todayMidnightShanghaiAsUtcMs = Date.UTC(
    shiftedNow.getUTCFullYear(),
    shiftedNow.getUTCMonth(),
    shiftedNow.getUTCDate(),
    0,
    0,
    0,
    0,
  );
  const firstDayMidnightShanghaiAsUtcMs = todayMidnightShanghaiAsUtcMs - (clampedDays - 1) * DAY_MS;

  const keys: string[] = [];
  for (let i = 0; i < clampedDays; i += 1) {
    const cur = new Date(firstDayMidnightShanghaiAsUtcMs + i * DAY_MS);
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    keys.push(`${y}-${m}-${d}`);
  }

  return {
    keys,
    startUtc: new Date(firstDayMidnightShanghaiAsUtcMs - SHANGHAI_OFFSET_MS),
    endUtc: new Date(todayMidnightShanghaiAsUtcMs + DAY_MS - 1 - SHANGHAI_OFFSET_MS),
  };
}

export type LlmUsageEventInput = {
  tenantId: string | null;
  tenantName?: string | null;
  scene: string;
  provider: string;
  model: string;
  fake: boolean;
  tokensIn: number;
  tokensOut: number;
  costMicro?: number;
  costBasis?: 'configured' | 'placeholder';
  createdAt: Date | string;
};

export type LlmDailyBucket = {
  date: string;
  calls: number;
  realCalls: number;
  fakeCalls: number;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  costMicro: number;
  costYuan: string;
};

export type LlmSceneBreakdown = {
  scene: string;
  label: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  costMicro: number;
  costYuan: string;
};

export type LlmModelBreakdown = {
  provider: string;
  model: string;
  fake: boolean;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  costMicro: number;
  costYuan: string;
};

export type LlmTenantBreakdown = {
  tenantId: string;
  tenantName: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  costMicro: number;
  costYuan: string;
};

export type LlmDailyCostReport = {
  days: number;
  includeFake: boolean;
  rateConfigured: boolean;
  windowStartDate: string;
  windowEndDate: string;
  totals: {
    calls: number;
    realCalls: number;
    fakeCalls: number;
    tokensIn: number;
    tokensOut: number;
    totalTokens: number;
    costMicro: number;
    costYuan: string;
  };
  daily: LlmDailyBucket[];
  byScene: LlmSceneBreakdown[];
  byModel: LlmModelBreakdown[];
  byTenant: LlmTenantBreakdown[];
};

export function sceneDisplayLabel(scene: string): string {
  if (LLM_SCENE_LABELS[scene]) return LLM_SCENE_LABELS[scene]!;
  if ((LLM_SCENES as readonly string[]).includes(scene as LlmScene)) return scene;
  return scene || '其他';
}

export function aggregateLlmDailyReport(
  events: ReadonlyArray<LlmUsageEventInput>,
  options: {
    days: number;
    includeFake: boolean;
    rates?: LlmCostRateMap;
    now?: Date;
  },
): LlmDailyCostReport {
  const { keys } = shanghaiDayWindowUtc(options.days, options.now ?? new Date());
  const rates = options.rates ?? {};
  const rateConfigured = Object.keys(rates).length > 0;

  const dailyMap = new Map<string, Omit<LlmDailyBucket, 'costYuan'>>();
  for (const key of keys) {
    dailyMap.set(key, {
      date: key,
      calls: 0,
      realCalls: 0,
      fakeCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      totalTokens: 0,
      costMicro: 0,
    });
  }

  const sceneMap = new Map<string, Omit<LlmSceneBreakdown, 'costYuan'>>();
  const modelMap = new Map<string, Omit<LlmModelBreakdown, 'costYuan'>>();
  const tenantMap = new Map<string, Omit<LlmTenantBreakdown, 'costYuan'>>();

  let totalCalls = 0;
  let totalReal = 0;
  let totalFake = 0;
  let totalIn = 0;
  let totalOut = 0;
  let totalCostMicro = 0;

  for (const ev of events) {
    if (!options.includeFake && ev.fake) continue;
    const dateKey = toShanghaiDateKey(ev.createdAt);
    const dayBucket = dailyMap.get(dateKey);
    if (!dayBucket) continue;

    const tokensIn = Math.max(0, Math.floor(ev.tokensIn));
    const tokensOut = Math.max(0, Math.floor(ev.tokensOut));
    const rowTokens = tokensIn + tokensOut;

    const computedCost =
      rateConfigured || ev.costMicro === undefined
        ? estimateLlmCallCostMicro({
            provider: ev.provider,
            model: ev.model,
            fake: ev.fake,
            tokensIn,
            tokensOut,
            rates,
          }).costMicro
        : Math.max(0, Math.floor(ev.costMicro));

    dayBucket.calls += 1;
    if (ev.fake) dayBucket.fakeCalls += 1;
    else dayBucket.realCalls += 1;
    dayBucket.tokensIn += tokensIn;
    dayBucket.tokensOut += tokensOut;
    dayBucket.totalTokens += rowTokens;
    dayBucket.costMicro += computedCost;

    totalCalls += 1;
    if (ev.fake) totalFake += 1;
    else totalReal += 1;
    totalIn += tokensIn;
    totalOut += tokensOut;
    totalCostMicro += computedCost;

    const sceneKey = ev.scene || 'other';
    const curScene = sceneMap.get(sceneKey) ?? {
      scene: sceneKey,
      label: sceneDisplayLabel(sceneKey),
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      totalTokens: 0,
      costMicro: 0,
    };
    curScene.calls += 1;
    curScene.tokensIn += tokensIn;
    curScene.tokensOut += tokensOut;
    curScene.totalTokens += rowTokens;
    curScene.costMicro += computedCost;
    sceneMap.set(sceneKey, curScene);

    const modelKey = `${ev.provider}::${ev.model}::${ev.fake ? '1' : '0'}`;
    const curModel = modelMap.get(modelKey) ?? {
      provider: ev.provider || 'unknown',
      model: ev.model || 'unknown',
      fake: ev.fake,
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      totalTokens: 0,
      costMicro: 0,
    };
    curModel.calls += 1;
    curModel.tokensIn += tokensIn;
    curModel.tokensOut += tokensOut;
    curModel.totalTokens += rowTokens;
    curModel.costMicro += computedCost;
    modelMap.set(modelKey, curModel);

    const tenantKey = ev.tenantId ?? 'system';
    const curTenant = tenantMap.get(tenantKey) ?? {
      tenantId: tenantKey,
      tenantName: formatLlmTenantDisplayName(ev.tenantName, tenantKey),
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      totalTokens: 0,
      costMicro: 0,
    };
    curTenant.calls += 1;
    curTenant.tokensIn += tokensIn;
    curTenant.tokensOut += tokensOut;
    curTenant.totalTokens += rowTokens;
    curTenant.costMicro += computedCost;
    tenantMap.set(tenantKey, curTenant);
  }

  const daily: LlmDailyBucket[] = keys
    .slice()
    .reverse()
    .map((key) => {
      const b = dailyMap.get(key)!;
      return { ...b, costYuan: formatMicroToYuan(b.costMicro) };
    });

  const byScene: LlmSceneBreakdown[] = [...sceneMap.values()]
    .sort((a, b) => b.costMicro - a.costMicro || b.totalTokens - a.totalTokens)
    .map((b) => ({ ...b, costYuan: formatMicroToYuan(b.costMicro) }));

  const byModel: LlmModelBreakdown[] = [...modelMap.values()]
    .sort((a, b) => b.costMicro - a.costMicro || b.totalTokens - a.totalTokens)
    .map((b) => ({ ...b, costYuan: formatMicroToYuan(b.costMicro) }));

  const byTenant: LlmTenantBreakdown[] = [...tenantMap.values()]
    .sort((a, b) => b.costMicro - a.costMicro || b.totalTokens - a.totalTokens)
    .map((b) => ({ ...b, costYuan: formatMicroToYuan(b.costMicro) }));

  return {
    days: keys.length,
    includeFake: options.includeFake,
    rateConfigured,
    windowStartDate: keys[0] ?? '',
    windowEndDate: keys[keys.length - 1] ?? '',
    totals: {
      calls: totalCalls,
      realCalls: totalReal,
      fakeCalls: totalFake,
      tokensIn: totalIn,
      tokensOut: totalOut,
      totalTokens: totalIn + totalOut,
      costMicro: totalCostMicro,
      costYuan: formatMicroToYuan(totalCostMicro),
    },
    daily,
    byScene,
    byModel,
    byTenant,
  };
}

export function llmDailyReportToCsv(report: LlmDailyCostReport): string {
  const headers = [
    '日期',
    '总调用次数',
    '真实模型调用',
    '模拟调用',
    '输入Token',
    '输出Token',
    '总Token',
    '成本（微元）',
    '预估成本（元）',
  ];
  const rows = report.daily.map((d) => [
    d.date,
    String(d.calls),
    String(d.realCalls),
    String(d.fakeCalls),
    String(d.tokensIn),
    String(d.tokensOut),
    String(d.totalTokens),
    String(d.costMicro),
    d.costYuan,
  ]);
  return toCsv(headers, rows);
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}
