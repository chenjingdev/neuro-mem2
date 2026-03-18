/**
 * HubMatcher — FTS5 + cosine similarity hybrid hub matching for MemoryNode ingestion.
 *
 * When a new leaf node is ingested, this service finds semantically matching
 * hub nodes to connect it to. Replaces the old AnchorCandidateFinder with a
 * 2-stage hybrid approach designed for 수십만 노드 scale.
 *
 * Pipeline:
 *   Stage 1 — FTS5 Pre-filtering (keyword matching):
 *     1. Build FTS5 query from the node's frontmatter + keywords
 *     2. Execute FTS5 MATCH filtered to hub nodes only
 *     3. Return candidate hub IDs ranked by BM25
 *
 *   Stage 2 — Cosine Similarity Reranking:
 *     1. Load embeddings for FTS5 candidate hubs
 *     2. Compute cosine similarity between node embedding and each hub
 *     3. Combine FTS5 rank + cosine similarity into hybrid score
 *     4. Apply >= 0.85 threshold on cosine similarity
 *     5. Return matched hubs sorted by hybrid score
 *
 * Fallback: When FTS5 returns < minFtsCandidates, falls back to brute-force
 * cosine similarity against all hub embeddings.
 *
 * Design:
 * - Uses MemoryNodeRepository for FTS5 search + embedding access
 * - Reuses cosineSimilarityVec from vector-searcher.ts
 * - Threshold >= 0.85 ensures high-confidence hub-to-leaf connections
 * - FTS5 pre-filter keeps brute-force comparisons minimal at scale
 */

import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../retrieval/embedding-provider.js';
import { MemoryNodeRepository } from '../db/memory-node-repo.js';
import { cosineSimilarityVec } from '../retrieval/vector-searcher.js';
import type { MemoryNodeType, MemoryNodeTypeNullable } from '../models/memory-node.js';

// ─── Configuration ────────────────────────────────────────────────

export interface HubMatcherConfig {
  /**
   * Minimum cosine similarity threshold for hub matching [0, 1].
   * Hubs below this are excluded from results.
   * Default: 0.85 (high-confidence matching only)
   */
  similarityThreshold: number;

  /**
   * Maximum number of matched hubs to return.
   * Default: 5
   */
  maxMatches: number;

  /**
   * Maximum number of FTS5 candidates in Stage 1.
   * Default: 50 (sufficient for hub-only filtered search)
   */
  ftsMaxCandidates: number;

  /**
   * Minimum FTS5 candidates before falling back to brute-force cosine search.
   * Default: 3
   */
  ftsMinCandidates: number;

  /**
   * Weight for FTS5 BM25 signal in the hybrid score [0, 1].
   * Cosine similarity weight = 1 - ftsWeight.
   * Default: 0.2 (cosine similarity is the dominant signal for hub matching)
   */
  ftsWeight: number;

  /**
   * Maximum hubs to load for brute-force fallback.
   * Default: 5000
   */
  bruteForceFallbackLimit: number;
}

export const DEFAULT_HUB_MATCHER_CONFIG: HubMatcherConfig = {
  similarityThreshold: 0.85,
  maxMatches: 5,
  ftsMaxCandidates: 50,
  ftsMinCandidates: 3,
  ftsWeight: 0.2,
  bruteForceFallbackLimit: 5000,
};

// ─── Result Types ─────────────────────────────────────────────────

/**
 * A matched hub node found by hybrid FTS5 + cosine scoring.
 */
export interface HubMatch {
  /** Hub node ID */
  hubId: string;
  /** Hub frontmatter label */
  label: string;
  /** Hub node type */
  nodeType: MemoryNodeTypeNullable;
  /** Raw cosine similarity [0, 1] */
  cosineSimilarity: number;
  /** Normalized FTS5 BM25 score [0, 1] (0 if not found via FTS) */
  ftsScore: number;
  /** Combined hybrid score [0, 1] = ftsWeight * ftsScore + (1 - ftsWeight) * cosineSimilarity */
  hybridScore: number;
  /** Which matching path produced this result */
  source: 'fts+cosine' | 'cosine-only';
}

/**
 * Result of hub matching for a node.
 */
export interface HubMatchResult {
  /** Matched hubs above threshold, sorted by hybrid score descending */
  matches: HubMatch[];
  /** Performance stats */
  stats: HubMatchStats;
}

export interface HubMatchStats {
  /** Stage 1: FTS5 search time (ms) */
  ftsTimeMs: number;
  /** Stage 1: Number of FTS5 hub candidates */
  ftsCandidateCount: number;
  /** Stage 2: Cosine comparison time (ms) */
  cosineTimeMs: number;
  /** Total hubs compared via cosine similarity */
  hubsCompared: number;
  /** Number of hubs above similarity threshold */
  matchesAboveThreshold: number;
  /** Whether brute-force fallback was used */
  usedBruteForceFallback: boolean;
  /** Total matching time (ms) */
  totalTimeMs: number;
}

// ─── HubMatcher Class ─────────────────────────────────────────────

export class HubMatcher {
  readonly config: HubMatcherConfig;
  private repo: MemoryNodeRepository;
  private db: Database.Database;

  constructor(
    db: Database.Database,
    config?: Partial<HubMatcherConfig>,
  ) {
    this.db = db;
    this.config = { ...DEFAULT_HUB_MATCHER_CONFIG, ...config };
    this.repo = new MemoryNodeRepository(db);
  }

  /**
   * Find matching hubs for a node using FTS5 + cosine hybrid scoring.
   *
   * @param queryText - Text to search for (typically frontmatter + keywords of the new node)
   * @param queryEmbedding - Pre-computed embedding of the node
   * @param options - Override config for this query
   * @returns Matched hubs above the similarity threshold
   */
  match(
    queryText: string,
    queryEmbedding: number[] | Float32Array,
    options?: Partial<HubMatcherConfig>,
  ): HubMatchResult {
    const config = { ...this.config, ...options };
    const totalStart = performance.now();

    // ═══════════════════════════════════════════════════════════════
    // Stage 1: FTS5 Pre-filtering (hub nodes only)
    // ═══════════════════════════════════════════════════════════════

    const ftsStart = performance.now();
    let ftsCandidates: { id: string; rank: number }[] = [];

    if (queryText.trim()) {
      ftsCandidates = this.repo.ftsSearchFiltered(queryText, {
        nodeRole: 'hub',
        limit: config.ftsMaxCandidates,
      });
    }
    const ftsTimeMs = round2(performance.now() - ftsStart);

    // ═══════════════════════════════════════════════════════════════
    // Stage 2: Cosine Similarity Scoring
    // ═══════════════════════════════════════════════════════════════

    const cosineStart = performance.now();
    let matches: HubMatch[];
    let hubsCompared: number;
    let usedBruteForceFallback = false;

    const queryArr = queryEmbedding instanceof Float32Array
      ? Array.from(queryEmbedding)
      : queryEmbedding;

    if (ftsCandidates.length >= config.ftsMinCandidates) {
      // Normal path: rerank FTS candidates with cosine similarity
      const result = this.rerankFtsCandidates(
        ftsCandidates,
        queryArr,
        config,
      );
      matches = result.matches;
      hubsCompared = ftsCandidates.length;
    } else {
      // Fallback: FTS returned too few hubs → brute-force cosine against all hubs
      usedBruteForceFallback = true;
      const bruteResult = this.bruteForceHubMatch(
        queryArr,
        config,
      );

      // Merge with FTS candidates (FTS candidates get score boost)
      if (ftsCandidates.length > 0) {
        const ftsReranked = this.rerankFtsCandidates(
          ftsCandidates,
          queryArr,
          config,
        );
        matches = this.mergeResults(ftsReranked.matches, bruteResult.matches);
      } else {
        matches = bruteResult.matches;
      }
      hubsCompared = bruteResult.hubsCompared + ftsCandidates.length;
    }

    const cosineTimeMs = round2(performance.now() - cosineStart);

    // Apply threshold filter and limit
    const matchesAboveThreshold = matches.length;
    matches = matches
      .sort((a, b) => b.hybridScore - a.hybridScore)
      .slice(0, config.maxMatches);

    const totalTimeMs = round2(performance.now() - totalStart);

    return {
      matches,
      stats: {
        ftsTimeMs,
        ftsCandidateCount: ftsCandidates.length,
        cosineTimeMs,
        hubsCompared,
        matchesAboveThreshold,
        usedBruteForceFallback,
        totalTimeMs,
      },
    };
  }

  /**
   * Find matching hubs using text query only (generates embedding internally).
   *
   * @param queryText - Text to search for
   * @param embeddingProvider - Provider to generate embedding
   * @param options - Override config
   */
  async matchWithEmbedding(
    queryText: string,
    embeddingProvider: EmbeddingProvider,
    options?: Partial<HubMatcherConfig>,
  ): Promise<HubMatchResult & { embedding: number[] }> {
    const embResponse = await embeddingProvider.embed({ text: queryText });
    const result = this.match(queryText, embResponse.embedding, options);
    return { ...result, embedding: embResponse.embedding };
  }

  // ─── Internal: FTS + Cosine Reranking ──────────────────────────

  /**
   * Rerank FTS5 candidates using cosine similarity.
   * Only hubs with cosine >= threshold are included.
   */
  private rerankFtsCandidates(
    ftsCandidates: { id: string; rank: number }[],
    queryEmbedding: number[],
    config: HubMatcherConfig,
  ): { matches: HubMatch[] } {
    if (ftsCandidates.length === 0) return { matches: [] };

    const candidateIds = ftsCandidates.map(c => c.id);

    // Load embeddings for candidates
    const embeddings = this.repo.getEmbeddingsByIds(candidateIds);

    // Load hub metadata (frontmatter, nodeType)
    const metadata = this.loadHubMetadata(candidateIds);

    // Normalize FTS5 ranks to [0, 1]
    const normalizedFts = normalizeFtsRanks(ftsCandidates);

    const matches: HubMatch[] = [];

    for (const candidate of ftsCandidates) {
      const meta = metadata.get(candidate.id);
      if (!meta) continue;

      const embedding = embeddings.get(candidate.id);
      if (!embedding) continue;

      const cosineSim = cosineSimilarityVec(queryEmbedding, embedding);

      // Apply threshold on cosine similarity
      if (cosineSim < config.similarityThreshold) continue;

      const ftsScore = normalizedFts.get(candidate.id) ?? 0;
      const hybridScore = round4(
        config.ftsWeight * ftsScore + (1 - config.ftsWeight) * cosineSim,
      );

      matches.push({
        hubId: candidate.id,
        label: meta.frontmatter,
        nodeType: meta.nodeType,
        cosineSimilarity: round4(cosineSim),
        ftsScore: round4(ftsScore),
        hybridScore,
        source: 'fts+cosine',
      });
    }

    return { matches };
  }

  // ─── Internal: Brute-Force Cosine Fallback ────────────────────

  /**
   * Brute-force cosine similarity against all hub embeddings.
   * Used when FTS5 returns too few candidates.
   */
  private bruteForceHubMatch(
    queryEmbedding: number[],
    config: HubMatcherConfig,
  ): { matches: HubMatch[]; hubsCompared: number } {
    // Load all hub embeddings
    const rows = this.db.prepare(`
      SELECT id, frontmatter, node_type, embedding, embedding_dim
      FROM memory_nodes
      WHERE node_role = 'hub' AND embedding IS NOT NULL AND embedding_dim IS NOT NULL
      LIMIT ?
    `).all(config.bruteForceFallbackLimit) as HubEmbeddingRow[];

    const matches: HubMatch[] = [];

    for (const row of rows) {
      const hubEmbedding = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding_dim,
      );

      const cosineSim = cosineSimilarityVec(queryEmbedding, hubEmbedding);

      // Apply threshold
      if (cosineSim < config.similarityThreshold) continue;

      matches.push({
        hubId: row.id,
        label: row.frontmatter,
        nodeType: (row.node_type as MemoryNodeTypeNullable) ?? null,
        cosineSimilarity: round4(cosineSim),
        ftsScore: 0,
        hybridScore: round4((1 - config.ftsWeight) * cosineSim),
        source: 'cosine-only',
      });
    }

    return { matches, hubsCompared: rows.length };
  }

  // ─── Internal: Merge Results ──────────────────────────────────

  /**
   * Merge FTS+cosine results with brute-force results.
   * Deduplicates by keeping the higher-scored version.
   */
  private mergeResults(
    ftsMatches: HubMatch[],
    bruteForceMatches: HubMatch[],
  ): HubMatch[] {
    const byId = new Map<string, HubMatch>();

    for (const m of ftsMatches) {
      byId.set(m.hubId, m);
    }

    for (const m of bruteForceMatches) {
      const existing = byId.get(m.hubId);
      if (!existing || m.hybridScore > existing.hybridScore) {
        byId.set(m.hubId, m);
      }
    }

    return Array.from(byId.values());
  }

  // ─── Internal: Hub Metadata ──────────────────────────────────

  private loadHubMetadata(ids: string[]): Map<string, HubMetadata> {
    if (ids.length === 0) return new Map();

    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT id, frontmatter, node_type
      FROM memory_nodes
      WHERE id IN (${placeholders})
    `).all(...ids) as { id: string; frontmatter: string; node_type: string | null }[];

    const map = new Map<string, HubMetadata>();
    for (const row of rows) {
      map.set(row.id, {
        frontmatter: row.frontmatter,
        nodeType: (row.node_type as MemoryNodeTypeNullable) ?? null,
      });
    }
    return map;
  }
}

// ─── Internal Types ──────────────────────────────────────────────

interface HubEmbeddingRow {
  id: string;
  frontmatter: string;
  node_type: string | null;
  embedding: Buffer;
  embedding_dim: number;
}

interface HubMetadata {
  frontmatter: string;
  nodeType: MemoryNodeTypeNullable;
}

// ─── Pure Helper Functions (exported for testing) ────────────────

/**
 * Normalize FTS5 ranks to [0, 1] range.
 *
 * FTS5 rank values are negative (more negative = better match by BM25).
 * We normalize so the best match = 1.0 and worst = 0.0.
 * If all ranks are identical, all normalized scores become 1.0.
 */
export function normalizeFtsRanks(
  candidates: { id: string; rank: number }[],
): Map<string, number> {
  const map = new Map<string, number>();
  if (candidates.length === 0) return map;

  let minRank = Infinity;
  let maxRank = -Infinity;
  for (const c of candidates) {
    if (c.rank < minRank) minRank = c.rank;
    if (c.rank > maxRank) maxRank = c.rank;
  }

  const range = maxRank - minRank;

  for (const c of candidates) {
    if (range === 0) {
      map.set(c.id, 1.0);
    } else {
      // Invert: most negative rank → highest score
      map.set(c.id, (maxRank - c.rank) / range);
    }
  }

  return map;
}

// ─── Internal Utilities ──────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
