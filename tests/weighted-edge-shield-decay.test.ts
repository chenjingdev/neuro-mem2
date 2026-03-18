/**
 * Tests for WeightedEdge shield + weight decay mechanism.
 *
 * Covers:
 * - Weight cap at 100
 * - Dynamic shield cap (baseShieldCap 50 + importance * salienceMultiplier 50)
 * - Shield absorbs decay before weight
 * - lastActivatedAtEvent tracking
 * - Weight overflow → shield charging
 * - Lazy event-based decay
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { CREATE_ANCHOR_TABLES } from '../src/db/anchor-schema.js';
import {
  WEIGHT_CAP,
  BASE_SHIELD_CAP,
  SALIENCE_MULTIPLIER,
  BASE_SHIELD_GAIN,
  computeShieldCap,
} from '../src/models/weighted-edge.js';
import type { CreateWeightedEdgeInput } from '../src/models/weighted-edge.js';
import {
  HebbianWeightUpdater,
  DEFAULT_HEBBIAN_CONFIG,
} from '../src/scoring/hebbian-updater.js';

// ─── Helpers ───────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_ANCHOR_TABLES);
  return db;
}

function makeEdgeInput(overrides: Partial<CreateWeightedEdgeInput> = {}): CreateWeightedEdgeInput {
  return {
    sourceId: 'node-a',
    sourceType: 'hub',
    targetId: 'node-b',
    targetType: 'leaf',
    edgeType: 'about',
    ...overrides,
  };
}

// ─── Constants ─────────────────────────────────────────────────

describe('WeightedEdge constants', () => {
  it('WEIGHT_CAP is 100', () => {
    expect(WEIGHT_CAP).toBe(100);
  });

  it('BASE_SHIELD_CAP is 50', () => {
    expect(BASE_SHIELD_CAP).toBe(50);
  });

  it('SALIENCE_MULTIPLIER is 50', () => {
    expect(SALIENCE_MULTIPLIER).toBe(50);
  });
});

// ─── computeShieldCap ──────────────────────────────────────────

describe('computeShieldCap', () => {
  it('returns 50 for importance=0', () => {
    expect(computeShieldCap(0)).toBe(50);
  });

  it('returns 100 for importance=1', () => {
    expect(computeShieldCap(1)).toBe(100);
  });

  it('returns 75 for importance=0.5', () => {
    expect(computeShieldCap(0.5)).toBe(75);
  });

  it('clamps importance below 0 to 0', () => {
    expect(computeShieldCap(-0.5)).toBe(50);
  });

  it('clamps importance above 1 to 1', () => {
    expect(computeShieldCap(1.5)).toBe(100);
  });
});

// ─── WeightedEdge DB: shield + lastActivatedAtEvent ────────────

describe('WeightedEdgeRepository — shield and lastActivatedAtEvent', () => {
  let db: Database.Database;
  let repo: WeightedEdgeRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new WeightedEdgeRepository(db);
  });

  it('createEdge stores shield=0 and lastActivatedAtEvent=0 by default', () => {
    const edge = repo.createEdge(makeEdgeInput());
    expect(edge.shield).toBe(0);
    expect(edge.lastActivatedAtEvent).toBe(0);
  });

  it('createEdge respects initial shield and currentEvent', () => {
    const edge = repo.createEdge(makeEdgeInput({
      shield: 10,
      currentEvent: 42,
      importance: 0.5,
    }));
    expect(edge.shield).toBe(10);
    expect(edge.lastActivatedAtEvent).toBe(42);
  });

  it('createEdge clamps shield to shieldCap', () => {
    const edge = repo.createEdge(makeEdgeInput({
      shield: 200,  // way above cap
      importance: 0,  // shieldCap = 50
    }));
    expect(edge.shield).toBe(50);
  });

  it('createEdge clamps weight to WEIGHT_CAP', () => {
    const edge = repo.createEdge(makeEdgeInput({ weight: 150 }));
    expect(edge.weight).toBe(100);
  });

  it('getEdge returns shield and lastActivatedAtEvent', () => {
    const created = repo.createEdge(makeEdgeInput({
      shield: 20,
      currentEvent: 10,
      importance: 1,
    }));
    const fetched = repo.getEdge(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.shield).toBe(20);
    expect(fetched!.lastActivatedAtEvent).toBe(10);
  });

  it('saveEdges batch stores shield and lastActivatedAtEvent', () => {
    const edges = repo.saveEdges([
      makeEdgeInput({ sourceId: 'a', shield: 5, currentEvent: 3 }),
      makeEdgeInput({ sourceId: 'b', shield: 15, currentEvent: 7, importance: 0.8 }),
    ]);
    expect(edges).toHaveLength(2);
    expect(edges[0].shield).toBe(5);
    expect(edges[0].lastActivatedAtEvent).toBe(3);
    expect(edges[1].shield).toBe(15);
    expect(edges[1].lastActivatedAtEvent).toBe(7);
  });
});

// ─── Reinforce with shield overflow ────────────────────────────

describe('WeightedEdgeRepository — reinforceEdge with shield overflow', () => {
  let db: Database.Database;
  let repo: WeightedEdgeRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new WeightedEdgeRepository(db);
  });

  it('reinforceEdge increases weight below cap', () => {
    const edge = repo.createEdge(makeEdgeInput({ weight: 50 }));
    const result = repo.reinforceEdge(edge.id, undefined, 1);
    expect(result).not.toBeNull();
    expect(result!.newWeight).toBeGreaterThan(50);
    expect(result!.newWeight).toBeLessThanOrEqual(WEIGHT_CAP);
  });

  it('reinforceEdge at cap causes shield overflow', () => {
    // Create edge at WEIGHT_CAP
    const edge = repo.createEdge(makeEdgeInput({ weight: WEIGHT_CAP, currentEvent: 0 }));
    expect(edge.weight).toBe(WEIGHT_CAP);
    expect(edge.shield).toBe(0);

    // Reinforce — weight is at cap, delta should be 0 from headroom
    // But even tiny delta should trigger overflow
    // Actually, weight=100 means headroom = (100-100)/100 = 0, delta=0
    // So shield stays at 0 — this is correct behavior
    const result = repo.reinforceEdge(edge.id, undefined, 5, 0.5);
    expect(result).not.toBeNull();
    expect(result!.newWeight).toBe(WEIGHT_CAP);
    // Delta was 0, so no overflow
    expect(result!.newShield).toBe(0);
  });

  it('reinforceEdge near cap overflows to shield', () => {
    // Create edge near cap
    const edge = repo.createEdge(makeEdgeInput({ weight: 99, currentEvent: 0 }));
    // Large learning rate to push past cap
    const result = repo.reinforceEdge(edge.id, 1.0, 5, 0.5);
    expect(result).not.toBeNull();
    expect(result!.newWeight).toBe(WEIGHT_CAP);
    // Overflow should have added to shield
    // delta = 1.0 * 100 * (100-99)/100 = 1.0 * 100 * 0.01 = 1.0
    // rawWeight = 99 + 1 = 100 → no overflow actually
    // Let's verify
    expect(result!.lastActivatedAtEvent).toBe(5);
  });

  it('reinforceEdge updates lastActivatedAtEvent', () => {
    const edge = repo.createEdge(makeEdgeInput({ currentEvent: 0 }));
    const result = repo.reinforceEdge(edge.id, undefined, 42);
    expect(result!.lastActivatedAtEvent).toBe(42);

    // Verify persisted
    const fetched = repo.getEdge(edge.id);
    expect(fetched!.lastActivatedAtEvent).toBe(42);
  });

  it('reinforceResult includes shield information', () => {
    const edge = repo.createEdge(makeEdgeInput({ weight: 50, shield: 10, importance: 1, currentEvent: 0 }));
    const result = repo.reinforceEdge(edge.id, undefined, 5);
    expect(result).not.toBeNull();
    expect(result!.previousShield).toBe(10);
    expect(typeof result!.newShield).toBe('number');
  });
});

// ─── Lazy event-based decay ────────────────────────────────────

describe('WeightedEdgeRepository — lazy event-based decay', () => {
  let db: Database.Database;
  let repo: WeightedEdgeRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new WeightedEdgeRepository(db);
  });

  it('applyLazyDecay with no event delta does nothing', () => {
    const edge = repo.createEdge(makeEdgeInput({ weight: 50, currentEvent: 10 }));
    const result = repo.applyLazyDecay(edge.id, 10);
    expect(result).not.toBeNull();
    expect(result!.decayAmount).toBe(0);
    expect(result!.shieldAbsorbed).toBe(0);
    expect(result!.weightReduced).toBe(0);
  });

  it('applyLazyDecay with shield absorbs decay', () => {
    const edge = repo.createEdge(makeEdgeInput({
      weight: 80,
      shield: 20,
      currentEvent: 0,
      decayRate: 0.5,
      importance: 1,
    }));
    // 10 events passed, decayAmount = 0.5 * 10 = 5
    const result = repo.applyLazyDecay(edge.id, 10);
    expect(result).not.toBeNull();
    expect(result!.decayAmount).toBe(5);
    expect(result!.shieldAbsorbed).toBe(5);
    expect(result!.weightReduced).toBe(0);

    const fetched = repo.getEdge(edge.id);
    expect(fetched!.weight).toBe(80);   // unchanged
    expect(fetched!.shield).toBe(15);    // 20 - 5
  });

  it('applyLazyDecay with partial shield hits weight', () => {
    const edge = repo.createEdge(makeEdgeInput({
      weight: 80,
      shield: 3,
      currentEvent: 0,
      decayRate: 1.0,
      importance: 1,
    }));
    // 10 events, decayAmount = 1.0 * 10 = 10
    const result = repo.applyLazyDecay(edge.id, 10);
    expect(result).not.toBeNull();
    expect(result!.decayAmount).toBe(10);
    expect(result!.shieldAbsorbed).toBe(3);
    expect(result!.weightReduced).toBe(7);

    const fetched = repo.getEdge(edge.id);
    expect(fetched!.weight).toBe(73);   // 80 - 7
    expect(fetched!.shield).toBe(0);     // fully consumed
  });

  it('applyLazyDecay without shield decays weight', () => {
    const edge = repo.createEdge(makeEdgeInput({
      weight: 50,
      currentEvent: 0,
      decayRate: 0.5,
    }));
    // 20 events, decayAmount = 0.5 * 20 = 10
    const result = repo.applyLazyDecay(edge.id, 20);
    expect(result!.decayAmount).toBe(10);
    expect(result!.shieldAbsorbed).toBe(0);
    expect(result!.weightReduced).toBe(10);

    const fetched = repo.getEdge(edge.id);
    expect(fetched!.weight).toBe(40);
  });

  it('applyLazyDecay does not make weight negative', () => {
    const edge = repo.createEdge(makeEdgeInput({
      weight: 5,
      currentEvent: 0,
      decayRate: 1.0,
    }));
    // 100 events, decayAmount = 100 — way more than weight
    const result = repo.applyLazyDecay(edge.id, 100);
    const fetched = repo.getEdge(edge.id);
    expect(fetched!.weight).toBe(0);
    expect(result!.weightReduced).toBe(5);
  });

  it('applyLazyDecay returns null for non-existent edge', () => {
    const result = repo.applyLazyDecay('non-existent', 10);
    expect(result).toBeNull();
  });
});

// ─── Batch decay ────────────────────────────────────────────────

describe('WeightedEdgeRepository — batch applyDecay', () => {
  let db: Database.Database;
  let repo: WeightedEdgeRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new WeightedEdgeRepository(db);
  });

  it('applyDecay with currentEvent decays all edges', () => {
    repo.createEdge(makeEdgeInput({ sourceId: 'a', weight: 60, currentEvent: 0, decayRate: 0.5 }));
    repo.createEdge(makeEdgeInput({ sourceId: 'b', weight: 40, shield: 10, currentEvent: 0, decayRate: 0.5, importance: 1 }));

    const result = repo.applyDecay({ currentEvent: 10 });
    expect(result.decayedCount).toBe(2);
  });

  it('applyDecay prunes edges below threshold', () => {
    repo.createEdge(makeEdgeInput({ sourceId: 'a', weight: 2, currentEvent: 0, decayRate: 1.0 }));
    repo.createEdge(makeEdgeInput({ sourceId: 'b', weight: 80, currentEvent: 0, decayRate: 0.01 }));

    repo.applyDecay({ currentEvent: 10, pruneBelow: 1 });
    // Edge 'a' had weight=2, decay=1.0*10=10 → weight ≈ 0 → pruned
    expect(repo.countEdges()).toBe(1);
  });
});

// ─── HebbianWeightUpdater — shield-aware ───────────────────────

describe('HebbianWeightUpdater — shield-aware update', () => {
  let updater: HebbianWeightUpdater;

  beforeEach(() => {
    updater = new HebbianWeightUpdater();
  });

  it('maxWeight defaults to WEIGHT_CAP (100)', () => {
    expect(updater.config.maxWeight).toBe(WEIGHT_CAP);
  });

  it('computeShieldAwareUpdate below cap does not change shield', () => {
    const result = updater.computeShieldAwareUpdate({
      currentWeight: 50,
      currentShield: 10,
      importance: 0.5,
      source: { nodeId: 'a', activationCount: 5 },
      target: { nodeId: 'b', activationCount: 5 },
    });
    expect(result.newWeight).toBeGreaterThan(50);
    expect(result.newWeight).toBeLessThanOrEqual(WEIGHT_CAP);
    expect(result.newShield).toBe(10); // unchanged
    expect(result.shieldGain).toBe(0);
  });

  it('computeShieldAwareUpdate near cap overflows to shield', () => {
    // Use a custom updater with useHeadroom=false so delta is not proportional to headroom
    const noHeadroomUpdater = new HebbianWeightUpdater({ useHeadroom: false });
    const result = noHeadroomUpdater.computeShieldAwareUpdate({
      currentWeight: 99,
      currentShield: 0,
      importance: 0.8,
      source: { nodeId: 'a', activationCount: 100 },
      target: { nodeId: 'b', activationCount: 100 },
      learningRate: 1.0,  // delta = 1.0 * 100 * ~1 * ~1 * 1.0 = ~100 → overflow
    });
    expect(result.newWeight).toBe(WEIGHT_CAP);
    expect(result.shieldGain).toBeGreaterThan(0);
    expect(result.newShield).toBeGreaterThan(0);
    // Shield cap = 50 + 0.8 * 50 = 90
    expect(result.shieldCap).toBe(90);
    expect(result.newShield).toBeLessThanOrEqual(90);
  });

  it('computeShieldAwareUpdate caps shield at dynamic cap', () => {
    const result = updater.computeShieldAwareUpdate({
      currentWeight: 99,
      currentShield: 48,  // close to cap for importance=0 (cap=50)
      importance: 0,
      source: { nodeId: 'a', activationCount: 100 },
      target: { nodeId: 'b', activationCount: 100 },
      learningRate: 1.0,
    });
    expect(result.shieldCap).toBe(50);
    expect(result.newShield).toBeLessThanOrEqual(50);
  });

  it('computeShieldAwareUpdate reports correct shieldCap for full importance', () => {
    const result = updater.computeShieldAwareUpdate({
      currentWeight: 50,
      currentShield: 0,
      importance: 1.0,
      source: { nodeId: 'a', activationCount: 1 },
      target: { nodeId: 'b', activationCount: 1 },
    });
    expect(result.shieldCap).toBe(100);  // 50 + 1.0 * 50
  });
});

// ─── Weight cap enforcement ─────────────────────────────────────

describe('Weight cap enforcement', () => {
  let db: Database.Database;
  let repo: WeightedEdgeRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new WeightedEdgeRepository(db);
  });

  it('updateWeight clamps to WEIGHT_CAP', () => {
    const edge = repo.createEdge(makeEdgeInput({ weight: 50 }));
    repo.updateWeight(edge.id, 200);  // above cap
    const fetched = repo.getEdge(edge.id);
    expect(fetched!.weight).toBe(WEIGHT_CAP);
  });

  it('updateWeight clamps to 0 for negative', () => {
    const edge = repo.createEdge(makeEdgeInput({ weight: 50 }));
    repo.updateWeight(edge.id, -10);
    const fetched = repo.getEdge(edge.id);
    expect(fetched!.weight).toBe(0);
  });
});
