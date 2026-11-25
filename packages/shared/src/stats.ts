import { z } from 'zod';

/**
 * GeoMix v2.2 统计置信与归因纯函数库（Issue #367 / #369）：
 * - Wilson 95% 置信区间（小样本防过拟合，严格钳位 [0, 1]）
 * - 置信等级分级（INSUFFICIENT / LOW / MEDIUM / HIGH）
 * - 双比例显著性 z 检验（无外部依赖，纯数值 erfc 近似）
 * - Difference-in-Differences（双重差分）对照归因净增益
 */

export const CONFIDENCE_LEVELS = ['INSUFFICIENT', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export type WilsonInterval = {
  hits: number;
  trials: number;
  rate: number;
  lower: number;
  upper: number;
  halfWidth: number;
  z: number;
  confidenceLevel: ConfidenceLevel;
};

export const wilsonIntervalSchema = z.object({
  hits: z.number().int().min(0),
  trials: z.number().int().min(0),
  rate: z.number().min(0).max(1),
  lower: z.number().min(0).max(1),
  upper: z.number().min(0).max(1),
  halfWidth: z.number().min(0).max(1),
  z: z.number().positive(),
  confidenceLevel: z.enum(CONFIDENCE_LEVELS),
});

export type TwoProportionSignificanceInput = {
  baselineHits: number;
  baselineTrials: number;
  currentHits: number;
  currentTrials: number;
  alpha?: number;
};

export const TWO_PROPORTION_DIRECTIONS = ['UP', 'DOWN', 'FLAT', 'INSUFFICIENT'] as const;
export type TwoProportionDirection = (typeof TWO_PROPORTION_DIRECTIONS)[number];

export type TwoProportionSignificanceResult = {
  baselineRate: number;
  currentRate: number;
  delta: number;
  zScore: number;
  pValue: number;
  alpha: number;
  significant: boolean;
  direction: TwoProportionDirection;
};

export type DifferenceInDifferencesInput = {
  treatmentBaseline: number;
  treatmentCurrent: number;
  controlBaseline: number;
  controlCurrent: number;
};

export const DID_DIRECTIONS = ['POSITIVE', 'NEGATIVE', 'NEUTRAL'] as const;
export type DidDirection = (typeof DID_DIRECTIONS)[number];

export type DifferenceInDifferencesResult = {
  treatmentDelta: number;
  controlDelta: number;
  netLift: number;
  direction: DidDirection;
};

export const differenceInDifferencesSchema = z.object({
  treatmentDelta: z.number(),
  controlDelta: z.number(),
  netLift: z.number(),
  direction: z.enum(DID_DIRECTIONS),
});

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function sanitizeCount(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}

/**
 * 互补误差函数 erfc(x)（Abramowitz & Stegun 7.1.26，最大误差 1.5e-7，零外部依赖）。
 */
function erfcApprox(x: number): number {
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const res = poly * Math.exp(-absX * absX);
  return x >= 0 ? res : 2 - res;
}

export function classifyConfidenceLevel(trials: number, halfWidth: number): ConfidenceLevel {
  const n = sanitizeCount(trials);
  if (n <= 0) return 'INSUFFICIENT';
  if (n < 5) return 'LOW';
  if (n >= 15 && Number.isFinite(halfWidth) && halfWidth <= 0.2) return 'HIGH';
  return 'MEDIUM';
}

/**
 * 计算 Wilson 置信区间（默认 95%，z = 1.96）。
 * 对 0/0、0/1、1/1、负数或超界输入零异常、严格钳位 [0, 1]。
 */
export function computeWilsonInterval(hits: number, trials: number, z = 1.96): WilsonInterval {
  const candidateZ = Number.isFinite(z) && z > 0 ? round4(Math.min(z, 100)) : 1.96;
  const safeZ = candidateZ > 0 ? candidateZ : 1.96;
  const n = sanitizeCount(trials);
  if (n === 0) {
    return {
      hits: 0,
      trials: 0,
      rate: 0,
      lower: 0,
      upper: 0,
      halfWidth: 0,
      z: safeZ,
      confidenceLevel: 'INSUFFICIENT',
    };
  }

  const k = Math.min(n, sanitizeCount(hits));
  const p = k / n;
  const z2 = safeZ * safeZ;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (safeZ * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;

  const rate = round4(clamp01(p));
  const rawLower = round4(clamp01(center - margin));
  const rawUpper = round4(clamp01(center + margin));
  const finalLower = Math.min(rawLower, rate);
  const finalUpper = Math.max(rawUpper, rate);
  const halfWidth = round4(Math.max(0, (finalUpper - finalLower) / 2));

  return {
    hits: k,
    trials: n,
    rate,
    lower: finalLower,
    upper: finalUpper,
    halfWidth,
    z: safeZ,
    confidenceLevel: classifyConfidenceLevel(n, halfWidth),
  };
}

/**
 * 双比例合并方差 z 检验（Two-Proportion Z-Test，双尾 p 值）。
 */
export function computeTwoProportionSignificance(
  input: TwoProportionSignificanceInput,
): TwoProportionSignificanceResult {
  const alpha =
    typeof input.alpha === 'number' &&
    Number.isFinite(input.alpha) &&
    input.alpha > 0 &&
    input.alpha < 1
      ? input.alpha
      : 0.05;
  const n1 = sanitizeCount(input.baselineTrials);
  const n2 = sanitizeCount(input.currentTrials);
  const k1 = Math.min(n1, sanitizeCount(input.baselineHits));
  const k2 = Math.min(n2, sanitizeCount(input.currentHits));

  if (n1 === 0 || n2 === 0) {
    const baselineRate = n1 > 0 ? round4(clamp01(k1 / n1)) : 0;
    const currentRate = n2 > 0 ? round4(clamp01(k2 / n2)) : 0;
    return {
      baselineRate,
      currentRate,
      delta: round4(currentRate - baselineRate),
      zScore: 0,
      pValue: 1,
      alpha,
      significant: false,
      direction: 'INSUFFICIENT',
    };
  }

  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const pooled = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const baselineRate = round4(clamp01(p1));
  const currentRate = round4(clamp01(p2));
  const delta = round4(p2 - p1);

  if (!Number.isFinite(se) || se <= 0) {
    return {
      baselineRate,
      currentRate,
      delta,
      zScore: 0,
      pValue: 1,
      alpha,
      significant: false,
      direction: 'FLAT',
    };
  }

  const rawDiff = p2 - p1;
  const rawZ = rawDiff / se;
  const pValue = round4(clamp01(erfcApprox(Math.abs(rawZ) / Math.SQRT2)));
  const significant = pValue < alpha;
  const direction: TwoProportionDirection =
    Math.abs(rawDiff) < 1e-12 ? 'FLAT' : rawDiff > 0 ? 'UP' : 'DOWN';

  return {
    baselineRate,
    currentRate,
    delta,
    zScore: round4(rawZ),
    pValue,
    alpha,
    significant,
    direction,
  };
}

/**
 * 双重差分（Difference-in-Differences）净增益计算：
 * netLift = (treatmentCurrent - treatmentBaseline) - (controlCurrent - controlBaseline)
 */
export function computeDifferenceInDifferences(
  input: DifferenceInDifferencesInput,
): DifferenceInDifferencesResult {
  const tBase = clamp01(input.treatmentBaseline);
  const tCurr = clamp01(input.treatmentCurrent);
  const cBase = clamp01(input.controlBaseline);
  const cCurr = clamp01(input.controlCurrent);

  const treatmentDelta = round4(tCurr - tBase);
  const controlDelta = round4(cCurr - cBase);
  const netLift = round4(treatmentDelta - controlDelta);
  const direction: DidDirection =
    netLift > 1e-6 ? 'POSITIVE' : netLift < -1e-6 ? 'NEGATIVE' : 'NEUTRAL';

  return {
    treatmentDelta,
    controlDelta,
    netLift,
    direction,
  };
}
