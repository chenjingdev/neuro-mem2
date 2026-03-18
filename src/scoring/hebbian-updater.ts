/**
 * HebbianWeightUpdater — co-retrieval frequency-based Hebbian weight update.
 *
 * Implements the classical Hebbian learning rule adapted for memory graph edges:
 *
 *   Δw = η · activation_i · activation_j · (1 - w)
 *
 * Where:
 *   - η (eta) is the learning rate
 *   - activation_i = normalized activation level of source node
 *   - activation_j = normalized activation level of target node
 *   - (1 - w) is the headroom factor ensuring asymptotic convergence to 1.0
 *
 * Activation levels are derived from co-retrieval frequency:
 *   activation(node) = 1 - exp(-activationCount / halfSaturation)
 *
 * This creates a sigmoid-like curve where:
 *   - 0 retrievals → activation ≈ 0
 *   - halfSaturation retrievals → activation ≈ 0.63
 *   - Many retrievals → activation → 1.0
 *
 * The updater also supports:
 *   - Batch co-retrieval updates (all pairwise edges from a retrieval set)
 *   - Asymmetric activation (source and target have different frequencies)
 *   - Weight decay integration (combined reinforce + decay in one pass)
 */

import type { WeightedEdge } from '../models/weighted-edge.js';
import { WEIGHT_CAP, BASE_SHIELD_GAIN, computeShieldCap } from '../models/weighted-edge.js';

// ────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────

export interface HebbianUpdaterConfig {
  /**
   * Base learning rate η for the Hebbian rule (default: 0.1).
   * Controls how quickly edges strengthen from co-activation.
   */
  learningRate: number;

  /**
   * Half-saturation constant for activation normalization (default: 5).
   * At this many co-retrievals, activation reaches ~63%.
   * Lower values → activation saturates faster.
   */
  halfSaturation: number;

  /**
   * Minimum activation level (default: 0.1).
   * Even nodes retrieved for the first time get a base activation.
   * Prevents zero-product from killing the Hebbian update entirely.
   */
  minActivation: number;

  /**
   * Maximum weight ceiling (default: WEIGHT_CAP = 100).
   * Weights are clamped to [0, maxWeight].
   */
  maxWeight: number;

  /**
   * Minimum weight floor (default: 0.0).
   * Weights will not go below this value after update.
   */
  minWeight: number;

  /**
   * Whether to apply an asymptotic headroom factor (1 - w).
   * When true: Δw = η · a_i · a_j · (1 - w) — converges to 1.0
   * When false: Δw = η · a_i · a_j — linear accumulation (clamped)
   * Default: true
   */
  useHeadroom: boolean;
}

export const DEFAULT_HEBBIAN_CONFIG: HebbianUpdaterConfig = {
  learningRate: 0.1,
  halfSaturation: 5,
  minActivation: 0.1,
  maxWeight: WEIGHT_CAP,
  minWeight: 0.0,
  useHeadroom: true,
};

// ────────────────────────────────────────────────────────
// Activation input types
// ────────────────────────────────────────────────────────

/** Describes a node's activation state for Hebbian computation */
export interface NodeActivation {
  /** Node ID */
  nodeId: string;
  /** How many times this node has been retrieved/activated */
  activationCount: number;
  /** Optional pre-computed activation level (overrides count-based computation) */
  activationLevel?: number;
}

/** Input for a single edge Hebbian update */
export interface HebbianUpdateInput {
  /** Current edge weight [0, 1] */
  currentWeight: number;
  /** Source node activation state */
  source: NodeActivation;
  /** Target node activation state */
  target: NodeActivation;
  /** Optional per-edge learning rate override */
  learningRate?: number;
}

/** Result of a single Hebbian update computation */
export interface HebbianUpdateResult {
  /** Source node ID */
  sourceId: string;
  /** Target node ID */
  targetId: string;
  /** Weight before update */
  previousWeight: number;
  /** Weight after update */
  newWeight: number;
  /** The delta applied: Δw = η · a_i · a_j · headroom */
  delta: number;
  /** Computed activation level for source node */
  sourceActivation: number;
  /** Computed activation level for target node */
  targetActivation: number;
  /** The learning rate used */
  learningRate: number;
  /** The headroom factor (1 - w), or 1.0 if headroom is disabled */
  headroom: number;
}

/** Input for batch co-retrieval update */
export interface CoRetrievalBatchInput {
  /** All nodes that were co-retrieved in a single retrieval pass */
  retrievedNodes: NodeActivation[];
  /**
   * Current weights for edges between co-retrieved nodes.
   * Key format: `${sourceId}:${targetId}` (sorted lexicographically for consistency)
   * Missing keys are treated as new edges with weight 0.
   */
  currentWeights: Map<string, number>;
  /** Optional per-batch learning rate override */
  learningRate?: number;
}

/** Summary of a batch co-retrieval update */
export interface CoRetrievalBatchResult {
  /** Individual update results for each pairwise edge */
  updates: HebbianUpdateResult[];
  /** Number of edges updated */
  updatedCount: number;
  /** Number of new edges (weight was 0 before) */
  newEdgeCount: number;
  /** Average delta across all updates */
  averageDelta: number;
  /** Maximum delta in this batch */
  maxDelta: number;
  /** Total number of pairwise combinations evaluated */
  totalPairs: number;
}

/** Result of a shield-aware Hebbian update with overflow */
export interface ShieldAwareUpdateResult extends HebbianUpdateResult {
  /** Shield value before update */
  previousShield: number;
  /** Shield value after update */
  newShield: number;
  /** Amount of weight overflow that went to shield */
  shieldGain: number;
  /** Dynamic shield cap used */
  shieldCap: number;
}

/** Input for shield-aware Hebbian update */
export interface ShieldAwareUpdateInput extends HebbianUpdateInput {
  /** Current shield value */
  currentShield: number;
  /** Node importance [0,1] for dynamic shield cap */
  importance: number;
}

/** Input for combined reinforce + decay pass */
export interface ReinforceDecayInput {
  /** Edge to update */
  edge: Pick<WeightedEdge, 'id' | 'weight' | 'decayRate' | 'activationCount'>;
  /** Source node activation */
  source: NodeActivation;
  /** Target node activation */
  target: NodeActivation;
  /** Time elapsed since last activation (ms), for decay computation */
  elapsedMs: number;
}

/** Result of combined reinforce + decay */
export interface ReinforceDecayResult {
  edgeId: string;
  previousWeight: number;
  reinforcedWeight: number;
  decayedWeight: number;
  finalWeight: number;
  reinforceDelta: number;
  decayDelta: number;
}

// ────────────────────────────────────────────────────────
// Pure computation functions
// ────────────────────────────────────────────────────────

/**
 * Compute the activation level of a node from its co-retrieval count.
 *
 * Uses a saturating exponential:
 *   activation = max(minActivation, 1 - exp(-count / halfSaturation))
 *
 * This produces a smooth curve:
 *   - count=0 → minActivation (not zero, to allow initial learning)
 *   - count=halfSaturation → ~0.63
 *   - count→∞ → 1.0
 *
 * @param activationCount - Number of co-retrievals
 * @param halfSaturation - Count at which activation ≈ 0.63
 * @param minActivation - Floor activation level
 * @returns Activation level in [minActivation, 1.0]
 */
export function computeActivationLevel(
  activationCount: number,
  halfSaturation: number = DEFAULT_HEBBIAN_CONFIG.halfSaturation,
  minActivation: number = DEFAULT_HEBBIAN_CONFIG.minActivation,
): number {
  if (halfSaturation <= 0) return 1.0;
  const count = Math.max(0, activationCount);
  const raw = 1.0 - Math.exp(-count / halfSaturation);
  return Math.max(minActivation, raw);
}

/**
 * Compute the Hebbian weight delta.
 *
 * Formula: Δw = η · activation_i · activation_j · headroom
 *
 * Where headroom = (1 - currentWeight) if useHeadroom is true, else 1.0.
 *
 * @param currentWeight - Current edge weight [0, 1]
 * @param activationI - Source node activation level [0, 1]
 * @param activationJ - Target node activation level [0, 1]
 * @param learningRate - Learning rate η
 * @param useHeadroom - Whether to apply (1 - w) factor
 * @returns The delta Δw to add to the current weight
 */
export function computeHebbianDelta(
  currentWeight: number,
  activationI: number,
  activationJ: number,
  learningRate: number = DEFAULT_HEBBIAN_CONFIG.learningRate,
  useHeadroom: boolean = DEFAULT_HEBBIAN_CONFIG.useHeadroom,
): number {
  const w = Math.max(0, Math.min(1, currentWeight));
  const headroom = useHeadroom ? (1.0 - w) : 1.0;
  return learningRate * activationI * activationJ * headroom;
}

/**
 * Create a canonical edge key for a pair of nodes.
 * Sorts IDs lexicographically for consistency (undirected edges).
 */
export function makeEdgeKey(nodeIdA: string, nodeIdB: string): string {
  return nodeIdA < nodeIdB
    ? `${nodeIdA}:${nodeIdB}`
    : `${nodeIdB}:${nodeIdA}`;
}

// ────────────────────────────────────────────────────────
// HebbianWeightUpdater class
// ────────────────────────────────────────────────────────

/**
 * Orchestrates Hebbian weight updates for anchor edges based on
 * co-retrieval frequency.
 *
 * Usage:
 *
 *   const updater = new HebbianWeightUpdater();
 *
 *   // Single edge update
 *   const result = updater.computeUpdate({
 *     currentWeight: 0.5,
 *     source: { nodeId: 'a1', activationCount: 3 },
 *     target: { nodeId: 'a2', activationCount: 7 },
 *   });
 *
 *   // Batch co-retrieval update
 *   const batch = updater.computeCoRetrievalUpdate({
 *     retrievedNodes: [
 *       { nodeId: 'a1', activationCount: 3 },
 *       { nodeId: 'a2', activationCount: 7 },
 *       { nodeId: 'a3', activationCount: 1 },
 *     ],
 *     currentWeights: weightsMap,
 *   });
 */
export class HebbianWeightUpdater {
  readonly config: HebbianUpdaterConfig;

  constructor(config?: Partial<HebbianUpdaterConfig>) {
    this.config = { ...DEFAULT_HEBBIAN_CONFIG, ...config };
  }

  /**
   * Get the activation level for a node, using either its pre-computed
   * level or computing from count.
   */
  getActivationLevel(node: NodeActivation): number {
    if (node.activationLevel !== undefined) {
      return Math.max(this.config.minActivation, Math.min(1.0, node.activationLevel));
    }
    return computeActivationLevel(
      node.activationCount,
      this.config.halfSaturation,
      this.config.minActivation,
    );
  }

  /**
   * Compute a single Hebbian weight update.
   *
   * @param input - Edge and node activation data
   * @returns Update result with old/new weight, delta, and activation details
   */
  computeUpdate(input: HebbianUpdateInput): HebbianUpdateResult {
    const lr = input.learningRate ?? this.config.learningRate;
    const sourceActivation = this.getActivationLevel(input.source);
    const targetActivation = this.getActivationLevel(input.target);

    const w = Math.max(0, Math.min(1, input.currentWeight));
    const headroom = this.config.useHeadroom ? (1.0 - w) : 1.0;
    const delta = lr * sourceActivation * targetActivation * headroom;
    const newWeight = Math.min(
      this.config.maxWeight,
      Math.max(this.config.minWeight, w + delta),
    );

    return {
      sourceId: input.source.nodeId,
      targetId: input.target.nodeId,
      previousWeight: input.currentWeight,
      newWeight: Math.round(newWeight * 10000) / 10000,
      delta: Math.round(delta * 10000) / 10000,
      sourceActivation: Math.round(sourceActivation * 10000) / 10000,
      targetActivation: Math.round(targetActivation * 10000) / 10000,
      learningRate: lr,
      headroom: Math.round(headroom * 10000) / 10000,
    };
  }

  /**
   * Compute a shield-aware Hebbian weight update with overflow.
   *
   * When weight + delta > WEIGHT_CAP:
   *   - weight is clamped to WEIGHT_CAP
   *   - overflow + BASE_SHIELD_GAIN goes to shield
   *   - shield is capped at computeShieldCap(importance)
   */
  computeShieldAwareUpdate(input: ShieldAwareUpdateInput): ShieldAwareUpdateResult {
    const lr = input.learningRate ?? this.config.learningRate;
    const sourceActivation = this.getActivationLevel(input.source);
    const targetActivation = this.getActivationLevel(input.target);

    const w = Math.max(0, Math.min(this.config.maxWeight, input.currentWeight));
    const headroom = this.config.useHeadroom ? (this.config.maxWeight - w) / this.config.maxWeight : 1.0;
    const delta = lr * this.config.maxWeight * sourceActivation * targetActivation * headroom;
    const rawWeight = w + delta;

    const shieldCap = computeShieldCap(input.importance);
    let newWeight: number;
    let newShield = input.currentShield;
    let shieldGain = 0;

    if (rawWeight > this.config.maxWeight) {
      const overflow = rawWeight - this.config.maxWeight;
      newWeight = this.config.maxWeight;
      shieldGain = overflow + BASE_SHIELD_GAIN;
      newShield = Math.min(shieldCap, input.currentShield + shieldGain);
    } else {
      newWeight = Math.max(this.config.minWeight, rawWeight);
    }

    return {
      sourceId: input.source.nodeId,
      targetId: input.target.nodeId,
      previousWeight: input.currentWeight,
      newWeight: Math.round(newWeight * 10000) / 10000,
      delta: Math.round(delta * 10000) / 10000,
      sourceActivation: Math.round(sourceActivation * 10000) / 10000,
      targetActivation: Math.round(targetActivation * 10000) / 10000,
      learningRate: lr,
      headroom: Math.round(headroom * 10000) / 10000,
      previousShield: input.currentShield,
      newShield: Math.round(newShield * 10000) / 10000,
      shieldGain: Math.round(shieldGain * 10000) / 10000,
      shieldCap,
    };
  }

  /**
   * Compute Hebbian updates for all pairwise edges among co-retrieved nodes.
   *
   * When multiple nodes are retrieved together in a single query, every
   * pairwise edge between them should be reinforced. The strength of
   * reinforcement depends on each node's activation frequency.
   *
   * @param input - Batch of co-retrieved nodes with their current edge weights
   * @returns Batch result with all pairwise updates and summary statistics
   */
  computeCoRetrievalUpdate(input: CoRetrievalBatchInput): CoRetrievalBatchResult {
    const nodes = input.retrievedNodes;
    const updates: HebbianUpdateResult[] = [];
    const lr = input.learningRate ?? this.config.learningRate;

    // Generate all pairwise combinations (undirected — avoid duplicates)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const nodeA = nodes[i];
        const nodeB = nodes[j];

        const key = makeEdgeKey(nodeA.nodeId, nodeB.nodeId);
        const currentWeight = input.currentWeights.get(key) ?? 0;

        const result = this.computeUpdate({
          currentWeight,
          source: nodeA,
          target: nodeB,
          learningRate: lr,
        });

        updates.push(result);
      }
    }

    const totalPairs = updates.length;
    const newEdgeCount = updates.filter(u => u.previousWeight === 0).length;
    const totalDelta = updates.reduce((sum, u) => sum + u.delta, 0);
    const averageDelta = totalPairs > 0
      ? Math.round((totalDelta / totalPairs) * 10000) / 10000
      : 0;
    const maxDelta = totalPairs > 0
      ? Math.max(...updates.map(u => u.delta))
      : 0;

    return {
      updates,
      updatedCount: updates.length,
      newEdgeCount,
      averageDelta,
      maxDelta,
      totalPairs,
    };
  }

  /**
   * Compute a combined reinforce + decay pass for an edge.
   *
   * This is useful during periodic maintenance: first apply Hebbian
   * reinforcement (if the edge was recently co-activated), then apply
   * time-based decay.
   *
   * Order: reinforce first, then decay on the reinforced weight.
   * This ensures recent co-activations are captured before decay.
   *
   * @param input - Edge, activation, and elapsed time data
   * @returns Combined result with reinforce and decay breakdowns
   */
  computeReinforceDecay(input: ReinforceDecayInput): ReinforceDecayResult {
    const { edge, source, target, elapsedMs } = input;

    // Step 1: Hebbian reinforcement
    const reinforceResult = this.computeUpdate({
      currentWeight: edge.weight,
      source,
      target,
    });

    const reinforcedWeight = reinforceResult.newWeight;

    // Step 2: Time-based decay on the reinforced weight
    // Simple exponential decay: w_new = w * (1 - decayRate) for each time unit
    // Normalize elapsedMs to "decay units" (1 unit = 1 day)
    const DECAY_UNIT_MS = 24 * 60 * 60 * 1000; // 1 day
    const decayUnits = elapsedMs / DECAY_UNIT_MS;
    const decayFactor = Math.pow(1.0 - edge.decayRate, decayUnits);
    const decayedWeight = Math.max(
      this.config.minWeight,
      Math.min(this.config.maxWeight, reinforcedWeight * decayFactor),
    );

    return {
      edgeId: edge.id,
      previousWeight: edge.weight,
      reinforcedWeight,
      decayedWeight,
      finalWeight: Math.round(decayedWeight * 10000) / 10000,
      reinforceDelta: Math.round((reinforcedWeight - edge.weight) * 10000) / 10000,
      decayDelta: Math.round((reinforcedWeight - decayedWeight) * 10000) / 10000,
    };
  }

  /**
   * Compute the theoretical equilibrium weight for an edge that receives
   * periodic reinforcement and decay.
   *
   * At equilibrium, the Hebbian increase equals the decay decrease:
   *   η · a_i · a_j · (1 - w_eq) = w_eq · decayRate
   *
   * Solving for w_eq:
   *   w_eq = (η · a_i · a_j) / (η · a_i · a_j + decayRate)
   *
   * This is useful for predicting where a frequently co-retrieved pair
   * will stabilize.
   *
   * @param sourceActivationCount - Source node retrieval count
   * @param targetActivationCount - Target node retrieval count
   * @param decayRate - Per-edge decay rate
   * @param learningRate - Optional learning rate override
   * @returns Predicted equilibrium weight
   */
  predictEquilibrium(
    sourceActivationCount: number,
    targetActivationCount: number,
    decayRate: number,
    learningRate?: number,
  ): number {
    const lr = learningRate ?? this.config.learningRate;
    const ai = computeActivationLevel(
      sourceActivationCount,
      this.config.halfSaturation,
      this.config.minActivation,
    );
    const aj = computeActivationLevel(
      targetActivationCount,
      this.config.halfSaturation,
      this.config.minActivation,
    );

    const reinforceStrength = lr * ai * aj;
    if (reinforceStrength + decayRate === 0) return 0;

    return reinforceStrength / (reinforceStrength + decayRate);
  }
}
