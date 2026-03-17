/**
 * MemoryChunkSearcher — direct vector similarity search on memory chunks.
 *
 * Unlike VectorSearcher which searches through anchors (semantic hubs),
 * this module performs direct cosine similarity search on the embeddings
 * of individual memory chunks (facts, episodes, concepts).
 *
 * This provides better recall for recently-ingested content that may
 * not yet be connected to anchors, and complements the anchor-based
 * search in the dual-path retrieval system.
 *
 * Pipeline:
 *   1. Generate query embedding via EmbeddingProvider
 *   2. Load all memory chunk embeddings from memory_embeddings table
 *   3. Compute cosine similarity between query and each chunk
 *   4. Select top-k chunks above the similarity threshold
 *   5. Load full content of matching chunks
 *   6. Return ranked ScoredMemoryItem[] for merging
 *
 * Performance: Brute-force cosine similarity is O(n * d) where n = chunk count,
 * d = embedding dimension. For local use (<50k chunks), this is <50ms.
 * For larger scale, an approximate nearest neighbor index can be added.
 */

import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from './embedding-provider.js';
import type { ScoredMemoryItem } from './types.js';
import type { MemoryNodeType } from '../models/memory-edge.js';
import { cosineSimilarityVec, bufferToFloat32Array } from './vector-searcher.js';
import type { EmbeddingRow } from '../db/memory-embedding-repo.js';

// ─── Configuration ───────────────────────────────────────────────

export interface ChunkSearchConfig {
  /**
   * Maximum number of results to return.
   * Default: 20
   */
  topK: number;

  /**
   * Minimum cosine similarity threshold [0, 1].
   * Chunks below this are filtered out.
   * Default: 0.3
   */
  similarityThreshold: number;

  /**
   * Which node types to search. Empty array means search all types.
   * Default: [] (all types)
   */
  nodeTypes: MemoryNodeType[];

  /**
   * Whether to include superseded facts in results.
   * Default: false
   */
  includeSuperseded: boolean;
}

export const DEFAULT_CHUNK_SEARCH_CONFIG: ChunkSearchConfig = {
  topK: 20,
  similarityThreshold: 0.3,
  nodeTypes: [],
  includeSuperseded: false,
};

// ─── Chunk Search Result ────────────────────────────────────────

/**
 * Result of a memory chunk search operation.
 */
export interface ChunkSearchResult {
  /** Ranked list of scored memory items */
  items: ScoredMemoryItem[];
  /** Search performance stats */
  stats: ChunkSearchStats;
}

/**
 * Performance statistics for the chunk search.
 */
export interface ChunkSearchStats {
  /** Time to generate the query embedding (ms) */
  embeddingTimeMs: number;
  /** Time to search chunks (ms) */
  searchTimeMs: number;
  /** Time to load content for matched chunks (ms) */
  contentLoadTimeMs: number;
  /** Total search time (ms) */
  totalTimeMs: number;
  /** Number of chunks compared */
  chunksCompared: number;
  /** Number of chunks that passed the similarity threshold */
  chunksMatched: number;
}

// ─── MemoryChunkSearcher Class ──────────────────────────────────

/**
 * Performs direct vector similarity search on memory chunks.
 *
 * Usage:
 *   const searcher = new MemoryChunkSearcher(db, embeddingProvider);
 *   const result = await searcher.search("TypeScript migration");
 *   // result.items contains ScoredMemoryItem[] for merging
 */
export class MemoryChunkSearcher {
  readonly config: ChunkSearchConfig;
  private db: Database.Database;
  private embeddingProvider: EmbeddingProvider;

  constructor(
    db: Database.Database,
    embeddingProvider: EmbeddingProvider,
    config?: Partial<ChunkSearchConfig>,
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.config = { ...DEFAULT_CHUNK_SEARCH_CONFIG, ...config };
  }

  /**
   * Search for memory chunks relevant to a query string.
   *
   * @param query - Natural language query
   * @param options - Override search configuration for this query
   * @returns ChunkSearchResult with ranked items and stats
   */
  async search(
    query: string,
    options?: Partial<ChunkSearchConfig>,
  ): Promise<ChunkSearchResult> {
    const config = { ...this.config, ...options };
    const totalStart = performance.now();

    // 1. Generate query embedding
    const embStart = performance.now();
    const embResponse = await this.embeddingProvider.embed({ text: query });
    const queryEmbedding = embResponse.embedding;
    const embeddingTimeMs = round2(performance.now() - embStart);

    // 2. Search chunks by embedding similarity
    const searchStart = performance.now();
    const matches = this.searchChunks(queryEmbedding, config);
    const searchTimeMs = round2(performance.now() - searchStart);

    // 3. Load content for matched chunks
    const contentStart = performance.now();
    const items = this.loadMatchedContent(matches, config);
    const contentLoadTimeMs = round2(performance.now() - contentStart);

    const totalTimeMs = round2(performance.now() - totalStart);

    return {
      items,
      stats: {
        embeddingTimeMs,
        searchTimeMs,
        contentLoadTimeMs,
        totalTimeMs,
        chunksCompared: matches.length > 0 ? this.countChunks(config) : 0,
        chunksMatched: items.length,
      },
    };
  }

  /**
   * Search using a pre-computed embedding vector.
   * Useful when the embedding is already available (e.g., cached or shared
   * with the anchor-based VectorSearcher).
   *
   * @param queryEmbedding - Pre-computed query embedding vector
   * @param options - Override search configuration
   * @returns ChunkSearchResult with ranked items and stats
   */
  searchByEmbedding(
    queryEmbedding: number[],
    options?: Partial<ChunkSearchConfig>,
  ): ChunkSearchResult {
    const config = { ...this.config, ...options };
    const totalStart = performance.now();

    const searchStart = performance.now();
    const matches = this.searchChunks(queryEmbedding, config);
    const searchTimeMs = round2(performance.now() - searchStart);

    const contentStart = performance.now();
    const items = this.loadMatchedContent(matches, config);
    const contentLoadTimeMs = round2(performance.now() - contentStart);

    const totalTimeMs = round2(performance.now() - totalStart);

    return {
      items,
      stats: {
        embeddingTimeMs: 0,
        searchTimeMs,
        contentLoadTimeMs,
        totalTimeMs,
        chunksCompared: matches.length > 0 ? this.countChunks(config) : 0,
        chunksMatched: items.length,
      },
    };
  }

  // ─── Internal: Chunk Search ─────────────────────────────────

  /**
   * Load all memory chunk embeddings and compute cosine similarity
   * against the query embedding. Returns top-k above threshold.
   */
  private searchChunks(
    queryEmbedding: number[],
    config: ChunkSearchConfig,
  ): ChunkMatch[] {
    // Build query based on node type filter
    let sql = 'SELECT * FROM memory_embeddings';
    const params: unknown[] = [];

    if (config.nodeTypes.length > 0) {
      const placeholders = config.nodeTypes.map(() => '?').join(', ');
      sql += ` WHERE node_type IN (${placeholders})`;
      params.push(...config.nodeTypes);
    }

    const rows = this.db.prepare(sql).all(...params) as EmbeddingRow[];

    if (rows.length === 0) return [];

    // Compute similarities
    const scored: ChunkMatch[] = [];

    for (const row of rows) {
      const embedding = bufferToFloat32Array(row.embedding, row.embedding_dim);
      if (!embedding) continue;

      const similarity = cosineSimilarityVec(queryEmbedding, embedding);

      if (similarity >= config.similarityThreshold) {
        scored.push({
          nodeId: row.node_id,
          nodeType: row.node_type as MemoryNodeType,
          similarity: round4(similarity),
        });
      }
    }

    // Sort by similarity descending, take top-k
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, config.topK);
  }

  /**
   * Load the textual content for matched chunks and build ScoredMemoryItems.
   */
  private loadMatchedContent(
    matches: ChunkMatch[],
    config: ChunkSearchConfig,
  ): ScoredMemoryItem[] {
    const items: ScoredMemoryItem[] = [];

    for (const match of matches) {
      const content = this.loadNodeContent(match.nodeId, match.nodeType, config);
      if (!content) continue;

      items.push({
        nodeId: match.nodeId,
        nodeType: match.nodeType,
        score: match.similarity,
        source: 'vector',
        content,
        retrievalMetadata: {
          searchMethod: 'direct_chunk',
          cosineSimilarity: match.similarity,
        },
      });
    }

    return items;
  }

  /**
   * Load the textual content of a memory node by type and ID.
   * Optionally filters out superseded facts.
   */
  private loadNodeContent(
    nodeId: string,
    nodeType: MemoryNodeType,
    config: ChunkSearchConfig,
  ): string | null {
    switch (nodeType) {
      case 'fact': {
        const whereClause = config.includeSuperseded
          ? 'WHERE id = ?'
          : 'WHERE id = ? AND superseded = 0';
        const row = this.db.prepare(
          `SELECT content, superseded FROM facts ${whereClause}`,
        ).get(nodeId) as { content: string; superseded: number } | undefined;
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

  // ─── Internal: Helpers ─────────────────────────────────────

  private countChunks(config: ChunkSearchConfig): number {
    if (config.nodeTypes.length > 0) {
      const placeholders = config.nodeTypes.map(() => '?').join(', ');
      const row = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM memory_embeddings WHERE node_type IN (${placeholders})`,
      ).get(...config.nodeTypes) as { cnt: number };
      return row.cnt;
    }
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM memory_embeddings',
    ).get() as { cnt: number };
    return row.cnt;
  }
}

// ─── Internal Types ──────────────────────────────────────────────

interface ChunkMatch {
  nodeId: string;
  nodeType: MemoryNodeType;
  similarity: number;
}

// ─── Internal Utilities ──────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
