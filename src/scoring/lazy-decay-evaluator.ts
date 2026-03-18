/**
 * LazyDecayEvaluator — event-based lazy evaluation of shield and weight decay.
 *
 * Instead of mutating the database on every event tick, this module computes
 * "effective" values on-the-fly when shield/weight are read. The stored
 * (persisted) values are only updated when the node/edge is explicitly
 * activated or periodically persisted.
 *
 * Formulas:
 *   gap = max(0, currentEvent - lastActivatedAtEvent)
 *   effectiveShield = max(0, shield - gap * shieldDecayRate)
 *   rawDecay = gap * weightDecayRate
 *   overflow = max(0, rawDecay - effectiveShield)
 *   effectiveWeight = max(0, weight - overflow)
 *
 * Default rates:
 *   shieldDecayRate = 0.5 per event gap
 *   weightDecayRate = decayRate (per-edge, typically 0.01)
 *
 * The "shield-first" design means:
 *   - Shield absorbs decay before weight is reduced
 *   - Shield itself decays linearly with event gap (0.5/event)
 *   - Once shield is exhausted, weight decays normally
 *
 * This is a pure computation module — no side effects, no DB access.
 */

// ─── Constants ───────────────────────────────────────────────────

/** Default shield decay rate per event gap unit */
export const DEFAULT_SHIELD_DECAY_RATE = 0.5;

// ─── Input/Output Types ─────────────────────────────────────────

/**
 * Minimal decay-relevant state of an edge or node.
 * These are the *stored* (persisted) values.
 */
export interface LazyDecayInput {
  /** Stored shield value (from last persist) */
  shield: number;
  /** Stored weight value (from last persist) */
  weight: number;
  /** Weight decay rate per event gap (per-edge/node decayRate) */
  decayRate: number;
  /** Global event counter value at last activation */
  lastActivatedAtEvent: number;
}

/**
 * Result of lazy decay evaluation — computed "effective" values.
 */
export interface LazyDecayResult {
  /** Effective shield after lazy decay: max(0, shield - gap * shieldDecayRate) */
  effectiveShield: number;
  /** Effective weight after lazy decay: max(0, weight - overflow) */
  effectiveWeight: number;
  /** Event gap since last activation */
  gap: number;
  /** Total raw decay amount (gap * decayRate) */
  rawDecay: number;
  /** Amount of decay absorbed by shield */
  shieldAbsorbed: number;
  /** Amount of decay that overflowed shield and hit weight */
  overflow: number;
  /** Whether the effective weight has decayed to zero (dead edge) */
  isDead: boolean;
}

/**
 * Configuration for the lazy decay evaluator.
 */
export interface LazyDecayConfig {
  /** Shield decay rate per event gap (default: 0.5) */
  shieldDecayRate: number;
}

export const DEFAULT_LAZY_DECAY_CONFIG: LazyDecayConfig = {
  shieldDecayRate: DEFAULT_SHIELD_DECAY_RATE,
};

// ─── Pure Computation Functions ─────────────────────────────────

/**
 * Compute the effective shield value after lazy decay.
 *
 * effectiveShield = max(0, shield - gap * shieldDecayRate)
 *
 * @param shield - Stored shield value
 * @param gap - Event gap (currentEvent - lastActivatedAtEvent)
 * @param shieldDecayRate - Shield decay per event unit (default 0.5)
 * @returns Effective shield value [0, shield]
 */
export function computeEffectiveShield(
  shield: number,
  gap: number,
  shieldDecayRate: number = DEFAULT_SHIELD_DECAY_RATE,
): number {
  if (gap <= 0 || shield <= 0) return Math.max(0, shield);
  return Math.max(0, shield - gap * shieldDecayRate);
}

/**
 * Compute the effective weight after lazy decay with shield absorption.
 *
 * rawDecay = gap * decayRate
 * effectiveShield = max(0, shield - gap * shieldDecayRate)
 * overflow = max(0, rawDecay - effectiveShield)
 * effectiveWeight = max(0, weight - overflow)
 *
 * @param weight - Stored weight value
 * @param shield - Stored shield value
 * @param gap - Event gap (currentEvent - lastActivatedAtEvent)
 * @param decayRate - Weight decay rate per event unit
 * @param shieldDecayRate - Shield decay per event unit (default 0.5)
 * @returns Effective weight value [0, weight]
 */
export function computeEffectiveWeight(
  weight: number,
  shield: number,
  gap: number,
  decayRate: number,
  shieldDecayRate: number = DEFAULT_SHIELD_DECAY_RATE,
): number {
  if (gap <= 0 || decayRate <= 0) return Math.max(0, weight);

  const effectiveShield = computeEffectiveShield(shield, gap, shieldDecayRate);
  const rawDecay = gap * decayRate;
  const overflow = Math.max(0, rawDecay - effectiveShield);
  return Math.max(0, weight - overflow);
}

/**
 * Full lazy decay evaluation — returns all intermediate values for debugging/logging.
 *
 * @param input - Stored decay-relevant state
 * @param currentEvent - Current global event counter value
 * @param config - Optional configuration overrides
 * @returns Complete decay evaluation result
 */
export function evaluateLazyDecay(
  input: LazyDecayInput,
  currentEvent: number,
  config: LazyDecayConfig = DEFAULT_LAZY_DECAY_CONFIG,
): LazyDecayResult {
  const gap = Math.max(0, currentEvent - input.lastActivatedAtEvent);

  if (gap === 0 || input.decayRate <= 0) {
    return {
      effectiveShield: Math.max(0, input.shield),
      effectiveWeight: Math.max(0, input.weight),
      gap: 0,
      rawDecay: 0,
      shieldAbsorbed: 0,
      overflow: 0,
      isDead: input.weight <= 0,
    };
  }

  const effectiveShield = computeEffectiveShield(input.shield, gap, config.shieldDecayRate);
  const rawDecay = gap * input.decayRate;

  // Shield absorbs up to its effective value
  const shieldAbsorbed = Math.min(effectiveShield, rawDecay);
  const overflow = Math.max(0, rawDecay - effectiveShield);
  const effectiveWeight = Math.max(0, input.weight - overflow);

  return {
    effectiveShield,
    effectiveWeight,
    gap,
    rawDecay,
    shieldAbsorbed,
    overflow,
    isDead: effectiveWeight <= 0,
  };
}

/**
 * Batch lazy decay evaluation for multiple edges/nodes.
 * Efficient for retrieval — compute effective values for all candidates at once.
 *
 * @param items - Array of stored decay states
 * @param currentEvent - Current global event counter value
 * @param config - Optional configuration overrides
 * @returns Array of decay results (same order as input)
 */
export function evaluateLazyDecayBatch(
  items: LazyDecayInput[],
  currentEvent: number,
  config: LazyDecayConfig = DEFAULT_LAZY_DECAY_CONFIG,
): LazyDecayResult[] {
  return items.map(item => evaluateLazyDecay(item, currentEvent, config));
}

/**
 * Compute effective weight+shield and return "materialized" values
 * suitable for persisting back to the database.
 *
 * Use this when you want to "flush" the lazy decay to the DB
 * (e.g., during activation, periodic maintenance, etc.).
 *
 * @param input - Stored decay-relevant state
 * @param currentEvent - Current global event counter value
 * @param config - Optional configuration overrides
 * @returns Object with new shield, weight, and lastActivatedAtEvent to persist
 */
export function materializeLazyDecay(
  input: LazyDecayInput,
  currentEvent: number,
  config: LazyDecayConfig = DEFAULT_LAZY_DECAY_CONFIG,
): { shield: number; weight: number; lastActivatedAtEvent: number } {
  const result = evaluateLazyDecay(input, currentEvent, config);
  return {
    shield: Math.round(result.effectiveShield * 10000) / 10000,
    weight: Math.round(result.effectiveWeight * 10000) / 10000,
    lastActivatedAtEvent: currentEvent,
  };
}

// ─── LazyDecayEvaluator Class ───────────────────────────────────

/**
 * Stateful evaluator that holds a reference to the current event counter
 * and configuration. Use this when you need to evaluate decay for many
 * items with the same event counter.
 */
export class LazyDecayEvaluator {
  readonly config: LazyDecayConfig;

  constructor(
    private getCurrentEvent: () => number,
    config?: Partial<LazyDecayConfig>,
  ) {
    this.config = { ...DEFAULT_LAZY_DECAY_CONFIG, ...config };
  }

  /**
   * Evaluate lazy decay for a single edge/node.
   */
  evaluate(input: LazyDecayInput): LazyDecayResult {
    return evaluateLazyDecay(input, this.getCurrentEvent(), this.config);
  }

  /**
   * Evaluate lazy decay for multiple items.
   */
  evaluateBatch(items: LazyDecayInput[]): LazyDecayResult[] {
    const currentEvent = this.getCurrentEvent();
    return evaluateLazyDecayBatch(items, currentEvent, this.config);
  }

  /**
   * Get effective weight for a single edge/node (convenience).
   */
  getEffectiveWeight(input: LazyDecayInput): number {
    const currentEvent = this.getCurrentEvent();
    return computeEffectiveWeight(
      input.weight, input.shield,
      Math.max(0, currentEvent - input.lastActivatedAtEvent),
      input.decayRate, this.config.shieldDecayRate,
    );
  }

  /**
   * Get effective shield for a single edge/node (convenience).
   */
  getEffectiveShield(shield: number, lastActivatedAtEvent: number): number {
    const gap = Math.max(0, this.getCurrentEvent() - lastActivatedAtEvent);
    return computeEffectiveShield(shield, gap, this.config.shieldDecayRate);
  }

  /**
   * Materialize (flush) lazy decay to DB-persistable values.
   */
  materialize(input: LazyDecayInput): { shield: number; weight: number; lastActivatedAtEvent: number } {
    return materializeLazyDecay(input, this.getCurrentEvent(), this.config);
  }

  /**
   * Check if an edge/node is effectively dead (weight = 0).
   */
  isDead(input: LazyDecayInput): boolean {
    return this.getEffectiveWeight(input) <= 0;
  }
}
