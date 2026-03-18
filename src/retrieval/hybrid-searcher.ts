/**
 * HybridSearcher — 2-stage FTS5 pre-filtering + vector reranking search pipeline.
 *
 * Replaces the old brute-force vector search with a scalable hybrid approach
 * designed for 수십만 노드 scale on the unified MemoryNode model.
 *
 * Pipeline:
 *   Stage 1 — FTS5 Pre-filtering (keyword matching):
 *     1. Tokenize the query into FTS5-safe terms (한영 혼용)
 *     2. Execute FTS5 MATCH on memory_nodes_fts (frontmatter + keywords + summary)
 *     3. Return top-N candidate node IDs ranked by BM25
 *
 *   Stage 2 — Vector Reranking (semantic similarity):
 *     1. Generate query embedding via EmbeddingProvider
 *     2. Load embeddings for FTS5 candidate nodes only (not all nodes)
 *     3. Compute cosine similarity between query and each candidate
 *     4. Combine FTS5 rank signal with vector similarity for final score
 *     5. Apply event-based decay penalty to final scores
 *     6. Return top-K results sorted by combined score
 *
 * Performance advantage over brute-force:
 *   - FTS5 pre-filter reduces vector comparison from O(N) to O(candidates)
 *   - For 100k nodes with 200 FTS candidates: ~200x fewer cosine computations
 *   - FTS5 uses SQLite's optimized inverted index (sub-ms at any scale)
 *
 * Fallback: When FTS5 returns < minFtsCandidates, falls back to brute-force
 * vector search on all nodes to ensure recall for purely semantic queries.
 */

import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from './embedding-provider.js';
import { MemoryNodeRepository } from '../db/memory-node-repo.js';
import type {
  MemoryNodeType,
  MemoryNodeRole,
  MemoryNode,
} from '../models/memory-node.js';

// ─── Import cosine similarity from dedicated module ──────────────
export { cosineSimilarity as cosineSimilarityVec } from './cosine-similarity.js';
import { cosineSimilarity as cosineSimilarityVec } from './cosine-similarity.js';

// ─── Configuration ───────────────────────────────────────────────

export interface HybridSearchConfig {
  /**
   * Maximum number of FTS5 candidates in Stage 1.
   * More candidates = better recall but slower reranking.
   * Default: 200 (good balance for 수십만 nodes)
   */
  ftsMaxCandidates: number;

  /**
   * Minimum FTS5 candidates before falling back to brute-force vector search.
   * If FTS5 returns fewer than this, we do a full vector scan for better recall.
   * Default: 5
   */
  ftsMinCandidates: number;

  /**
   * Maximum results to return after reranking (final output).
   * Default: 20
   */
  topK: number;

  /**
   * Minimum combined score threshold [0, 1].
   * Items below this are filtered out.
   * Default: 0.1
   */
  minScore: number;

  /**
   * Weight for FTS5 BM25 signal in the combined score [0, 1].
   * Vector similarity weight = 1 - ftsWeight.
   * Default: 0.3 (vector similarity is the primary signal)
   */
  ftsWeight: number;

  /**
   * Whether to apply event-based decay to final scores.
   * Scores are penalized based on how many events have elapsed since last activation.
   * Default: true
   */
  applyDecay: boolean;

  /**
   * Decay half-life in event units.
   * After this many events since last activation, the decay factor = 0.5.
   * Higher = slower decay. Default: 50 events
   */
  decayHalfLife: number;

  /**
   * Maximum number of nodes to load for brute-force fallback.
   * Limits memory usage when falling back to full vector scan.
   * Default: 10000
   */
  bruteForceFallbackLimit: number;

  /**
   * Optional node type filter.
   * If set, only nodes of these types are included.
   */
  nodeTypeFilter?: MemoryNodeType | MemoryNodeType[];

  /**
   * Optional node role filter.
   */
  nodeRoleFilter?: MemoryNodeRole;
}

export const DEFAULT_HYBRID_SEARCH_CONFIG: HybridSearchConfig = {
  ftsMaxCandidates: 200,
  ftsMinCandidates: 5,
  topK: 20,
  minScore: 0.1,
  ftsWeight: 0.3,
  applyDecay: true,
  decayHalfLife: 50,
  bruteForceFallbackLimit: 10000,
};

// ─── Search Result Types ────────────────────────────────────────

export interface HybridSearchItem {
  /** Node ID */
  nodeId: string;
  /** Node type */
  nodeType: MemoryNodeType;
  /** Node role */
  nodeRole: MemoryNodeRole;
  /** Frontmatter label (L0) */
  frontmatter: string;
  /** Combined score after FTS+vector+decay [0, 1] */
  score: number;
  /** Breakdown of score components */
  scoreBreakdown: {
    /** Normalized FTS5 BM25 score [0, 1] */
    ftsScore: number;
    /** Cosine similarity [0, 1] */
    vectorScore: number;
    /** Decay multiplier [0, 1] (1.0 = no decay) */
    decayFactor: number;
    /** Combined score before decay */
    combinedBeforeDecay: number;
  };
  /** Which stage contributed this result */
  source: 'fts+vector' | 'vector-only' | 'fts-only';
}

export interface HybridSearchResult {
  /** Ranked list of search results */
  items: HybridSearchItem[];
  /** Performance statistics */
  stats: HybridSearchStats;
}

export interface HybridSearchStats {
  /** Stage 1: FTS5 pre-filtering time (ms) */
  ftsTimeMs: number;
  /** Stage 1: Number of FTS5 candidates */
  ftsCandidateCount: number;
  /** Stage 2: Embedding generation time (ms) */
  embeddingTimeMs: number;
  /** Stage 2: Vector reranking time (ms) */
  rerankTimeMs: number;
  /** Total search time (ms) */
  totalTimeMs: number;
  /** Whether brute-force fallback was used */
  usedBruteForceFallback: boolean;
  /** Total nodes considered for vector comparison */
  vectorComparisonCount: number;
  /** Final output count */
  outputCount: number;
  /** Current global event counter (for decay context) */
  currentEventCounter?: number;
}

// ─── HybridSearcher Class ───────────────────────────────────────

/**
 * Performs 2-stage hybrid search: FTS5 pre-filtering → vector reranking.
 *
 * Usage:
 *   const searcher = new HybridSearcher(db, embeddingProvider);
 *   const result = await searcher.search("TypeScript 마이그레이션 전략");
 *   // result.items contains ranked HybridSearchItem[]
 */
export class HybridSearcher {
  readonly config: HybridSearchConfig;
  private repo: MemoryNodeRepository;
  private embeddingProvider: EmbeddingProvider;
  private db: Database.Database;

  constructor(
    db: Database.Database,
    embeddingProvider: EmbeddingProvider,
    config?: Partial<HybridSearchConfig>,
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.config = { ...DEFAULT_HYBRID_SEARCH_CONFIG, ...config };
    this.repo = new MemoryNodeRepository(db);
  }

  /**
   * Execute the 2-stage hybrid search pipeline.
   *
   * @param query - Natural language query (한영 혼용 지원)
   * @param currentEventCounter - Current global event counter for decay computation
   * @param options - Override search configuration for this query
   */
  async search(
    query: string,
    currentEventCounter?: number,
    options?: Partial<HybridSearchConfig>,
  ): Promise<HybridSearchResult> {
    const config = { ...this.config, ...options };
    const totalStart = performance.now();

    if (!query.trim()) {
      return {
        items: [],
        stats: emptyStats(),
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // Stage 1: FTS5 Pre-filtering
    // ═══════════════════════════════════════════════════════════════

    const ftsStart = performance.now();
    let ftsCandidates: { id: string; rank: number }[];

    if (config.nodeTypeFilter || config.nodeRoleFilter) {
      ftsCandidates = this.repo.ftsSearchFiltered(query, {
        nodeType: config.nodeTypeFilter,
        nodeRole: config.nodeRoleFilter,
        limit: config.ftsMaxCandidates,
      });
    } else {
      ftsCandidates = this.repo.ftsSearch(query, config.ftsMaxCandidates);
    }
    const ftsTimeMs = round2(performance.now() - ftsStart);

    // ═══════════════════════════════════════════════════════════════
    // Stage 2: Vector Reranking
    // ═══════════════════════════════════════════════════════════════

    // 2a. Generate query embedding
    const embStart = performance.now();
    const embResponse = await this.embeddingProvider.embed({ text: query });
    const queryEmbedding = embResponse.embedding;
    const embeddingTimeMs = round2(performance.now() - embStart);

    // 2b. Determine vector comparison candidates
    const rerankStart = performance.now();
    let usedBruteForceFallback = false;
    let vectorComparisonCount = 0;
    let items: HybridSearchItem[];

    if (ftsCandidates.length >= config.ftsMinCandidates) {
      // Normal path: rerank FTS candidates using vector similarity
      items = this.rerankWithVector(
        ftsCandidates,
        queryEmbedding,
        config,
        currentEventCounter,
      );
      vectorComparisonCount = ftsCandidates.length;
    } else {
      // Fallback: FTS returned too few results → brute-force vector search
      // This handles purely semantic queries that don't match keywords well
      usedBruteForceFallback = true;
      const bruteForceItems = this.bruteForceVectorSearch(
        queryEmbedding,
        config,
        currentEventCounter,
      );
      vectorComparisonCount = bruteForceItems.comparisonCount;

      // Merge with whatever FTS did return (they get FTS score boost)
      items = this.mergeFtsAndBruteForce(
        ftsCandidates,
        bruteForceItems.items,
        queryEmbedding,
        config,
        currentEventCounter,
      );
    }

    const rerankTimeMs = round2(performance.now() - rerankStart);

    // Apply final filtering and limiting
    items = items
      .filter(item => item.score >= config.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, config.topK);

    const totalTimeMs = round2(performance.now() - totalStart);

    return {
      items,
      stats: {
        ftsTimeMs,
        ftsCandidateCount: ftsCandidates.length,
        embeddingTimeMs,
        rerankTimeMs,
        totalTimeMs,
        usedBruteForceFallback,
        vectorComparisonCount,
        outputCount: items.length,
        currentEventCounter,
      },
    };
  }

  /**
   * Search by pre-computed embedding (skip embedding generation step).
   * Useful when the query embedding is already available (e.g., cached).
   */
  async searchByEmbedding(
    queryEmbedding: number[],
    queryText: string,
    currentEventCounter?: number,
    options?: Partial<HybridSearchConfig>,
  ): Promise<HybridSearchResult> {
    const config = { ...this.config, ...options };
    const totalStart = performance.now();

    // Stage 1: FTS pre-filtering (still uses text query)
    const ftsStart = performance.now();
    let ftsCandidates: { id: string; rank: number }[];

    if (config.nodeTypeFilter || config.nodeRoleFilter) {
      ftsCandidates = this.repo.ftsSearchFiltered(queryText, {
        nodeType: config.nodeTypeFilter,
        nodeRole: config.nodeRoleFilter,
        limit: config.ftsMaxCandidates,
      });
    } else {
      ftsCandidates = this.repo.ftsSearch(queryText, config.ftsMaxCandidates);
    }
    const ftsTimeMs = round2(performance.now() - ftsStart);

    // Stage 2: Vector reranking with pre-computed embedding
    const rerankStart = performance.now();
    let usedBruteForceFallback = false;
    let vectorComparisonCount = 0;
    let items: HybridSearchItem[];

    if (ftsCandidates.length >= config.ftsMinCandidates) {
      items = this.rerankWithVector(ftsCandidates, queryEmbedding, config, currentEventCounter);
      vectorComparisonCount = ftsCandidates.length;
    } else {
      usedBruteForceFallback = true;
      const bruteForceItems = this.bruteForceVectorSearch(queryEmbedding, config, currentEventCounter);
      vectorComparisonCount = bruteForceItems.comparisonCount;
      items = this.mergeFtsAndBruteForce(ftsCandidates, bruteForceItems.items, queryEmbedding, config, currentEventCounter);
    }

    const rerankTimeMs = round2(performance.now() - rerankStart);

    items = items
      .filter(item => item.score >= config.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, config.topK);

    const totalTimeMs = round2(performance.now() - totalStart);

    return {
      items,
      stats: {
        ftsTimeMs,
        ftsCandidateCount: ftsCandidates.length,
        embeddingTimeMs: 0, // No embedding generation
        rerankTimeMs,
        totalTimeMs,
        usedBruteForceFallback,
        vectorComparisonCount,
        outputCount: items.length,
        currentEventCounter,
      },
    };
  }

  // ─── Internal: FTS + Vector Reranking ──────────────────────────

  /**
   * Rerank FTS5 candidates using vector cosine similarity.
   * Combines FTS5 BM25 rank with vector similarity into a single score.
   */
  private rerankWithVector(
    ftsCandidates: { id: string; rank: number }[],
    queryEmbedding: number[],
    config: HybridSearchConfig,
    currentEventCounter?: number,
  ): HybridSearchItem[] {
    if (ftsCandidates.length === 0) return [];

    // Get candidate IDs and fetch their embeddings + node metadata
    const candidateIds = ftsCandidates.map(c => c.id);
    const embeddings = this.repo.getEmbeddingsByIds(candidateIds);
    const nodeMetadata = this.getNodeMetadataByIds(candidateIds);

    // Normalize FTS5 ranks to [0, 1] range
    // FTS5 rank is negative (more negative = better match), so we invert
    const normalizedFtsScores = normalizeFtsRanks(ftsCandidates);

    const items: HybridSearchItem[] = [];

    for (const candidate of ftsCandidates) {
      const meta = nodeMetadata.get(candidate.id);
      if (!meta) continue;

      const ftsScore = normalizedFtsScores.get(candidate.id) ?? 0;

      // Compute vector similarity if embedding exists
      const embedding = embeddings.get(candidate.id);
      let vectorScore = 0;
      if (embedding) {
        vectorScore = cosineSimilarityVec(queryEmbedding, embedding);
      }

      // Combine FTS and vector scores
      const combinedBeforeDecay =
        config.ftsWeight * ftsScore + (1 - config.ftsWeight) * vectorScore;

      // Apply event-based decay
      const decayFactor = config.applyDecay && currentEventCounter != null
        ? computeEventDecay(
            meta.lastActivatedAtEvent,
            currentEventCounter,
            config.decayHalfLife,
          )
        : 1.0;

      const finalScore = round4(combinedBeforeDecay * decayFactor);

      items.push({
        nodeId: candidate.id,
        nodeType: meta.nodeType,
        nodeRole: meta.nodeRole,
        frontmatter: meta.frontmatter,
        score: finalScore,
        scoreBreakdown: {
          ftsScore: round4(ftsScore),
          vectorScore: round4(vectorScore),
          decayFactor: round4(decayFactor),
          combinedBeforeDecay: round4(combinedBeforeDecay),
        },
        source: 'fts+vector',
      });
    }

    return items;
  }

  // ─── Internal: Brute-Force Vector Fallback ─────────────────────

  /**
   * Brute-force vector search when FTS5 returns insufficient candidates.
   * Loads all embeddings (up to bruteForceFallbackLimit) and computes cosine similarity.
   */
  private bruteForceVectorSearch(
    queryEmbedding: number[],
    config: HybridSearchConfig,
    currentEventCounter?: number,
  ): { items: HybridSearchItem[]; comparisonCount: number } {
    // Load all embeddings (with optional type filter)
    const nodeType = Array.isArray(config.nodeTypeFilter)
      ? undefined  // Can't pass array to getAllEmbeddings, will filter after
      : config.nodeTypeFilter;

    let allEmbeddings = this.repo.getAllEmbeddings(nodeType);

    // Apply array type filter if needed
    if (Array.isArray(config.nodeTypeFilter)) {
      const typeSet = new Set(config.nodeTypeFilter);
      const metaMap = this.getNodeMetadataByIds(allEmbeddings.map(e => e.id));
      allEmbeddings = allEmbeddings.filter(e => {
        const meta = metaMap.get(e.id);
        return meta && typeSet.has(meta.nodeType);
      });
    }

    // Limit for memory safety
    if (allEmbeddings.length > config.bruteForceFallbackLimit) {
      allEmbeddings = allEmbeddings.slice(0, config.bruteForceFallbackLimit);
    }

    const comparisonCount = allEmbeddings.length;
    const candidateIds = allEmbeddings.map(e => e.id);
    const nodeMetadata = this.getNodeMetadataByIds(candidateIds);

    const items: HybridSearchItem[] = [];

    for (const entry of allEmbeddings) {
      const meta = nodeMetadata.get(entry.id);
      if (!meta) continue;

      // Apply role filter
      if (config.nodeRoleFilter && meta.nodeRole !== config.nodeRoleFilter) continue;

      const vectorScore = cosineSimilarityVec(queryEmbedding, entry.embedding);
      const combinedBeforeDecay = vectorScore; // No FTS signal

      const decayFactor = config.applyDecay && currentEventCounter != null
        ? computeEventDecay(
            meta.lastActivatedAtEvent,
            currentEventCounter,
            config.decayHalfLife,
          )
        : 1.0;

      const finalScore = round4(combinedBeforeDecay * decayFactor);

      items.push({
        nodeId: entry.id,
        nodeType: meta.nodeType,
        nodeRole: meta.nodeRole,
        frontmatter: meta.frontmatter,
        score: finalScore,
        scoreBreakdown: {
          ftsScore: 0,
          vectorScore: round4(vectorScore),
          decayFactor: round4(decayFactor),
          combinedBeforeDecay: round4(combinedBeforeDecay),
        },
        source: 'vector-only',
      });
    }

    return { items, comparisonCount };
  }

  // ─── Internal: Merge FTS + Brute-Force Results ─────────────────

  /**
   * Merge FTS5 candidates with brute-force vector results.
   * FTS candidates get a combined FTS+vector score; brute-force items get vector-only.
   * Deduplicates by keeping the higher-scored version.
   */
  private mergeFtsAndBruteForce(
    ftsCandidates: { id: string; rank: number }[],
    bruteForceItems: HybridSearchItem[],
    queryEmbedding: number[],
    config: HybridSearchConfig,
    currentEventCounter?: number,
  ): HybridSearchItem[] {
    const result = new Map<string, HybridSearchItem>();

    // First, add FTS candidates with combined FTS+vector score
    if (ftsCandidates.length > 0) {
      const ftsReranked = this.rerankWithVector(
        ftsCandidates,
        queryEmbedding,
        config,
        currentEventCounter,
      );
      for (const item of ftsReranked) {
        result.set(item.nodeId, item);
      }
    }

    // Then, add brute-force items (only if not already in FTS results, or higher score)
    for (const item of bruteForceItems) {
      const existing = result.get(item.nodeId);
      if (!existing || item.score > existing.score) {
        result.set(item.nodeId, item);
      }
    }

    return Array.from(result.values());
  }

  // ─── Internal: Node Metadata Helper ────────────────────────────

  /**
   * Load lightweight metadata for multiple nodes (type, role, frontmatter, lifecycle).
   * Uses a single SQL query for efficiency.
   */
  private getNodeMetadataByIds(ids: string[]): Map<string, NodeMetadata> {
    if (ids.length === 0) return new Map();

    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT id, node_type, node_role, frontmatter, last_activated_at_event, activation_count
      FROM memory_nodes
      WHERE id IN (${placeholders})
    `).all(...ids) as NodeMetadataRow[];

    const map = new Map<string, NodeMetadata>();
    for (const row of rows) {
      map.set(row.id, {
        nodeType: row.node_type as MemoryNodeType,
        nodeRole: row.node_role as MemoryNodeRole,
        frontmatter: row.frontmatter,
        lastActivatedAtEvent: row.last_activated_at_event,
        activationCount: row.activation_count,
      });
    }
    return map;
  }
}

// ─── Internal Types ──────────────────────────────────────────────

interface NodeMetadataRow {
  id: string;
  node_type: string;
  node_role: string;
  frontmatter: string;
  last_activated_at_event: number;
  activation_count: number;
}

interface NodeMetadata {
  nodeType: MemoryNodeType;
  nodeRole: MemoryNodeRole;
  frontmatter: string;
  lastActivatedAtEvent: number;
  activationCount: number;
}

// ─── Pure Helper Functions (exported for testing) ────────────────

/**
 * Normalize FTS5 ranks to [0, 1] range.
 *
 * FTS5 rank values are negative (more negative = better match by BM25).
 * We normalize so the best match = 1.0 and worst = 0.0.
 *
 * If all ranks are identical, all normalized scores become 1.0.
 */
export function normalizeFtsRanks(
  candidates: { id: string; rank: number }[],
): Map<string, number> {
  const map = new Map<string, number>();
  if (candidates.length === 0) return map;

  // FTS5 rank is negative; more negative = better
  // Find the range for normalization
  let minRank = Infinity;
  let maxRank = -Infinity;
  for (const c of candidates) {
    if (c.rank < minRank) minRank = c.rank;
    if (c.rank > maxRank) maxRank = c.rank;
  }

  const range = maxRank - minRank;

  for (const c of candidates) {
    if (range === 0) {
      // All ranks identical → all get score 1.0
      map.set(c.id, 1.0);
    } else {
      // Invert: most negative rank → highest score
      // Score = (maxRank - rank) / range → best match gets 1.0
      map.set(c.id, (maxRank - c.rank) / range);
    }
  }

  return map;
}

/**
 * Compute event-based decay factor using exponential half-life decay.
 *
 * Formula: decayFactor = 2^(-eventsSinceActivation / halfLife)
 *
 * - 0 events elapsed → factor = 1.0 (no decay)
 * - halfLife events elapsed → factor = 0.5
 * - 2 * halfLife events elapsed → factor = 0.25
 * - Node never activated → uses createdAtEvent as baseline
 *
 * @param lastActivatedAtEvent - Global event counter when node was last activated
 * @param currentEventCounter - Current global event counter
 * @param halfLife - Number of events for half-life (default 50)
 * @returns Decay factor in (0, 1]
 */
export function computeEventDecay(
  lastActivatedAtEvent: number,
  currentEventCounter: number,
  halfLife: number = 50,
): number {
  const elapsed = Math.max(0, currentEventCounter - lastActivatedAtEvent);
  if (elapsed === 0) return 1.0;
  if (halfLife <= 0) return 1.0;
  return Math.pow(2, -elapsed / halfLife);
}

// ─── Internal Utilities ──────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function emptyStats(): HybridSearchStats {
  return {
    ftsTimeMs: 0,
    ftsCandidateCount: 0,
    embeddingTimeMs: 0,
    rerankTimeMs: 0,
    totalTimeMs: 0,
    usedBruteForceFallback: false,
    vectorComparisonCount: 0,
    outputCount: 0,
  };
}
