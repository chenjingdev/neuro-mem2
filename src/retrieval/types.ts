/**
 * Retrieval types — shared interfaces for the dual-path
 * (vector + graph) retrieval system and result merger.
 *
 * The retrieval system has two independent paths:
 *   1. Vector path: embedding similarity search (anchors → memory nodes)
 *   2. Graph path: Hebbian-weighted graph traversal (anchor → edges → nodes)
 *
 * Each path produces a list of ScoredMemoryItem results.
 * The ResultMerger combines, deduplicates, normalizes, and ranks them.
 */

import type { MemoryNodeType } from '../models/memory-edge.js';

// ─── Source Path ─────────────────────────────────────────────

/** Which retrieval path produced this result */
export type RetrievalSource = 'vector' | 'graph';

// ─── Scored Memory Item ──────────────────────────────────────

/**
 * A single memory item scored by a retrieval path.
 *
 * This is the common output format from both vector and graph retrievers.
 * The score semantics differ by source:
 *   - vector: cosine similarity [0, 1]
 *   - graph: Hebbian edge weight [0, 1], possibly path-aggregated
 */
export interface ScoredMemoryItem {
  /** ID of the memory node (fact, episode, concept, or anchor) */
  nodeId: string;
  /** Type of the memory node */
  nodeType: MemoryNodeType;
  /** Relevance score from this retrieval path [0, 1] */
  score: number;
  /** Which path produced this result */
  source: RetrievalSource;
  /** The textual content of this memory node (for context injection) */
  content: string;
  /** Optional metadata about the retrieval (e.g., traversal depth, anchor activated) */
  retrievalMetadata?: Record<string, unknown>;
}

// ─── Merged Result ───────────────────────────────────────────

/**
 * A merged retrieval result — the output of the ResultMerger.
 *
 * Contains the final ranking score and provenance from both paths.
 */
export interface MergedMemoryItem {
  /** ID of the memory node */
  nodeId: string;
  /** Type of the memory node */
  nodeType: MemoryNodeType;
  /** Final merged score [0, 1] after normalization and combination */
  score: number;
  /** The textual content of this memory node */
  content: string;
  /** Which paths contributed to this result */
  sources: RetrievalSource[];
  /** Individual scores from each source path (before merge) */
  sourceScores: {
    vector?: number;
    graph?: number;
  };
  /** Combined retrieval metadata from all sources */
  retrievalMetadata?: Record<string, unknown>;
}

// ─── Merger Configuration ────────────────────────────────────

/**
 * Configuration for the ResultMerger.
 */
export interface MergerConfig {
  /**
   * Weight for the vector path score in the final combination [0, 1].
   * Graph path weight = 1 - vectorWeight.
   * Default: 0.5 (equal weighting)
   */
  vectorWeight: number;

  /**
   * Bonus score added when a node appears in both paths [0, 1].
   * This rewards convergence — if both paths agree on relevance,
   * the item is likely truly relevant.
   * Default: 0.1
   */
  convergenceBonus: number;

  /**
   * Minimum merged score to include in results [0, 1].
   * Items below this threshold are filtered out.
   * Default: 0.05
   */
  minScore: number;

  /**
   * Maximum number of results to return.
   * Default: 20
   */
  maxResults: number;

  /**
   * Normalization strategy for raw scores before merging.
   * - 'minmax': Scale scores to [0, 1] within each path (relative ranking)
   * - 'none': Use raw scores as-is (assumes scores are already in [0, 1])
   * Default: 'minmax'
   */
  normalization: 'minmax' | 'none';
}

// ─── Merge Statistics ────────────────────────────────────────

/**
 * Statistics about the merge operation — useful for debugging and tuning.
 */
export interface MergeStats {
  /** Number of items from vector path (input) */
  vectorInputCount: number;
  /** Number of items from graph path (input) */
  graphInputCount: number;
  /** Number of items that appeared in both paths */
  overlapCount: number;
  /** Number of items after deduplication */
  uniqueCount: number;
  /** Number of items after threshold filtering */
  filteredCount: number;
  /** Number of items in final output (after maxResults limit) */
  outputCount: number;
  /** Time taken for the merge operation in milliseconds */
  mergeTimeMs: number;
}

/**
 * Complete output of a merge operation.
 */
export interface MergeResult {
  /** Ranked list of merged memory items */
  items: MergedMemoryItem[];
  /** Statistics about the merge */
  stats: MergeStats;
}
