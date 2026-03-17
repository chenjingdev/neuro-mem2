/**
 * Anchor models — semantic hub nodes and Hebbian weight management types
 * for the dual-path (vector + graph) retrieval system.
 *
 * An Anchor is a semantic hub node in the memory graph that aggregates
 * related memory nodes (facts, episodes, concepts) around a theme.
 * During retrieval, anchors are activated via vector similarity or
 * graph traversal, then connected nodes are retrieved via WeightedEdges.
 *
 * This module also contains types for Hebbian-style weight management
 * on graph edges: upsert, decay, bulk update, and query filters.
 */

import type { MemoryNodeType, EdgeType } from './memory-edge.js';

// ─── Anchor Node Types ────────────────────────────────────────────

/** Anchor type — how the anchor was created / what it represents */
export type AnchorType =
  | 'entity'     // Named entity (person, project, technology)
  | 'topic'      // Topical theme (e.g., "database optimization")
  | 'temporal'   // Time-based cluster (e.g., "sprint 12 work")
  | 'composite'; // Auto-merged from multiple related anchors

export const ANCHOR_TYPES: readonly AnchorType[] = [
  'entity',
  'topic',
  'temporal',
  'composite',
] as const;

/**
 * An Anchor node — a semantic hub in the retrieval graph.
 *
 * Anchors serve as activation points for dual-path retrieval:
 * - Vector path: embedding similarity search finds matching anchors
 * - Graph path: Hebbian-weighted edges traverse from anchor to memory nodes
 */
export interface Anchor {
  /** Unique anchor identifier (UUID v4) */
  id: string;
  /** Canonical label (e.g., "TypeScript migration", "user-auth service") */
  label: string;
  /** Description of the anchor's semantic scope */
  description: string;
  /** How this anchor was created */
  anchorType: AnchorType;
  /** Alternative labels for matching (e.g., abbreviations, aliases) */
  aliases: string[];
  /**
   * Embedding vector for vector-path retrieval.
   * Stored as Float32Array in memory, serialized to BLOB in SQLite.
   * Dimensionality depends on the embedding model used.
   */
  embedding?: Float32Array;
  /** Dimensionality of the embedding vector (for validation) */
  embeddingDim?: number;

  // ── Decay Metadata ──
  /**
   * Current importance weight of this anchor [0, 1].
   * Decays over time if not accessed; reinforced on retrieval access.
   * Used to rank anchors during dual-path retrieval.
   */
  currentWeight: number;
  /** Initial weight at creation (for baseline comparison and decay reset) */
  initialWeight: number;
  /**
   * Decay rate per time unit [0, 1].
   * Applied during periodic maintenance: w_new = w * (1 - decayRate).
   * 0 = no decay (permanent anchor); higher = faster forgetting.
   */
  decayRate: number;
  /** How many times this anchor has been accessed during retrieval queries */
  accessCount: number;
  /** ISO 8601 timestamp of last retrieval access (read/query) */
  lastAccessedAt?: string;

  // ── Activation Tracking (co-activation / Hebbian reinforcement) ──
  /** How many times this anchor has been activated during retrieval */
  activationCount: number;
  /** ISO 8601 timestamp of last retrieval activation */
  lastActivatedAt?: string;

  // ── Computed Decay Fields ──
  /**
   * Effective weight after applying time-based decay dynamically.
   * Computed on read: effectiveWeight = currentWeight * decayFactor(now - lastAccessedAt)
   * Not persisted — always recalculated from currentWeight, decayRate, and lastAccessedAt.
   * Falls back to currentWeight if lastAccessedAt is not set.
   */
  effectiveWeight: number;

  // ── Timestamps ──
  /** ISO 8601 timestamp of creation */
  createdAt: string;
  /** ISO 8601 timestamp of last update */
  updatedAt: string;
  /** Optional metadata (extraction source, model info, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating an Anchor — IDs and timestamps are generated internally.
 */
export interface CreateAnchorInput {
  /** Canonical label */
  label: string;
  /** Description of the anchor's semantic scope */
  description: string;
  /** Anchor type */
  anchorType: AnchorType;
  /** Optional aliases */
  aliases?: string[];
  /** Optional embedding vector */
  embedding?: Float32Array;
  /** Initial weight (default 0.5) */
  initialWeight?: number;
  /** Decay rate (default 0.01) */
  decayRate?: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Input for updating an existing Anchor.
 */
export interface UpdateAnchorInput {
  /** Update label */
  label?: string;
  /** Update description */
  description?: string;
  /** Merge new aliases (additive) */
  addAliases?: string[];
  /** Replace embedding vector */
  embedding?: Float32Array;
  /** Increment activation count and update lastActivatedAt */
  recordActivation?: boolean;
  /** Record a retrieval access (increments accessCount, updates lastAccessedAt) */
  recordAccess?: boolean;
  /** Set weight directly (clamped to [0, 1]) */
  currentWeight?: number;
  /** Update decay rate */
  decayRate?: number;
  /** Additional metadata (merged with existing) */
  metadata?: Record<string, unknown>;
}

/**
 * Compact Anchor reference for retrieval results (without embedding).
 */
export interface AnchorRef {
  id: string;
  label: string;
  anchorType: AnchorType;
  currentWeight: number;
  /** Effective weight after time+usage decay (dynamically computed) */
  effectiveWeight: number;
  accessCount: number;
  lastAccessedAt?: string;
  activationCount: number;
  lastActivatedAt?: string;
}

// ─── Hebbian Weight Management Types ──────────────────────────────

/**
 * Input for upserting an edge: creates if not exists, updates weight if exists.
 * This is the primary operation for anchor weight management.
 */
export interface UpsertEdgeInput {
  sourceId: string;
  sourceType: MemoryNodeType;
  targetId: string;
  targetType: MemoryNodeType;
  edgeType: EdgeType;
  /** Weight to set (on create) or merge with existing (on update) */
  weight: number;
  metadata?: Record<string, unknown>;
}

/**
 * Describes how to merge weights during upsert.
 */
export type WeightMergeStrategy =
  | 'replace'      // Simply replace old weight with new
  | 'max'          // Take the higher weight
  | 'hebbian'      // Apply Hebbian reinforcement: w_new = w_old + delta * (1 - w_old)
  | 'average';     // Average of old and new

/**
 * Options for bulk weight decay.
 */
export interface DecayOptions {
  /** Decay factor (0-1). Applied as: new_weight = old_weight * factor */
  factor: number;
  /** Only decay edges below this weight threshold (optional) */
  maxWeight?: number;
  /** Only decay edges of these types (optional, all if omitted) */
  edgeTypes?: EdgeType[];
  /** Delete edges whose weight falls below this after decay (optional) */
  pruneBelow?: number;
}

/**
 * Result of a decay operation.
 */
export interface DecayResult {
  /** Number of edges whose weights were decayed */
  decayedCount: number;
  /** Number of edges pruned (deleted because weight fell below threshold) */
  prunedCount: number;
}

/**
 * Identifies a unique edge by its endpoint pair and type.
 */
export interface EdgeEndpoints {
  sourceId: string;
  targetId: string;
  edgeType: EdgeType;
}

/**
 * Input for a bulk weight update on multiple edges.
 */
export interface BulkWeightUpdate {
  edgeId: string;
  newWeight: number;
}

/**
 * Filter options for querying edges.
 */
export interface EdgeQueryFilter {
  /** Filter by source node type */
  sourceType?: MemoryNodeType;
  /** Filter by target node type */
  targetType?: MemoryNodeType;
  /** Filter by edge type(s) */
  edgeTypes?: EdgeType[];
  /** Minimum weight threshold */
  minWeight?: number;
  /** Maximum weight threshold */
  maxWeight?: number;
  /** Maximum number of results */
  limit?: number;
}
