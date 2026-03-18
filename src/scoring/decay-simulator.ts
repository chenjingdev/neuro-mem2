/**
 * Edge Decay Simulation Engine
 *
 * Simulates weight decay over time (event gap progression) for one or more edges,
 * applying the shield-first lazy decay formula at each step. This enables:
 *
 * - UI visualization of projected decay curves
 * - "What-if" analysis for different shield/weight/decayRate configurations
 * - Batch simulation across many edges for dashboard summaries
 *
 * Uses the same lazy decay formulas from lazy-decay-evaluator.ts:
 *   effectiveShield = max(0, shield - gap * shieldDecayRate)
 *   rawDecay = gap * weightDecayRate
 *   overflow = max(0, rawDecay - effectiveShield)
 *   effectiveWeight = max(0, weight - overflow)
 *
 * This is a pure computation module — no DB access, no side effects.
 */

import {
  evaluateLazyDecay,
  DEFAULT_SHIELD_DECAY_RATE,
  type LazyDecayInput,
  type LazyDecayConfig,
  DEFAULT_LAZY_DECAY_CONFIG,
} from './lazy-decay-evaluator.js';

// ─── Simulation Parameters ─────────────────────────────────

/**
 * Parameters controlling a decay simulation run.
 */
export interface DecaySimulationParams {
  /**
   * Number of event steps to simulate.
   * Each step = one event gap unit from the starting point.
   * Default: 100
   */
  totalSteps: number;

  /**
   * Event gap between each simulation step.
   * stepSize=1 means each step is +1 event. stepSize=5 means +5 events per step.
   * Useful for speeding up simulation over large ranges.
   * Default: 1
   */
  stepSize: number;

  /**
   * Speed multiplier for real-time simulation playback (UI use).
   * Does not affect the simulation math — only relevant for UI playback pacing.
   * 1.0 = normal, 2.0 = 2x fast, 0.5 = half speed.
   * Default: 1.0
   */
  speed: number;

  /**
   * Shield decay rate override. If omitted, uses DEFAULT_SHIELD_DECAY_RATE (0.5).
   */
  shieldDecayRate?: number;

  /**
   * If true, include intermediate details (rawDecay, shieldAbsorbed, overflow)
   * in each snapshot. Default: false (lighter payload for large simulations).
   */
  includeDetails?: boolean;
}

export const DEFAULT_SIMULATION_PARAMS: DecaySimulationParams = {
  totalSteps: 100,
  stepSize: 1,
  speed: 1.0,
  includeDetails: false,
};

// ─── Simulation Snapshot ────────────────────────────────────

/**
 * A single snapshot in the decay simulation timeline.
 */
export interface DecaySnapshot {
  /** Simulation step index (0 = initial state, 1 = first step, ...) */
  step: number;

  /** Simulated global event counter at this step */
  eventCounter: number;

  /** Effective weight at this step */
  weight: number;

  /** Effective shield at this step */
  shield: number;

  /** Whether weight has decayed to 0 */
  isDead: boolean;

  // ── Optional detail fields (when includeDetails=true) ──

  /** Raw decay amount (gap * decayRate) — from event 0, not incremental */
  rawDecay?: number;

  /** Amount of decay absorbed by shield at this step */
  shieldAbsorbed?: number;

  /** Overflow that hit weight at this step */
  overflow?: number;
}

// ─── Single Edge Simulation Result ──────────────────────────

/**
 * Full simulation result for a single edge.
 */
export interface DecaySimulationResult {
  /** Input edge state used for simulation */
  input: {
    weight: number;
    shield: number;
    decayRate: number;
    lastActivatedAtEvent: number;
  };

  /** Simulation parameters used */
  params: DecaySimulationParams;

  /** Timeline of decay snapshots */
  snapshots: DecaySnapshot[];

  /** Summary statistics */
  summary: {
    /** Event counter at which weight first reaches 0 (null if never) */
    deathEvent: number | null;
    /** Step number at which weight first reaches 0 (null if never) */
    deathStep: number | null;
    /** Event counter at which shield is fully depleted (null if never) */
    shieldDepletedEvent: number | null;
    /** Step at which shield is fully depleted (null if never) */
    shieldDepletedStep: number | null;
    /** Final effective weight */
    finalWeight: number;
    /** Final effective shield */
    finalShield: number;
    /** Total events simulated */
    totalEventsSimulated: number;
    /** Percentage of weight remaining at end */
    weightRetentionPct: number;
  };
}

// ─── Batch Simulation Result ────────────────────────────────

/**
 * Result for a batch edge simulation. Includes per-edge summaries
 * but omits individual snapshots for performance (unless requested).
 */
export interface BatchDecaySimulationResult {
  /** Per-edge simulation results */
  edges: Array<{
    edgeId: string;
    result: DecaySimulationResult;
  }>;

  /** Aggregate statistics across all edges */
  aggregate: {
    /** Total edges simulated */
    totalEdges: number;
    /** Edges that die within the simulation window */
    dyingEdges: number;
    /** Edges that survive the full simulation */
    survivingEdges: number;
    /** Average final weight across all edges */
    avgFinalWeight: number;
    /** Average weight retention percentage */
    avgRetentionPct: number;
    /** Median death event (null if <50% die) */
    medianDeathEvent: number | null;
  };
}

// ─── Simulation Engine ──────────────────────────────────────

/**
 * Simulate decay for a single edge over a configurable event range.
 *
 * This projects the edge's weight/shield state forward through `totalSteps`
 * event increments, computing effective values at each step using the
 * lazy decay formula.
 *
 * @param edgeState - Current stored state of the edge
 * @param params - Simulation parameters (steps, stepSize, speed, etc.)
 * @returns Full simulation result with snapshots and summary
 */
export function simulateEdgeDecay(
  edgeState: LazyDecayInput,
  params: Partial<DecaySimulationParams> = {},
): DecaySimulationResult {
  const p: DecaySimulationParams = { ...DEFAULT_SIMULATION_PARAMS, ...params };
  const config: LazyDecayConfig = {
    shieldDecayRate: p.shieldDecayRate ?? DEFAULT_SHIELD_DECAY_RATE,
  };

  const snapshots: DecaySnapshot[] = [];
  let deathEvent: number | null = null;
  let deathStep: number | null = null;
  let shieldDepletedEvent: number | null = null;
  let shieldDepletedStep: number | null = null;

  // Step 0: initial state (current effective state with gap=0)
  snapshots.push({
    step: 0,
    eventCounter: edgeState.lastActivatedAtEvent,
    weight: edgeState.weight,
    shield: edgeState.shield,
    isDead: edgeState.weight <= 0,
    ...(p.includeDetails ? { rawDecay: 0, shieldAbsorbed: 0, overflow: 0 } : {}),
  });

  if (edgeState.weight <= 0) {
    deathEvent = edgeState.lastActivatedAtEvent;
    deathStep = 0;
  }

  if (edgeState.shield <= 0) {
    shieldDepletedEvent = edgeState.lastActivatedAtEvent;
    shieldDepletedStep = 0;
  }

  // Steps 1..totalSteps: simulate forward
  for (let step = 1; step <= p.totalSteps; step++) {
    const simulatedEvent = edgeState.lastActivatedAtEvent + step * p.stepSize;

    const result = evaluateLazyDecay(edgeState, simulatedEvent, config);

    const snapshot: DecaySnapshot = {
      step,
      eventCounter: simulatedEvent,
      weight: result.effectiveWeight,
      shield: result.effectiveShield,
      isDead: result.isDead,
    };

    if (p.includeDetails) {
      snapshot.rawDecay = result.rawDecay;
      snapshot.shieldAbsorbed = result.shieldAbsorbed;
      snapshot.overflow = result.overflow;
    }

    snapshots.push(snapshot);

    // Track first death
    if (result.isDead && deathEvent === null) {
      deathEvent = simulatedEvent;
      deathStep = step;
    }

    // Track shield depletion
    if (result.effectiveShield <= 0 && shieldDepletedEvent === null) {
      shieldDepletedEvent = simulatedEvent;
      shieldDepletedStep = step;
    }

    // Early termination: if weight is dead and shield depleted, remaining steps are trivial
    if (result.isDead && result.effectiveShield <= 0) {
      // Fill remaining steps with dead state for complete timeline
      for (let remaining = step + 1; remaining <= p.totalSteps; remaining++) {
        const remainingEvent = edgeState.lastActivatedAtEvent + remaining * p.stepSize;
        snapshots.push({
          step: remaining,
          eventCounter: remainingEvent,
          weight: 0,
          shield: 0,
          isDead: true,
          ...(p.includeDetails ? { rawDecay: result.rawDecay, shieldAbsorbed: 0, overflow: result.rawDecay } : {}),
        });
      }
      break;
    }
  }

  const finalSnapshot = snapshots[snapshots.length - 1];
  const totalEventsSimulated = p.totalSteps * p.stepSize;

  return {
    input: {
      weight: edgeState.weight,
      shield: edgeState.shield,
      decayRate: edgeState.decayRate,
      lastActivatedAtEvent: edgeState.lastActivatedAtEvent,
    },
    params: p,
    snapshots,
    summary: {
      deathEvent,
      deathStep,
      shieldDepletedEvent,
      shieldDepletedStep,
      finalWeight: finalSnapshot.weight,
      finalShield: finalSnapshot.shield,
      totalEventsSimulated,
      weightRetentionPct: edgeState.weight > 0
        ? Math.round((finalSnapshot.weight / edgeState.weight) * 10000) / 100
        : 0,
    },
  };
}

/**
 * Simulate decay for multiple edges in batch.
 *
 * Returns per-edge results plus aggregate statistics.
 * For very large batches, consider using `includeDetails: false`
 * and reducing `totalSteps` to keep payload size manageable.
 *
 * @param edges - Array of { edgeId, state } pairs
 * @param params - Shared simulation parameters
 * @returns Batch simulation result with per-edge and aggregate data
 */
export function simulateBatchDecay(
  edges: Array<{ edgeId: string; state: LazyDecayInput }>,
  params: Partial<DecaySimulationParams> = {},
): BatchDecaySimulationResult {
  const results = edges.map(({ edgeId, state }) => ({
    edgeId,
    result: simulateEdgeDecay(state, params),
  }));

  // Compute aggregates
  const totalEdges = results.length;
  const dyingEdges = results.filter(r => r.result.summary.deathEvent !== null).length;
  const survivingEdges = totalEdges - dyingEdges;

  const finalWeights = results.map(r => r.result.summary.finalWeight);
  const avgFinalWeight = totalEdges > 0
    ? Math.round((finalWeights.reduce((a, b) => a + b, 0) / totalEdges) * 10000) / 10000
    : 0;

  const retentions = results.map(r => r.result.summary.weightRetentionPct);
  const avgRetentionPct = totalEdges > 0
    ? Math.round((retentions.reduce((a, b) => a + b, 0) / totalEdges) * 100) / 100
    : 0;

  // Median death event (only among edges that die)
  const deathEvents = results
    .map(r => r.result.summary.deathEvent)
    .filter((e): e is number => e !== null)
    .sort((a, b) => a - b);

  const medianDeathEvent = deathEvents.length >= totalEdges / 2 && deathEvents.length > 0
    ? deathEvents[Math.floor(deathEvents.length / 2)]
    : null;

  return {
    edges: results,
    aggregate: {
      totalEdges,
      dyingEdges,
      survivingEdges,
      avgFinalWeight,
      avgRetentionPct,
      medianDeathEvent,
    },
  };
}

/**
 * Compute the projected event at which an edge will die (weight=0),
 * given its current state. Uses binary search for efficiency.
 *
 * Returns null if the edge has decayRate=0 or shield is large enough
 * to prevent death within a reasonable horizon (1M events).
 *
 * @param edgeState - Current stored state
 * @param config - Optional decay config override
 * @returns Projected death event counter, or null if the edge won't die
 */
export function projectDeathEvent(
  edgeState: LazyDecayInput,
  config?: Partial<LazyDecayConfig>,
): number | null {
  if (edgeState.decayRate <= 0) return null;
  if (edgeState.weight <= 0) return edgeState.lastActivatedAtEvent;

  const decayConfig: LazyDecayConfig = { ...DEFAULT_LAZY_DECAY_CONFIG, ...config };
  const maxHorizon = 1_000_000; // 1M events max search

  // Binary search for death event
  let lo = edgeState.lastActivatedAtEvent;
  let hi = edgeState.lastActivatedAtEvent + maxHorizon;

  // Check if death occurs within horizon
  const finalResult = evaluateLazyDecay(edgeState, hi, decayConfig);
  if (!finalResult.isDead) return null;

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const result = evaluateLazyDecay(edgeState, mid, decayConfig);
    if (result.isDead) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return hi;
}

/**
 * Compute the projected event at which shield is fully depleted.
 *
 * effectiveShield = max(0, shield - gap * shieldDecayRate)
 * Shield depletes when gap = shield / shieldDecayRate
 *
 * @param shield - Current shield value
 * @param lastActivatedAtEvent - Event counter at last activation
 * @param shieldDecayRate - Shield decay rate (default 0.5)
 * @returns Projected event at which shield reaches 0, or null if shield is 0
 */
export function projectShieldDepletionEvent(
  shield: number,
  lastActivatedAtEvent: number,
  shieldDecayRate: number = DEFAULT_SHIELD_DECAY_RATE,
): number | null {
  if (shield <= 0 || shieldDecayRate <= 0) return null;

  const gapToDepletion = Math.ceil(shield / shieldDecayRate);
  return lastActivatedAtEvent + gapToDepletion;
}

// ─── DecaySimulator Class ───────────────────────────────────

/**
 * Stateful decay simulator that holds configuration and provides
 * convenience methods for simulation runs. Wraps the pure functions
 * for use in service layers and API handlers.
 */
export class DecaySimulator {
  readonly defaultParams: DecaySimulationParams;
  readonly decayConfig: LazyDecayConfig;

  constructor(
    defaultParams?: Partial<DecaySimulationParams>,
    decayConfig?: Partial<LazyDecayConfig>,
  ) {
    this.defaultParams = { ...DEFAULT_SIMULATION_PARAMS, ...defaultParams };
    this.decayConfig = { ...DEFAULT_LAZY_DECAY_CONFIG, ...decayConfig };
  }

  /**
   * Simulate decay for a single edge.
   */
  simulate(
    edgeState: LazyDecayInput,
    params?: Partial<DecaySimulationParams>,
  ): DecaySimulationResult {
    const merged = {
      ...this.defaultParams,
      ...params,
      shieldDecayRate: params?.shieldDecayRate ?? this.decayConfig.shieldDecayRate,
    };
    return simulateEdgeDecay(edgeState, merged);
  }

  /**
   * Simulate decay for a batch of edges.
   */
  simulateBatch(
    edges: Array<{ edgeId: string; state: LazyDecayInput }>,
    params?: Partial<DecaySimulationParams>,
  ): BatchDecaySimulationResult {
    const merged = {
      ...this.defaultParams,
      ...params,
      shieldDecayRate: params?.shieldDecayRate ?? this.decayConfig.shieldDecayRate,
    };
    return simulateBatchDecay(edges, merged);
  }

  /**
   * Project when an edge will die.
   */
  projectDeath(edgeState: LazyDecayInput): number | null {
    return projectDeathEvent(edgeState, this.decayConfig);
  }

  /**
   * Project when shield will deplete.
   */
  projectShieldDepletion(shield: number, lastActivatedAtEvent: number): number | null {
    return projectShieldDepletionEvent(shield, lastActivatedAtEvent, this.decayConfig.shieldDecayRate);
  }
}
