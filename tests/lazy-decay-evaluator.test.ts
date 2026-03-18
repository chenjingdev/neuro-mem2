/**
 * Tests for LazyDecayEvaluator — event-based lazy shield + weight decay.
 *
 * Validates the formulas:
 *   effectiveShield = max(0, shield - gap * 0.5)
 *   effectiveWeight = max(0, weight - overflow)
 * where overflow = max(0, gap * decayRate - effectiveShield)
 */

import { describe, it, expect } from 'vitest';
import {
  computeEffectiveShield,
  computeEffectiveWeight,
  evaluateLazyDecay,
  evaluateLazyDecayBatch,
  materializeLazyDecay,
  LazyDecayEvaluator,
  DEFAULT_SHIELD_DECAY_RATE,
  DEFAULT_LAZY_DECAY_CONFIG,
  type LazyDecayInput,
} from '../src/scoring/lazy-decay-evaluator.js';

// ─── computeEffectiveShield ──────────────────────────────────────

describe('computeEffectiveShield', () => {
  it('returns shield unchanged when gap is 0', () => {
    expect(computeEffectiveShield(20, 0)).toBe(20);
  });

  it('returns shield unchanged when gap is negative', () => {
    expect(computeEffectiveShield(20, -5)).toBe(20);
  });

  it('decays shield by gap * 0.5 (default rate)', () => {
    // shield=20, gap=10 → 20 - 10*0.5 = 15
    expect(computeEffectiveShield(20, 10)).toBe(15);
  });

  it('clamps to 0 when decay exceeds shield', () => {
    // shield=5, gap=20 → 5 - 20*0.5 = -5 → clamped to 0
    expect(computeEffectiveShield(5, 20)).toBe(0);
  });

  it('returns 0 for 0 shield regardless of gap', () => {
    expect(computeEffectiveShield(0, 100)).toBe(0);
  });

  it('supports custom shield decay rate', () => {
    // shield=30, gap=10, rate=1.0 → 30 - 10*1.0 = 20
    expect(computeEffectiveShield(30, 10, 1.0)).toBe(20);
  });

  it('handles fractional gap values', () => {
    // shield=10, gap=0.3 (retrieval event) → 10 - 0.3*0.5 = 9.85
    expect(computeEffectiveShield(10, 0.3)).toBeCloseTo(9.85, 4);
  });

  it('handles large gap values (수십만 이벤트 시나리오)', () => {
    // shield=50, gap=200 → 50 - 200*0.5 = -50 → 0
    expect(computeEffectiveShield(50, 200)).toBe(0);
  });

  it('exact boundary: shield equals gap * rate', () => {
    // shield=10, gap=20 → 10 - 20*0.5 = 0 exactly
    expect(computeEffectiveShield(10, 20)).toBe(0);
  });
});

// ─── computeEffectiveWeight ──────────────────────────────────────

describe('computeEffectiveWeight', () => {
  it('returns weight unchanged when gap is 0', () => {
    expect(computeEffectiveWeight(80, 20, 0, 0.01)).toBe(80);
  });

  it('returns weight unchanged when decayRate is 0', () => {
    expect(computeEffectiveWeight(80, 20, 100, 0)).toBe(80);
  });

  it('shield fully absorbs decay when effectiveShield >= rawDecay', () => {
    // weight=80, shield=20, gap=10, decayRate=0.01
    // effectiveShield = 20 - 10*0.5 = 15
    // rawDecay = 10 * 0.01 = 0.1
    // overflow = max(0, 0.1 - 15) = 0
    // effectiveWeight = 80 - 0 = 80
    expect(computeEffectiveWeight(80, 20, 10, 0.01)).toBe(80);
  });

  it('weight is reduced when decay exceeds effective shield', () => {
    // weight=80, shield=5, gap=100, decayRate=0.5
    // effectiveShield = max(0, 5 - 100*0.5) = 0
    // rawDecay = 100 * 0.5 = 50
    // overflow = max(0, 50 - 0) = 50
    // effectiveWeight = max(0, 80 - 50) = 30
    expect(computeEffectiveWeight(80, 5, 100, 0.5)).toBe(30);
  });

  it('weight clamps to 0 when fully decayed', () => {
    // weight=10, shield=0, gap=50, decayRate=1.0
    // effectiveShield = 0
    // rawDecay = 50
    // overflow = 50
    // effectiveWeight = max(0, 10 - 50) = 0
    expect(computeEffectiveWeight(10, 0, 50, 1.0)).toBe(0);
  });

  it('partial shield absorption — shield protects some weight', () => {
    // weight=80, shield=10, gap=20, decayRate=1.0
    // effectiveShield = max(0, 10 - 20*0.5) = 0
    // rawDecay = 20 * 1.0 = 20
    // overflow = max(0, 20 - 0) = 20
    // effectiveWeight = max(0, 80 - 20) = 60
    expect(computeEffectiveWeight(80, 10, 20, 1.0)).toBe(60);
  });

  it('high shield completely protects weight even with high decay', () => {
    // weight=50, shield=100, gap=10, decayRate=2.0
    // effectiveShield = max(0, 100 - 10*0.5) = 95
    // rawDecay = 10 * 2.0 = 20
    // overflow = max(0, 20 - 95) = 0
    // effectiveWeight = 50
    expect(computeEffectiveWeight(50, 100, 10, 2.0)).toBe(50);
  });

  it('handles negative gap gracefully', () => {
    expect(computeEffectiveWeight(80, 20, -5, 0.01)).toBe(80);
  });

  it('handles typical edge scenario (decayRate=0.01, moderate gap)', () => {
    // weight=75, shield=30, gap=50, decayRate=0.01
    // effectiveShield = max(0, 30 - 50*0.5) = 5
    // rawDecay = 50 * 0.01 = 0.5
    // overflow = max(0, 0.5 - 5) = 0
    // effectiveWeight = 75
    expect(computeEffectiveWeight(75, 30, 50, 0.01)).toBe(75);
  });

  it('scenario: shield barely insufficient', () => {
    // weight=60, shield=10, gap=22, decayRate=0.5
    // effectiveShield = max(0, 10 - 22*0.5) = max(0, -1) = 0
    // rawDecay = 22 * 0.5 = 11
    // overflow = max(0, 11 - 0) = 11
    // effectiveWeight = max(0, 60 - 11) = 49
    expect(computeEffectiveWeight(60, 10, 22, 0.5)).toBe(49);
  });
});

// ─── evaluateLazyDecay (full result) ─────────────────────────────

describe('evaluateLazyDecay', () => {
  const baseInput: LazyDecayInput = {
    shield: 20,
    weight: 80,
    decayRate: 0.01,
    lastActivatedAtEvent: 100,
  };

  it('returns zero-decay result when currentEvent equals lastActivatedAtEvent', () => {
    const result = evaluateLazyDecay(baseInput, 100);
    expect(result.gap).toBe(0);
    expect(result.rawDecay).toBe(0);
    expect(result.shieldAbsorbed).toBe(0);
    expect(result.overflow).toBe(0);
    expect(result.effectiveShield).toBe(20);
    expect(result.effectiveWeight).toBe(80);
    expect(result.isDead).toBe(false);
  });

  it('computes correct values with moderate gap', () => {
    // gap=10, decayRate=0.01
    // effectiveShield = max(0, 20 - 10*0.5) = 15
    // rawDecay = 10 * 0.01 = 0.1
    // shieldAbsorbed = min(15, 0.1) = 0.1
    // overflow = max(0, 0.1 - 15) = 0
    // effectiveWeight = 80
    const result = evaluateLazyDecay(baseInput, 110);
    expect(result.gap).toBe(10);
    expect(result.effectiveShield).toBe(15);
    expect(result.rawDecay).toBeCloseTo(0.1, 6);
    expect(result.shieldAbsorbed).toBeCloseTo(0.1, 6);
    expect(result.overflow).toBe(0);
    expect(result.effectiveWeight).toBe(80);
    expect(result.isDead).toBe(false);
  });

  it('detects dead edges', () => {
    const dyingInput: LazyDecayInput = {
      shield: 0,
      weight: 5,
      decayRate: 1.0,
      lastActivatedAtEvent: 0,
    };
    const result = evaluateLazyDecay(dyingInput, 100);
    expect(result.effectiveWeight).toBe(0);
    expect(result.isDead).toBe(true);
  });

  it('handles decayRate=0 as no decay', () => {
    const noDecayInput: LazyDecayInput = {
      shield: 10,
      weight: 50,
      decayRate: 0,
      lastActivatedAtEvent: 0,
    };
    const result = evaluateLazyDecay(noDecayInput, 1000);
    expect(result.effectiveWeight).toBe(50);
    expect(result.effectiveShield).toBe(10);
    expect(result.gap).toBe(0); // gap is reported as 0 since no decay applied
    expect(result.rawDecay).toBe(0);
  });

  it('supports custom shieldDecayRate via config', () => {
    // shield=20, gap=10, shieldDecayRate=1.0 → effectiveShield = 20 - 10 = 10
    // rawDecay = 10 * 0.01 = 0.1
    const result = evaluateLazyDecay(baseInput, 110, { shieldDecayRate: 1.0 });
    expect(result.effectiveShield).toBe(10);
    expect(result.rawDecay).toBeCloseTo(0.1, 6);
    expect(result.effectiveWeight).toBe(80);
  });

  it('correctly computes shield absorption vs overflow split', () => {
    const input: LazyDecayInput = {
      shield: 5,
      weight: 100,
      decayRate: 2.0,
      lastActivatedAtEvent: 50,
    };
    // gap=50, shieldDecayRate=0.5
    // effectiveShield = max(0, 5 - 50*0.5) = 0
    // rawDecay = 50 * 2.0 = 100
    // shieldAbsorbed = min(0, 100) = 0
    // overflow = max(0, 100 - 0) = 100
    // effectiveWeight = max(0, 100 - 100) = 0
    const result = evaluateLazyDecay(input, 100);
    expect(result.effectiveShield).toBe(0);
    expect(result.rawDecay).toBe(100);
    expect(result.shieldAbsorbed).toBe(0);
    expect(result.overflow).toBe(100);
    expect(result.effectiveWeight).toBe(0);
    expect(result.isDead).toBe(true);
  });

  it('handles currentEvent < lastActivatedAtEvent (time travel safe)', () => {
    const result = evaluateLazyDecay(baseInput, 50); // 50 < 100
    expect(result.gap).toBe(0);
    expect(result.effectiveShield).toBe(20);
    expect(result.effectiveWeight).toBe(80);
  });
});

// ─── evaluateLazyDecayBatch ──────────────────────────────────────

describe('evaluateLazyDecayBatch', () => {
  it('evaluates multiple items in batch', () => {
    const items: LazyDecayInput[] = [
      { shield: 20, weight: 80, decayRate: 0.01, lastActivatedAtEvent: 90 },
      { shield: 0, weight: 50, decayRate: 1.0, lastActivatedAtEvent: 50 },
      { shield: 100, weight: 100, decayRate: 0.5, lastActivatedAtEvent: 95 },
    ];

    const results = evaluateLazyDecayBatch(items, 100);
    expect(results).toHaveLength(3);

    // Item 0: well-protected, gap=10
    expect(results[0].effectiveWeight).toBe(80);
    expect(results[0].effectiveShield).toBe(15); // 20 - 10*0.5

    // Item 1: no shield, high decay, gap=50
    expect(results[1].effectiveWeight).toBe(0); // 50 - 50 = 0
    expect(results[1].isDead).toBe(true);

    // Item 2: high shield, gap=5
    // effectiveShield = 100 - 5*0.5 = 97.5
    // rawDecay = 5*0.5 = 2.5
    // overflow = 0 (2.5 < 97.5)
    expect(results[2].effectiveWeight).toBe(100);
    expect(results[2].effectiveShield).toBe(97.5);
  });

  it('returns empty array for empty input', () => {
    expect(evaluateLazyDecayBatch([], 100)).toEqual([]);
  });
});

// ─── materializeLazyDecay ────────────────────────────────────────

describe('materializeLazyDecay', () => {
  it('returns persistable values with rounded precision', () => {
    const input: LazyDecayInput = {
      shield: 20,
      weight: 80,
      decayRate: 0.01,
      lastActivatedAtEvent: 100,
    };

    const result = materializeLazyDecay(input, 110);
    expect(result.lastActivatedAtEvent).toBe(110);
    expect(result.shield).toBe(15); // 20 - 10*0.5
    expect(result.weight).toBe(80); // shield absorbed all decay
  });

  it('materializes decayed weight correctly', () => {
    const input: LazyDecayInput = {
      shield: 0,
      weight: 50,
      decayRate: 0.5,
      lastActivatedAtEvent: 0,
    };

    const result = materializeLazyDecay(input, 20);
    // effectiveShield = 0
    // rawDecay = 20 * 0.5 = 10
    // overflow = 10
    // effectiveWeight = 50 - 10 = 40
    expect(result.weight).toBe(40);
    expect(result.shield).toBe(0);
    expect(result.lastActivatedAtEvent).toBe(20);
  });
});

// ─── LazyDecayEvaluator class ────────────────────────────────────

describe('LazyDecayEvaluator', () => {
  it('evaluates using provided getCurrentEvent function', () => {
    let eventCounter = 100;
    const evaluator = new LazyDecayEvaluator(() => eventCounter);

    const input: LazyDecayInput = {
      shield: 20,
      weight: 80,
      decayRate: 0.01,
      lastActivatedAtEvent: 90,
    };

    const result = evaluator.evaluate(input);
    expect(result.gap).toBe(10);
    expect(result.effectiveShield).toBe(15);
    expect(result.effectiveWeight).toBe(80);

    // Advance event counter
    eventCounter = 200;
    const result2 = evaluator.evaluate(input);
    expect(result2.gap).toBe(110);
  });

  it('getEffectiveWeight convenience method', () => {
    const evaluator = new LazyDecayEvaluator(() => 100);

    const input: LazyDecayInput = {
      shield: 0,
      weight: 50,
      decayRate: 0.5,
      lastActivatedAtEvent: 80,
    };

    // gap=20, effectiveShield=0, rawDecay=10, overflow=10
    expect(evaluator.getEffectiveWeight(input)).toBe(40);
  });

  it('getEffectiveShield convenience method', () => {
    const evaluator = new LazyDecayEvaluator(() => 100);
    // shield=30, gap=20 → 30 - 20*0.5 = 20
    expect(evaluator.getEffectiveShield(30, 80)).toBe(20);
  });

  it('isDead detects zero-weight edges', () => {
    const evaluator = new LazyDecayEvaluator(() => 1000);

    const deadInput: LazyDecayInput = {
      shield: 0,
      weight: 5,
      decayRate: 1.0,
      lastActivatedAtEvent: 0,
    };
    expect(evaluator.isDead(deadInput)).toBe(true);

    const aliveInput: LazyDecayInput = {
      shield: 500,
      weight: 100,
      decayRate: 0.01,
      lastActivatedAtEvent: 999,
    };
    expect(evaluator.isDead(aliveInput)).toBe(false);
  });

  it('materialize returns DB-persistable values', () => {
    const evaluator = new LazyDecayEvaluator(() => 150);

    const input: LazyDecayInput = {
      shield: 40,
      weight: 90,
      decayRate: 0.01,
      lastActivatedAtEvent: 100,
    };

    const result = evaluator.materialize(input);
    // gap=50, effectiveShield = 40 - 50*0.5 = 15
    // rawDecay = 50*0.01 = 0.5, overflow = 0
    expect(result.shield).toBe(15);
    expect(result.weight).toBe(90);
    expect(result.lastActivatedAtEvent).toBe(150);
  });

  it('evaluateBatch processes multiple items', () => {
    const evaluator = new LazyDecayEvaluator(() => 100);

    const items: LazyDecayInput[] = [
      { shield: 10, weight: 50, decayRate: 0.01, lastActivatedAtEvent: 95 },
      { shield: 0, weight: 30, decayRate: 1.0, lastActivatedAtEvent: 50 },
    ];

    const results = evaluator.evaluateBatch(items);
    expect(results).toHaveLength(2);
    expect(results[0].effectiveWeight).toBe(50);
    // gap=50, rawDecay=50*1.0=50, overflow=50, weight=max(0,30-50)=0
    expect(results[1].isDead).toBe(true);
  });

  it('supports custom shieldDecayRate config', () => {
    const evaluator = new LazyDecayEvaluator(() => 100, { shieldDecayRate: 2.0 });

    const input: LazyDecayInput = {
      shield: 30,
      weight: 80,
      decayRate: 0.01,
      lastActivatedAtEvent: 90,
    };

    // gap=10, shieldDecayRate=2.0 → effectiveShield = 30 - 10*2.0 = 10
    const result = evaluator.evaluate(input);
    expect(result.effectiveShield).toBe(10);
  });
});

// ─── Constants & defaults ─────────────────────────────────────────

describe('constants and defaults', () => {
  it('DEFAULT_SHIELD_DECAY_RATE is 0.5', () => {
    expect(DEFAULT_SHIELD_DECAY_RATE).toBe(0.5);
  });

  it('DEFAULT_LAZY_DECAY_CONFIG uses 0.5 shield decay rate', () => {
    expect(DEFAULT_LAZY_DECAY_CONFIG.shieldDecayRate).toBe(0.5);
  });
});

// ─── Edge case / regression scenarios ────────────────────────────

describe('edge cases', () => {
  it('very small weight with very small decay does not go negative', () => {
    const result = evaluateLazyDecay(
      { shield: 0, weight: 0.001, decayRate: 0.0001, lastActivatedAtEvent: 0 },
      5,
    );
    expect(result.effectiveWeight).toBeGreaterThanOrEqual(0);
  });

  it('very large gap does not produce NaN or Infinity', () => {
    const result = evaluateLazyDecay(
      { shield: 100, weight: 100, decayRate: 0.01, lastActivatedAtEvent: 0 },
      1_000_000,
    );
    expect(Number.isFinite(result.effectiveWeight)).toBe(true);
    expect(Number.isFinite(result.effectiveShield)).toBe(true);
    expect(result.effectiveWeight).toBe(0);
    expect(result.effectiveShield).toBe(0);
  });

  it('negative stored values are clamped to 0', () => {
    const result = evaluateLazyDecay(
      { shield: -5, weight: -10, decayRate: 0.01, lastActivatedAtEvent: 0 },
      10,
    );
    expect(result.effectiveShield).toBe(0);
    expect(result.effectiveWeight).toBe(0);
  });

  it('fractional event counter increments work (retrieval.completed +0.3)', () => {
    const input: LazyDecayInput = {
      shield: 10,
      weight: 50,
      decayRate: 1.0,
      lastActivatedAtEvent: 99.7,
    };
    // gap=0.3
    // effectiveShield = 10 - 0.3*0.5 = 9.85
    // rawDecay = 0.3 * 1.0 = 0.3
    // shieldAbsorbed = 0.3 (shield > rawDecay)
    // effectiveWeight = 50
    const result = evaluateLazyDecay(input, 100);
    expect(result.gap).toBeCloseTo(0.3, 6);
    expect(result.effectiveShield).toBeCloseTo(9.85, 4);
    expect(result.effectiveWeight).toBe(50);
  });
});
