/**
 * AnchorCandidateFinder — coarse-filters existing anchors by local embedding
 * similarity when a new fact is ingested.
 *
 * This is a key component of the brain-like memory pipeline: instead of creating
 * isolated facts, we find semantically related anchors so the LLM can decide
 * whether to connect the fact to existing anchors or create new ones.
 *
 * Pipeline position:
 *   FactIngestionPipeline → AnchorCandidateFinder → (LLM anchor decision) → edge creation
 *
 * Design decisions:
 * - Reuses VectorSearcher's cosineSimilarityVec + bufferToFloat32Array for cosine scoring
 * - Reads anchor embeddings directly from SQLite BLOB (same pattern as VectorSearcher)
 * - Decay-aware: computes effective anchor weight at query time
 * - Returns ranked AnchorCandidate[] for downstream LLM anchor-linking decisions
 * - Fully local: uses EmbeddingProvider (LocalEmbeddingProvider) — no external API
 */

import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../retrieval/embedding-provider.js';
import {
  cosineSimilarityVec,
  bufferToFloat32Array,
} from '../retrieval/vector-searcher.js';
import {
  computeAnchorEffectiveWeight,
  type AnchorDecayConfig,
  DEFAULT_DECAY_CONFIG,
} from '../scoring/anchor-decay.js';
import type { Anchor } from '../models/anchor.js';

// ─── Configuration ────────────────────────────────────────────────

export interface AnchorCandidateFinderConfig {
  /**
   * Minimum cosine similarity threshold [0, 1].
   * Anchors below this are filtered out of candidate list.
   * Default: 0.25 (lower than VectorSearcher's 0.3 to be more inclusive
   * during ingestion — the LLM will make the final decision).
   */
  similarityThreshold: number;

  /**
   * Maximum number of candidate anchors to return.
   * Default: 10
   */
  maxCandidates: number;

  /**
   * Whether to factor in anchor effective weight (time + usage decay)
   * when scoring candidates.
   * Default: true
   */
  useDecayWeighting: boolean;
}

export const DEFAULT_CANDIDATE_FINDER_CONFIG: AnchorCandidateFinderConfig = {
  similarityThreshold: 0.25,
  maxCandidates: 10,
  useDecayWeighting: true,
};

// ─── Result types ─────────────────────────────────────────────────

/**
 * A candidate anchor found by embedding similarity during fact ingestion.
 */
export interface AnchorCandidate {
  /** Anchor ID */
  anchorId: string;
  /** Anchor label (human-readable) */
  label: string;
  /** Anchor description */
  description: string;
  /** Anchor type: entity | topic | temporal | composite */
  anchorType: Anchor['anchorType'];
  /** Raw cosine similarity between fact embedding and anchor embedding [0, 1] */
  similarity: number;
  /** Decay-adjusted effective weight of the anchor [0, 1] */
  effectiveWeight: number;
  /** Combined score: similarity * effectiveWeight (if decay weighting enabled) */
  score: number;
}

/**
 * Result of anchor candidate search for a fact.
 */
export interface AnchorCandidateResult {
  /** Ranked candidate anchors (highest score first) */
  candidates: AnchorCandidate[];
  /** The fact embedding generated during search (can be cached for later use) */
  factEmbedding: number[];
  /** Performance stats */
  stats: {
    /** Time to generate the fact embedding (ms) */
    embeddingTimeMs: number;
    /** Time to search anchors (ms) */
    searchTimeMs: number;
    /** Total anchors with embeddings compared */
    anchorsCompared: number;
    /** Number of candidates above threshold */
    candidatesFound: number;
  };
}

// ─── AnchorCandidateFinder ────────────────────────────────────────

export class AnchorCandidateFinder {
  readonly config: AnchorCandidateFinderConfig;
  private readonly decayConfig: AnchorDecayConfig;

  constructor(
    private readonly db: Database.Database,
    private readonly embeddingProvider: EmbeddingProvider,
    config?: Partial<AnchorCandidateFinderConfig>,
    decayConfig?: Partial<AnchorDecayConfig>,
  ) {
    this.config = { ...DEFAULT_CANDIDATE_FINDER_CONFIG, ...config };
    this.decayConfig = { ...DEFAULT_DECAY_CONFIG, ...decayConfig };
  }

  /**
   * Find anchor candidates for a single fact by embedding similarity.
   *
   * Steps:
   *   1. Embed the fact content via EmbeddingProvider
   *   2. Load all anchors with embeddings from DB
   *   3. Compute cosine similarity (reusing VectorSearcher helpers)
   *   4. Apply decay-weighted scoring
   *   5. Filter by threshold + top-k
   *
   * @param factContent - The text content of the fact to find anchors for
   * @returns Ranked anchor candidates with similarity scores
   */
  async findCandidates(factContent: string): Promise<AnchorCandidateResult> {
    const now = new Date();

    // Step 1: Embed the fact content
    const embStart = performance.now();
    const embResponse = await this.embeddingProvider.embed({ text: factContent });
    const factEmbedding = embResponse.embedding;
    const embeddingTimeMs = round2(performance.now() - embStart);

    // Step 2-5: Search anchors using the embedding
    const searchStart = performance.now();
    const { candidates, anchorsCompared } = this.searchAnchorsForCandidates(
      factEmbedding,
      now,
    );
    const searchTimeMs = round2(performance.now() - searchStart);

    return {
      candidates,
      factEmbedding,
      stats: {
        embeddingTimeMs,
        searchTimeMs,
        anchorsCompared,
        candidatesFound: candidates.length,
      },
    };
  }

  /**
   * Find anchor candidates using a pre-computed embedding.
   * Useful when the embedding has already been generated (e.g., for batch processing).
   */
  findCandidatesByEmbedding(factEmbedding: number[]): AnchorCandidateResult {
    const now = new Date();
    const searchStart = performance.now();
    const { candidates, anchorsCompared } = this.searchAnchorsForCandidates(
      factEmbedding,
      now,
    );
    const searchTimeMs = round2(performance.now() - searchStart);

    return {
      candidates,
      factEmbedding,
      stats: {
        embeddingTimeMs: 0,
        searchTimeMs,
        anchorsCompared,
        candidatesFound: candidates.length,
      },
    };
  }

  /**
   * Find anchor candidates for multiple facts in batch.
   * Embeds all facts first (using embedBatch if available), then searches.
   */
  async findCandidatesBatch(
    factContents: string[],
  ): Promise<AnchorCandidateResult[]> {
    if (factContents.length === 0) return [];

    // Embed all facts
    let embeddings: number[][];
    if (this.embeddingProvider.embedBatch) {
      const responses = await this.embeddingProvider.embedBatch(factContents);
      embeddings = responses.map(r => r.embedding);
    } else {
      embeddings = [];
      for (const content of factContents) {
        const resp = await this.embeddingProvider.embed({ text: content });
        embeddings.push(resp.embedding);
      }
    }

    // Search for each embedding
    return embeddings.map(emb => this.findCandidatesByEmbedding(emb));
  }

  // ─── Internal: anchor search ───────────────────────────────────

  /**
   * Load anchors with embeddings from DB and compute cosine similarity
   * against the fact embedding. Reuses VectorSearcher's helper functions.
   */
  private searchAnchorsForCandidates(
    factEmbedding: number[],
    now: Date,
  ): { candidates: AnchorCandidate[]; anchorsCompared: number } {
    // Load all anchors with embeddings (same query pattern as VectorSearcher)
    const rows = this.db.prepare(`
      SELECT id, label, description, anchor_type, embedding, embedding_dim,
        current_weight, decay_rate, access_count, last_accessed_at, created_at
      FROM anchors
      WHERE embedding IS NOT NULL AND embedding_dim IS NOT NULL
    `).all() as AnchorEmbeddingRow[];

    if (rows.length === 0) {
      return { candidates: [], anchorsCompared: 0 };
    }

    const scored: AnchorCandidate[] = [];

    for (const row of rows) {
      // Reuse VectorSearcher's bufferToFloat32Array for BLOB deserialization
      const anchorEmbedding = bufferToFloat32Array(row.embedding, row.embedding_dim);
      if (!anchorEmbedding) continue;

      // Reuse VectorSearcher's cosineSimilarityVec
      const similarity = cosineSimilarityVec(factEmbedding, anchorEmbedding);

      if (similarity < this.config.similarityThreshold) continue;

      // Compute decay-aware effective weight
      const effectiveWeight = this.config.useDecayWeighting
        ? computeAnchorEffectiveWeight(
            {
              currentWeight: row.current_weight ?? 0.5,
              decayRate: row.decay_rate ?? 0.01,
              lastAccessedAt: row.last_accessed_at ?? undefined,
              createdAt: row.created_at,
              accessCount: row.access_count ?? 0,
            },
            now,
            this.decayConfig,
          )
        : 1.0;

      // Combined score: similarity * effective weight
      const score = round4(similarity * effectiveWeight);

      scored.push({
        anchorId: row.id,
        label: row.label,
        description: row.description,
        anchorType: row.anchor_type as Anchor['anchorType'],
        similarity: round4(similarity),
        effectiveWeight: round4(effectiveWeight),
        score,
      });
    }

    // Sort by combined score descending, take top-k
    scored.sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, this.config.maxCandidates);

    return { candidates, anchorsCompared: rows.length };
  }
}

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

// ─── Internal Utilities ──────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
