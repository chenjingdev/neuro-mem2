/**
 * BFS Expander — weighted-edge BFS expansion from re-judged anchors.
 *
 * After LLM re-ranking confirms which anchors are truly relevant,
 * this module performs a BFS walk through weighted_edges to discover
 * additional associated facts that weren't found in the initial
 * coarse expansion (VectorSearcher.expandAnchor, which is 1-hop only).
 *
 * Brain-like behavior: this is "associative recall" — once the cortex
 * (LLM) confirms certain anchors are relevant, the hippocampus (BFS)
 * follows association chains to recall related memories.
 *
 * Reuses existing GraphTraverser for the actual BFS traversal,
 * and converts results into ScoredMemoryItem format for pipeline integration.
 */

import type Database from 'better-sqlite3';
import { GraphTraverser, type GraphTraversalInput } from './graph-traverser.js';
import type { AnchorMatch } from './vector-searcher.js';
import type { ScoredMemoryItem } from './types.js';

// ─── Configuration ───────────────────────────────────────────────

export interface BFSExpanderConfig {
  /**
   * Maximum BFS traversal depth from each anchor.
   * Depth 1 = direct neighbors, depth 2 = neighbors of neighbors.
   * Default: 2
   */
  maxDepth: number;

  /**
   * Minimum edge weight to follow during BFS traversal [0, 1].
   * Edges below this threshold are not traversed.
   * Default: 0.1
   */
  minEdgeWeight: number;

  /**
   * Maximum number of nodes to collect across all anchors.
   * Default: 30
   */
  maxNodes: number;

  /**
   * Whether to include facts in BFS results.
   * Default: true
   */
  includeFacts: boolean;

  /**
   * Whether to include episodes in BFS results.
   * Default: true
   */
  includeEpisodes: boolean;

  /**
   * Whether to include concepts in BFS results.
   * Default: true
   */
  includeConcepts: boolean;

  /**
   * Score multiplier applied to BFS-discovered items.
   * BFS items get: anchorSimilarity * edgeWeight * this multiplier.
   * Lower values ensure BFS items rank below direct matches.
   * Default: 0.8
   */
  scoreMultiplier: number;
}

export const DEFAULT_BFS_EXPANDER_CONFIG: BFSExpanderConfig = {
  maxDepth: 2,
  minEdgeWeight: 0.1,
  maxNodes: 30,
  includeFacts: true,
  includeEpisodes: true,
  includeConcepts: true,
  scoreMultiplier: 0.8,
};

// ─── BFS Expansion Result ────────────────────────────────────────

export interface BFSExpansionResult {
  /** New items discovered via BFS (not already in existing items) */
  newItems: ScoredMemoryItem[];
  /** Statistics for pipeline traceability */
  stats: BFSExpansionStats;
}

export interface BFSExpansionStats {
  /** Time for BFS traversal (ms) */
  bfsTimeMs: number;
  /** Number of re-judged anchors used as BFS seeds */
  seedAnchorsCount: number;
  /** Total nodes discovered by BFS (before deduplication) */
  totalDiscovered: number;
  /** New unique nodes added (after dedup against existing items) */
  newNodesAdded: number;
  /** Edges traversed during BFS */
  edgesTraversed: number;
}

// ─── BFSExpander Class ───────────────────────────────────────────

export class BFSExpander {
  readonly config: BFSExpanderConfig;
  private graphTraverser: GraphTraverser;

  constructor(
    db: Database.Database,
    config?: Partial<BFSExpanderConfig>,
  ) {
    this.config = { ...DEFAULT_BFS_EXPANDER_CONFIG, ...config };
    this.graphTraverser = new GraphTraverser(db);
  }

  /**
   * Expand from re-judged anchors via weighted-edge BFS.
   *
   * Takes the anchors that survived LLM re-ranking and walks
   * their weighted_edge connections to discover additional
   * associated memory nodes.
   *
   * @param rejudgedAnchors - Anchors confirmed relevant by LLM re-ranking
   * @param existingItems - Items already in the result set (for dedup)
   * @param configOverride - Per-call config overrides
   * @returns New items discovered via BFS, deduplicated against existing
   */
  async expand(
    rejudgedAnchors: AnchorMatch[],
    existingItems: ScoredMemoryItem[],
    configOverride?: Partial<BFSExpanderConfig>,
  ): Promise<BFSExpansionResult> {
    const config = { ...this.config, ...configOverride };
    const start = performance.now();

    if (rejudgedAnchors.length === 0) {
      return {
        newItems: [],
        stats: {
          bfsTimeMs: 0,
          seedAnchorsCount: 0,
          totalDiscovered: 0,
          newNodesAdded: 0,
          edgesTraversed: 0,
        },
      };
    }

    // Build set of existing node IDs for deduplication
    const existingNodeIds = new Set(existingItems.map(item => item.nodeId));

    // Also exclude anchor IDs themselves (they're seeds, not results)
    for (const anchor of rejudgedAnchors) {
      existingNodeIds.add(anchor.anchorId);
    }

    // Build node types filter
    const nodeTypes: Array<'fact' | 'episode' | 'concept'> = [];
    if (config.includeFacts) nodeTypes.push('fact');
    if (config.includeEpisodes) nodeTypes.push('episode');
    if (config.includeConcepts) nodeTypes.push('concept');

    // Build anchor similarity lookup for score calculation
    const anchorSimilarityMap = new Map<string, number>();
    for (const anchor of rejudgedAnchors) {
      anchorSimilarityMap.set(anchor.anchorId, anchor.similarity);
    }

    // Use GraphTraverser for the actual BFS
    const traversalInput: GraphTraversalInput = {
      anchorIds: rejudgedAnchors.map(a => a.anchorId),
      maxDepth: config.maxDepth,
      minWeight: config.minEdgeWeight,
      maxNodes: config.maxNodes,
      nodeTypes,
    };

    const traversalResult = await this.graphTraverser.traverse(traversalInput);

    // Convert GraphTraversal results to ScoredMemoryItems, filtering out existing
    const newItems: ScoredMemoryItem[] = [];

    // Process facts
    for (const sf of traversalResult.facts) {
      if (existingNodeIds.has(sf.fact.id)) continue;

      const anchorSim = anchorSimilarityMap.get(sf.sourceAnchorId) ?? 0.5;
      const score = round4(sf.score * anchorSim * config.scoreMultiplier);

      newItems.push({
        nodeId: sf.fact.id,
        nodeType: 'fact',
        score,
        source: 'graph',
        content: sf.fact.content,
        retrievalMetadata: {
          bfsExpanded: true,
          bfsDepth: sf.depth,
          sourceAnchorId: sf.sourceAnchorId,
          anchorSimilarity: anchorSim,
          graphTraversalScore: sf.score,
          scoreMultiplier: config.scoreMultiplier,
        },
      });
    }

    // Process episodes
    for (const se of traversalResult.episodes) {
      if (existingNodeIds.has(se.episode.id)) continue;

      const anchorSim = anchorSimilarityMap.get(se.sourceAnchorId) ?? 0.5;
      const score = round4(se.score * anchorSim * config.scoreMultiplier);

      newItems.push({
        nodeId: se.episode.id,
        nodeType: 'episode',
        score,
        source: 'graph',
        content: `[${se.episode.title}] ${se.episode.description}`,
        retrievalMetadata: {
          bfsExpanded: true,
          bfsDepth: se.depth,
          sourceAnchorId: se.sourceAnchorId,
          anchorSimilarity: anchorSim,
          graphTraversalScore: se.score,
          scoreMultiplier: config.scoreMultiplier,
        },
      });
    }

    // Process concepts
    for (const sc of traversalResult.concepts) {
      if (existingNodeIds.has(sc.concept.id)) continue;

      const anchorSim = anchorSimilarityMap.get(sc.sourceAnchorId) ?? 0.5;
      const score = round4(sc.score * anchorSim * config.scoreMultiplier);

      newItems.push({
        nodeId: sc.concept.id,
        nodeType: 'concept',
        score,
        source: 'graph',
        content: `[${sc.concept.name}] ${sc.concept.description}`,
        retrievalMetadata: {
          bfsExpanded: true,
          bfsDepth: sc.depth,
          sourceAnchorId: sc.sourceAnchorId,
          anchorSimilarity: anchorSim,
          graphTraversalScore: sc.score,
          scoreMultiplier: config.scoreMultiplier,
        },
      });
    }

    // Sort by score descending
    newItems.sort((a, b) => b.score - a.score);

    const bfsTimeMs = round2(performance.now() - start);
    const totalDiscovered =
      traversalResult.facts.length +
      traversalResult.episodes.length +
      traversalResult.concepts.length;

    return {
      newItems,
      stats: {
        bfsTimeMs,
        seedAnchorsCount: rejudgedAnchors.length,
        totalDiscovered,
        newNodesAdded: newItems.length,
        edgesTraversed: traversalResult.traversedEdges.length,
      },
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
