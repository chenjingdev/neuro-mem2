/**
 * Anchor Decay — computes weight decay for Hebbian-weighted edges.
 *
 * Two independent decay signals are combined:
 *
 * 1. **Time-based decay** (exponential / half-life):
 *    Factor = exp(-ln(2) * elapsed / halfLife)
 *    Edges that haven't been activated recently decay toward 0.
 *
 * 2. **Usage-based decay** (activation frequency):
 *    Factor = 1 - usageDecayRate * (1 / (1 + activationCount))
 *    Frequently activated edges are more resistant to decay.
 *    Rarely activated edges decay faster.
 *
 * Combined: decayedWeight = weight * timeDecayFactor * usageDecayFactor
 *
 * The combined approach ensures that:
 * - Old but frequently used connections persist (high usage counters time decay)
 * - Recently created but unused connections fade (low usage amplifies time decay)
 * - The system naturally "forgets" irrelevant associations
 */

// ────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────

/** Configuration for the anchor decay function */
export interface AnchorDecayConfig {
  /**
   * Half-life for time-based decay in milliseconds.
   * After this duration without activation, weight drops to 50%.
   * Default: 14 days (1,209,600,000 ms)
   */
  timeHalfLifeMs: number;

  /**
   * Base rate for usage-based decay (0-1).
   * Higher values make infrequently-used edges decay faster.
   * Default: 0.3
   */
  usageDecayRate: number;

  /**
   * Minimum weight floor — weights will not decay below this value.
   * Prevents fully-connected edges from disappearing entirely.
   * Default: 0.01
   */
  minWeight: number;

  /**
   * Prune threshold — edges below this weight after decay can be removed.
   * Default: 0.05
   */
  pruneThreshold: number;

  /**
   * Weight of time-based signal in the combined decay (0-1).
   * Usage weight = 1 - timeWeight.
   * Default: 0.7 (time is the primary decay driver)
   */
  timeWeight: number;
}

/** Input describing an edge for decay computation */
export interface DecayEdgeInput {
  /** Current edge weight (0-1) */
  weight: number;
  /** ISO 8601 timestamp of last activation (or creation if never activated) */
  lastActivatedAt: string;
  /** Number of times the edge has been co-activated */
  activationCount: number;
  /** Per-edge decay rate (from WeightedEdge.decayRate, default 0.01) */
  edgeDecayRate: number;
}

/** Result of a single edge decay computation */
export interface DecayComputeResult {
  /** New weight after decay (clamped to [minWeight, 1]) */
  newWeight: number;
  /** Time-based decay factor that was applied (0-1) */
  timeDecayFactor: number;
  /** Usage-based decay factor that was applied (0-1) */
  usageDecayFactor: number;
  /** Combined decay factor (product of time and usage factors) */
  combinedFactor: number;
  /** Whether the edge should be pruned (newWeight < pruneThreshold) */
  shouldPrune: boolean;
  /** How much weight was lost */
  weightDelta: number;
}

/** Summary of a batch decay operation */
export interface BatchDecaySummary {
  /** Total edges processed */
  totalProcessed: number;
  /** Edges whose weights actually changed */
  decayedCount: number;
  /** Edges marked for pruning */
  pruneCount: number;
  /** Average decay factor across all edges */
  averageDecayFactor: number;
  /** Timestamp when decay was computed */
  computedAt: string;
}

// ────────────────────────────────────────────────────────
// Default configuration
// ────────────────────────────────────────────────────────

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export const DEFAULT_DECAY_CONFIG: AnchorDecayConfig = {
  timeHalfLifeMs: FOURTEEN_DAYS_MS,
  usageDecayRate: 0.3,
  minWeight: 0.01,
  pruneThreshold: 0.05,
  timeWeight: 0.7,
};

// ────────────────────────────────────────────────────────
// Pure decay computation functions
// ────────────────────────────────────────────────────────

/**
 * Compute time-based exponential decay factor.
 *
 * Uses the half-life formula: factor = exp(-ln(2) * elapsed / halfLife)
 *
 * - elapsed = 0          -> factor = 1.0 (no decay)
 * - elapsed = halfLife    -> factor = 0.5
 * - elapsed = 2*halfLife  -> factor = 0.25
 * - elapsed = infinity    -> factor -> 0.0
 *
 * The per-edge decay rate scales the effective half-life:
 * effectiveHalfLife = halfLife / (edgeDecayRate / defaultDecayRate)
 * This means edges with higher decay rates decay faster.
 *
 * @param elapsedMs - Time elapsed since last activation (ms)
 * @param halfLifeMs - Base half-life in milliseconds
 * @param edgeDecayRate - Per-edge decay rate (scales the half-life)
 * @returns Decay factor in (0, 1]
 */
export function computeTimeDecay(
  elapsedMs: number,
  halfLifeMs: number,
  edgeDecayRate: number = 0.01,
): number {
  if (elapsedMs <= 0) return 1.0;
  if (halfLifeMs <= 0) return 0.0;

  // Scale half-life by the per-edge decay rate relative to default (0.01)
  // Higher decay rate -> shorter effective half-life -> faster decay
  const defaultRate = 0.01;
  const rateMultiplier = edgeDecayRate > 0 ? edgeDecayRate / defaultRate : 1.0;
  const effectiveHalfLife = halfLifeMs / rateMultiplier;

  if (effectiveHalfLife <= 0) return 0.0;

  const lambda = Math.LN2 / effectiveHalfLife;
  return Math.exp(-lambda * elapsedMs);
}

/**
 * Compute usage-based decay factor.
 *
 * Frequently activated edges resist decay; rarely activated edges decay faster.
 *
 * Formula: factor = 1 - usageDecayRate * (1 / (1 + activationCount))
 *
 * - activationCount = 0   -> factor = 1 - usageDecayRate (maximum usage penalty)
 * - activationCount = 1   -> factor = 1 - usageDecayRate/2
 * - activationCount = 9   -> factor = 1 - usageDecayRate/10
 * - activationCount = inf -> factor -> 1.0 (no usage penalty)
 *
 * This creates a smooth curve where each additional activation provides
 * diminishing returns in decay resistance.
 *
 * @param activationCount - Number of times the edge has been co-activated
 * @param usageDecayRate - Base usage decay rate (0-1)
 * @returns Decay factor in (0, 1]
 */
export function computeUsageDecay(
  activationCount: number,
  usageDecayRate: number,
): number {
  if (usageDecayRate <= 0) return 1.0;
  if (usageDecayRate > 1) return Math.max(0, 1.0 - usageDecayRate);

  const count = Math.max(0, activationCount);
  const usagePenalty = usageDecayRate * (1 / (1 + count));

  return Math.max(0, 1.0 - usagePenalty);
}

/**
 * Compute the combined decay factor from time and usage signals.
 *
 * The combination uses a weighted geometric mean approach:
 * combinedFactor = timeDecayFactor^timeWeight * usageDecayFactor^(1-timeWeight)
 *
 * This is more robust than simple multiplication because:
 * - One extreme factor doesn't dominate completely
 * - The timeWeight parameter controls the balance
 *
 * @param timeDecayFactor - Factor from time-based decay (0-1)
 * @param usageDecayFactor - Factor from usage-based decay (0-1)
 * @param timeWeight - Weight for time signal (0-1), usage weight = 1-timeWeight
 * @returns Combined decay factor in [0, 1]
 */
export function computeCombinedDecayFactor(
  timeDecayFactor: number,
  usageDecayFactor: number,
  timeWeight: number = 0.7,
): number {
  // Clamp inputs
  const tFactor = Math.max(0, Math.min(1, timeDecayFactor));
  const uFactor = Math.max(0, Math.min(1, usageDecayFactor));
  const tWeight = Math.max(0, Math.min(1, timeWeight));

  // Handle edge cases for geometric mean (0^x = 0)
  if (tFactor === 0 || uFactor === 0) return 0;

  // Weighted geometric mean: t^w * u^(1-w)
  return Math.pow(tFactor, tWeight) * Math.pow(uFactor, 1 - tWeight);
}

/**
 * Compute the full decay result for a single edge.
 *
 * @param edge - Edge data needed for decay computation
 * @param now - Current timestamp (ISO 8601 or Date)
 * @param config - Decay configuration (uses defaults if omitted)
 * @returns Detailed decay computation result
 */
export function computeEdgeDecay(
  edge: DecayEdgeInput,
  now: Date | string = new Date(),
  config: AnchorDecayConfig = DEFAULT_DECAY_CONFIG,
): DecayComputeResult {
  const nowMs = typeof now === 'string' ? new Date(now).getTime() : now.getTime();
  const lastMs = new Date(edge.lastActivatedAt).getTime();

  // Compute elapsed time, guard against invalid dates
  const elapsedMs = Math.max(0, nowMs - lastMs);

  // Compute individual factors
  const timeDecayFactor = computeTimeDecay(
    elapsedMs,
    config.timeHalfLifeMs,
    edge.edgeDecayRate,
  );

  const usageDecayFactor = computeUsageDecay(
    edge.activationCount,
    config.usageDecayRate,
  );

  // Combine factors
  const combinedFactor = computeCombinedDecayFactor(
    timeDecayFactor,
    usageDecayFactor,
    config.timeWeight,
  );

  // Apply decay to weight
  const rawNewWeight = edge.weight * combinedFactor;

  // Clamp to [minWeight, 1.0]
  const newWeight = Math.max(config.minWeight, Math.min(1.0, rawNewWeight));

  return {
    newWeight,
    timeDecayFactor,
    usageDecayFactor,
    combinedFactor,
    shouldPrune: newWeight < config.pruneThreshold,
    weightDelta: edge.weight - newWeight,
  };
}

// ────────────────────────────────────────────────────────
// Anchor-level effective weight computation
// ────────────────────────────────────────────────────────

/** Input for computing an anchor's effective weight */
export interface AnchorDecayInput {
  /** Current stored weight [0, 1] */
  currentWeight: number;
  /** Decay rate per time unit [0, 1] */
  decayRate: number;
  /** ISO 8601 timestamp of last access (or creation if never accessed) */
  lastAccessedAt?: string;
  /** ISO 8601 timestamp of creation (fallback when lastAccessedAt is null) */
  createdAt: string;
  /** Number of times the anchor has been accessed */
  accessCount: number;
}

/**
 * Compute the effective weight of an anchor after applying time-based
 * and usage-based decay dynamically (without persisting).
 *
 * This is the anchor-level analog of computeEdgeDecay: it uses the same
 * dual-signal (time + usage) decay formula but operates on anchor metadata
 * instead of edge metadata.
 *
 * effectiveWeight = currentWeight * combinedDecayFactor
 *
 * Where combinedDecayFactor = timeDecay^timeWeight * usageDecay^(1-timeWeight)
 *
 * @param input - Anchor decay metadata
 * @param now - Current timestamp (defaults to Date.now())
 * @param config - Decay configuration (uses defaults if omitted)
 * @returns Effective weight clamped to [config.minWeight, 1.0]
 */
export function computeAnchorEffectiveWeight(
  input: AnchorDecayInput,
  now: Date | string = new Date(),
  config: AnchorDecayConfig = DEFAULT_DECAY_CONFIG,
): number {
  if (input.currentWeight <= 0) return config.minWeight;
  if (input.decayRate <= 0) return input.currentWeight;

  const nowMs = typeof now === 'string' ? new Date(now).getTime() : now.getTime();
  const referenceTime = input.lastAccessedAt ?? input.createdAt;
  const refMs = new Date(referenceTime).getTime();
  const elapsedMs = Math.max(0, nowMs - refMs);

  if (elapsedMs === 0) return input.currentWeight;

  const timeFactor = computeTimeDecay(elapsedMs, config.timeHalfLifeMs, input.decayRate);
  const usageFactor = computeUsageDecay(input.accessCount, config.usageDecayRate);
  const combined = computeCombinedDecayFactor(timeFactor, usageFactor, config.timeWeight);

  const raw = input.currentWeight * combined;
  return Math.max(config.minWeight, Math.min(1.0, raw));
}

// ────────────────────────────────────────────────────────
// AnchorDecay class — stateful decay manager
// ────────────────────────────────────────────────────────

/**
 * Manages anchor weight decay across the memory graph.
 *
 * Usage:
 *   const decay = new AnchorDecay();
 *   const result = decay.computeDecay(edgeInput);
 *   const summary = decay.computeBatchDecay(edges);
 */
export class AnchorDecay {
  readonly config: AnchorDecayConfig;

  constructor(config?: Partial<AnchorDecayConfig>) {
    this.config = { ...DEFAULT_DECAY_CONFIG, ...config };
  }

  /**
   * Compute decay for a single edge.
   */
  computeDecay(
    edge: DecayEdgeInput,
    now?: Date | string,
  ): DecayComputeResult {
    return computeEdgeDecay(edge, now ?? new Date(), this.config);
  }

  /**
   * Compute decay for a batch of edges.
   * Returns individual results and a summary.
   */
  computeBatchDecay(
    edges: DecayEdgeInput[],
    now?: Date | string,
  ): { results: DecayComputeResult[]; summary: BatchDecaySummary } {
    const timestamp = now ?? new Date();
    const results = edges.map(edge => computeEdgeDecay(edge, timestamp, this.config));

    const decayedCount = results.filter(r => r.weightDelta > 0).length;
    const pruneCount = results.filter(r => r.shouldPrune).length;
    const avgFactor = results.length > 0
      ? results.reduce((sum, r) => sum + r.combinedFactor, 0) / results.length
      : 1.0;

    const computedAt = typeof timestamp === 'string'
      ? timestamp
      : timestamp.toISOString();

    return {
      results,
      summary: {
        totalProcessed: edges.length,
        decayedCount,
        pruneCount,
        averageDecayFactor: Math.round(avgFactor * 10000) / 10000,
        computedAt,
      },
    };
  }

  /**
   * Compute effective weight for an anchor, applying time + usage decay.
   * This is the anchor-level analog of computeDecay for edges.
   */
  computeAnchorWeight(
    input: AnchorDecayInput,
    now?: Date | string,
  ): number {
    return computeAnchorEffectiveWeight(input, now ?? new Date(), this.config);
  }

  /**
   * Predict when an edge's weight will drop below a threshold.
   *
   * Uses the time-based decay formula in reverse to estimate
   * how long until the weight reaches the target.
   *
   * Note: This is an approximation since usage decay is treated as constant.
   *
   * @param edge - Current edge state
   * @param targetWeight - Target weight threshold (default: pruneThreshold)
   * @returns Estimated milliseconds until weight reaches target, or Infinity if never
   */
  predictDecayTime(
    edge: DecayEdgeInput,
    targetWeight?: number,
  ): number {
    const target = targetWeight ?? this.config.pruneThreshold;

    if (edge.weight <= target) return 0;
    if (edge.weight <= 0) return 0;

    // We need: weight * timeDecay^timeWeight * usageDecay^(1-timeWeight) = target
    // Solve for timeDecay: timeDecay = (target / (weight * usageFactor))^(1/timeWeight)
    const usageFactor = computeUsageDecay(
      edge.activationCount,
      this.config.usageDecayRate,
    );
    const usageComponent = Math.pow(usageFactor, 1 - this.config.timeWeight);
    const adjustedTarget = target / (edge.weight * usageComponent);

    if (adjustedTarget >= 1.0) return 0;
    if (adjustedTarget <= 0) return Infinity;

    // timeDecay = exp(-lambda * t) = adjustedTarget^(1/timeWeight)
    const timeDecayTarget = Math.pow(adjustedTarget, 1 / this.config.timeWeight);

    if (timeDecayTarget <= 0) return Infinity;
    if (timeDecayTarget >= 1.0) return 0;

    // Solve: exp(-lambda * t) = timeDecayTarget => t = -ln(timeDecayTarget) / lambda
    const defaultRate = 0.01;
    const rateMultiplier = edge.edgeDecayRate > 0 ? edge.edgeDecayRate / defaultRate : 1.0;
    const effectiveHalfLife = this.config.timeHalfLifeMs / rateMultiplier;
    const lambda = Math.LN2 / effectiveHalfLife;

    return -Math.log(timeDecayTarget) / lambda;
  }
}
