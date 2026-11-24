import { describe, expect, it } from 'vitest';
import {
  classifyConfidenceLevel,
  computeDifferenceInDifferences,
  computeTwoProportionSignificance,
  computeWilsonInterval,
  wilsonIntervalSchema,
} from './stats';

describe('stats.ts — Wilson interval, two-proportion significance & DiD', () => {
  it('handles 0/0, 0/1, 1/1, 2/3, and 15/20 with strict [0, 1] clamping and confidence tiers', () => {
    const empty = computeWilsonInterval(0, 0);
    expect(empty).toEqual({
      hits: 0,
      trials: 0,
      rate: 0,
      lower: 0,
      upper: 0,
      halfWidth: 0,
      z: 1.96,
      confidenceLevel: 'INSUFFICIENT',
    });

    const zeroOfOne = computeWilsonInterval(0, 1);
    expect(zeroOfOne.rate).toBe(0);
    expect(zeroOfOne.lower).toBe(0);
    expect(zeroOfOne.upper).toBeGreaterThan(0.75);
    expect(zeroOfOne.upper).toBeLessThanOrEqual(1);
    expect(zeroOfOne.confidenceLevel).toBe('LOW');

    const oneOfOne = computeWilsonInterval(1, 1);
    expect(oneOfOne.rate).toBe(1);
    expect(oneOfOne.lower).toBeGreaterThanOrEqual(0);
    expect(oneOfOne.lower).toBeLessThan(0.25);
    expect(oneOfOne.upper).toBe(1);
    expect(oneOfOne.confidenceLevel).toBe('LOW');

    const twoOfThree = computeWilsonInterval(2, 3);
    expect(twoOfThree.rate).toBeCloseTo(0.6667, 4);
    expect(twoOfThree.lower).toBeCloseTo(0.2077, 3);
    expect(twoOfThree.upper).toBeCloseTo(0.9385, 3);
    expect(twoOfThree.confidenceLevel).toBe('LOW');

    const fifteenOfTwenty = computeWilsonInterval(15, 20);
    expect(fifteenOfTwenty.rate).toBe(0.75);
    expect(fifteenOfTwenty.lower).toBeCloseTo(0.5313, 3);
    expect(fifteenOfTwenty.upper).toBeCloseTo(0.8881, 3);
    expect(fifteenOfTwenty.halfWidth).toBeCloseTo(0.1784, 3);
    expect(fifteenOfTwenty.confidenceLevel).toBe('HIGH');

    expect(wilsonIntervalSchema.parse(fifteenOfTwenty)).toEqual(fifteenOfTwenty);
  });

  it('safely clamps out-of-range, negative, and NaN inputs without throwing', () => {
    const neg = computeWilsonInterval(-5, 10);
    expect(neg.hits).toBe(0);
    expect(neg.trials).toBe(10);
    expect(neg.lower).toBeGreaterThanOrEqual(0);
    expect(neg.upper).toBeLessThanOrEqual(1);

    const overflow = computeWilsonInterval(25, 20);
    expect(overflow.hits).toBe(20);
    expect(overflow.rate).toBe(1);
    expect(overflow.upper).toBe(1);

    const nanInput = computeWilsonInterval(Number.NaN, Number.NaN, -1);
    expect(nanInput.confidenceLevel).toBe('INSUFFICIENT');
    expect(nanInput.z).toBe(1.96);

    expect(classifyConfidenceLevel(10, 0.25)).toBe('MEDIUM');
    expect(classifyConfidenceLevel(15, 0.21)).toBe('MEDIUM');
    expect(classifyConfidenceLevel(15, 0.2)).toBe('HIGH');
  });

  it('computes two-proportion z-test significance accurately and handles zero-trial/flat edges', () => {
    const insufficient = computeTwoProportionSignificance({
      baselineHits: 0,
      baselineTrials: 0,
      currentHits: 3,
      currentTrials: 5,
    });
    expect(insufficient.direction).toBe('INSUFFICIENT');
    expect(insufficient.significant).toBe(false);
    expect(insufficient.pValue).toBe(1);

    const flat = computeTwoProportionSignificance({
      baselineHits: 0,
      baselineTrials: 10,
      currentHits: 0,
      currentTrials: 10,
    });
    expect(flat.direction).toBe('FLAT');
    expect(flat.significant).toBe(false);
    expect(flat.zScore).toBe(0);

    const significantUp = computeTwoProportionSignificance({
      baselineHits: 4,
      baselineTrials: 20,
      currentHits: 14,
      currentTrials: 20,
    });
    expect(significantUp.direction).toBe('UP');
    expect(significantUp.delta).toBeCloseTo(0.5, 4);
    expect(significantUp.zScore).toBeGreaterThan(3);
    expect(significantUp.pValue).toBeLessThan(0.01);
    expect(significantUp.significant).toBe(true);

    const notSignificant = computeTwoProportionSignificance({
      baselineHits: 5,
      baselineTrials: 10,
      currentHits: 6,
      currentTrials: 10,
    });
    expect(notSignificant.direction).toBe('UP');
    expect(notSignificant.significant).toBe(false);
    expect(notSignificant.pValue).toBeGreaterThan(0.05);
  });

  it('computes Difference-in-Differences net lift and direction', () => {
    const positive = computeDifferenceInDifferences({
      treatmentBaseline: 0.2,
      treatmentCurrent: 0.55,
      controlBaseline: 0.2,
      controlCurrent: 0.3,
    });
    expect(positive).toEqual({
      treatmentDelta: 0.35,
      controlDelta: 0.1,
      netLift: 0.25,
      direction: 'POSITIVE',
    });

    const neutral = computeDifferenceInDifferences({
      treatmentBaseline: 0.2,
      treatmentCurrent: 0.35,
      controlBaseline: 0.1,
      controlCurrent: 0.25,
    });
    expect(neutral.netLift).toBe(0);
    expect(neutral.direction).toBe('NEUTRAL');

    const negative = computeDifferenceInDifferences({
      treatmentBaseline: 0.5,
      treatmentCurrent: 0.45,
      controlBaseline: 0.4,
      controlCurrent: 0.5,
    });
    expect(negative.netLift).toBe(-0.15);
    expect(negative.direction).toBe('NEGATIVE');
  });

  it('handles extreme z values without violating wilsonIntervalSchema or halfWidth invariants', () => {
    const tinyZ = computeWilsonInterval(5, 10, 1e-5);
    expect(tinyZ.z).toBe(1.96);
    expect(wilsonIntervalSchema.safeParse(tinyZ).success).toBe(true);

    const hugeZ = computeWilsonInterval(5, 10, 1e200);
    expect(hugeZ.z).toBe(100);
    expect(hugeZ.lower).toBeLessThanOrEqual(hugeZ.rate);
    expect(hugeZ.upper).toBeGreaterThanOrEqual(hugeZ.rate);
    expect(hugeZ.upper).toBeGreaterThan(0.99);
    expect(hugeZ.halfWidth).toBeCloseTo((hugeZ.upper - hugeZ.lower) / 2, 4);
    expect(wilsonIntervalSchema.safeParse(hugeZ).success).toBe(true);
  });

  it('derives two-proportion direction from raw p2 - p1 even when rounded delta is 0', () => {
    const tinyLiftUp = computeTwoProportionSignificance({
      baselineHits: 0,
      baselineTrials: 1_000_000,
      currentHits: 5,
      currentTrials: 1_000_000,
    });
    expect(tinyLiftUp.significant).toBe(true);
    expect(tinyLiftUp.direction).toBe('UP');

    const tinyLiftDown = computeTwoProportionSignificance({
      baselineHits: 5,
      baselineTrials: 1_000_000,
      currentHits: 0,
      currentTrials: 1_000_000,
    });
    expect(tinyLiftDown.significant).toBe(true);
    expect(tinyLiftDown.direction).toBe('DOWN');
  });
});
