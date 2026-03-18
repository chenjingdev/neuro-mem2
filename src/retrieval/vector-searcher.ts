/**
 * VectorSearcher — embedding-based similarity search for memory retrieval.
 *
 * This is the "vector path" of the dual-path retrieval system.
 * It generates a query embedding, then searches anchors (semantic hubs)
 * by cosine similarity to find the most relevant memory context.
 *
 * Pipeline:
 *   1. Generate query embedding via EmbeddingProvider
 *   2. Load all anchors with embeddings from the DB
 *   3. Compute cosine similarity between query and each anchor
 *   4. Select top-k anchors above the similarity threshold
 *   5. (Optional) Expand to connected memory nodes via weighted edges
 *   6. Return ranked ScoredMemoryItem[] for merging with graph path
 *
 * Performance: Brute-force cosine similarity is O(n * d) where n = anchor count,
 * d = embedding dimension. For local use (<10k anchors), this is <10ms.
 * For larger scale, an approximate nearest neighbor index can be added.
 */

import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from './embedding-provider.js';
import type { ScoredMemoryItem } from './types.js';
import type { Anchor } from '../models/anchor.js';
import {
  computeAnchorEffectiveWeight,
  computeEdgeDecay,
  type AnchorDecayConfig,
  DEFAULT_DECAY_CONFIG,
} from '../scoring/anchor-decay.js';

// ─── Configuration ───────────────────────────────────────────────

export interface VectorSearchConfig {
  /**
   * Maximum number of anchor results to return (before expansion).
   * Default: 10
   */
  topK: number;

  /**
   * Minimum cosine similarity threshold [0, 1].
   * Anchors below this are filtered out.
   * Default: 0.3
   */
  similarityThreshold: number;

  /**
   * Whether to expand anchor results to connected memory nodes
   * via weighted edges (facts, episodes, concepts).
   * Default: true
   */
  expandToMemoryNodes: boolean;

  /**
   * Minimum edge weight for expansion [0, 1].
   * Only edges above this weight are used during expansion.
   * Default: 0.1
   */
  expansionMinWeight: number;

  /**
   * Maximum number of memory nodes to include per anchor during expansion.
   * Default: 5
   */
  expansionMaxPerAnchor: number;

  /**
   * Maximum total results after expansion.
   * Default: 50
   */
  maxTotalResults: number;
}

export const DEFAULT_VECTOR_SEARCH_CONFIG: VectorSearchConfig = {
  topK: 10,
  similarityThreshold: 0.3,
  expandToMemoryNodes: true,
  expansionMinWeight: 0.1,
  expansionMaxPerAnchor: 5,
  maxTotalResults: 50,
};

// ─── Vector Search Result ────────────────────────────────────────

/**
 * Result of a vector search operation, including matched anchors
 * and optionally expanded memory nodes.
 */
export interface VectorSearchResult {
  /** Ranked list of scored memory items (anchors + expanded nodes) */
  items: ScoredMemoryItem[];
  /** Matched anchors with their similarity scores */
  matchedAnchors: AnchorMatch[];
  /** Search performance stats */
  stats: VectorSearchStats;
}

/**
 * An anchor matched by vector similarity.
 */
export interface AnchorMatch {
  /** The anchor that matched */
  anchorId: string;
  /** Anchor label */
  label: string;
  /** Cosine similarity score [0, 1] */
  similarity: number;
  /** Number of connected memory nodes found during expansion */
  expandedNodeCount: number;
}

/**
 * Performance statistics for the vector search.
 */
export interface VectorSearchStats {
  /** Time to generate the query embedding (ms) */
  embeddingTimeMs: number;
  /** Time to search anchors (ms) */
  searchTimeMs: number;
  /** Time to expand to memory nodes (ms) */
  expansionTimeMs: number;
  /** Total search time (ms) */
  totalTimeMs: number;
  /** Number of anchors with embeddings that were compared */
  anchorsCompared: number;
  /** Number of anchors that passed the similarity threshold */
  anchorsMatched: number;
  /** Number of memory nodes returned after expansion */
  nodesExpanded: number;
}

// ─── VectorSearcher Class ────────────────────────────────────────

/**
 * Performs embedding-based vector similarity search on the anchor graph.
 *
 * Usage:
 *   const searcher = new VectorSearcher(db, embeddingProvider);
 *   const result = await searcher.search("TypeScript migration");
 *   // result.items contains ScoredMemoryItem[] for merging
 */
export class VectorSearcher {
  readonly config: VectorSearchConfig;
  private db: Database.Database;
  private embeddingProvider: EmbeddingProvider;
  /** Decay configuration for computing effective weights at retrieval time */
  readonly decayConfig: AnchorDecayConfig;

  constructor(
    db: Database.Database,
    embeddingProvider: EmbeddingProvider,
    config?: Partial<VectorSearchConfig>,
    decayConfig?: Partial<AnchorDecayConfig>,
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.config = { ...DEFAULT_VECTOR_SEARCH_CONFIG, ...config };
    this.decayConfig = { ...DEFAULT_DECAY_CONFIG, ...decayConfig };
  }

  /**
   * Search for memory items relevant to a query string.
   *
   * @param query - Natural language query
   * @param options - Override search configuration for this query
   * @returns VectorSearchResult with ranked items and stats
   */
  async search(
    query: string,
    options?: Partial<VectorSearchConfig>,
  ): Promise<VectorSearchResult> {
    const config = { ...this.config, ...options };
    const totalStart = performance.now();

    // 1. Generate query embedding
    const embStart = performance.now();
    const embResponse = await this.embeddingProvider.embed({ text: query });
    const queryEmbedding = embResponse.embedding;
    const embeddingTimeMs = round2(performance.now() - embStart);

    // 2. Load and search anchors
    const searchStart = performance.now();
    const anchorMatches = this.searchAnchors(queryEmbedding, config);
    const searchTimeMs = round2(performance.now() - searchStart);

    // 3. Build scored items from anchor matches
    const items: ScoredMemoryItem[] = [];
    const matchedAnchors: AnchorMatch[] = [];

    for (const match of anchorMatches) {
      // Add the anchor itself as a scored item (using effective score = similarity * anchor weight)
      items.push({
        nodeId: match.anchor.id,
        nodeType: 'anchor',
        score: match.effectiveScore,
        source: 'vector',
        content: `[${match.anchor.label}] ${match.anchor.description}`,
        retrievalMetadata: {
          anchorLabel: match.anchor.label,
          anchorType: match.anchor.anchorType,
          cosineSimilarity: match.similarity,
          anchorWeight: match.anchorWeight,
          effectiveScore: match.effectiveScore,
        },
      });

      matchedAnchors.push({
        anchorId: match.anchor.id,
        label: match.anchor.label,
        similarity: match.similarity,
        expandedNodeCount: 0,
      });
    }

    // 4. Expand to connected memory nodes
    let expansionTimeMs = 0;
    let nodesExpanded = 0;

    if (config.expandToMemoryNodes && anchorMatches.length > 0) {
      const expStart = performance.now();

      for (let i = 0; i < anchorMatches.length; i++) {
        const match = anchorMatches[i];
        // Pass effectiveScore (similarity * anchorWeight) for decay-aware propagation
        const expandedItems = this.expandAnchor(
          match.anchor.id,
          match.effectiveScore,
          config,
        );

        nodesExpanded += expandedItems.length;
        matchedAnchors[i].expandedNodeCount = expandedItems.length;
        items.push(...expandedItems);
      }

      expansionTimeMs = round2(performance.now() - expStart);
    }

    // 5. Deduplicate (same node from multiple anchors — keep highest score)
    const deduped = this.deduplicateItems(items);

    // 6. Sort by score descending and limit
    deduped.sort((a, b) => b.score - a.score);
    const limited = deduped.slice(0, config.maxTotalResults);

    const totalTimeMs = round2(performance.now() - totalStart);

    return {
      items: limited,
      matchedAnchors,
      stats: {
        embeddingTimeMs,
        searchTimeMs,
        expansionTimeMs,
        totalTimeMs,
        anchorsCompared: anchorMatches.length > 0
          ? this.countAnchorsWithEmbeddings()
          : 0,
        anchorsMatched: anchorMatches.length,
        nodesExpanded,
      },
    };
  }

  /**
   * Search for similar anchors using a pre-computed embedding vector.
   * Useful when the embedding is already available (e.g., cached).
   *
   * @param queryEmbedding - Pre-computed query embedding vector
   * @param options - Override search configuration
   * @returns Top-k similar anchors with similarity scores
   */
  searchByEmbedding(
    queryEmbedding: number[],
    options?: Partial<VectorSearchConfig>,
  ): Array<{ anchor: Pick<Anchor, 'id' | 'label' | 'description' | 'anchorType'>; similarity: number; anchorWeight: number; effectiveScore: number }> {
    const config = { ...this.config, ...options };
    return this.searchAnchors(queryEmbedding, config).map(m => ({
      anchor: {
        id: m.anchor.id,
        label: m.anchor.label,
        description: m.anchor.description,
        anchorType: m.anchor.anchorType,
      },
      similarity: m.similarity,
      anchorWeight: m.anchorWeight,
      effectiveScore: m.effectiveScore,
    }));
  }

  // ─── Internal: Anchor Search ─────────────────────────────────

  /**
   * Load all anchors with embeddings and compute cosine similarity
   * against the query embedding. Returns top-k above threshold.
   *
   * The final anchor score combines raw cosine similarity with the
   * anchor's real-time effective weight (computed via time + usage decay):
   *
   *   effectiveWeight = computeAnchorEffectiveWeight(anchorDecayInput)
   *   effectiveScore = cosineSimilarity * effectiveWeight
   *
   * This ensures that recently-accessed, frequently-used anchors rank
   * higher than stale, decayed anchors at the same similarity level.
   * Unlike the stored `current_weight` (updated periodically by the
   * DecayScheduler), effectiveWeight reflects decay at the exact
   * moment of retrieval.
   */
  private searchAnchors(
    queryEmbedding: number[],
    config: VectorSearchConfig,
  ): Array<{ anchor: AnchorWithEmbedding; similarity: number; anchorWeight: number; effectiveScore: number }> {
    const now = new Date();

    // Load all anchors that have embeddings, including decay metadata
    const rows = this.db.prepare(`
      SELECT id, label, description, anchor_type, embedding, embedding_dim,
        current_weight, decay_rate, access_count, last_accessed_at, created_at
      FROM anchors
      WHERE embedding IS NOT NULL AND embedding_dim IS NOT NULL
    `).all() as AnchorEmbeddingRow[];

    if (rows.length === 0) return [];

    // Compute similarities weighted by dynamically-decayed effective weight
    const scored: Array<{ anchor: AnchorWithEmbedding; similarity: number; anchorWeight: number; effectiveScore: number }> = [];

    for (const row of rows) {
      const embedding = bufferToFloat32Array(row.embedding, row.embedding_dim);
      if (!embedding) continue;

      const rawSimilarity = cosineSimilarityVec(queryEmbedding, embedding);

      // Compute real-time effective weight using time + usage decay
      const anchorWeight = computeAnchorEffectiveWeight(
        {
          currentWeight: row.current_weight ?? 0.5,
          decayRate: row.decay_rate ?? 0.01,
          lastAccessedAt: row.last_accessed_at ?? undefined,
          createdAt: row.created_at,
          accessCount: row.access_count ?? 0,
        },
        now,
        this.decayConfig,
      );

      // Combine cosine similarity with decay-affected anchor weight
      // This ensures decayed anchors rank lower than active ones
      const effectiveScore = rawSimilarity * anchorWeight;

      if (rawSimilarity >= config.similarityThreshold) {
        scored.push({
          anchor: {
            id: row.id,
            label: row.label,
            description: row.description,
            anchorType: row.anchor_type as Anchor['anchorType'],
            embedding,
          },
          similarity: round4(rawSimilarity),
          anchorWeight: round4(anchorWeight),
          effectiveScore: round4(effectiveScore),
        });
      }
    }

    // Sort by effective score (similarity * effective weight) descending, take top-k
    scored.sort((a, b) => b.effectiveScore - a.effectiveScore);
    return scored.slice(0, config.topK);
  }

  // ─── Internal: Expansion ───────────────────────────────────────

  /**
   * Expand an anchor to its connected memory nodes via weighted edges.
   * The anchor's effective score (similarity * anchor weight) is propagated
   * to child nodes, further attenuated by the decay-applied effective edge weight.
   *
   * Propagation formula: node_score = anchorEffectiveScore * effectiveEdgeWeight
   *
   * Where effectiveEdgeWeight = computeEdgeDecay(edge).newWeight
   *
   * This ensures decay flows through the entire retrieval chain:
   *   anchor effective weight → effective edge weight → memory node score
   */
  private expandAnchor(
    anchorId: string,
    anchorSimilarity: number,
    config: VectorSearchConfig,
  ): ScoredMemoryItem[] {
    const now = new Date();

    // Get outgoing edges from this anchor to memory nodes, including decay metadata
    const rows = this.db.prepare(`
      SELECT id, target_id, target_type, edge_type, weight,
        decay_rate, activation_count, last_activated_at, created_at
      FROM weighted_edges
      WHERE source_id = ? AND source_type = 'anchor'
        AND target_type IN ('fact', 'episode', 'concept')
      ORDER BY weight DESC
    `).all(anchorId) as EdgeRow[];

    const items: ScoredMemoryItem[] = [];

    for (const row of rows) {
      // Compute effective edge weight using time + usage decay
      const decayResult = computeEdgeDecay(
        {
          weight: row.weight,
          lastActivatedAt: row.last_activated_at ?? row.created_at,
          activationCount: row.activation_count ?? 0,
          edgeDecayRate: row.decay_rate ?? 0.01,
        },
        now,
        this.decayConfig,
      );

      const effectiveEdgeWeight = decayResult.newWeight;

      // Filter by minimum expansion weight after decay
      if (effectiveEdgeWeight < config.expansionMinWeight) continue;

      // Propagate score: anchor similarity * effective edge weight
      const score = round4(anchorSimilarity * effectiveEdgeWeight);

      // Load the content of the target node
      const content = this.loadNodeContent(row.target_id, row.target_type);
      if (!content) continue;

      items.push({
        nodeId: row.target_id,
        nodeType: row.target_type as ScoredMemoryItem['nodeType'],
        score,
        source: 'vector',
        content,
        retrievalMetadata: {
          expandedFromAnchor: anchorId,
          edgeType: row.edge_type,
          edgeWeight: row.weight,
          effectiveEdgeWeight,
          anchorSimilarity,
        },
      });
    }

    // Sort by score descending and limit to expansionMaxPerAnchor
    items.sort((a, b) => b.score - a.score);
    return items.slice(0, config.expansionMaxPerAnchor);
  }

  /**
   * Load the textual content of a memory node by type and ID.
   */
  private loadNodeContent(nodeId: string, nodeType: string): string | null {
    switch (nodeType) {
      case 'fact': {
        const row = this.db.prepare(
          'SELECT content FROM facts WHERE id = ?',
        ).get(nodeId) as { content: string } | undefined;
        return row?.content ?? null;
      }
      case 'episode': {
        const row = this.db.prepare(
          'SELECT title, description FROM episodes WHERE id = ?',
        ).get(nodeId) as { title: string; description: string } | undefined;
        return row ? `[${row.title}] ${row.description}` : null;
      }
      case 'concept': {
        const row = this.db.prepare(
          'SELECT name, description FROM concepts WHERE id = ?',
        ).get(nodeId) as { name: string; description: string } | undefined;
        return row ? `[${row.name}] ${row.description}` : null;
      }
      default:
        return null;
    }
  }

  // ─── Internal: Deduplication ───────────────────────────────────

  /**
   * Deduplicate items by nodeId, keeping the highest score for each.
   */
  private deduplicateItems(items: ScoredMemoryItem[]): ScoredMemoryItem[] {
    const best = new Map<string, ScoredMemoryItem>();

    for (const item of items) {
      const existing = best.get(item.nodeId);
      if (!existing || item.score > existing.score) {
        best.set(item.nodeId, item);
      }
    }

    return Array.from(best.values());
  }

  // ─── Internal: Helpers ─────────────────────────────────────────

  private countAnchorsWithEmbeddings(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM anchors WHERE embedding IS NOT NULL',
    ).get() as { cnt: number };
    return row.cnt;
  }
}

// ─── Re-exported from cosine-similarity module ───────────────────

export {
  cosineSimilarity as cosineSimilarityVec,
  bufferToFloat32Array,
} from './cosine-similarity.js';

// ─── Internal Types ──────────────────────────────────────────────

interface AnchorEmbeddingRow {
  id: string;
  label: string;
  description: string;
  anchor_type: string;
  embedding: Buffer;
  embedding_dim: number;
  current_weight: number;
  decay_rate: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
}

interface AnchorWithEmbedding {
  id: string;
  label: string;
  description: string;
  anchorType: Anchor['anchorType'];
  embedding: Float32Array;
}

interface EdgeRow {
  id: string;
  target_id: string;
  target_type: string;
  edge_type: string;
  weight: number;
  decay_rate: number;
  activation_count: number;
  last_activated_at: string | null;
  created_at: string;
}

// ─── Internal Utilities ──────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
