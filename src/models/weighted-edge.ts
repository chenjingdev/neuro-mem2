/**
 * WeightedEdge models — enhanced graph edges for the dual-path retrieval system.
 *
 * WeightedEdges connect Anchors to memory nodes (facts, episodes, concepts)
 * or to other Anchors. They carry Hebbian learning parameters that evolve
 * through co-activation during retrieval:
 *
 * - When an anchor and a memory node are retrieved together, their connecting
 *   edge weight is reinforced (Hebbian rule).
 * - Over time, unused edges decay, enabling natural forgetting.
 * - The retrieval system uses these weights to rank graph-path results.
 */

import type { MemoryNodeType, EdgeType } from './memory-edge.js';
import type { AnchorType } from './anchor.js';

// ─── Extended Node Type ───────────────────────────────────────────

/**
 * Extended node type that includes 'anchor' alongside existing memory node types.
 * Used in WeightedEdge endpoints to allow anchor-to-node and anchor-to-anchor edges.
 */
export type WeightedNodeType = MemoryNodeType | 'anchor';

// ─── WeightedEdge Relationship Types ──────────────────────────────

/**
 * Relationship types for weighted edges in the retrieval graph.
 * Extends EdgeType with anchor-specific relationships.
 */
export type WeightedEdgeType =
  | EdgeType                       // All existing edge types
  | 'anchor_to_fact'               // Anchor activates a fact
  | 'anchor_to_episode'            // Anchor activates an episode
  | 'anchor_to_concept'            // Anchor activates a concept
  | 'anchor_to_anchor'             // Inter-anchor association
  | 'query_activated';             // Dynamic edge from query to anchor

export const WEIGHTED_EDGE_TYPES: readonly WeightedEdgeType[] = [
  // Existing EdgeType values
  'episode_mentions_concept',
  'concept_related_to',
  'fact_supports_concept',
  'episode_contains_fact',
  'temporal_next',
  'derived_from',
  // Anchor-specific
  'anchor_to_fact',
  'anchor_to_episode',
  'anchor_to_concept',
  'anchor_to_anchor',
  'query_activated',
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
  /** Current Hebbian weight (0-1): strength of co-activation */
  weight: number;
  /** Initial weight at creation (for baseline comparison) */
  initialWeight: number;

  // ── Learning Parameters ──
  /** Learning rate for Hebbian reinforcement (default 0.1) */
  learningRate: number;
  /** Decay rate per time unit (default 0.01) — applied during periodic maintenance */
  decayRate: number;

  // ── Activation Tracking ──
  /** Number of times this edge has been co-activated */
  activationCount: number;
  /** ISO 8601 timestamp of last co-activation */
  lastActivatedAt?: string;

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
  /** Initial weight (default 0.5) */
  weight?: number;
  /** Learning rate (default 0.1) */
  learningRate?: number;
  /** Decay rate (default 0.01) */
  decayRate?: number;
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
  activationCount: number;
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
  activationCount: number;
}
