/**
 * ResultMerger — combines dual-path (vector + graph) retrieval results
 * into a single ranked context list.
 *
 * Pipeline:
 *   1. Normalize: Scale raw scores within each path to [0, 1]
 *   2. Deduplicate: Group items by nodeId, keeping per-source scores
 *   3. Combine: Weighted sum of vector + graph scores, with convergence bonus
 *   4. Filter: Drop items below minimum score threshold
 *   5. Rank: Sort by final score descending
 *   6. Limit: Return top-K results
 *
 * The merger is stateless and pure — all configuration is injected.
 */

import type {
  ScoredMemoryItem,
  MergedMemoryItem,
  MergerConfig,
  MergeResult,
  MergeStats,
  RetrievalSource,
} from './types.js';

// ─── Default Configuration ────────────────────────────────────

export const DEFAULT_MERGER_CONFIG: MergerConfig = {
  vectorWeight: 0.5,
  convergenceBonus: 0.1,
  minScore: 0.05,
  maxResults: 20,
  normalization: 'minmax',
};

// ─── ResultMerger ─────────────────────────────────────────────

/**
 * Merges retrieval results from vector and graph paths into a
 * unified, deduplicated, normalized, and ranked context list.
 *
 * Usage:
 *   const merger = new ResultMerger();
 *   const result = merger.merge(vectorResults, graphResults);
 *   // result.items is the ranked context list
 *   // result.stats has merge statistics
 */
export class ResultMerger {
  readonly config: MergerConfig;

  constructor(config?: Partial<MergerConfig>) {
    this.config = { ...DEFAULT_MERGER_CONFIG, ...config };

    // Validate configuration
    if (this.config.vectorWeight < 0 || this.config.vectorWeight > 1) {
      throw new Error(`vectorWeight must be in [0, 1], got ${this.config.vectorWeight}`);
    }
    if (this.config.convergenceBonus < 0 || this.config.convergenceBonus > 1) {
      throw new Error(`convergenceBonus must be in [0, 1], got ${this.config.convergenceBonus}`);
    }
    if (this.config.minScore < 0 || this.config.minScore > 1) {
      throw new Error(`minScore must be in [0, 1], got ${this.config.minScore}`);
    }
    if (this.config.maxResults < 1) {
      throw new Error(`maxResults must be >= 1, got ${this.config.maxResults}`);
    }
  }

  /**
   * Merge results from two retrieval paths into a ranked context list.
   *
   * @param vectorResults - Results from the vector similarity path
   * @param graphResults - Results from the graph traversal path
   * @returns MergeResult with ranked items and statistics
   */
  merge(
    vectorResults: ScoredMemoryItem[],
    graphResults: ScoredMemoryItem[],
  ): MergeResult {
    const startTime = performance.now();

    // 1. Normalize scores within each path
    const normalizedVector = this.normalizeScores(vectorResults, 'vector');
    const normalizedGraph = this.normalizeScores(graphResults, 'graph');

    // 2. Deduplicate and group by nodeId
    const grouped = this.groupByNode(normalizedVector, normalizedGraph);

    // 3. Combine scores for each unique node
    const merged = this.combineScores(grouped);

    // 4. Filter by minimum score
    const filtered = merged.filter(item => item.score >= this.config.minScore);

    // 5. Sort by score descending (stable sort for determinism)
    filtered.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Secondary sort: prefer items from both sources
      if (a.sources.length !== b.sources.length) return b.sources.length - a.sources.length;
      // Tertiary sort: by nodeId for determinism
      return a.nodeId.localeCompare(b.nodeId);
    });

    // 6. Limit to maxResults
    const output = filtered.slice(0, this.config.maxResults);

    const mergeTimeMs = performance.now() - startTime;

    // Compute overlap
    const vectorIds = new Set(vectorResults.map(r => r.nodeId));
    const graphIds = new Set(graphResults.map(r => r.nodeId));
    let overlapCount = 0;
    for (const id of vectorIds) {
      if (graphIds.has(id)) overlapCount++;
    }

    const stats: MergeStats = {
      vectorInputCount: vectorResults.length,
      graphInputCount: graphResults.length,
      overlapCount,
      uniqueCount: grouped.size,
      filteredCount: filtered.length,
      outputCount: output.length,
      mergeTimeMs: Math.round(mergeTimeMs * 100) / 100,
    };

    return { items: output, stats };
  }

  // ─── Internal: Normalization ──────────────────────────────

  /**
   * Normalize scores within a single path using the configured strategy.
   * Returns a new array (does not mutate input).
   */
  private normalizeScores(
    items: ScoredMemoryItem[],
    expectedSource: RetrievalSource,
  ): ScoredMemoryItem[] {
    if (items.length === 0) return [];

    if (this.config.normalization === 'none') {
      // Just clamp to [0, 1]
      return items.map(item => ({
        ...item,
        source: expectedSource,
        score: clamp01(item.score),
      }));
    }

    // Min-max normalization
    return minMaxNormalize(items, expectedSource);
  }

  // ─── Internal: Grouping ───────────────────────────────────

  /**
   * Group items from both paths by nodeId.
   * Each entry contains the per-source scores and metadata.
   */
  private groupByNode(
    vectorItems: ScoredMemoryItem[],
    graphItems: ScoredMemoryItem[],
  ): Map<string, GroupedNode> {
    const groups = new Map<string, GroupedNode>();

    for (const item of vectorItems) {
      const existing = groups.get(item.nodeId);
      if (existing) {
        // Keep the higher vector score if duplicate within same path
        if (!existing.vectorScore || item.score > existing.vectorScore) {
          existing.vectorScore = item.score;
          existing.vectorMetadata = item.retrievalMetadata;
        }
      } else {
        groups.set(item.nodeId, {
          nodeId: item.nodeId,
          nodeType: item.nodeType,
          content: item.content,
          vectorScore: item.score,
          vectorMetadata: item.retrievalMetadata,
        });
      }
    }

    for (const item of graphItems) {
      const existing = groups.get(item.nodeId);
      if (existing) {
        // Keep the higher graph score if duplicate within same path
        if (!existing.graphScore || item.score > existing.graphScore) {
          existing.graphScore = item.score;
          existing.graphMetadata = item.retrievalMetadata;
        }
      } else {
        groups.set(item.nodeId, {
          nodeId: item.nodeId,
          nodeType: item.nodeType,
          content: item.content,
          graphScore: item.score,
          graphMetadata: item.retrievalMetadata,
        });
      }
    }

    return groups;
  }

  // ─── Internal: Score Combination ──────────────────────────

  /**
   * Combine per-source scores into a final merged score for each node.
   */
  private combineScores(groups: Map<string, GroupedNode>): MergedMemoryItem[] {
    const { vectorWeight, convergenceBonus } = this.config;
    const graphWeight = 1 - vectorWeight;

    const results: MergedMemoryItem[] = [];

    for (const [, group] of groups) {
      const sources: RetrievalSource[] = [];
      const sourceScores: { vector?: number; graph?: number } = {};

      const hasVector = group.vectorScore !== undefined;
      const hasGraph = group.graphScore !== undefined;

      if (hasVector) {
        sources.push('vector');
        sourceScores.vector = group.vectorScore;
      }
      if (hasGraph) {
        sources.push('graph');
        sourceScores.graph = group.graphScore;
      }

      // Compute the combined score
      let score: number;

      if (hasVector && hasGraph) {
        // Both paths agree — weighted combination + convergence bonus
        score =
          vectorWeight * group.vectorScore! +
          graphWeight * group.graphScore! +
          convergenceBonus;
      } else if (hasVector) {
        // Only vector path — scale by vector weight only
        score = vectorWeight * group.vectorScore!;
      } else {
        // Only graph path — scale by graph weight only
        score = graphWeight * group.graphScore!;
      }

      // Clamp final score to [0, 1]
      score = clamp01(score);

      // Merge retrieval metadata from both sources
      const retrievalMetadata = mergeMetadata(
        group.vectorMetadata,
        group.graphMetadata,
      );

      results.push({
        nodeId: group.nodeId,
        nodeType: group.nodeType,
        content: group.content,
        score: roundScore(score),
        sources,
        sourceScores,
        retrievalMetadata: Object.keys(retrievalMetadata).length > 0
          ? retrievalMetadata
          : undefined,
      });
    }

    return results;
  }
}

// ─── Internal Types ─────────────────────────────────────────

interface GroupedNode {
  nodeId: string;
  nodeType: import('../models/memory-edge.js').MemoryNodeType;
  content: string;
  vectorScore?: number;
  graphScore?: number;
  vectorMetadata?: Record<string, unknown>;
  graphMetadata?: Record<string, unknown>;
}

// ─── Helper Functions (exported for testing) ─────────────────

/**
 * Min-max normalization: scale scores to [0, 1] within a result set.
 * If all scores are identical, all normalized scores become 1.0.
 * If there's only one item, its normalized score becomes 1.0.
 */
export function minMaxNormalize(
  items: ScoredMemoryItem[],
  source: RetrievalSource,
): ScoredMemoryItem[] {
  if (items.length === 0) return [];

  let min = Infinity;
  let max = -Infinity;

  for (const item of items) {
    if (item.score < min) min = item.score;
    if (item.score > max) max = item.score;
  }

  const range = max - min;

  return items.map(item => ({
    ...item,
    source,
    score: range === 0 ? 1.0 : (item.score - min) / range,
  }));
}

/**
 * Clamp a value to [0, 1].
 */
export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Round score to 4 decimal places for consistent output.
 */
export function roundScore(score: number): number {
  return Math.round(score * 10000) / 10000;
}

/**
 * Merge metadata objects from both retrieval paths.
 * Keys from graph path are prefixed with 'graph_' if they conflict.
 */
function mergeMetadata(
  vectorMeta?: Record<string, unknown>,
  graphMeta?: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (vectorMeta) {
    for (const [key, value] of Object.entries(vectorMeta)) {
      result[`vector_${key}`] = value;
    }
  }

  if (graphMeta) {
    for (const [key, value] of Object.entries(graphMeta)) {
      result[`graph_${key}`] = value;
    }
  }

  return result;
}
