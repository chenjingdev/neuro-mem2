/**
 * Tests for Anchor weight decay — time-based and usage-based decay functions.
 */

import { describe, it, expect } from 'vitest';
import {
  computeTimeDecay,
  computeUsageDecay,
  computeCombinedDecayFactor,
  computeEdgeDecay,
  AnchorDecay,
  DEFAULT_DECAY_CONFIG,
  type DecayEdgeInput,
} from '../src/scoring/anchor-decay.js';

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * ONE_DAY_MS;

function makeEdge(overrides: Partial<DecayEdgeInput> = {}): DecayEdgeInput {
  return {
    weight: 0.8,
    lastActivatedAt: new Date().toISOString(),
    activationCount: 5,
    edgeDecayRate: 0.01,
    ...overrides,
  };
}

function pastDate(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// ────────────────────────────────────────────────────────
// computeTimeDecay
// ────────────────────────────────────────────────────────

describe('computeTimeDecay', () => {
  it('returns 1.0 when elapsed time is 0', () => {
    expect(computeTimeDecay(0, FOURTEEN_DAYS_MS)).toBe(1.0);
  });

  it('returns ~0.5 at exactly one half-life', () => {
    const factor = computeTimeDecay(FOURTEEN_DAYS_MS, FOURTEEN_DAYS_MS);
    expect(factor).toBeCloseTo(0.5, 5);
  });

  it('returns ~0.25 at exactly two half-lives', () => {
    const factor = computeTimeDecay(2 * FOURTEEN_DAYS_MS, FOURTEEN_DAYS_MS);
    expect(factor).toBeCloseTo(0.25, 5);
  });

  it('returns ~0.125 at three half-lives', () => {
    const factor = computeTimeDecay(3 * FOURTEEN_DAYS_MS, FOURTEEN_DAYS_MS);
    expect(factor).toBeCloseTo(0.125, 5);
  });

  it('approaches 0 for very large elapsed time', () => {
    const factor = computeTimeDecay(100 * FOURTEEN_DAYS_MS, FOURTEEN_DAYS_MS);
    expect(factor).toBeLessThan(1e-10);
  });

  it('returns 1.0 for negative elapsed time (future activation)', () => {
    expect(computeTimeDecay(-1000, FOURTEEN_DAYS_MS)).toBe(1.0);
  });

  it('returns 0.0 when half-life is 0', () => {
    expect(computeTimeDecay(1000, 0)).toBe(0.0);
  });

  it('scales decay by per-edge decay rate', () => {
    // Higher decay rate -> faster decay -> lower factor
    const normal = computeTimeDecay(FOURTEEN_DAYS_MS, FOURTEEN_DAYS_MS, 0.01);
    const fast = computeTimeDecay(FOURTEEN_DAYS_MS, FOURTEEN_DAYS_MS, 0.02);
    const slow = computeTimeDecay(FOURTEEN_DAYS_MS, FOURTEEN_DAYS_MS, 0.005);

    expect(fast).toBeLessThan(normal);
    expect(slow).toBeGreaterThan(normal);
    expect(normal).toBeCloseTo(0.5, 5);
  });

  it('2x decay rate halves the effective half-life', () => {
    // With 2x rate, one base half-life should give factor = 0.25 (two effective half-lives)
    const factor = computeTimeDecay(FOURTEEN_DAYS_MS, FOURTEEN_DAYS_MS, 0.02);
    expect(factor).toBeCloseTo(0.25, 5);
  });
});

// ────────────────────────────────────────────────────────
// computeUsageDecay
// ────────────────────────────────────────────────────────

describe('computeUsageDecay', () => {
  it('returns maximum penalty for 0 activations', () => {
    const factor = computeUsageDecay(0, 0.3);
    // 1 - 0.3 * (1/1) = 0.7
    expect(factor).toBeCloseTo(0.7, 10);
  });

  it('returns reduced penalty with more activations', () => {
    const factor0 = computeUsageDecay(0, 0.3);
    const factor5 = computeUsageDecay(5, 0.3);
    const factor50 = computeUsageDecay(50, 0.3);

    expect(factor0).toBeLessThan(factor5);
    expect(factor5).toBeLessThan(factor50);
  });

  it('approaches 1.0 for very high activation counts', () => {
    const factor = computeUsageDecay(1000, 0.3);
    // 1 - 0.3/1001 ~ 0.9997
    expect(factor).toBeGreaterThan(0.999);
  });

  it('returns 1.0 when usage decay rate is 0', () => {
    expect(computeUsageDecay(0, 0)).toBe(1.0);
  });

  it('handles negative activation count as 0', () => {
    const factorNeg = computeUsageDecay(-5, 0.3);
    const factor0 = computeUsageDecay(0, 0.3);
    expect(factorNeg).toBeCloseTo(factor0, 10);
  });

  it('specific values match formula: 1 - rate/(1+count)', () => {
    // activationCount=9, rate=0.3: 1 - 0.3/10 = 0.97
    expect(computeUsageDecay(9, 0.3)).toBeCloseTo(0.97, 10);
    // activationCount=1, rate=0.3: 1 - 0.3/2 = 0.85
    expect(computeUsageDecay(1, 0.3)).toBeCloseTo(0.85, 10);
  });
});

// ────────────────────────────────────────────────────────
// computeCombinedDecayFactor
// ────────────────────────────────────────────────────────

describe('computeCombinedDecayFactor', () => {
  it('returns 1.0 when both factors are 1.0', () => {
    expect(computeCombinedDecayFactor(1.0, 1.0)).toBe(1.0);
  });

  it('returns 0 when time factor is 0', () => {
    expect(computeCombinedDecayFactor(0, 0.9)).toBe(0);
  });

  it('returns 0 when usage factor is 0', () => {
    expect(computeCombinedDecayFactor(0.9, 0)).toBe(0);
  });

  it('weighted geometric mean with timeWeight=0.7', () => {
    // 0.5^0.7 * 0.8^0.3 = ~0.5648 * ~0.9332 = ~0.5271
    const result = computeCombinedDecayFactor(0.5, 0.8, 0.7);
    expect(result).toBeCloseTo(Math.pow(0.5, 0.7) * Math.pow(0.8, 0.3), 5);
  });

  it('time-only when timeWeight=1', () => {
    const result = computeCombinedDecayFactor(0.4, 0.9, 1.0);
    expect(result).toBeCloseTo(0.4, 10);
  });

  it('usage-only when timeWeight=0', () => {
    const result = computeCombinedDecayFactor(0.4, 0.9, 0.0);
    expect(result).toBeCloseTo(0.9, 10);
  });

  it('clamps inputs to [0, 1]', () => {
    const result = computeCombinedDecayFactor(1.5, -0.1, 0.5);
    expect(result).toBe(0); // negative factor clamps to 0
  });
});

// ────────────────────────────────────────────────────────
// computeEdgeDecay (integration of all signals)
// ────────────────────────────────────────────────────────

describe('computeEdgeDecay', () => {
  it('returns no decay for just-activated edge', () => {
    const now = new Date();
    const edge = makeEdge({ lastActivatedAt: now.toISOString() });
    const result = computeEdgeDecay(edge, now);

    expect(result.timeDecayFactor).toBeCloseTo(1.0, 5);
    expect(result.newWeight).toBeCloseTo(edge.weight * result.combinedFactor, 5);
    expect(result.weightDelta).toBeCloseTo(0, 1);
  });

  it('decays significantly for an old, unused edge', () => {
    const edge = makeEdge({
      weight: 0.5,
      lastActivatedAt: pastDate(30 * ONE_DAY_MS), // 30 days ago
      activationCount: 0,
      edgeDecayRate: 0.01,
    });

    const result = computeEdgeDecay(edge);

    expect(result.newWeight).toBeLessThan(edge.weight);
    expect(result.timeDecayFactor).toBeLessThan(0.5); // past 2 half-lives
    expect(result.usageDecayFactor).toBeLessThan(1.0); // 0 activations
    expect(result.weightDelta).toBeGreaterThan(0); // weight decreased
  });

  it('decays slowly for frequently-used edge', () => {
    const twoDaysAgo = pastDate(2 * ONE_DAY_MS);
    const edge = makeEdge({
      weight: 0.8,
      lastActivatedAt: twoDaysAgo,
      activationCount: 100,
    });

    const result = computeEdgeDecay(edge);

    // High activation count provides decay resistance
    expect(result.usageDecayFactor).toBeGreaterThan(0.99);
    expect(result.newWeight).toBeGreaterThan(0.7);
    expect(result.shouldPrune).toBe(false);
  });

  it('respects minimum weight floor', () => {
    const edge = makeEdge({
      weight: 0.02,
      lastActivatedAt: pastDate(100 * ONE_DAY_MS),
      activationCount: 0,
    });

    const result = computeEdgeDecay(edge);
    expect(result.newWeight).toBeGreaterThanOrEqual(DEFAULT_DECAY_CONFIG.minWeight);
  });

  it('marks edge for pruning when below threshold', () => {
    const edge = makeEdge({
      weight: 0.06,
      lastActivatedAt: pastDate(60 * ONE_DAY_MS),
      activationCount: 0,
    });

    const result = computeEdgeDecay(edge);
    expect(result.shouldPrune).toBe(true);
  });

  it('weightDelta equals original minus new weight', () => {
    const edge = makeEdge({
      lastActivatedAt: pastDate(7 * ONE_DAY_MS),
    });

    const result = computeEdgeDecay(edge);
    expect(result.weightDelta).toBeCloseTo(edge.weight - result.newWeight, 10);
  });

  it('higher edge decay rate causes faster decay', () => {
    const lastActivated = pastDate(14 * ONE_DAY_MS);
    const now = new Date();

    const slowEdge = makeEdge({ lastActivatedAt: lastActivated, edgeDecayRate: 0.005 });
    const normalEdge = makeEdge({ lastActivatedAt: lastActivated, edgeDecayRate: 0.01 });
    const fastEdge = makeEdge({ lastActivatedAt: lastActivated, edgeDecayRate: 0.02 });

    const slowResult = computeEdgeDecay(slowEdge, now);
    const normalResult = computeEdgeDecay(normalEdge, now);
    const fastResult = computeEdgeDecay(fastEdge, now);

    expect(fastResult.newWeight).toBeLessThan(normalResult.newWeight);
    expect(normalResult.newWeight).toBeLessThan(slowResult.newWeight);
  });
});

// ────────────────────────────────────────────────────────
// AnchorDecay class
// ────────────────────────────────────────────────────────

describe('AnchorDecay', () => {
  it('uses default config when none provided', () => {
    const decay = new AnchorDecay();
    expect(decay.config).toEqual(DEFAULT_DECAY_CONFIG);
  });

  it('merges partial config with defaults', () => {
    const decay = new AnchorDecay({ timeHalfLifeMs: 7 * ONE_DAY_MS });
    expect(decay.config.timeHalfLifeMs).toBe(7 * ONE_DAY_MS);
    expect(decay.config.usageDecayRate).toBe(DEFAULT_DECAY_CONFIG.usageDecayRate);
  });

  describe('computeDecay', () => {
    it('delegates to computeEdgeDecay with config', () => {
      const decay = new AnchorDecay();
      const edge = makeEdge({ lastActivatedAt: pastDate(7 * ONE_DAY_MS) });
      const result = decay.computeDecay(edge);

      expect(result.newWeight).toBeLessThan(edge.weight);
      expect(result.combinedFactor).toBeGreaterThan(0);
      expect(result.combinedFactor).toBeLessThan(1);
    });
  });

  describe('computeBatchDecay', () => {
    it('processes multiple edges and returns summary', () => {
      const decay = new AnchorDecay();
      const edges = [
        makeEdge({ lastActivatedAt: pastDate(1 * ONE_DAY_MS), activationCount: 10 }),
        makeEdge({ lastActivatedAt: pastDate(30 * ONE_DAY_MS), activationCount: 0 }),
        makeEdge({ lastActivatedAt: pastDate(60 * ONE_DAY_MS), activationCount: 2 }),
      ];

      const { results, summary } = decay.computeBatchDecay(edges);

      expect(results).toHaveLength(3);
      expect(summary.totalProcessed).toBe(3);
      expect(summary.decayedCount).toBeGreaterThan(0);
      expect(summary.averageDecayFactor).toBeGreaterThan(0);
      expect(summary.averageDecayFactor).toBeLessThan(1);
      expect(summary.computedAt).toBeDefined();
    });

    it('returns empty summary for no edges', () => {
      const decay = new AnchorDecay();
      const { results, summary } = decay.computeBatchDecay([]);

      expect(results).toHaveLength(0);
      expect(summary.totalProcessed).toBe(0);
      expect(summary.decayedCount).toBe(0);
      expect(summary.averageDecayFactor).toBe(1.0);
    });

    it('identifies edges that should be pruned', () => {
      const decay = new AnchorDecay();
      const edges = [
        makeEdge({ weight: 0.8, lastActivatedAt: pastDate(1 * ONE_DAY_MS), activationCount: 50 }),
        makeEdge({ weight: 0.06, lastActivatedAt: pastDate(90 * ONE_DAY_MS), activationCount: 0 }),
      ];

      const { summary } = decay.computeBatchDecay(edges);
      expect(summary.pruneCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('predictDecayTime', () => {
    it('returns 0 if weight is already below threshold', () => {
      const decay = new AnchorDecay();
      const edge = makeEdge({ weight: 0.01 });
      expect(decay.predictDecayTime(edge)).toBe(0);
    });

    it('returns positive time for healthy edge', () => {
      const decay = new AnchorDecay();
      const edge = makeEdge({ weight: 0.8, activationCount: 5 });
      const timeMs = decay.predictDecayTime(edge);

      expect(timeMs).toBeGreaterThan(0);
      expect(Number.isFinite(timeMs)).toBe(true);
    });

    it('higher activation count extends predicted time', () => {
      const decay = new AnchorDecay();
      const lowUsage = makeEdge({ weight: 0.8, activationCount: 1 });
      const highUsage = makeEdge({ weight: 0.8, activationCount: 100 });

      const timeLow = decay.predictDecayTime(lowUsage);
      const timeHigh = decay.predictDecayTime(highUsage);

      expect(timeHigh).toBeGreaterThan(timeLow);
    });

    it('higher decay rate shortens predicted time', () => {
      const decay = new AnchorDecay();
      const slowEdge = makeEdge({ weight: 0.8, edgeDecayRate: 0.005 });
      const fastEdge = makeEdge({ weight: 0.8, edgeDecayRate: 0.02 });

      const timeSlow = decay.predictDecayTime(slowEdge);
      const timeFast = decay.predictDecayTime(fastEdge);

      expect(timeFast).toBeLessThan(timeSlow);
    });

    it('can predict with custom target weight', () => {
      const decay = new AnchorDecay();
      const edge = makeEdge({ weight: 0.8, activationCount: 5 });

      const timeToHalf = decay.predictDecayTime(edge, 0.4);
      const timeToPrune = decay.predictDecayTime(edge, 0.05);

      expect(timeToHalf).toBeLessThan(timeToPrune);
    });
  });
});

// ────────────────────────────────────────────────────────
// Integration: decay behavior over time
// ────────────────────────────────────────────────────────

describe('Decay behavior over time (simulation)', () => {
  it('edge weight decreases monotonically over time', () => {
    const decay = new AnchorDecay();
    const baseTime = Date.now();
    const weights: number[] = [];

    for (let day = 0; day <= 60; day += 5) {
      const edge = makeEdge({
        weight: 0.8,
        lastActivatedAt: new Date(baseTime).toISOString(),
        activationCount: 3,
      });

      const now = new Date(baseTime + day * ONE_DAY_MS);
      const result = decay.computeDecay(edge, now);
      weights.push(result.newWeight);
    }

    // Verify monotonically decreasing
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThanOrEqual(weights[i - 1]);
    }
  });

  it('frequently-used edge retains more weight than unused edge', () => {
    const decay = new AnchorDecay();
    const thirtyDaysAgo = pastDate(30 * ONE_DAY_MS);

    const usedEdge = makeEdge({
      weight: 0.8,
      lastActivatedAt: thirtyDaysAgo,
      activationCount: 50,
    });

    const unusedEdge = makeEdge({
      weight: 0.8,
      lastActivatedAt: thirtyDaysAgo,
      activationCount: 0,
    });

    const usedResult = decay.computeDecay(usedEdge);
    const unusedResult = decay.computeDecay(unusedEdge);

    expect(usedResult.newWeight).toBeGreaterThan(unusedResult.newWeight);
  });

  it('short half-life config causes faster decay', () => {
    const shortHalfLife = new AnchorDecay({ timeHalfLifeMs: 3 * ONE_DAY_MS });
    const longHalfLife = new AnchorDecay({ timeHalfLifeMs: 30 * ONE_DAY_MS });

    const edge = makeEdge({
      weight: 0.8,
      lastActivatedAt: pastDate(7 * ONE_DAY_MS),
    });

    const shortResult = shortHalfLife.computeDecay(edge);
    const longResult = longHalfLife.computeDecay(edge);

    expect(shortResult.newWeight).toBeLessThan(longResult.newWeight);
  });
});
