/**
 * Decay Policy / Strategy Module
 *
 * Provides a pluggable strategy pattern for decay computation on
 * weighted edges and anchors. Each policy encapsulates a specific
 * decay behavior (time-based, access-based, or combined) and can
 * be swapped or composed at runtime.
 *
 * Design:
 * - `DecayPolicy` interface — a pure function from edge state → new weight
 * - `TimeBasedDecayPolicy` — exponential decay based on time since last activation
 * - `AccessBasedDecayPolicy` — penalizes infrequently accessed/activated edges
 * - `CombinedDecayPolicy` — weighted geometric mean of time + access signals
 * - `DecayPolicyEngine` — applies a policy across repos, collecting results
 *
 * Usage:
 *   const policy = createCombinedPolicy({ timeHalfLifeMs: 7 * DAY });
 *   const engine = new DecayPolicyEngine(policy, weightedEdgeRepo, anchorRepo);
 *   const result = engine.applyToAllEdges();
 */

import {
  computeTimeDecay,
  computeUsageDecay,
  computeCombinedDecayFactor,
  DEFAULT_DECAY_CONFIG,
} from './anchor-decay.js';

// ────────────────────────────────────────────────────────
// Core Types
// ────────────────────────────────────────────────────────

/**
 * Snapshot of an edge or anchor's decay-relevant state.
 * This is the universal input for all decay policies.
 */
export interface DecayableState {
  /** Current weight [0, 1] */
  weight: number;
  /** ISO 8601 timestamp of last activation (or creation if never activated) */
  lastActivatedAt: string;
  /** Number of times activated / co-activated */
  activationCount: number;
  /** Per-edge decay rate (scales effective half-life; default 0.01) */
  decayRate: number;
  /** ISO 8601 timestamp of last retrieval access (may differ from activation) */
  lastAccessedAt?: string;
  /** Number of times accessed during retrieval queries */
  accessCount?: number;
}

/**
 * Result of applying a decay policy to a single item.
 */
export interface DecayPolicyResult {
  /** New weight after decay (clamped to [minWeight, 1]) */
  newWeight: number;
  /** Decay factor applied (0–1, where 1 = no decay) */
  decayFactor: number;
  /** Whether the item should be pruned */
  shouldPrune: boolean;
  /** Weight lost */
  weightDelta: number;
  /** Name of the policy that produced this result */
  policyName: string;
}

/**
 * A DecayPolicy computes a decayed weight from the current state of
 * an edge or anchor. Policies are pure functions (no side effects)
 * and composable.
 */
export interface DecayPolicy {
  /** Human-readable name for logging / debugging */
  readonly name: string;

  /**
   * Compute decay for a single item.
   *
   * @param state - Current decay-relevant state
   * @param now - Reference timestamp for elapsed-time computation
   * @returns Decay result with new weight and metadata
   */
  compute(state: DecayableState, now?: Date): DecayPolicyResult;
}

// ────────────────────────────────────────────────────────
// Configuration Types
// ────────────────────────────────────────────────────────

export interface TimeBasedDecayConfig {
  /**
   * Half-life in milliseconds.
   * After this duration without activation, weight drops to 50%.
   * Default: 14 days
   */
  halfLifeMs: number;
  /** Minimum weight floor (default: 0.01) */
  minWeight: number;
  /** Prune threshold — items below this are marked for removal (default: 0.05) */
  pruneThreshold: number;
}

export interface AccessBasedDecayConfig {
  /**
   * Base penalty rate for low usage (0–1).
   * Higher values penalize infrequent access more.
   * Default: 0.3
   */
  usageDecayRate: number;
  /**
   * Whether to also consider access count (not just activation count).
   * When true, accessCount is added to activationCount for resistance calculation.
   * Default: false
   */
  includeAccessCount: boolean;
  /** Minimum weight floor (default: 0.01) */
  minWeight: number;
  /** Prune threshold (default: 0.05) */
  pruneThreshold: number;
}

export interface CombinedDecayConfig {
  /** Time-based half-life in milliseconds (default: 14 days) */
  halfLifeMs: number;
  /** Base usage decay rate (default: 0.3) */
  usageDecayRate: number;
  /**
   * Weight of time signal in the combination (0–1).
   * Usage weight = 1 - timeWeight.
   * Default: 0.7
   */
  timeWeight: number;
  /** Include accessCount in usage computation (default: false) */
  includeAccessCount: boolean;
  /** Minimum weight floor (default: 0.01) */
  minWeight: number;
  /** Prune threshold (default: 0.05) */
  pruneThreshold: number;
}

// ────────────────────────────────────────────────────────
// Default Configurations
// ────────────────────────────────────────────────────────

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export const DEFAULT_TIME_DECAY_CONFIG: TimeBasedDecayConfig = {
  halfLifeMs: FOURTEEN_DAYS_MS,
  minWeight: 0.01,
  pruneThreshold: 0.05,
};

export const DEFAULT_ACCESS_DECAY_CONFIG: AccessBasedDecayConfig = {
  usageDecayRate: 0.3,
  includeAccessCount: false,
  minWeight: 0.01,
  pruneThreshold: 0.05,
};

export const DEFAULT_COMBINED_DECAY_CONFIG: CombinedDecayConfig = {
  halfLifeMs: FOURTEEN_DAYS_MS,
  usageDecayRate: 0.3,
  timeWeight: 0.7,
  includeAccessCount: false,
  minWeight: 0.01,
  pruneThreshold: 0.05,
};

// ────────────────────────────────────────────────────────
// TimeBasedDecayPolicy
// ────────────────────────────────────────────────────────

/**
 * Exponential time-based decay.
 *
 * Uses the half-life formula: factor = exp(-ln(2) * elapsed / halfLife)
 * Edges that haven't been activated recently decay toward 0.
 * Per-edge decayRate scales the effective half-life (higher rate = faster decay).
 */
export class TimeBasedDecayPolicy implements DecayPolicy {
  readonly name = 'time-based';
  private readonly config: TimeBasedDecayConfig;

  constructor(config?: Partial<TimeBasedDecayConfig>) {
    this.config = { ...DEFAULT_TIME_DECAY_CONFIG, ...config };
  }

  compute(state: DecayableState, now: Date = new Date()): DecayPolicyResult {
    const nowMs = now.getTime();
    const lastMs = new Date(state.lastActivatedAt).getTime();
    const elapsedMs = Math.max(0, nowMs - lastMs);

    const decayFactor = computeTimeDecay(
      elapsedMs,
      this.config.halfLifeMs,
      state.decayRate,
    );

    const rawWeight = state.weight * decayFactor;
    const newWeight = Math.max(this.config.minWeight, Math.min(1.0, rawWeight));

    return {
      newWeight,
      decayFactor,
      shouldPrune: newWeight < this.config.pruneThreshold,
      weightDelta: state.weight - newWeight,
      policyName: this.name,
    };
  }

  getConfig(): Readonly<TimeBasedDecayConfig> {
    return this.config;
  }
}

// ────────────────────────────────────────────────────────
// AccessBasedDecayPolicy
// ────────────────────────────────────────────────────────

/**
 * Access/usage-based decay.
 *
 * Penalizes edges that have been rarely activated or accessed.
 * Formula: factor = 1 - usageDecayRate * (1 / (1 + effectiveCount))
 *
 * Frequently accessed edges resist decay; rarely accessed edges are penalized.
 * This is a stateless (non-temporal) policy — it only looks at counts.
 */
export class AccessBasedDecayPolicy implements DecayPolicy {
  readonly name = 'access-based';
  private readonly config: AccessBasedDecayConfig;

  constructor(config?: Partial<AccessBasedDecayConfig>) {
    this.config = { ...DEFAULT_ACCESS_DECAY_CONFIG, ...config };
  }

  compute(state: DecayableState, _now?: Date): DecayPolicyResult {
    const effectiveCount = this.config.includeAccessCount
      ? state.activationCount + (state.accessCount ?? 0)
      : state.activationCount;

    const decayFactor = computeUsageDecay(effectiveCount, this.config.usageDecayRate);

    const rawWeight = state.weight * decayFactor;
    const newWeight = Math.max(this.config.minWeight, Math.min(1.0, rawWeight));

    return {
      newWeight,
      decayFactor,
      shouldPrune: newWeight < this.config.pruneThreshold,
      weightDelta: state.weight - newWeight,
      policyName: this.name,
    };
  }

  getConfig(): Readonly<AccessBasedDecayConfig> {
    return this.config;
  }
}

// ────────────────────────────────────────────────────────
// CombinedDecayPolicy
// ────────────────────────────────────────────────────────

/**
 * Combined time + access decay using weighted geometric mean.
 *
 * combinedFactor = timeFactor^timeWeight * usageFactor^(1 - timeWeight)
 *
 * This ensures:
 * - Old but frequently used connections persist
 * - Recently created but unused connections fade
 * - Neither signal completely dominates
 */
export class CombinedDecayPolicy implements DecayPolicy {
  readonly name = 'combined';
  private readonly config: CombinedDecayConfig;

  constructor(config?: Partial<CombinedDecayConfig>) {
    this.config = { ...DEFAULT_COMBINED_DECAY_CONFIG, ...config };
  }

  compute(state: DecayableState, now: Date = new Date()): DecayPolicyResult {
    const nowMs = now.getTime();
    const lastMs = new Date(state.lastActivatedAt).getTime();
    const elapsedMs = Math.max(0, nowMs - lastMs);

    // Time signal
    const timeFactor = computeTimeDecay(
      elapsedMs,
      this.config.halfLifeMs,
      state.decayRate,
    );

    // Usage signal
    const effectiveCount = this.config.includeAccessCount
      ? state.activationCount + (state.accessCount ?? 0)
      : state.activationCount;

    const usageFactor = computeUsageDecay(effectiveCount, this.config.usageDecayRate);

    // Combine
    const combinedFactor = computeCombinedDecayFactor(
      timeFactor,
      usageFactor,
      this.config.timeWeight,
    );

    const rawWeight = state.weight * combinedFactor;
    const newWeight = Math.max(this.config.minWeight, Math.min(1.0, rawWeight));

    return {
      newWeight,
      decayFactor: combinedFactor,
      shouldPrune: newWeight < this.config.pruneThreshold,
      weightDelta: state.weight - newWeight,
      policyName: this.name,
    };
  }

  getConfig(): Readonly<CombinedDecayConfig> {
    return this.config;
  }
}

// ────────────────────────────────────────────────────────
// NoDecayPolicy (null object for testing / permanent items)
// ────────────────────────────────────────────────────────

/**
 * No-op decay policy — items retain their current weight.
 * Useful for marking certain edges or anchors as permanent.
 */
export class NoDecayPolicy implements DecayPolicy {
  readonly name = 'none';

  compute(state: DecayableState): DecayPolicyResult {
    return {
      newWeight: state.weight,
      decayFactor: 1.0,
      shouldPrune: false,
      weightDelta: 0,
      policyName: this.name,
    };
  }
}

// ────────────────────────────────────────────────────────
// DecayPolicyEngine — applies policies to edge/anchor repos
// ────────────────────────────────────────────────────────

/** Result item from an engine decay pass */
export interface EngineDecayItem {
  id: string;
  previousWeight: number;
  result: DecayPolicyResult;
}

/** Summary of an engine decay pass */
export interface EngineDecaySummary {
  /** Total items processed */
  totalProcessed: number;
  /** Items whose weight actually changed */
  decayedCount: number;
  /** Items marked for pruning */
  pruneCount: number;
  /** IDs of items to prune */
  pruneIds: string[];
  /** Average decay factor */
  averageDecayFactor: number;
  /** Policy name used */
  policyName: string;
  /** Timestamp of computation */
  computedAt: string;
}

/**
 * Interface for a repository that supports policy-based decay.
 * Both WeightedEdgeRepository and AnchorRepository can be adapted to this.
 */
export interface DecayableRepository {
  /**
   * Get all items that are candidates for decay.
   * Each item must provide: id, weight, lastActivatedAt, activationCount, decayRate.
   */
  getDecayableItems(): DecayableItem[];

  /**
   * Update the weight of a single item.
   */
  updateItemWeight(id: string, newWeight: number): void;

  /**
   * Delete an item by ID (for pruning).
   */
  deleteItem(id: string): boolean;
}

/** Minimal decay-relevant data from a repository item */
export interface DecayableItem {
  id: string;
  weight: number;
  lastActivatedAt: string;
  activationCount: number;
  decayRate: number;
  lastAccessedAt?: string;
  accessCount?: number;
}

/**
 * DecayPolicyEngine applies a DecayPolicy across all items in a repository.
 *
 * It separates the "what to decay" (policy) from "where to decay" (repository),
 * enabling the same policy to be applied to both edges and anchors.
 *
 * Usage:
 *   const policy = new CombinedDecayPolicy({ halfLifeMs: 7 * DAY });
 *   const adapter = new WeightedEdgeDecayAdapter(weightedEdgeRepo);
 *   const engine = new DecayPolicyEngine(policy, adapter);
 *   const summary = engine.execute();
 */
export class DecayPolicyEngine {
  constructor(
    private readonly policy: DecayPolicy,
    private readonly repo: DecayableRepository,
  ) {}

  /**
   * Execute a full decay pass: compute decay for all items, update weights,
   * and optionally prune items below threshold.
   *
   * @param options.prune - Whether to delete items marked for pruning (default: false)
   * @param options.dryRun - If true, compute decay but don't persist (default: false)
   * @param options.now - Reference timestamp (default: current time)
   * @returns Summary and per-item results
   */
  execute(options?: {
    prune?: boolean;
    dryRun?: boolean;
    now?: Date;
  }): { items: EngineDecayItem[]; summary: EngineDecaySummary } {
    const now = options?.now ?? new Date();
    const prune = options?.prune ?? false;
    const dryRun = options?.dryRun ?? false;

    const decayableItems = this.repo.getDecayableItems();
    const engineItems: EngineDecayItem[] = [];
    const pruneIds: string[] = [];
    let totalDecayFactor = 0;
    let decayedCount = 0;

    for (const item of decayableItems) {
      // Skip items with zero decay rate
      if (item.decayRate <= 0) continue;

      const state: DecayableState = {
        weight: item.weight,
        lastActivatedAt: item.lastActivatedAt,
        activationCount: item.activationCount,
        decayRate: item.decayRate,
        lastAccessedAt: item.lastAccessedAt,
        accessCount: item.accessCount,
      };

      const result = this.policy.compute(state, now);

      const engineItem: EngineDecayItem = {
        id: item.id,
        previousWeight: item.weight,
        result,
      };

      engineItems.push(engineItem);
      totalDecayFactor += result.decayFactor;

      if (result.weightDelta > 0) {
        decayedCount++;
      }

      if (result.shouldPrune) {
        pruneIds.push(item.id);
      }

      // Persist if not dry run
      if (!dryRun) {
        if (result.weightDelta > 0) {
          this.repo.updateItemWeight(item.id, result.newWeight);
        }

        if (prune && result.shouldPrune) {
          this.repo.deleteItem(item.id);
        }
      }
    }

    const totalProcessed = engineItems.length;
    const averageDecayFactor = totalProcessed > 0
      ? Math.round((totalDecayFactor / totalProcessed) * 10000) / 10000
      : 1.0;

    return {
      items: engineItems,
      summary: {
        totalProcessed,
        decayedCount,
        pruneCount: pruneIds.length,
        pruneIds,
        averageDecayFactor,
        policyName: this.policy.name,
        computedAt: now.toISOString(),
      },
    };
  }

  /** Get the policy this engine uses */
  getPolicy(): DecayPolicy {
    return this.policy;
  }
}

// ────────────────────────────────────────────────────────
// Repository Adapters
// ────────────────────────────────────────────────────────

/**
 * Adapter that makes WeightedEdgeRepository compatible with DecayPolicyEngine.
 */
export class WeightedEdgeDecayAdapter implements DecayableRepository {
  constructor(private readonly repo: {
    queryEdges(filter: { minWeight?: number; orderBy?: string }): Array<{
      id: string; weight: number; lastActivatedAt?: string;
      activationCount: number; decayRate: number; createdAt: string;
    }>;
    updateWeight(edgeId: string, newWeight: number): void;
    deleteEdge(edgeId: string): boolean;
  }) {}

  getDecayableItems(): DecayableItem[] {
    // Get all edges (no min weight filter — we need to check everything)
    const edges = this.repo.queryEdges({ orderBy: 'weight_desc' });
    return edges.map(e => ({
      id: e.id,
      weight: e.weight,
      lastActivatedAt: e.lastActivatedAt ?? e.createdAt,
      activationCount: e.activationCount,
      decayRate: e.decayRate,
    }));
  }

  updateItemWeight(id: string, newWeight: number): void {
    this.repo.updateWeight(id, newWeight);
  }

  deleteItem(id: string): boolean {
    return this.repo.deleteEdge(id);
  }
}

/**
 * Adapter that makes AnchorRepository compatible with DecayPolicyEngine.
 */
export class AnchorDecayAdapter implements DecayableRepository {
  constructor(private readonly repo: {
    listAnchors(limit?: number): Array<{
      id: string; currentWeight: number; lastActivatedAt?: string;
      activationCount: number; lastAccessedAt?: string; accessCount: number;
    }>;
    getAnchor(id: string): { decayRate: number; createdAt: string } | null;
    updateAnchor(id: string, input: { currentWeight?: number }): unknown;
    deleteAnchor(id: string): boolean;
  }) {}

  getDecayableItems(): DecayableItem[] {
    const refs = this.repo.listAnchors();
    return refs.map(ref => {
      const anchor = this.repo.getAnchor(ref.id);
      return {
        id: ref.id,
        weight: ref.currentWeight,
        lastActivatedAt: ref.lastActivatedAt ?? anchor?.createdAt ?? new Date().toISOString(),
        activationCount: ref.activationCount,
        decayRate: anchor?.decayRate ?? 0.01,
        lastAccessedAt: ref.lastAccessedAt,
        accessCount: ref.accessCount,
      };
    });
  }

  updateItemWeight(id: string, newWeight: number): void {
    this.repo.updateAnchor(id, { currentWeight: newWeight });
  }

  deleteItem(id: string): boolean {
    return this.repo.deleteAnchor(id);
  }
}

// ────────────────────────────────────────────────────────
// Factory Functions
// ────────────────────────────────────────────────────────

/** Create a time-based decay policy with optional config overrides */
export function createTimeBasedPolicy(
  config?: Partial<TimeBasedDecayConfig>,
): TimeBasedDecayPolicy {
  return new TimeBasedDecayPolicy(config);
}

/** Create an access-based decay policy with optional config overrides */
export function createAccessBasedPolicy(
  config?: Partial<AccessBasedDecayConfig>,
): AccessBasedDecayPolicy {
  return new AccessBasedDecayPolicy(config);
}

/** Create a combined (time + access) decay policy with optional config overrides */
export function createCombinedPolicy(
  config?: Partial<CombinedDecayConfig>,
): CombinedDecayPolicy {
  return new CombinedDecayPolicy(config);
}

/** Create a no-op policy (items never decay) */
export function createNoDecayPolicy(): NoDecayPolicy {
  return new NoDecayPolicy();
}
