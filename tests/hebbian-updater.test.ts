/**
 * Tests for HebbianWeightUpdater — co-retrieval frequency-based
 * Hebbian weight update logic.
 *
 * Covers:
 *   - Activation level computation from co-retrieval counts
 *   - Single edge Hebbian update (Δw = η · a_i · a_j · (1 - w))
 *   - Batch co-retrieval pairwise updates
 *   - Combined reinforce + decay pass
 *   - Equilibrium prediction
 *   - Edge cases and convergence properties
 */

import { describe, it, expect } from 'vitest';
import {
  HebbianWeightUpdater,
  computeActivationLevel,
  computeHebbianDeltaFromActivation,
  makeEdgeKey,
  DEFAULT_HEBBIAN_CONFIG,
} from '../src/scoring/index.js';

// ────────────────────────────────────────────────────────
// computeActivationLevel
// ────────────────────────────────────────────────────────

describe('computeActivationLevel', () => {
  it('returns minActivation for 0 retrievals', () => {
    const level = computeActivationLevel(0, 5, 0.1);
    expect(level).toBeCloseTo(0.1, 5);
  });

  it('returns ~0.63 at halfSaturation count', () => {
    const level = computeActivationLevel(5, 5);
    // 1 - exp(-1) ≈ 0.6321
    expect(level).toBeCloseTo(0.6321, 3);
  });

  it('approaches 1.0 for very high counts', () => {
    const level = computeActivationLevel(100, 5);
    expect(level).toBeGreaterThan(0.99);
  });

  it('is monotonically increasing with count', () => {
    let prev = 0;
    for (let count = 0; count <= 20; count++) {
      const level = computeActivationLevel(count, 5, 0.1);
      expect(level).toBeGreaterThanOrEqual(prev);
      prev = level;
    }
  });

  it('handles negative count as 0', () => {
    const level = computeActivationLevel(-5, 5, 0.1);
    expect(level).toBeCloseTo(0.1, 5);
  });

  it('returns 1.0 when halfSaturation is 0 or negative', () => {
    expect(computeActivationLevel(5, 0)).toBe(1.0);
    expect(computeActivationLevel(5, -1)).toBe(1.0);
  });

  it('respects custom minActivation', () => {
    const level = computeActivationLevel(0, 5, 0.3);
    expect(level).toBeCloseTo(0.3, 5);
  });

  it('uses defaults when parameters omitted', () => {
    const level = computeActivationLevel(0);
    expect(level).toBeCloseTo(DEFAULT_HEBBIAN_CONFIG.minActivation, 5);
  });
});

// ────────────────────────────────────────────────────────
// computeHebbianDelta (pure function)
// ────────────────────────────────────────────────────────

describe('computeHebbianDelta (from activation)', () => {
  it('computes Δw = η · a_i · a_j · (1 - w) with headroom', () => {
    // η=0.1, a_i=0.5, a_j=0.8, w=0.3
    // Δw = 0.1 * 0.5 * 0.8 * (1 - 0.3) = 0.1 * 0.5 * 0.8 * 0.7 = 0.028
    const delta = computeHebbianDeltaFromActivation(0.3, 0.5, 0.8, 0.1, true);
    expect(delta).toBeCloseTo(0.028, 5);
  });

  it('computes Δw = η · a_i · a_j without headroom', () => {
    // η=0.1, a_i=0.5, a_j=0.8, no headroom
    // Δw = 0.1 * 0.5 * 0.8 = 0.04
    const delta = computeHebbianDeltaFromActivation(0.3, 0.5, 0.8, 0.1, false);
    expect(delta).toBeCloseTo(0.04, 5);
  });

  it('delta is zero when weight is 1.0 (with headroom)', () => {
    const delta = computeHebbianDeltaFromActivation(1.0, 1.0, 1.0, 0.5, true);
    expect(delta).toBeCloseTo(0, 5);
  });

  it('delta is maximum when weight is 0 and activations are 1.0', () => {
    // Δw = η * 1.0 * 1.0 * (1 - 0) = η
    const delta = computeHebbianDeltaFromActivation(0, 1.0, 1.0, 0.1, true);
    expect(delta).toBeCloseTo(0.1, 5);
  });

  it('clamps weight to [0, 1] before computing', () => {
    // weight > 1 → clamped to 1 → headroom = 0
    expect(computeHebbianDeltaFromActivation(1.5, 1.0, 1.0, 0.1, true)).toBeCloseTo(0, 5);
    // weight < 0 → clamped to 0 → headroom = 1
    expect(computeHebbianDeltaFromActivation(-0.5, 1.0, 1.0, 0.1, true)).toBeCloseTo(0.1, 5);
  });
});

// ────────────────────────────────────────────────────────
// makeEdgeKey
// ────────────────────────────────────────────────────────

describe('makeEdgeKey', () => {
  it('sorts IDs lexicographically', () => {
    expect(makeEdgeKey('b', 'a')).toBe('a:b');
    expect(makeEdgeKey('a', 'b')).toBe('a:b');
  });

  it('handles same IDs', () => {
    expect(makeEdgeKey('x', 'x')).toBe('x:x');
  });
});

// ────────────────────────────────────────────────────────
// HebbianWeightUpdater — construction
// ────────────────────────────────────────────────────────

describe('HebbianWeightUpdater', () => {
  it('creates with default config', () => {
    const updater = new HebbianWeightUpdater();
    expect(updater.config.learningRate).toBe(0.1);
    expect(updater.config.halfSaturation).toBe(5);
    expect(updater.config.minActivation).toBe(0.1);
    expect(updater.config.useHeadroom).toBe(true);
  });

  it('merges partial config', () => {
    const updater = new HebbianWeightUpdater({
      learningRate: 0.2,
      halfSaturation: 10,
    });
    expect(updater.config.learningRate).toBe(0.2);
    expect(updater.config.halfSaturation).toBe(10);
    expect(updater.config.minActivation).toBe(0.1); // default preserved
  });

  // ────────────────────────────────────────────────────
  // getActivationLevel
  // ────────────────────────────────────────────────────

  describe('getActivationLevel()', () => {
    it('computes from activationCount', () => {
      const updater = new HebbianWeightUpdater({ halfSaturation: 5, minActivation: 0.1 });
      const level = updater.getActivationLevel({ nodeId: 'n1', activationCount: 5 });
      expect(level).toBeCloseTo(0.6321, 3);
    });

    it('uses pre-computed activationLevel when provided', () => {
      const updater = new HebbianWeightUpdater();
      const level = updater.getActivationLevel({
        nodeId: 'n1',
        activationCount: 100, // would give ~1.0
        activationLevel: 0.42, // but this overrides
      });
      expect(level).toBeCloseTo(0.42, 5);
    });

    it('clamps pre-computed level to [minActivation, 1.0]', () => {
      const updater = new HebbianWeightUpdater({ minActivation: 0.1 });
      expect(updater.getActivationLevel({
        nodeId: 'n1', activationCount: 0, activationLevel: 0.01,
      })).toBeCloseTo(0.1, 5);
      expect(updater.getActivationLevel({
        nodeId: 'n1', activationCount: 0, activationLevel: 1.5,
      })).toBeCloseTo(1.0, 5);
    });
  });

  // ────────────────────────────────────────────────────
  // computeUpdate — single edge
  // ────────────────────────────────────────────────────

  describe('computeUpdate()', () => {
    it('increases weight based on Hebbian rule', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1, halfSaturation: 5 });
      const result = updater.computeUpdate({
        currentWeight: 0.5,
        source: { nodeId: 'a1', activationCount: 5 },
        target: { nodeId: 'a2', activationCount: 10 },
      });

      expect(result.newWeight).toBeGreaterThan(0.5);
      expect(result.delta).toBeGreaterThan(0);
      expect(result.sourceId).toBe('a1');
      expect(result.targetId).toBe('a2');
      expect(result.sourceActivation).toBeCloseTo(0.6321, 3);
      expect(result.targetActivation).toBeGreaterThan(0.86); // 1 - exp(-2) ≈ 0.8647
      expect(result.headroom).toBeCloseTo(0.5, 3);
    });

    it('correctly applies formula Δw = η · a_i · a_j · (1 - w)', () => {
      const updater = new HebbianWeightUpdater({
        learningRate: 0.2,
        halfSaturation: 5,
        minActivation: 0.0,
      });

      // Both at halfSaturation → activation ≈ 0.6321
      const result = updater.computeUpdate({
        currentWeight: 0.4,
        source: { nodeId: 's', activationCount: 5 },
        target: { nodeId: 't', activationCount: 5 },
      });

      const a = 1 - Math.exp(-1); // 0.6321
      const expectedDelta = 0.2 * a * a * (1 - 0.4);
      expect(result.delta).toBeCloseTo(expectedDelta, 3);
    });

    it('delta approaches zero as weight approaches 1.0', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.5 });
      const result = updater.computeUpdate({
        currentWeight: 0.99,
        source: { nodeId: 's', activationCount: 100 },
        target: { nodeId: 't', activationCount: 100 },
      });
      expect(result.delta).toBeLessThan(0.01);
      expect(result.newWeight).toBeLessThanOrEqual(1.0);
    });

    it('weight never exceeds maxWeight', () => {
      // Use explicit maxWeight=1.0 to test clamping (default is WEIGHT_CAP=100)
      const updater = new HebbianWeightUpdater({ learningRate: 1.0, useHeadroom: false, maxWeight: 1.0 });
      const result = updater.computeUpdate({
        currentWeight: 0.95,
        source: { nodeId: 's', activationCount: 100, activationLevel: 1.0 },
        target: { nodeId: 't', activationCount: 100, activationLevel: 1.0 },
      });
      expect(result.newWeight).toBeLessThanOrEqual(1.0);
    });

    it('uses per-edge learning rate override', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1 });

      const resultDefault = updater.computeUpdate({
        currentWeight: 0.5,
        source: { nodeId: 's', activationCount: 5 },
        target: { nodeId: 't', activationCount: 5 },
      });

      const resultOverride = updater.computeUpdate({
        currentWeight: 0.5,
        source: { nodeId: 's', activationCount: 5 },
        target: { nodeId: 't', activationCount: 5 },
        learningRate: 0.5,
      });

      expect(resultOverride.delta).toBeGreaterThan(resultDefault.delta);
      expect(resultOverride.learningRate).toBe(0.5);
    });

    it('high-frequency nodes strengthen edges more than low-frequency', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1, halfSaturation: 5 });

      const resultHighFreq = updater.computeUpdate({
        currentWeight: 0.3,
        source: { nodeId: 's', activationCount: 50 },
        target: { nodeId: 't', activationCount: 50 },
      });

      const resultLowFreq = updater.computeUpdate({
        currentWeight: 0.3,
        source: { nodeId: 's', activationCount: 1 },
        target: { nodeId: 't', activationCount: 1 },
      });

      expect(resultHighFreq.delta).toBeGreaterThan(resultLowFreq.delta);
    });

    it('asymmetric activation works correctly', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1, halfSaturation: 5 });

      const result = updater.computeUpdate({
        currentWeight: 0.5,
        source: { nodeId: 's', activationCount: 1 },  // low activation
        target: { nodeId: 't', activationCount: 100 }, // high activation
      });

      // Low source activation should limit the delta
      expect(result.sourceActivation).toBeLessThan(0.3);
      expect(result.targetActivation).toBeGreaterThan(0.99);
      expect(result.delta).toBeGreaterThan(0);
      // But less than if both were high
      const bothHigh = updater.computeUpdate({
        currentWeight: 0.5,
        source: { nodeId: 's', activationCount: 100 },
        target: { nodeId: 't', activationCount: 100 },
      });
      expect(result.delta).toBeLessThan(bothHigh.delta);
    });

    it('without headroom mode, delta does not depend on current weight', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1, useHeadroom: false });

      const lowWeight = updater.computeUpdate({
        currentWeight: 0.1,
        source: { nodeId: 's', activationCount: 5, activationLevel: 0.5 },
        target: { nodeId: 't', activationCount: 5, activationLevel: 0.5 },
      });

      const highWeight = updater.computeUpdate({
        currentWeight: 0.9,
        source: { nodeId: 's', activationCount: 5, activationLevel: 0.5 },
        target: { nodeId: 't', activationCount: 5, activationLevel: 0.5 },
      });

      expect(lowWeight.delta).toBeCloseTo(highWeight.delta, 5);
    });
  });

  // ────────────────────────────────────────────────────
  // computeCoRetrievalUpdate — batch
  // ────────────────────────────────────────────────────

  describe('computeCoRetrievalUpdate()', () => {
    it('generates all pairwise updates for 3 co-retrieved nodes', () => {
      const updater = new HebbianWeightUpdater();

      const weights = new Map<string, number>();
      weights.set(makeEdgeKey('a1', 'a2'), 0.3);
      weights.set(makeEdgeKey('a1', 'a3'), 0.5);
      weights.set(makeEdgeKey('a2', 'a3'), 0.1);

      const result = updater.computeCoRetrievalUpdate({
        retrievedNodes: [
          { nodeId: 'a1', activationCount: 5 },
          { nodeId: 'a2', activationCount: 10 },
          { nodeId: 'a3', activationCount: 3 },
        ],
        currentWeights: weights,
      });

      // 3 nodes → C(3,2) = 3 pairs
      expect(result.totalPairs).toBe(3);
      expect(result.updatedCount).toBe(3);
      expect(result.newEdgeCount).toBe(0); // all weights existed

      // All should have increased
      for (const update of result.updates) {
        expect(update.newWeight).toBeGreaterThan(update.previousWeight);
      }

      expect(result.averageDelta).toBeGreaterThan(0);
      expect(result.maxDelta).toBeGreaterThanOrEqual(result.averageDelta);
    });

    it('handles new edges (weight 0) in co-retrieval', () => {
      const updater = new HebbianWeightUpdater();

      const result = updater.computeCoRetrievalUpdate({
        retrievedNodes: [
          { nodeId: 'n1', activationCount: 5 },
          { nodeId: 'n2', activationCount: 5 },
        ],
        currentWeights: new Map(), // no existing edges
      });

      expect(result.totalPairs).toBe(1);
      expect(result.newEdgeCount).toBe(1);
      expect(result.updates[0].previousWeight).toBe(0);
      expect(result.updates[0].newWeight).toBeGreaterThan(0);
    });

    it('handles single node (no pairs)', () => {
      const updater = new HebbianWeightUpdater();
      const result = updater.computeCoRetrievalUpdate({
        retrievedNodes: [{ nodeId: 'n1', activationCount: 5 }],
        currentWeights: new Map(),
      });

      expect(result.totalPairs).toBe(0);
      expect(result.updatedCount).toBe(0);
      expect(result.averageDelta).toBe(0);
    });

    it('handles empty node list', () => {
      const updater = new HebbianWeightUpdater();
      const result = updater.computeCoRetrievalUpdate({
        retrievedNodes: [],
        currentWeights: new Map(),
      });

      expect(result.totalPairs).toBe(0);
    });

    it('generates C(n,2) pairs for n nodes', () => {
      const updater = new HebbianWeightUpdater();

      for (const n of [2, 3, 4, 5]) {
        const nodes = Array.from({ length: n }, (_, i) => ({
          nodeId: `n${i}`,
          activationCount: i + 1,
        }));

        const result = updater.computeCoRetrievalUpdate({
          retrievedNodes: nodes,
          currentWeights: new Map(),
        });

        const expectedPairs = (n * (n - 1)) / 2;
        expect(result.totalPairs).toBe(expectedPairs);
      }
    });

    it('uses batch-level learning rate override', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1 });

      const baseResult = updater.computeCoRetrievalUpdate({
        retrievedNodes: [
          { nodeId: 'n1', activationCount: 5 },
          { nodeId: 'n2', activationCount: 5 },
        ],
        currentWeights: new Map(),
      });

      const boostedResult = updater.computeCoRetrievalUpdate({
        retrievedNodes: [
          { nodeId: 'n1', activationCount: 5 },
          { nodeId: 'n2', activationCount: 5 },
        ],
        currentWeights: new Map(),
        learningRate: 0.5,
      });

      expect(boostedResult.updates[0].delta).toBeGreaterThan(baseResult.updates[0].delta);
    });
  });

  // ────────────────────────────────────────────────────
  // computeReinforceDecay — combined pass
  // ────────────────────────────────────────────────────

  describe('computeReinforceDecay()', () => {
    it('applies reinforcement then decay', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1 });

      const result = updater.computeReinforceDecay({
        edge: { id: 'e1', weight: 0.5, decayRate: 0.01, activationCount: 5 },
        source: { nodeId: 's', activationCount: 10 },
        target: { nodeId: 't', activationCount: 10 },
        elapsedMs: 24 * 60 * 60 * 1000, // 1 day
      });

      expect(result.previousWeight).toBe(0.5);
      expect(result.reinforcedWeight).toBeGreaterThan(0.5);
      // After reinforcement, decay should slightly reduce
      expect(result.finalWeight).toBeLessThan(result.reinforcedWeight);
      expect(result.reinforceDelta).toBeGreaterThan(0);
      expect(result.decayDelta).toBeGreaterThan(0);
    });

    it('no decay when elapsedMs is 0', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1 });

      const result = updater.computeReinforceDecay({
        edge: { id: 'e1', weight: 0.5, decayRate: 0.1, activationCount: 5 },
        source: { nodeId: 's', activationCount: 10 },
        target: { nodeId: 't', activationCount: 10 },
        elapsedMs: 0,
      });

      expect(result.reinforcedWeight).toBe(result.finalWeight);
      expect(result.decayDelta).toBeCloseTo(0, 4);
    });

    it('zero decay rate means no decay', () => {
      const updater = new HebbianWeightUpdater();

      const result = updater.computeReinforceDecay({
        edge: { id: 'e1', weight: 0.5, decayRate: 0, activationCount: 5 },
        source: { nodeId: 's', activationCount: 10 },
        target: { nodeId: 't', activationCount: 10 },
        elapsedMs: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      expect(result.finalWeight).toBe(result.reinforcedWeight);
    });
  });

  // ────────────────────────────────────────────────────
  // predictEquilibrium
  // ────────────────────────────────────────────────────

  describe('predictEquilibrium()', () => {
    it('predicts equilibrium for balanced reinforcement and decay', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1, halfSaturation: 5 });

      const eq = updater.predictEquilibrium(10, 10, 0.05);

      // Both activated 10 times → high activation
      // Equilibrium should be between 0 and 1
      expect(eq).toBeGreaterThan(0.5);
      expect(eq).toBeLessThan(1.0);
    });

    it('higher activation counts → higher equilibrium', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1, halfSaturation: 5 });

      const eqLow = updater.predictEquilibrium(1, 1, 0.05);
      const eqHigh = updater.predictEquilibrium(50, 50, 0.05);

      expect(eqHigh).toBeGreaterThan(eqLow);
    });

    it('higher decay rate → lower equilibrium', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1, halfSaturation: 5 });

      const eqLowDecay = updater.predictEquilibrium(10, 10, 0.01);
      const eqHighDecay = updater.predictEquilibrium(10, 10, 0.5);

      expect(eqLowDecay).toBeGreaterThan(eqHighDecay);
    });

    it('returns 0 when reinforcement and decay are both 0', () => {
      const updater = new HebbianWeightUpdater({
        learningRate: 0,
        minActivation: 0,
      });
      const eq = updater.predictEquilibrium(0, 0, 0);
      expect(eq).toBe(0);
    });

    it('equilibrium formula: η·a_i·a_j / (η·a_i·a_j + decayRate)', () => {
      const updater = new HebbianWeightUpdater({
        learningRate: 0.1,
        halfSaturation: 5,
        minActivation: 0,
      });

      const ai = 1 - Math.exp(-10 / 5);
      const aj = 1 - Math.exp(-10 / 5);
      const reinforce = 0.1 * ai * aj;
      const decay = 0.05;
      const expected = reinforce / (reinforce + decay);

      const eq = updater.predictEquilibrium(10, 10, 0.05);
      expect(eq).toBeCloseTo(expected, 4);
    });
  });

  // ────────────────────────────────────────────────────
  // Convergence properties
  // ────────────────────────────────────────────────────

  describe('Convergence properties', () => {
    it('repeated updates converge weight toward equilibrium', () => {
      const updater = new HebbianWeightUpdater({
        learningRate: 0.1,
        halfSaturation: 5,
        minActivation: 0.1,
      });

      const source = { nodeId: 's', activationCount: 10 };
      const target = { nodeId: 't', activationCount: 10 };
      const decayRate = 0.05;

      // Predicted equilibrium
      const equilibrium = updater.predictEquilibrium(10, 10, decayRate);

      // Simulate reinforce+decay cycle
      let weight = 0.1; // start low
      for (let i = 0; i < 100; i++) {
        const result = updater.computeUpdate({
          currentWeight: weight,
          source,
          target,
        });
        weight = result.newWeight;
        // Apply decay
        weight = weight * (1 - decayRate);
      }

      // Should converge near equilibrium
      expect(weight).toBeCloseTo(equilibrium, 1);
    });

    it('weight is monotonically increasing under repeated reinforcement', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1 });

      let weight = 0.1;
      for (let i = 0; i < 20; i++) {
        const result = updater.computeUpdate({
          currentWeight: weight,
          source: { nodeId: 's', activationCount: 10 },
          target: { nodeId: 't', activationCount: 10 },
        });
        expect(result.newWeight).toBeGreaterThanOrEqual(weight);
        weight = result.newWeight;
      }

      // Should approach 1.0
      expect(weight).toBeGreaterThan(0.8);
    });

    it('diminishing returns: each reinforcement adds less delta', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.2 });

      let weight = 0.1;
      const deltas: number[] = [];

      for (let i = 0; i < 10; i++) {
        const result = updater.computeUpdate({
          currentWeight: weight,
          source: { nodeId: 's', activationCount: 10 },
          target: { nodeId: 't', activationCount: 10 },
        });
        deltas.push(result.delta);
        weight = result.newWeight;
      }

      // Each delta should be smaller than the previous
      for (let i = 1; i < deltas.length; i++) {
        expect(deltas[i]).toBeLessThan(deltas[i - 1]);
      }
    });

    it('co-retrieval batch strengthens frequently co-retrieved pairs more over time', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0.1, halfSaturation: 5 });

      // Simulate: nodes A and B are always co-retrieved,
      // nodes A and C are co-retrieved less often
      const weights = new Map<string, number>();
      const keyAB = makeEdgeKey('a', 'b');
      const keyAC = makeEdgeKey('a', 'c');
      weights.set(keyAB, 0);
      weights.set(keyAC, 0);

      let activationA = 0;
      let activationB = 0;
      let activationC = 0;

      // 10 rounds: A and B always retrieved together; A and C only every 3rd round
      for (let round = 0; round < 10; round++) {
        activationA++;
        activationB++;

        // A-B always co-retrieved
        const abResult = updater.computeUpdate({
          currentWeight: weights.get(keyAB)!,
          source: { nodeId: 'a', activationCount: activationA },
          target: { nodeId: 'b', activationCount: activationB },
        });
        weights.set(keyAB, abResult.newWeight);

        // A-C co-retrieved every 3rd round
        if (round % 3 === 0) {
          activationC++;
          const acResult = updater.computeUpdate({
            currentWeight: weights.get(keyAC)!,
            source: { nodeId: 'a', activationCount: activationA },
            target: { nodeId: 'c', activationCount: activationC },
          });
          weights.set(keyAC, acResult.newWeight);
        }
      }

      // A-B should be much stronger than A-C
      expect(weights.get(keyAB)!).toBeGreaterThan(weights.get(keyAC)!);
    });
  });

  // ────────────────────────────────────────────────────
  // Edge cases
  // ────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('handles zero learning rate', () => {
      const updater = new HebbianWeightUpdater({ learningRate: 0 });
      const result = updater.computeUpdate({
        currentWeight: 0.5,
        source: { nodeId: 's', activationCount: 100 },
        target: { nodeId: 't', activationCount: 100 },
      });
      expect(result.delta).toBe(0);
      expect(result.newWeight).toBe(0.5);
    });

    it('handles very large activation counts', () => {
      const updater = new HebbianWeightUpdater();
      const result = updater.computeUpdate({
        currentWeight: 0.5,
        source: { nodeId: 's', activationCount: 1000000 },
        target: { nodeId: 't', activationCount: 1000000 },
      });
      // Activations should be ~1.0, delta should be well-defined
      expect(result.sourceActivation).toBeCloseTo(1.0, 3);
      expect(result.targetActivation).toBeCloseTo(1.0, 3);
      expect(result.newWeight).toBeGreaterThan(0.5);
      expect(result.newWeight).toBeLessThanOrEqual(1.0);
    });

    it('handles custom maxWeight below 1.0', () => {
      const updater = new HebbianWeightUpdater({ maxWeight: 0.8 });
      const result = updater.computeUpdate({
        currentWeight: 0.79,
        source: { nodeId: 's', activationCount: 100, activationLevel: 1.0 },
        target: { nodeId: 't', activationCount: 100, activationLevel: 1.0 },
        learningRate: 0.5,
      });
      expect(result.newWeight).toBeLessThanOrEqual(0.8);
    });

    it('handles custom minWeight above 0', () => {
      const updater = new HebbianWeightUpdater({ minWeight: 0.1, learningRate: 0 });
      const result = updater.computeUpdate({
        currentWeight: 0.05,
        source: { nodeId: 's', activationCount: 0 },
        target: { nodeId: 't', activationCount: 0 },
      });
      // No reinforcement (lr=0), but weight is clamped to minWeight
      expect(result.newWeight).toBeGreaterThanOrEqual(0.1);
    });
  });
});
