/**
 * Tests for Decay Policy / Strategy Module
 *
 * Sub-AC 6.2: 시간 경과(time-based decay) 및 미사용(access-based decay)
 * 기준의 decay 정책/전략 모듈 구현
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TimeBasedDecayPolicy,
  AccessBasedDecayPolicy,
  CombinedDecayPolicy,
  NoDecayPolicy,
  DecayPolicyEngine,
  WeightedEdgeDecayAdapter,
  AnchorDecayAdapter,
  createTimeBasedPolicy,
  createAccessBasedPolicy,
  createCombinedPolicy,
  createNoDecayPolicy,
  DEFAULT_TIME_DECAY_CONFIG,
  DEFAULT_ACCESS_DECAY_CONFIG,
  DEFAULT_COMBINED_DECAY_CONFIG,
  type DecayableState,
  type DecayableItem,
  type DecayableRepository,
} from '../src/scoring/decay-policy.js';

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * ONE_DAY_MS;

function makeState(overrides: Partial<DecayableState> = {}): DecayableState {
  return {
    weight: 0.8,
    lastActivatedAt: new Date().toISOString(),
    activationCount: 5,
    decayRate: 0.01,
    ...overrides,
  };
}

function pastDate(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** In-memory mock repository for engine tests */
class MockDecayableRepo implements DecayableRepository {
  items: DecayableItem[] = [];
  updatedWeights: Map<string, number> = new Map();
  deletedIds: Set<string> = new Set();

  getDecayableItems(): DecayableItem[] {
    return this.items.filter(i => !this.deletedIds.has(i.id));
  }

  updateItemWeight(id: string, newWeight: number): void {
    this.updatedWeights.set(id, newWeight);
  }

  deleteItem(id: string): boolean {
    if (this.items.some(i => i.id === id)) {
      this.deletedIds.add(id);
      return true;
    }
    return false;
  }

  addItem(item: DecayableItem): void {
    this.items.push(item);
  }
}

// ────────────────────────────────────────────────────────
// TimeBasedDecayPolicy
// ────────────────────────────────────────────────────────

describe('TimeBasedDecayPolicy', () => {
  it('has correct name', () => {
    const policy = new TimeBasedDecayPolicy();
    expect(policy.name).toBe('time-based');
  });

  it('uses default config when none provided', () => {
    const policy = new TimeBasedDecayPolicy();
    expect(policy.getConfig()).toEqual(DEFAULT_TIME_DECAY_CONFIG);
  });

  it('merges partial config with defaults', () => {
    const policy = new TimeBasedDecayPolicy({ halfLifeMs: 7 * ONE_DAY_MS });
    expect(policy.getConfig().halfLifeMs).toBe(7 * ONE_DAY_MS);
    expect(policy.getConfig().minWeight).toBe(DEFAULT_TIME_DECAY_CONFIG.minWeight);
  });

  it('returns no decay for just-activated item', () => {
    const policy = new TimeBasedDecayPolicy();
    const now = new Date();
    const state = makeState({ lastActivatedAt: now.toISOString() });
    const result = policy.compute(state, now);

    expect(result.decayFactor).toBeCloseTo(1.0, 5);
    expect(result.newWeight).toBeCloseTo(state.weight, 3);
    expect(result.weightDelta).toBeCloseTo(0, 3);
    expect(result.policyName).toBe('time-based');
  });

  it('returns ~50% factor at exactly one half-life', () => {
    const policy = new TimeBasedDecayPolicy();
    const state = makeState({
      weight: 1.0,
      lastActivatedAt: pastDate(FOURTEEN_DAYS_MS),
    });
    const result = policy.compute(state);

    expect(result.decayFactor).toBeCloseTo(0.5, 3);
    expect(result.newWeight).toBeCloseTo(0.5, 3);
  });

  it('decays more for longer elapsed time', () => {
    const policy = new TimeBasedDecayPolicy();

    const recent = policy.compute(makeState({ lastActivatedAt: pastDate(1 * ONE_DAY_MS) }));
    const medium = policy.compute(makeState({ lastActivatedAt: pastDate(14 * ONE_DAY_MS) }));
    const old = policy.compute(makeState({ lastActivatedAt: pastDate(60 * ONE_DAY_MS) }));

    expect(recent.newWeight).toBeGreaterThan(medium.newWeight);
    expect(medium.newWeight).toBeGreaterThan(old.newWeight);
  });

  it('respects minimum weight floor', () => {
    const policy = new TimeBasedDecayPolicy({ minWeight: 0.05 });
    const state = makeState({
      weight: 0.06,
      lastActivatedAt: pastDate(200 * ONE_DAY_MS),
    });
    const result = policy.compute(state);

    expect(result.newWeight).toBeGreaterThanOrEqual(0.05);
  });

  it('marks item for pruning when below threshold', () => {
    const policy = new TimeBasedDecayPolicy({ pruneThreshold: 0.1 });
    const state = makeState({
      weight: 0.1,
      lastActivatedAt: pastDate(100 * ONE_DAY_MS),
    });
    const result = policy.compute(state);

    expect(result.shouldPrune).toBe(true);
  });

  it('higher edge decay rate causes faster decay', () => {
    const policy = new TimeBasedDecayPolicy();
    const lastActivated = pastDate(14 * ONE_DAY_MS);

    const slow = policy.compute(makeState({ lastActivatedAt: lastActivated, decayRate: 0.005 }));
    const normal = policy.compute(makeState({ lastActivatedAt: lastActivated, decayRate: 0.01 }));
    const fast = policy.compute(makeState({ lastActivatedAt: lastActivated, decayRate: 0.02 }));

    expect(fast.newWeight).toBeLessThan(normal.newWeight);
    expect(normal.newWeight).toBeLessThan(slow.newWeight);
  });

  it('custom half-life changes decay speed', () => {
    const shortLife = new TimeBasedDecayPolicy({ halfLifeMs: 3 * ONE_DAY_MS });
    const longLife = new TimeBasedDecayPolicy({ halfLifeMs: 30 * ONE_DAY_MS });

    const state = makeState({ lastActivatedAt: pastDate(7 * ONE_DAY_MS) });

    const shortResult = shortLife.compute(state);
    const longResult = longLife.compute(state);

    expect(shortResult.newWeight).toBeLessThan(longResult.newWeight);
  });
});

// ────────────────────────────────────────────────────────
// AccessBasedDecayPolicy
// ────────────────────────────────────────────────────────

describe('AccessBasedDecayPolicy', () => {
  it('has correct name', () => {
    const policy = new AccessBasedDecayPolicy();
    expect(policy.name).toBe('access-based');
  });

  it('uses default config when none provided', () => {
    const policy = new AccessBasedDecayPolicy();
    expect(policy.getConfig()).toEqual(DEFAULT_ACCESS_DECAY_CONFIG);
  });

  it('penalizes zero-activation items the most', () => {
    const policy = new AccessBasedDecayPolicy();
    const zeroAct = policy.compute(makeState({ activationCount: 0 }));
    const someAct = policy.compute(makeState({ activationCount: 5 }));
    const highAct = policy.compute(makeState({ activationCount: 100 }));

    expect(zeroAct.newWeight).toBeLessThan(someAct.newWeight);
    expect(someAct.newWeight).toBeLessThan(highAct.newWeight);
  });

  it('returns policyName as access-based', () => {
    const policy = new AccessBasedDecayPolicy();
    const result = policy.compute(makeState());
    expect(result.policyName).toBe('access-based');
  });

  it('high activation count approaches no penalty', () => {
    const policy = new AccessBasedDecayPolicy();
    const result = policy.compute(makeState({ activationCount: 10000 }));

    // Factor should be very close to 1.0
    expect(result.decayFactor).toBeGreaterThan(0.999);
    expect(result.newWeight).toBeCloseTo(0.8, 2);
  });

  it('includes accessCount when configured', () => {
    const withAccess = new AccessBasedDecayPolicy({ includeAccessCount: true });
    const withoutAccess = new AccessBasedDecayPolicy({ includeAccessCount: false });

    const state = makeState({
      activationCount: 2,
      accessCount: 50,
    });

    const withResult = withAccess.compute(state);
    const withoutResult = withoutAccess.compute(state);

    // Including accessCount should result in less decay (more "usage")
    expect(withResult.newWeight).toBeGreaterThan(withoutResult.newWeight);
  });

  it('is time-independent (ignores lastActivatedAt)', () => {
    const policy = new AccessBasedDecayPolicy();

    const recent = policy.compute(makeState({
      lastActivatedAt: pastDate(1 * ONE_DAY_MS),
      activationCount: 5,
    }));
    const old = policy.compute(makeState({
      lastActivatedAt: pastDate(100 * ONE_DAY_MS),
      activationCount: 5,
    }));

    // Same activation count, different time — should produce same result
    expect(recent.newWeight).toBeCloseTo(old.newWeight, 10);
    expect(recent.decayFactor).toBeCloseTo(old.decayFactor, 10);
  });

  it('respects min weight floor', () => {
    const policy = new AccessBasedDecayPolicy({ minWeight: 0.1, usageDecayRate: 0.9 });
    const state = makeState({ weight: 0.1, activationCount: 0 });
    const result = policy.compute(state);

    expect(result.newWeight).toBeGreaterThanOrEqual(0.1);
  });

  it('higher usageDecayRate increases penalty', () => {
    const mild = new AccessBasedDecayPolicy({ usageDecayRate: 0.1 });
    const harsh = new AccessBasedDecayPolicy({ usageDecayRate: 0.5 });

    const state = makeState({ activationCount: 2 });

    const mildResult = mild.compute(state);
    const harshResult = harsh.compute(state);

    expect(harshResult.newWeight).toBeLessThan(mildResult.newWeight);
  });
});

// ────────────────────────────────────────────────────────
// CombinedDecayPolicy
// ────────────────────────────────────────────────────────

describe('CombinedDecayPolicy', () => {
  it('has correct name', () => {
    const policy = new CombinedDecayPolicy();
    expect(policy.name).toBe('combined');
  });

  it('uses default config when none provided', () => {
    const policy = new CombinedDecayPolicy();
    expect(policy.getConfig()).toEqual(DEFAULT_COMBINED_DECAY_CONFIG);
  });

  it('old + unused items decay the most', () => {
    const policy = new CombinedDecayPolicy();

    const oldUnused = policy.compute(makeState({
      lastActivatedAt: pastDate(60 * ONE_DAY_MS),
      activationCount: 0,
    }));
    const recentUnused = policy.compute(makeState({
      lastActivatedAt: pastDate(1 * ONE_DAY_MS),
      activationCount: 0,
    }));
    const oldUsed = policy.compute(makeState({
      lastActivatedAt: pastDate(60 * ONE_DAY_MS),
      activationCount: 100,
    }));

    expect(oldUnused.newWeight).toBeLessThan(recentUnused.newWeight);
    expect(oldUnused.newWeight).toBeLessThan(oldUsed.newWeight);
  });

  it('recent + frequently used items barely decay', () => {
    const policy = new CombinedDecayPolicy();
    const now = new Date();
    const result = policy.compute(makeState({
      weight: 0.9,
      lastActivatedAt: pastDate(1 * ONE_DAY_MS),
      activationCount: 100,
    }), now);

    expect(result.newWeight).toBeGreaterThan(0.85);
    expect(result.shouldPrune).toBe(false);
  });

  it('timeWeight=1 makes it equivalent to time-only', () => {
    const combined = new CombinedDecayPolicy({ timeWeight: 1.0 });
    const timeOnly = new TimeBasedDecayPolicy();

    const state = makeState({
      lastActivatedAt: pastDate(14 * ONE_DAY_MS),
      activationCount: 5,
    });
    const now = new Date();

    const combinedResult = combined.compute(state, now);
    const timeResult = timeOnly.compute(state, now);

    expect(combinedResult.newWeight).toBeCloseTo(timeResult.newWeight, 3);
  });

  it('timeWeight=0 makes it equivalent to access-only', () => {
    const combined = new CombinedDecayPolicy({ timeWeight: 0.0 });
    const accessOnly = new AccessBasedDecayPolicy();

    const state = makeState({
      lastActivatedAt: pastDate(14 * ONE_DAY_MS),
      activationCount: 5,
    });
    const now = new Date();

    const combinedResult = combined.compute(state, now);
    const accessResult = accessOnly.compute(state, now);

    expect(combinedResult.newWeight).toBeCloseTo(accessResult.newWeight, 3);
  });

  it('includes accessCount when configured', () => {
    const withAccess = new CombinedDecayPolicy({ includeAccessCount: true });
    const withoutAccess = new CombinedDecayPolicy({ includeAccessCount: false });

    const state = makeState({
      activationCount: 2,
      accessCount: 30,
      lastActivatedAt: pastDate(7 * ONE_DAY_MS),
    });

    const withResult = withAccess.compute(state);
    const withoutResult = withoutAccess.compute(state);

    expect(withResult.newWeight).toBeGreaterThan(withoutResult.newWeight);
  });
});

// ────────────────────────────────────────────────────────
// NoDecayPolicy
// ────────────────────────────────────────────────────────

describe('NoDecayPolicy', () => {
  it('has correct name', () => {
    expect(new NoDecayPolicy().name).toBe('none');
  });

  it('returns weight unchanged', () => {
    const policy = new NoDecayPolicy();
    const state = makeState({ weight: 0.42 });
    const result = policy.compute(state);

    expect(result.newWeight).toBe(0.42);
    expect(result.decayFactor).toBe(1.0);
    expect(result.shouldPrune).toBe(false);
    expect(result.weightDelta).toBe(0);
    expect(result.policyName).toBe('none');
  });

  it('works for any input regardless of time or usage', () => {
    const policy = new NoDecayPolicy();
    const state = makeState({
      weight: 0.01,
      lastActivatedAt: pastDate(365 * ONE_DAY_MS),
      activationCount: 0,
    });
    const result = policy.compute(state);
    expect(result.newWeight).toBe(0.01);
  });
});

// ────────────────────────────────────────────────────────
// Factory Functions
// ────────────────────────────────────────────────────────

describe('Factory functions', () => {
  it('createTimeBasedPolicy returns TimeBasedDecayPolicy', () => {
    const policy = createTimeBasedPolicy({ halfLifeMs: 7 * ONE_DAY_MS });
    expect(policy).toBeInstanceOf(TimeBasedDecayPolicy);
    expect(policy.getConfig().halfLifeMs).toBe(7 * ONE_DAY_MS);
  });

  it('createAccessBasedPolicy returns AccessBasedDecayPolicy', () => {
    const policy = createAccessBasedPolicy({ usageDecayRate: 0.5 });
    expect(policy).toBeInstanceOf(AccessBasedDecayPolicy);
    expect(policy.getConfig().usageDecayRate).toBe(0.5);
  });

  it('createCombinedPolicy returns CombinedDecayPolicy', () => {
    const policy = createCombinedPolicy({ timeWeight: 0.5 });
    expect(policy).toBeInstanceOf(CombinedDecayPolicy);
    expect(policy.getConfig().timeWeight).toBe(0.5);
  });

  it('createNoDecayPolicy returns NoDecayPolicy', () => {
    const policy = createNoDecayPolicy();
    expect(policy).toBeInstanceOf(NoDecayPolicy);
  });
});

// ────────────────────────────────────────────────────────
// DecayPolicyEngine
// ────────────────────────────────────────────────────────

describe('DecayPolicyEngine', () => {
  let repo: MockDecayableRepo;

  beforeEach(() => {
    repo = new MockDecayableRepo();
  });

  function addTestItems() {
    repo.addItem({
      id: 'e1',
      weight: 0.8,
      lastActivatedAt: pastDate(7 * ONE_DAY_MS),
      activationCount: 10,
      decayRate: 0.01,
    });
    repo.addItem({
      id: 'e2',
      weight: 0.5,
      lastActivatedAt: pastDate(30 * ONE_DAY_MS),
      activationCount: 0,
      decayRate: 0.01,
    });
    repo.addItem({
      id: 'e3',
      weight: 0.1,
      lastActivatedAt: pastDate(60 * ONE_DAY_MS),
      activationCount: 1,
      decayRate: 0.02,
    });
    // Item with zero decay rate — should be skipped
    repo.addItem({
      id: 'e4',
      weight: 0.9,
      lastActivatedAt: pastDate(90 * ONE_DAY_MS),
      activationCount: 0,
      decayRate: 0.0,
    });
  }

  it('processes all decayable items (skipping zero decay rate)', () => {
    addTestItems();
    const policy = new CombinedDecayPolicy();
    const engine = new DecayPolicyEngine(policy, repo);

    const { summary } = engine.execute();

    // 3 items processed (e4 skipped because decayRate = 0)
    expect(summary.totalProcessed).toBe(3);
    expect(summary.policyName).toBe('combined');
    expect(summary.computedAt).toBeDefined();
  });

  it('updates repo weights when not dry run', () => {
    addTestItems();
    const policy = new CombinedDecayPolicy();
    const engine = new DecayPolicyEngine(policy, repo);

    engine.execute();

    // All decayed items should have been updated
    expect(repo.updatedWeights.size).toBeGreaterThan(0);
    expect(repo.updatedWeights.has('e4')).toBe(false); // skipped
  });

  it('does not update repo weights in dry run mode', () => {
    addTestItems();
    const policy = new CombinedDecayPolicy();
    const engine = new DecayPolicyEngine(policy, repo);

    const { summary } = engine.execute({ dryRun: true });

    expect(summary.totalProcessed).toBe(3);
    expect(repo.updatedWeights.size).toBe(0);
    expect(repo.deletedIds.size).toBe(0);
  });

  it('prunes items when prune=true', () => {
    repo.addItem({
      id: 'old-weak',
      weight: 0.06,
      lastActivatedAt: pastDate(100 * ONE_DAY_MS),
      activationCount: 0,
      decayRate: 0.01,
    });

    const policy = new CombinedDecayPolicy({ pruneThreshold: 0.05 });
    const engine = new DecayPolicyEngine(policy, repo);

    const { summary } = engine.execute({ prune: true });

    expect(summary.pruneCount).toBe(1);
    expect(summary.pruneIds).toContain('old-weak');
    expect(repo.deletedIds.has('old-weak')).toBe(true);
  });

  it('does not prune items when prune=false (default)', () => {
    repo.addItem({
      id: 'old-weak',
      weight: 0.06,
      lastActivatedAt: pastDate(100 * ONE_DAY_MS),
      activationCount: 0,
      decayRate: 0.01,
    });

    const policy = new CombinedDecayPolicy({ pruneThreshold: 0.05 });
    const engine = new DecayPolicyEngine(policy, repo);

    const { summary } = engine.execute();

    expect(summary.pruneCount).toBe(1); // marked, but not deleted
    expect(repo.deletedIds.size).toBe(0);
  });

  it('handles empty repository', () => {
    const policy = new CombinedDecayPolicy();
    const engine = new DecayPolicyEngine(policy, repo);

    const { items, summary } = engine.execute();

    expect(items).toHaveLength(0);
    expect(summary.totalProcessed).toBe(0);
    expect(summary.decayedCount).toBe(0);
    expect(summary.averageDecayFactor).toBe(1.0);
  });

  it('returns per-item results with correct data', () => {
    repo.addItem({
      id: 'single',
      weight: 0.8,
      lastActivatedAt: pastDate(14 * ONE_DAY_MS),
      activationCount: 5,
      decayRate: 0.01,
    });

    const policy = new TimeBasedDecayPolicy();
    const engine = new DecayPolicyEngine(policy, repo);

    const { items } = engine.execute();

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('single');
    expect(items[0].previousWeight).toBe(0.8);
    expect(items[0].result.newWeight).toBeLessThan(0.8);
    expect(items[0].result.policyName).toBe('time-based');
  });

  it('accepts custom now parameter', () => {
    repo.addItem({
      id: 'e1',
      weight: 0.8,
      lastActivatedAt: '2025-01-01T00:00:00.000Z',
      activationCount: 5,
      decayRate: 0.01,
    });

    const policy = new TimeBasedDecayPolicy();
    const engine = new DecayPolicyEngine(policy, repo);

    // 14 days after lastActivatedAt -> ~50% factor
    const now14d = new Date('2025-01-15T00:00:00.000Z');
    const { items: items14 } = engine.execute({ now: now14d, dryRun: true });
    expect(items14[0].result.decayFactor).toBeCloseTo(0.5, 2);

    // 28 days after -> ~25% factor
    const now28d = new Date('2025-01-29T00:00:00.000Z');
    const { items: items28 } = engine.execute({ now: now28d, dryRun: true });
    expect(items28[0].result.decayFactor).toBeCloseTo(0.25, 2);
  });

  it('getPolicy returns the engine policy', () => {
    const policy = new CombinedDecayPolicy();
    const engine = new DecayPolicyEngine(policy, repo);
    expect(engine.getPolicy()).toBe(policy);
  });

  it('correctly computes summary.averageDecayFactor', () => {
    repo.addItem({
      id: 'a',
      weight: 0.8,
      lastActivatedAt: pastDate(7 * ONE_DAY_MS),
      activationCount: 5,
      decayRate: 0.01,
    });
    repo.addItem({
      id: 'b',
      weight: 0.5,
      lastActivatedAt: pastDate(14 * ONE_DAY_MS),
      activationCount: 0,
      decayRate: 0.01,
    });

    const policy = new TimeBasedDecayPolicy();
    const engine = new DecayPolicyEngine(policy, repo);

    const { items, summary } = engine.execute({ dryRun: true });

    const expectedAvg = (items[0].result.decayFactor + items[1].result.decayFactor) / 2;
    expect(summary.averageDecayFactor).toBeCloseTo(expectedAvg, 3);
  });
});

// ────────────────────────────────────────────────────────
// Policy Switching: same data, different policies
// ────────────────────────────────────────────────────────

describe('Policy switching (strategy pattern)', () => {
  let repo: MockDecayableRepo;

  beforeEach(() => {
    repo = new MockDecayableRepo();
    repo.addItem({
      id: 'item1',
      weight: 0.8,
      lastActivatedAt: pastDate(14 * ONE_DAY_MS),
      activationCount: 3,
      decayRate: 0.01,
    });
  });

  it('different policies produce different results for same data', () => {
    const now = new Date();

    const timeEngine = new DecayPolicyEngine(new TimeBasedDecayPolicy(), repo);
    const accessEngine = new DecayPolicyEngine(new AccessBasedDecayPolicy(), repo);
    const combinedEngine = new DecayPolicyEngine(new CombinedDecayPolicy(), repo);
    const noEngine = new DecayPolicyEngine(new NoDecayPolicy(), repo);

    const timeResult = timeEngine.execute({ dryRun: true, now }).items[0].result;
    const accessResult = accessEngine.execute({ dryRun: true, now }).items[0].result;
    const combinedResult = combinedEngine.execute({ dryRun: true, now }).items[0].result;
    const noResult = noEngine.execute({ dryRun: true, now }).items[0].result;

    // NoDecay should keep original weight
    expect(noResult.newWeight).toBe(0.8);

    // All policies should report different decay factors
    expect(timeResult.policyName).toBe('time-based');
    expect(accessResult.policyName).toBe('access-based');
    expect(combinedResult.policyName).toBe('combined');
    expect(noResult.policyName).toBe('none');

    // Time-based and access-based should produce different factors
    expect(timeResult.decayFactor).not.toBeCloseTo(accessResult.decayFactor, 3);
  });
});

// ────────────────────────────────────────────────────────
// Integration: decay simulation over time
// ────────────────────────────────────────────────────────

describe('Decay simulation over time', () => {
  it('combined policy monotonically decreases weight over time', () => {
    const policy = new CombinedDecayPolicy();
    const baseTime = new Date('2025-01-01T00:00:00.000Z');
    const weights: number[] = [];

    for (let day = 0; day <= 60; day += 5) {
      const state = makeState({
        weight: 0.8,
        lastActivatedAt: baseTime.toISOString(),
        activationCount: 3,
      });
      const now = new Date(baseTime.getTime() + day * ONE_DAY_MS);
      const result = policy.compute(state, now);
      weights.push(result.newWeight);
    }

    // Verify monotonically decreasing
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThanOrEqual(weights[i - 1]);
    }
  });

  it('frequently-used items retain more weight than unused', () => {
    const policy = new CombinedDecayPolicy();
    const thirtyDaysAgo = pastDate(30 * ONE_DAY_MS);

    const used = policy.compute(makeState({
      weight: 0.8,
      lastActivatedAt: thirtyDaysAgo,
      activationCount: 50,
    }));

    const unused = policy.compute(makeState({
      weight: 0.8,
      lastActivatedAt: thirtyDaysAgo,
      activationCount: 0,
    }));

    expect(used.newWeight).toBeGreaterThan(unused.newWeight);
  });

  it('recently created but never used item decays quickly with combined policy', () => {
    const policy = new CombinedDecayPolicy();
    const result = policy.compute(makeState({
      weight: 0.5,
      lastActivatedAt: pastDate(7 * ONE_DAY_MS),
      activationCount: 0,
    }));

    // Low usage amplifies time decay
    expect(result.newWeight).toBeLessThan(0.5);
    expect(result.weightDelta).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────
// WeightedEdgeDecayAdapter (interface contract)
// ────────────────────────────────────────────────────────

describe('WeightedEdgeDecayAdapter', () => {
  it('adapts a mock repo to DecayableRepository interface', () => {
    const mockEdgeRepo = {
      queryEdges: () => [
        {
          id: 'we1',
          weight: 0.7,
          lastActivatedAt: '2025-01-01T00:00:00.000Z',
          activationCount: 3,
          decayRate: 0.01,
          createdAt: '2024-12-01T00:00:00.000Z',
        },
      ],
      updateWeight: (_id: string, _w: number) => {},
      deleteEdge: (_id: string) => true,
    };

    const adapter = new WeightedEdgeDecayAdapter(mockEdgeRepo);
    const items = adapter.getDecayableItems();

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('we1');
    expect(items[0].weight).toBe(0.7);
    expect(items[0].lastActivatedAt).toBe('2025-01-01T00:00:00.000Z');
    expect(items[0].activationCount).toBe(3);
    expect(items[0].decayRate).toBe(0.01);
  });

  it('falls back to createdAt when lastActivatedAt is missing', () => {
    const mockEdgeRepo = {
      queryEdges: () => [
        {
          id: 'we2',
          weight: 0.5,
          lastActivatedAt: undefined,
          activationCount: 0,
          decayRate: 0.01,
          createdAt: '2024-12-01T00:00:00.000Z',
        },
      ],
      updateWeight: () => {},
      deleteEdge: () => true,
    };

    const adapter = new WeightedEdgeDecayAdapter(mockEdgeRepo);
    const items = adapter.getDecayableItems();
    expect(items[0].lastActivatedAt).toBe('2024-12-01T00:00:00.000Z');
  });
});

// ────────────────────────────────────────────────────────
// AnchorDecayAdapter (interface contract)
// ────────────────────────────────────────────────────────

describe('AnchorDecayAdapter', () => {
  it('adapts a mock anchor repo to DecayableRepository interface', () => {
    const mockAnchorRepo = {
      listAnchors: () => [
        {
          id: 'a1',
          currentWeight: 0.6,
          lastActivatedAt: '2025-01-10T00:00:00.000Z',
          activationCount: 5,
          lastAccessedAt: '2025-01-12T00:00:00.000Z',
          accessCount: 8,
        },
      ],
      getAnchor: () => ({
        decayRate: 0.02,
        createdAt: '2025-01-01T00:00:00.000Z',
      }),
      updateAnchor: () => ({}),
      deleteAnchor: () => true,
    };

    const adapter = new AnchorDecayAdapter(mockAnchorRepo);
    const items = adapter.getDecayableItems();

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('a1');
    expect(items[0].weight).toBe(0.6);
    expect(items[0].decayRate).toBe(0.02);
    expect(items[0].accessCount).toBe(8);
    expect(items[0].lastAccessedAt).toBe('2025-01-12T00:00:00.000Z');
  });
});
