/**
 * WeightedEdge models — enhanced graph edges for the MemoryNode retrieval system.
 *
 * WeightedEdges connect MemoryNodes (hub/leaf) with Hebbian learning parameters
 * that evolve through co-activation during retrieval:
 *
 * - When nodes are co-activated, the connecting edge weight is reinforced.
 * - Overflow above weight cap (100) charges shield + baseShieldGain.
 * - Shield absorbs decay before weight is reduced.
 * - lastActivatedAtEvent tracks the global event counter for lazy decay.
 *
 * Caps:
 *   - Weight cap: 100 (hard ceiling)
 *   - Shield cap: baseShieldCap(50) + importance * salienceMultiplier(50)
 *     where importance is derived from connected node importance (0-1)
 */

// ─── Constants ───────────────────────────────────────────────────

/** Hard ceiling for edge weight */
export const WEIGHT_CAP = 100;

/** Base shield capacity before importance scaling */
export const BASE_SHIELD_CAP = 50;

/** Multiplier applied to node importance for additional shield capacity */
export const SALIENCE_MULTIPLIER = 50;

/** Base shield gain when weight overflows cap (always added on overflow) */
export const BASE_SHIELD_GAIN = 1.0;

/**
 * Compute dynamic shield cap for an edge.
 * shieldCap = baseShieldCap(50) + importance * salienceMultiplier(50)
 * @param importance - Node importance score [0, 1]
 */
export function computeShieldCap(importance: number): number {
  const clamped = Math.max(0, Math.min(1, importance));
  return BASE_SHIELD_CAP + clamped * SALIENCE_MULTIPLIER;
}

// ─── Node Type for Edge Endpoints ─────────────────────────────────

/**
 * Node type for weighted edge endpoints.
 * Uses MemoryNode roles: 'hub' and 'leaf'.
 */
export type WeightedNodeType = 'hub' | 'leaf';

// ─── WeightedEdge Relationship Types ──────────────────────────────

/**
 * Relationship types for weighted edges in the MemoryNode graph.
 *
 * These 6 semantic edge types replace the old entity-specific types
 * (episode_mentions_concept, anchor_to_fact, etc.) with universal
 * relationship semantics applicable to any MemoryNode pair:
 *
 * - about:       Node A is about/describes Node B (topic association)
 * - related:     Nodes are semantically related (general association)
 * - caused:      Node A caused/triggered Node B (causal relationship)
 * - precedes:    Node A temporally/logically precedes Node B (ordering)
 * - refines:     Node A refines/elaborates Node B (specialization)
 * - contradicts: Node A contradicts/conflicts with Node B (opposition)
 */
export type WeightedEdgeType =
  | 'about'        // Topic association: A is about B
  | 'related'      // General semantic association
  | 'caused'       // Causal: A caused/triggered B
  | 'precedes'     // Temporal/logical ordering: A precedes B
  | 'refines'      // Specialization: A refines/elaborates B
  | 'contradicts'; // Opposition: A contradicts B

export const WEIGHTED_EDGE_TYPES: readonly WeightedEdgeType[] = [
  'about',
  'related',
  'caused',
  'precedes',
  'refines',
  'contradicts',
] as const;

// ─── WeightedEdge Model ──────────────────────────────────────────

/**
 * A WeightedEdge in the retrieval graph — a directed edge between
 * two nodes (anchors or memory nodes) with Hebbian learning parameters.
 */
export interface WeightedEdge {
  /** Unique edge identifier (UUID v4) */
  id: string;

  // ── Endpoints ──
  /** Source node ID (anchor or memory node) */
  sourceId: string;
  /** Source node type */
  sourceType: WeightedNodeType;
  /** Target node ID (anchor or memory node) */
  targetId: string;
  /** Target node type */
  targetType: WeightedNodeType;

  // ── Relationship ──
  /** Relationship type */
  edgeType: WeightedEdgeType;

  // ── Hebbian Weight ──
  /** Current Hebbian weight [0, WEIGHT_CAP(100)]: strength of co-activation */
  weight: number;
  /** Initial weight at creation (for baseline comparison) */
  initialWeight: number;

  // ── Shield (decay buffer) ──
  /**
   * Shield absorbs decay before weight is reduced.
   * Charged when weight overflows WEIGHT_CAP.
   * Dynamic cap: baseShieldCap(50) + importance * salienceMultiplier(50)
   */
  shield: number;

  // ── Learning Parameters ──
  /** Learning rate for Hebbian reinforcement (default 0.1) */
  learningRate: number;
  /** Decay rate per event unit (default 0.01) — applied lazily on access */
  decayRate: number;

  // ── Activation Tracking ──
  /** Number of times this edge has been co-activated */
  activationCount: number;
  /** ISO 8601 timestamp of last co-activation */
  lastActivatedAt?: string;
  /**
   * Global event counter value when this edge was last activated.
   * Used for lazy event-based decay: decayAmount = decayRate * (currentEvent - lastActivatedAtEvent)
   */
  lastActivatedAtEvent: number;

  // ── Timestamps ──
  /** ISO 8601 timestamp of creation */
  createdAt: string;
  /** ISO 8601 timestamp of last update (weight change, activation, etc.) */
  updatedAt: string;

  // ── Metadata ──
  /** Optional metadata (provenance, extraction context, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating a WeightedEdge.
 */
export interface CreateWeightedEdgeInput {
  sourceId: string;
  sourceType: WeightedNodeType;
  targetId: string;
  targetType: WeightedNodeType;
  edgeType: WeightedEdgeType;
  /** Initial weight (default 0.5, cap 100) */
  weight?: number;
  /** Initial shield value (default 0) */
  shield?: number;
  /** Learning rate (default 0.1) */
  learningRate?: number;
  /** Decay rate per event (default 0.01) */
  decayRate?: number;
  /** Current global event counter value for lastActivatedAtEvent */
  currentEvent?: number;
  /** Importance of connected node [0,1] for shield cap computation */
  importance?: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Hebbian reinforcement input — applies the Hebbian learning rule
 * to strengthen an edge after co-activation.
 *
 * Formula: w_new = w_old + learningRate * (1 - w_old)
 * This ensures weight approaches 1.0 asymptotically.
 */
export interface ReinforceEdgeInput {
  /** Edge ID to reinforce */
  edgeId: string;
  /** Override learning rate for this reinforcement (uses edge's default if omitted) */
  learningRate?: number;
  /** Optional context about what triggered this co-activation */
  activationContext?: string;
  /** Current global event counter value */
  currentEvent?: number;
  /** Importance of connected node [0,1] for shield cap */
  importance?: number;
}

/**
 * Batch co-activation input — reinforce multiple edges that were
 * activated together in a single retrieval pass.
 */
export interface BatchCoActivationInput {
  /** Edge IDs that were co-activated */
  edgeIds: string[];
  /** Override learning rate for this batch */
  learningRate?: number;
  /** Context of the retrieval that triggered co-activation */
  queryContext?: string;
}

/**
 * Result of a Hebbian reinforcement operation.
 */
export interface ReinforceResult {
  edgeId: string;
  previousWeight: number;
  newWeight: number;
  previousShield: number;
  newShield: number;
  activationCount: number;
  lastActivatedAtEvent: number;
}

/**
 * Filter for querying weighted edges.
 */
export interface WeightedEdgeFilter {
  /** Filter by source node ID */
  sourceId?: string;
  /** Filter by source node type */
  sourceType?: WeightedNodeType;
  /** Filter by target node type */
  targetType?: WeightedNodeType;
  /** Filter by edge type(s) */
  edgeTypes?: WeightedEdgeType[];
  /** Minimum weight threshold */
  minWeight?: number;
  /** Maximum weight threshold */
  maxWeight?: number;
  /** Minimum activation count */
  minActivationCount?: number;
  /** Maximum number of results */
  limit?: number;
  /** Sort order for results */
  orderBy?: 'weight_desc' | 'weight_asc' | 'activation_desc' | 'recent_first';
}

/**
 * Compact weighted edge for retrieval results.
 */
export interface WeightedEdgeRef {
  id: string;
  sourceId: string;
  sourceType: WeightedNodeType;
  targetId: string;
  targetType: WeightedNodeType;
  edgeType: WeightedEdgeType;
  weight: number;
  shield: number;
  activationCount: number;
  lastActivatedAtEvent: number;
}
