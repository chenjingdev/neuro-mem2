/**
 * Memory Edge models — typed graph relationships between memory nodes
 * (episodes, concepts, facts) with Hebbian-style weights.
 *
 * Weights represent co-activation strength and are updated
 * when connected nodes are accessed together during retrieval.
 */

/** Node type discriminator for edge endpoints */
export type MemoryNodeType = 'episode' | 'concept' | 'fact' | 'anchor';

/** Relationship types between memory nodes */
export type EdgeType =
  | 'episode_mentions_concept'   // An episode references a concept
  | 'concept_related_to'         // Two concepts are semantically related
  | 'fact_supports_concept'      // A fact provides evidence for a concept
  | 'episode_contains_fact'      // A fact was extracted from an episode's turn range
  | 'temporal_next'              // Temporal ordering between episodes
  | 'derived_from';              // A memory was derived from another

/**
 * A directed edge between two memory nodes with Hebbian weight.
 */
export interface MemoryEdge {
  /** Unique edge identifier (UUID v4) */
  id: string;
  /** Source node ID */
  sourceId: string;
  /** Source node type */
  sourceType: MemoryNodeType;
  /** Target node ID */
  targetId: string;
  /** Target node type */
  targetType: MemoryNodeType;
  /** Relationship type */
  edgeType: EdgeType;
  /** Hebbian weight (0-1): strength of co-activation */
  weight: number;
  /** ISO 8601 timestamp of creation */
  createdAt: string;
  /** ISO 8601 timestamp of last weight update */
  updatedAt: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating an edge.
 */
export interface CreateEdgeInput {
  sourceId: string;
  sourceType: MemoryNodeType;
  targetId: string;
  targetType: MemoryNodeType;
  edgeType: EdgeType;
  weight?: number;
  metadata?: Record<string, unknown>;
}
