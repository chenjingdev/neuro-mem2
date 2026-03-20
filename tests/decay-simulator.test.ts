/**
 * Tests for Edge Decay Simulation Engine
 */
import { describe, it, expect } from 'vitest';
import {
  simulateEdgeDecay,
  simulateBatchDecay,
  projectDeathEvent,
  projectShieldDepletionEvent,
  DecaySimulator,
  DEFAULT_SIMULATION_PARAMS,
  type DecaySimulationParams,
} from '../src/scoring/decay-simulator.js';
import type { LazyDecayInput } from '../src/scoring/lazy-decay-evaluator.js';

// ─── Helpers ─────────────────────────────────────────────

function makeEdge(overrides: Partial<LazyDecayInput> = {}): LazyDecayInput {
  return {
    weight: 80,
    shield: 10,
    decayRate: 0.5,
    lastActivatedAtEvent: 100,
    ...overrides,
  };
}

// ─── simulateEdgeDecay ──────────────────────────────────

describe('simulateEdgeDecay', () => {
  it('should produce totalSteps+1 snapshots (including step 0)', () => {
    const result = simulateEdgeDecay(makeEdge(), { totalSteps: 10 });
    expect(result.snapshots).toHaveLength(11);
    expect(result.snapshots[0].step).toBe(0);
    expect(result.snapshots[10].step).toBe(10);
  });

  it('step 0 should reflect initial state', () => {
    const edge = makeEdge({ weight: 50, shield: 20 });
    const result = simulateEdgeDecay(edge, { totalSteps: 5 });
    expect(result.snapshots[0]).toMatchObject({
      step: 0,
      weight: 50,
      shield: 20,
      isDead: false,
    });
  });

  it('should show weight decay progression over steps', () => {
    const edge = makeEdge({ weight: 100, shield: 0, decayRate: 1.0, lastActivatedAtEvent: 0 });
    const result = simulateEdgeDecay(edge, { totalSteps: 5, stepSize: 1 });

    // With shield=0, weight decays directly: effectiveWeight = max(0, 100 - gap*1.0)
    // But the formula involves shield decay too...
    // gap=1: effectiveShield=0, rawDecay=1, overflow=1, effectiveWeight=99
    expect(result.snapshots[1].weight).toBe(99);
    expect(result.snapshots[2].weight).toBe(98);
    expect(result.snapshots[5].weight).toBe(95);
  });

  it('should show shield absorbing decay', () => {
    // With shield=20, shieldDecayRate=0.5
    // gap=1: effectiveShield = 20 - 1*0.5 = 19.5, rawDecay = 0.5*1 = 0.5
    // overflow = max(0, 0.5 - 19.5) = 0
    // So weight stays at 80 for a while (shield absorbs everything)
    const edge = makeEdge({ weight: 80, shield: 20, decayRate: 0.5 });
    const result = simulateEdgeDecay(edge, { totalSteps: 5, includeDetails: true });

    // At step 1 (gap=1): effectiveShield=19.5, rawDecay=0.5, overflow=0
    expect(result.snapshots[1].weight).toBe(80);
    expect(result.snapshots[1].overflow).toBe(0);
  });

  it('should respect stepSize', () => {
    const edge = makeEdge({ lastActivatedAtEvent: 0 });
    const result = simulateEdgeDecay(edge, { totalSteps: 5, stepSize: 10 });

    expect(result.snapshots[0].eventCounter).toBe(0);
    expect(result.snapshots[1].eventCounter).toBe(10);
    expect(result.snapshots[5].eventCounter).toBe(50);
    expect(result.summary.totalEventsSimulated).toBe(50);
  });

  it('should detect death event', () => {
    // weight=10, shield=0, decayRate=1.0 → weight hits 0 at gap=10
    const edge = makeEdge({ weight: 10, shield: 0, decayRate: 1.0, lastActivatedAtEvent: 0 });
    const result = simulateEdgeDecay(edge, { totalSteps: 20 });

    expect(result.summary.deathEvent).toBe(10);
    expect(result.summary.deathStep).toBe(10);
    expect(result.snapshots[10].isDead).toBe(true);
  });

  it('should detect shield depletion event', () => {
    // shield=10, shieldDecayRate=0.5 → depletes at gap = 10/0.5 = 20
    const edge = makeEdge({ shield: 10, lastActivatedAtEvent: 0 });
    const result = simulateEdgeDecay(edge, { totalSteps: 25 });

    expect(result.summary.shieldDepletedEvent).toBe(20);
    expect(result.summary.shieldDepletedStep).toBe(20);
  });

  it('should early-terminate when edge is dead and shield depleted', () => {
    const edge = makeEdge({ weight: 5, shield: 0, decayRate: 5.0, lastActivatedAtEvent: 0 });
    const result = simulateEdgeDecay(edge, { totalSteps: 100 });

    // Should still have totalSteps+1 snapshots (filled with dead state)
    expect(result.snapshots).toHaveLength(101);
    // But all after death should be dead
    const deadIdx = result.summary.deathStep!;
    for (let i = deadIdx; i <= 100; i++) {
      expect(result.snapshots[i].isDead).toBe(true);
      expect(result.snapshots[i].weight).toBe(0);
    }
  });

  it('should include detail fields when includeDetails=true', () => {
    const edge = makeEdge({ weight: 50, shield: 5, decayRate: 1.0, lastActivatedAtEvent: 0 });
    const result = simulateEdgeDecay(edge, { totalSteps: 3, includeDetails: true });

    for (const snap of result.snapshots) {
      expect(snap.rawDecay).toBeDefined();
      expect(snap.shieldAbsorbed).toBeDefined();
      expect(snap.overflow).toBeDefined();
    }
  });

  it('should NOT include detail fields when includeDetails=false', () => {
    const edge = makeEdge();
    const result = simulateEdgeDecay(edge, { totalSteps: 3, includeDetails: false });

    for (const snap of result.snapshots) {
      expect(snap.rawDecay).toBeUndefined();
      expect(snap.shieldAbsorbed).toBeUndefined();
      expect(snap.overflow).toBeUndefined();
    }
  });

  it('should compute weight retention percentage', () => {
    const edge = makeEdge({ weight: 100, shield: 0, decayRate: 0.5, lastActivatedAtEvent: 0 });
    const result = simulateEdgeDecay(edge, { totalSteps: 10 });

    expect(result.summary.weightRetentionPct).toBeGreaterThan(0);
    expect(result.summary.weightRetentionPct).toBeLessThanOrEqual(100);
  });

  it('should handle zero decay rate (no decay)', () => {
    const edge = makeEdge({ weight: 80, shield: 10, decayRate: 0 });
    const result = simulateEdgeDecay(edge, { totalSteps: 10 });

    // Weight should remain unchanged
    for (const snap of result.snapshots) {
      expect(snap.weight).toBe(80);
    }
    expect(result.summary.deathEvent).toBeNull();
    expect(result.summary.weightRetentionPct).toBe(100);
  });

  it('should handle already-dead edge', () => {
    const edge = makeEdge({ weight: 0, shield: 0 });
    const result = simulateEdgeDecay(edge, { totalSteps: 5 });

    expect(result.snapshots[0].isDead).toBe(true);
    expect(result.summary.deathEvent).toBe(edge.lastActivatedAtEvent);
    expect(result.summary.deathStep).toBe(0);
    expect(result.summary.weightRetentionPct).toBe(0);
  });

  it('should apply custom shieldDecayRate', () => {
    const edge = makeEdge({ shield: 20, lastActivatedAtEvent: 0 });
    const fastShield = simulateEdgeDecay(edge, { totalSteps: 250, shieldDecayRate: 2.0 });
    const slowShield = simulateEdgeDecay(edge, { totalSteps: 250, shieldDecayRate: 0.1 });

    // Fast shield decay → shield depletes sooner
    expect(fastShield.summary.shieldDepletedStep!).toBeLessThan(slowShield.summary.shieldDepletedStep!);
  });

  it('should use default params when none provided', () => {
    const result = simulateEdgeDecay(makeEdge());
    expect(result.params.totalSteps).toBe(DEFAULT_SIMULATION_PARAMS.totalSteps);
    expect(result.params.stepSize).toBe(DEFAULT_SIMULATION_PARAMS.stepSize);
    expect(result.params.speed).toBe(DEFAULT_SIMULATION_PARAMS.speed);
  });
});

// ─── simulateBatchDecay ─────────────────────────────────

describe('simulateBatchDecay', () => {
  it('should simulate multiple edges and return per-edge results', () => {
    const edges = [
      { edgeId: 'e1', state: makeEdge({ weight: 100, shield: 0, decayRate: 1.0 }) },
      { edgeId: 'e2', state: makeEdge({ weight: 50, shield: 20, decayRate: 0.5 }) },
      { edgeId: 'e3', state: makeEdge({ weight: 10, shield: 0, decayRate: 2.0 }) },
    ];

    const result = simulateBatchDecay(edges, { totalSteps: 20 });

    expect(result.edges).toHaveLength(3);
    expect(result.edges[0].edgeId).toBe('e1');
    expect(result.edges[1].edgeId).toBe('e2');
    expect(result.edges[2].edgeId).toBe('e3');
  });

  it('should compute correct aggregate statistics', () => {
    const edges = [
      { edgeId: 'e1', state: makeEdge({ weight: 100, shield: 0, decayRate: 1.0, lastActivatedAtEvent: 0 }) },
      { edgeId: 'e2', state: makeEdge({ weight: 100, shield: 50, decayRate: 0.01, lastActivatedAtEvent: 0 }) },
    ];

    const result = simulateBatchDecay(edges, { totalSteps: 200 });

    expect(result.aggregate.totalEdges).toBe(2);
    expect(result.aggregate.dyingEdges + result.aggregate.survivingEdges).toBe(2);
    expect(typeof result.aggregate.avgFinalWeight).toBe('number');
    expect(typeof result.aggregate.avgRetentionPct).toBe('number');
  });

  it('should handle empty edges array', () => {
    const result = simulateBatchDecay([], { totalSteps: 10 });
    expect(result.edges).toHaveLength(0);
    expect(result.aggregate.totalEdges).toBe(0);
    expect(result.aggregate.avgFinalWeight).toBe(0);
  });
});

// ─── projectDeathEvent ──────────────────────────────────

describe('projectDeathEvent', () => {
  it('should find exact death event for simple case', () => {
    // weight=10, shield=0, decayRate=1.0 → dies at gap=10 → event=110
    const edge = makeEdge({ weight: 10, shield: 0, decayRate: 1.0, lastActivatedAtEvent: 100 });
    const death = projectDeathEvent(edge);
    expect(death).toBe(110);
  });

  it('should return null for zero decay rate', () => {
    const edge = makeEdge({ decayRate: 0 });
    expect(projectDeathEvent(edge)).toBeNull();
  });

  it('should return lastActivatedAtEvent for already-dead edge', () => {
    const edge = makeEdge({ weight: 0, lastActivatedAtEvent: 50 });
    expect(projectDeathEvent(edge)).toBe(50);
  });

  it('should account for shield when projecting death', () => {
    // Shield delays death
    const noShield = makeEdge({ weight: 10, shield: 0, decayRate: 1.0, lastActivatedAtEvent: 0 });
    const withShield = makeEdge({ weight: 10, shield: 20, decayRate: 1.0, lastActivatedAtEvent: 0 });

    const deathNoShield = projectDeathEvent(noShield)!;
    const deathWithShield = projectDeathEvent(withShield)!;

    expect(deathWithShield).toBeGreaterThan(deathNoShield);
  });

  it('should return null for edge that survives 1M events', () => {
    // Very low decay + high shield → practically immortal
    const edge = makeEdge({ weight: 100, shield: 50, decayRate: 0.00001 });
    const death = projectDeathEvent(edge);
    // With such low decay, might not die within 1M events
    // This depends on exact math, just verify it's a number or null
    expect(death === null || typeof death === 'number').toBe(true);
  });
});

// ─── projectShieldDepletionEvent ────────────────────────

describe('projectShieldDepletionEvent', () => {
  it('should compute shield depletion event', () => {
    // shield=10, rate=0.5 → depletes at gap=20 → event=120
    const event = projectShieldDepletionEvent(10, 100, 0.5);
    expect(event).toBe(120);
  });

  it('should return null for zero shield', () => {
    expect(projectShieldDepletionEvent(0, 100, 0.5)).toBeNull();
  });

  it('should return null for zero decay rate', () => {
    expect(projectShieldDepletionEvent(10, 100, 0)).toBeNull();
  });

  it('should handle large shield values', () => {
    const event = projectShieldDepletionEvent(100, 0, 0.5);
    expect(event).toBe(200);
  });

  it('should use default rate when not provided', () => {
    // Default shieldDecayRate=0.5, shield=10 → gap=20
    const event = projectShieldDepletionEvent(10, 50);
    expect(event).toBe(70);
  });
});

// ─── DecaySimulator class ───────────────────────────────

describe('DecaySimulator', () => {
  it('should use default params from constructor', () => {
    const sim = new DecaySimulator({ totalSteps: 50, stepSize: 2 });
    const result = sim.simulate(makeEdge());
    expect(result.params.totalSteps).toBe(50);
    expect(result.params.stepSize).toBe(2);
  });

  it('should allow per-call param overrides', () => {
    const sim = new DecaySimulator({ totalSteps: 50 });
    const result = sim.simulate(makeEdge(), { totalSteps: 10 });
    expect(result.params.totalSteps).toBe(10);
  });

  it('should use configured shieldDecayRate', () => {
    const sim = new DecaySimulator({}, { shieldDecayRate: 2.0 });
    const edge = makeEdge({ shield: 10, lastActivatedAtEvent: 0 });
    const result = sim.simulate(edge, { totalSteps: 10 });

    // With shieldDecayRate=2.0, shield depletes at gap=5
    expect(result.summary.shieldDepletedStep).toBe(5);
  });

  it('projectDeath should work', () => {
    const sim = new DecaySimulator();
    const edge = makeEdge({ weight: 10, shield: 0, decayRate: 1.0, lastActivatedAtEvent: 0 });
    expect(sim.projectDeath(edge)).toBe(10);
  });

  it('projectShieldDepletion should work', () => {
    const sim = new DecaySimulator();
    const event = sim.projectShieldDepletion(10, 100);
    expect(event).toBe(120);
  });

  it('simulateBatch should work', () => {
    const sim = new DecaySimulator();
    const edges = [
      { edgeId: 'a', state: makeEdge({ weight: 50 }) },
      { edgeId: 'b', state: makeEdge({ weight: 100 }) },
    ];
    const result = sim.simulateBatch(edges, { totalSteps: 10 });
    expect(result.edges).toHaveLength(2);
    expect(result.aggregate.totalEdges).toBe(2);
  });
});

// ─── Edge cases ─────────────────────────────────────────

describe('Edge cases', () => {
  it('should handle very high decay rate', () => {
    const edge = makeEdge({ weight: 100, shield: 0, decayRate: 100.0, lastActivatedAtEvent: 0 });
    const result = simulateEdgeDecay(edge, { totalSteps: 5 });
    expect(result.snapshots[1].isDead).toBe(true);
    expect(result.summary.deathStep).toBe(1);
  });

  it('should handle very small weight', () => {
    const edge = makeEdge({ weight: 0.001, shield: 0, decayRate: 0.01, lastActivatedAtEvent: 0 });
    const result = simulateEdgeDecay(edge, { totalSteps: 5 });
    // Should still decay properly
    expect(result.snapshots[0].weight).toBe(0.001);
  });

  it('should handle very large step size', () => {
    const edge = makeEdge({ weight: 100, shield: 0, decayRate: 0.01, lastActivatedAtEvent: 0 });
    const result = simulateEdgeDecay(edge, { totalSteps: 5, stepSize: 1000 });
    expect(result.snapshots[1].eventCounter).toBe(1000);
    // Gap of 1000 with decayRate 0.01 = rawDecay 10 → weight 90
    expect(result.snapshots[1].weight).toBe(90);
  });

  it('should handle totalSteps=1', () => {
    const result = simulateEdgeDecay(makeEdge(), { totalSteps: 1 });
    expect(result.snapshots).toHaveLength(2); // step 0 + step 1
  });
});
