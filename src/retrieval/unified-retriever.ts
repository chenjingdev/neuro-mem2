/**
 * UnifiedRetriever — single-pipeline retrieval that embeds a query locally
 * and finds top-K anchors by cosine similarity, then expands to connected
 * memory nodes via weighted edges, and re-ranks using graph + content signals.
 *
 * This replaces the DualPathRetriever with a single, traceable pipeline:
 *   1. Embed query locally (LocalEmbeddingProvider / any EmbeddingProvider)
 *   2. Cosine similarity search on anchors (reuses VectorSearcher)
 *   3. Expand matched anchors to connected facts/episodes/concepts
 *   4. Re-rank: graph traversal + Level 0/Level 1 content signals
 *      (optional LLM re-ranking for cortical relevance judgment)
 *   5. (Optional) Hebbian reinforcement of activated paths
 *
 * Brain-like behavior: retrieval is anchor-association-based, not raw-text RAG.
 * The query activates semantic anchors, which then propagate to connected memories
 * through weighted edges — mimicking associative recall. Re-ranking amplifies
 * items with strong graph connections and relevant summaries, while optional LLM
 * re-ranking acts as "cortical attention" for refined relevance.
 */

import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from './embedding-provider.js';
import {
  VectorSearcher,
  type VectorSearchConfig,
  type VectorSearchResult,
  type AnchorMatch,
} from './vector-searcher.js';
import { ReRanker, type ReRankerConfig, type ReRankStats } from './reranker.js';
import {
  LLMReranker,
  type LLMRerankerConfig,
  type LLMRerankStats,
} from './llm-reranker.js';
import type { ScoredMemoryItem } from './types.js';
import type { AnchorDecayConfig } from '../scoring/anchor-decay.js';
import type { LLMProvider } from '../extraction/llm-provider.js';
import { ProgressiveDepthEnricher, type EnrichmentStats } from './progressive-depth-enricher.js';
import {
  BFSExpander,
  type BFSExpanderConfig,
  type BFSExpansionStats,
} from './bfs-expander.js';

// ─── Configuration ───────────────────────────────────────────────

export interface UnifiedRetrieverConfig {
  /** VectorSearcher configuration overrides */
  vector: Partial<VectorSearchConfig>;
  /** Maximum results to return */
  maxResults: number;
  /** Minimum score threshold [0, 1] */
  minScore: number;
  /** Enable Hebbian reinforcement on retrieval */
  reinforceOnRetrieval: boolean;
  /** Hebbian learning rate for reinforcement */
  reinforcementRate: number;
  /** Graph+content re-ranker configuration */
  reranker?: Partial<ReRankerConfig>;
  /** LLM re-ranker configuration (optional — requires llmProvider in constructor) */
  llmReranker?: Partial<LLMRerankerConfig>;
  /** BFS expander configuration (expansion from re-judged anchors) */
  bfsExpander?: Partial<BFSExpanderConfig>;
  /** Enable graph+content re-ranking (default: true) */
  enableReranking: boolean;
  /** Enable BFS expansion from re-judged anchors (default: true) */
  enableBFSExpansion: boolean;
}

export const DEFAULT_UNIFIED_RETRIEVER_CONFIG: UnifiedRetrieverConfig = {
  vector: {},
  maxResults: 20,
  minScore: 0.05,
  reinforceOnRetrieval: true,
  reinforcementRate: 0.05,
  enableReranking: false,
  enableBFSExpansion: true,
};

// ─── Recall Query / Result Types ─────────────────────────────────

export interface UnifiedRecallQuery {
  /** Natural language query text */
  text: string;
  /** Override retriever config for this query */
  config?: Partial<UnifiedRetrieverConfig>;
  /**
   * Progressive depth parameter: top deepK nodes are enriched to L2 (summary + metadata),
   * remaining nodes are enriched to L1 (metadata only).
   * If 0 or undefined, no progressive depth enrichment is applied.
   * Default: 0 (no enrichment)
   */
  deepK?: number;
}

export interface UnifiedRecallResult {
  /** Ranked list of scored memory items */
  items: ScoredMemoryItem[];
  /** Anchors activated during this recall */
  activatedAnchors: AnchorMatch[];
  /** Diagnostics for pipeline traceability */
  diagnostics: UnifiedRecallDiagnostics;
}

export interface UnifiedRecallDiagnostics {
  /** Time to embed the query (ms) */
  embeddingTimeMs: number;
  /** Time to search anchors by cosine similarity (ms) */
  anchorSearchTimeMs: number;
  /** Time to expand to connected memory nodes (ms) */
  expansionTimeMs: number;
  /** Time for graph+content re-ranking (ms), 0 if skipped */
  rerankTimeMs: number;
  /** Time for LLM re-ranking (ms), 0 if skipped */
  llmRerankTimeMs: number;
  /** Time for BFS expansion from re-judged anchors (ms), 0 if skipped */
  bfsExpansionTimeMs: number;
  /** Time for Hebbian reinforcement (ms), 0 if skipped */
  reinforceTimeMs: number;
  /** Total pipeline time (ms) */
  totalTimeMs: number;
  /** Number of anchors with embeddings that were compared */
  anchorsCompared: number;
  /** Number of anchors that matched above threshold */
  anchorsMatched: number;
  /** Number of memory nodes returned after expansion */
  nodesExpanded: number;
  /** Number of new nodes added by BFS expansion */
  bfsNodesAdded: number;
  /** Number of edges reinforced (0 if reinforcement disabled) */
  edgesReinforced: number;
  /** Graph+content re-ranking stats (if performed) */
  rerankStats?: ReRankStats;
  /** LLM re-ranking stats (if performed) */
  llmRerankStats?: LLMRerankStats;
  /** BFS expansion stats (if performed) */
  bfsExpansionStats?: BFSExpansionStats;
  /** Progressive depth enrichment stats (if deepK was applied) */
  enrichmentStats?: EnrichmentStats;
  /** Pipeline stages for traceability */
  stages: PipelineStage[];
}

export interface PipelineStage {
  name: string;
  status: 'complete' | 'skipped' | 'error';
  durationMs: number;
  detail?: string;
}

// ─── Trace Hook ──────────────────────────────────────────────────

export type UnifiedTraceHook = (event: UnifiedTraceEvent) => void;

export interface UnifiedTraceEvent {
  stage: 'embed_query' | 'anchor_search' | 'expansion' | 'rerank' | 'llm_rerank' | 'bfs_expansion' | 'reinforce' | 'complete';
  status: 'start' | 'complete' | 'error' | 'skipped';
  durationMs?: number;
  detail?: Record<string, unknown>;
}

// ─── UnifiedRetriever Class ──────────────────────────────────────

export class UnifiedRetriever {
  readonly config: UnifiedRetrieverConfig;
  private vectorSearcher: VectorSearcher;
  private db: Database.Database;
  private traceHook?: UnifiedTraceHook;
  private graphReranker: ReRanker;
  private llmReranker?: LLMReranker;
  private bfsExpander: BFSExpander;
  private depthEnricher: ProgressiveDepthEnricher;

  constructor(
    db: Database.Database,
    embeddingProvider: EmbeddingProvider,
    config?: Partial<UnifiedRetrieverConfig>,
    decayConfig?: Partial<AnchorDecayConfig>,
    traceHook?: UnifiedTraceHook,
    llmProvider?: LLMProvider,
  ) {
    this.db = db;
    this.config = { ...DEFAULT_UNIFIED_RETRIEVER_CONFIG, ...config };
    this.vectorSearcher = new VectorSearcher(
      db,
      embeddingProvider,
      this.config.vector,
      decayConfig,
    );
    this.traceHook = traceHook;

    // Initialize graph+content re-ranker (always available — no external deps)
    this.graphReranker = new ReRanker(db, this.config.reranker);

    // Initialize BFS expander for post-rerank associative expansion
    this.bfsExpander = new BFSExpander(db, this.config.bfsExpander);

    // Initialize progressive depth enricher
    this.depthEnricher = new ProgressiveDepthEnricher(db);

    // Initialize LLM re-ranker if provider is supplied
    if (llmProvider) {
      this.llmReranker = new LLMReranker(llmProvider, this.config.llmReranker);
    }
  }

  /**
   * Recall memories relevant to a query.
   *
   * Pipeline:
   *   1. Embed query → vector
   *   2. Cosine similarity → top-K anchors
   *   3. Expand anchors → connected memory nodes
   *   4. Re-rank: graph traversal + content signals (+ optional LLM)
   *   5. (Optional) Hebbian reinforcement
   */
  async recall(query: UnifiedRecallQuery): Promise<UnifiedRecallResult> {
    const config = { ...this.config, ...query.config };
    const totalStart = performance.now();
    const stages: PipelineStage[] = [];

    // ── Stage 1-3: Vector search (embed + cosine + expand) ──
    this.traceHook?.({
      stage: 'embed_query',
      status: 'start',
    });

    let vectorResult: VectorSearchResult;
    try {
      vectorResult = await this.vectorSearcher.search(
        query.text,
        config.vector,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.traceHook?.({
        stage: 'embed_query',
        status: 'error',
        detail: { error: errMsg },
      });
      stages.push({
        name: 'embed_query',
        status: 'error',
        durationMs: round2(performance.now() - totalStart),
        detail: errMsg,
      });

      return {
        items: [],
        activatedAnchors: [],
        diagnostics: buildEmptyDiagnostics(totalStart, stages),
      };
    }

    // Record stage timings from VectorSearcher stats
    stages.push({
      name: 'embed_query',
      status: 'complete',
      durationMs: vectorResult.stats.embeddingTimeMs,
    });
    this.traceHook?.({
      stage: 'embed_query',
      status: 'complete',
      durationMs: vectorResult.stats.embeddingTimeMs,
    });

    stages.push({
      name: 'anchor_search',
      status: 'complete',
      durationMs: vectorResult.stats.searchTimeMs,
      detail: `${vectorResult.stats.anchorsMatched} anchors matched out of ${vectorResult.stats.anchorsCompared}`,
    });
    this.traceHook?.({
      stage: 'anchor_search',
      status: 'complete',
      durationMs: vectorResult.stats.searchTimeMs,
      detail: {
        anchorsMatched: vectorResult.stats.anchorsMatched,
        anchorsCompared: vectorResult.stats.anchorsCompared,
      },
    });

    const expansionStatus = vectorResult.stats.nodesExpanded > 0 ? 'complete' : 'skipped';
    stages.push({
      name: 'expansion',
      status: expansionStatus as PipelineStage['status'],
      durationMs: vectorResult.stats.expansionTimeMs,
      detail: `${vectorResult.stats.nodesExpanded} nodes expanded`,
    });
    this.traceHook?.({
      stage: 'expansion',
      status: expansionStatus as UnifiedTraceEvent['status'],
      durationMs: vectorResult.stats.expansionTimeMs,
      detail: { nodesExpanded: vectorResult.stats.nodesExpanded },
    });

    // Filter by minimum score (pre-rerank)
    let items = vectorResult.items.filter(item => item.score >= config.minScore);

    // ── Stage 4a: Graph+content re-ranking ──
    let rerankTimeMs = 0;
    let rerankStats: ReRankStats | undefined;

    if (config.enableReranking && items.length > 0 && vectorResult.matchedAnchors.length > 0) {
      this.traceHook?.({ stage: 'rerank', status: 'start' });

      try {
        const rerankResult = await this.graphReranker.rerank(
          items,
          vectorResult.matchedAnchors,
          query.text,
        );

        rerankTimeMs = rerankResult.stats.totalTimeMs;
        rerankStats = rerankResult.stats;
        items = rerankResult.items;

        stages.push({
          name: 'rerank',
          status: 'complete',
          durationMs: rerankTimeMs,
          detail: `graph: ${rerankResult.stats.graphEnrichedCount} enriched, content: ${rerankResult.stats.contentEnrichedCount} enriched, ${rerankResult.stats.contentReplacedCount} replaced`,
        });
        this.traceHook?.({
          stage: 'rerank',
          status: 'complete',
          durationMs: rerankTimeMs,
          detail: {
            graphEnrichedCount: rerankResult.stats.graphEnrichedCount,
            contentEnrichedCount: rerankResult.stats.contentEnrichedCount,
            contentReplacedCount: rerankResult.stats.contentReplacedCount,
          },
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        rerankTimeMs = round2(performance.now() - totalStart);
        stages.push({
          name: 'rerank',
          status: 'error',
          durationMs: 0,
          detail: `Re-rank failed: ${errMsg}`,
        });
        this.traceHook?.({
          stage: 'rerank',
          status: 'error',
          detail: { error: errMsg },
        });
        // Continue with un-reranked items (graceful degradation)
      }
    } else {
      stages.push({
        name: 'rerank',
        status: 'skipped',
        durationMs: 0,
        detail: !config.enableReranking
          ? 'Re-ranking disabled'
          : items.length === 0
            ? 'No items to re-rank'
            : 'No anchors matched',
      });
      this.traceHook?.({ stage: 'rerank', status: 'skipped' });
    }

    // ── Stage 4b: LLM re-ranking (optional) ──
    let llmRerankTimeMs = 0;
    let llmRerankStats: LLMRerankStats | undefined;

    if (this.llmReranker && items.length > 0) {
      this.traceHook?.({ stage: 'llm_rerank', status: 'start' });

      const llmRerankResult = await this.llmReranker.rerank(
        query.text,
        items,
        vectorResult.matchedAnchors,
        config.llmReranker,
      );

      llmRerankTimeMs = llmRerankResult.stats.rerankTimeMs;
      llmRerankStats = llmRerankResult.stats;
      items = llmRerankResult.items;

      const llmStatus = llmRerankResult.stats.source === 'error_fallback' ? 'error' : 'complete';
      stages.push({
        name: 'llm_rerank',
        status: llmStatus as PipelineStage['status'],
        durationMs: llmRerankTimeMs,
        detail: `${llmRerankResult.stats.source}: ${llmRerankResult.stats.candidatesSent} candidates → ${llmRerankResult.stats.itemsReturned} items (${llmRerankResult.stats.itemsFiltered} filtered)`,
      });
      this.traceHook?.({
        stage: 'llm_rerank',
        status: llmStatus as UnifiedTraceEvent['status'],
        durationMs: llmRerankTimeMs,
        detail: {
          source: llmRerankResult.stats.source,
          candidatesSent: llmRerankResult.stats.candidatesSent,
          itemsReturned: llmRerankResult.stats.itemsReturned,
          itemsFiltered: llmRerankResult.stats.itemsFiltered,
        },
      });
    } else {
      stages.push({
        name: 'llm_rerank',
        status: 'skipped',
        durationMs: 0,
        detail: this.llmReranker ? 'No items to re-rank' : 'No LLM provider configured',
      });
      this.traceHook?.({ stage: 'llm_rerank', status: 'skipped' });
    }

    // ── Stage 4c: BFS expansion from re-judged anchors ──
    let bfsExpansionTimeMs = 0;
    let bfsNodesAdded = 0;
    let bfsExpansionStats: BFSExpansionStats | undefined;

    if (config.enableBFSExpansion && vectorResult.matchedAnchors.length > 0) {
      this.traceHook?.({ stage: 'bfs_expansion', status: 'start' });

      try {
        const bfsResult = await this.bfsExpander.expand(
          vectorResult.matchedAnchors,
          items,
          config.bfsExpander,
        );

        bfsExpansionTimeMs = bfsResult.stats.bfsTimeMs;
        bfsNodesAdded = bfsResult.stats.newNodesAdded;
        bfsExpansionStats = bfsResult.stats;

        // Merge BFS-discovered items into the result set
        if (bfsResult.newItems.length > 0) {
          items.push(...bfsResult.newItems);
          // Re-sort after merging BFS items
          items.sort((a, b) => b.score - a.score);
        }

        stages.push({
          name: 'bfs_expansion',
          status: bfsResult.newItems.length > 0 ? 'complete' : 'skipped',
          durationMs: bfsExpansionTimeMs,
          detail: `${bfsResult.stats.seedAnchorsCount} seed anchors → ${bfsResult.stats.totalDiscovered} discovered → ${bfsResult.stats.newNodesAdded} new nodes added (${bfsResult.stats.edgesTraversed} edges traversed)`,
        });
        this.traceHook?.({
          stage: 'bfs_expansion',
          status: bfsResult.newItems.length > 0 ? 'complete' : 'skipped',
          durationMs: bfsExpansionTimeMs,
          detail: {
            seedAnchorsCount: bfsResult.stats.seedAnchorsCount,
            totalDiscovered: bfsResult.stats.totalDiscovered,
            newNodesAdded: bfsResult.stats.newNodesAdded,
            edgesTraversed: bfsResult.stats.edgesTraversed,
          },
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        bfsExpansionTimeMs = round2(performance.now() - totalStart);
        stages.push({
          name: 'bfs_expansion',
          status: 'error',
          durationMs: 0,
          detail: `BFS expansion failed: ${errMsg}`,
        });
        this.traceHook?.({
          stage: 'bfs_expansion',
          status: 'error',
          detail: { error: errMsg },
        });
        // Continue with existing items (graceful degradation)
      }
    } else {
      stages.push({
        name: 'bfs_expansion',
        status: 'skipped',
        durationMs: 0,
        detail: !config.enableBFSExpansion
          ? 'BFS expansion disabled'
          : 'No anchors matched',
      });
      this.traceHook?.({ stage: 'bfs_expansion', status: 'skipped' });
    }

    // Limit results (post-rerank + BFS expansion)
    items = items.slice(0, config.maxResults);

    // ── Stage 5: Hebbian reinforcement ──
    let edgesReinforced = 0;
    let reinforceTimeMs = 0;

    if (config.reinforceOnRetrieval && vectorResult.matchedAnchors.length > 0) {
      this.traceHook?.({ stage: 'reinforce', status: 'start' });
      const reinforceStart = performance.now();

      try {
        edgesReinforced = this.reinforceActivatedPaths(
          vectorResult.matchedAnchors,
          items,
          config.reinforcementRate,
        );
        reinforceTimeMs = round2(performance.now() - reinforceStart);

        stages.push({
          name: 'reinforce',
          status: 'complete',
          durationMs: reinforceTimeMs,
          detail: `${edgesReinforced} edges reinforced`,
        });
        this.traceHook?.({
          stage: 'reinforce',
          status: 'complete',
          durationMs: reinforceTimeMs,
          detail: { edgesReinforced },
        });
      } catch (err) {
        reinforceTimeMs = round2(performance.now() - reinforceStart);
        stages.push({
          name: 'reinforce',
          status: 'error',
          durationMs: reinforceTimeMs,
          detail: err instanceof Error ? err.message : String(err),
        });
        this.traceHook?.({
          stage: 'reinforce',
          status: 'error',
          durationMs: reinforceTimeMs,
        });
      }
    } else {
      stages.push({
        name: 'reinforce',
        status: 'skipped',
        durationMs: 0,
      });
      this.traceHook?.({ stage: 'reinforce', status: 'skipped' });
    }

    // ── Stage 6: Progressive depth enrichment ──
    let enrichmentStats: EnrichmentStats | undefined;

    if (query.deepK && query.deepK > 0 && items.length > 0) {
      const enrichResult = this.depthEnricher.enrichScoredItems(items, query.deepK);
      items = enrichResult.items;
      enrichmentStats = enrichResult.stats;

      stages.push({
        name: 'progressive_depth',
        status: 'complete',
        durationMs: enrichResult.stats.enrichTimeMs,
        detail: `deepK=${query.deepK}: ${enrichResult.stats.l2Count} L2 + ${enrichResult.stats.l1Count} L1`,
      });
    } else {
      stages.push({
        name: 'progressive_depth',
        status: 'skipped',
        durationMs: 0,
        detail: !query.deepK ? 'No deepK specified' : 'No items to enrich',
      });
    }

    const totalTimeMs = round2(performance.now() - totalStart);

    this.traceHook?.({
      stage: 'complete',
      status: 'complete',
      durationMs: totalTimeMs,
      detail: {
        itemCount: items.length,
        anchorsMatched: vectorResult.matchedAnchors.length,
        reranked: config.enableReranking,
        llmReranked: !!this.llmReranker,
        deepK: query.deepK,
      },
    });

    return {
      items,
      activatedAnchors: vectorResult.matchedAnchors,
      diagnostics: {
        embeddingTimeMs: vectorResult.stats.embeddingTimeMs,
        anchorSearchTimeMs: vectorResult.stats.searchTimeMs,
        expansionTimeMs: vectorResult.stats.expansionTimeMs,
        rerankTimeMs,
        llmRerankTimeMs,
        bfsExpansionTimeMs,
        reinforceTimeMs,
        totalTimeMs,
        anchorsCompared: vectorResult.stats.anchorsCompared,
        anchorsMatched: vectorResult.stats.anchorsMatched,
        nodesExpanded: vectorResult.stats.nodesExpanded,
        bfsNodesAdded,
        edgesReinforced,
        rerankStats,
        llmRerankStats,
        bfsExpansionStats,
        enrichmentStats,
        stages,
      },
    };
  }

  // ─── Internal: Hebbian Reinforcement ────────────────────────

  /**
   * Reinforce weighted edges connecting activated anchors to retrieved items.
   * This implements Hebbian learning: "neurons that fire together wire together".
   *
   * When a query activates an anchor and that anchor expands to memory nodes
   * that appear in the final result, the connecting edge is strengthened.
   */
  private reinforceActivatedPaths(
    matchedAnchors: AnchorMatch[],
    resultItems: ScoredMemoryItem[],
    learningRate: number,
  ): number {
    let reinforced = 0;
    const resultNodeIds = new Set(resultItems.map(i => i.nodeId));
    const anchorIds = matchedAnchors.map(a => a.anchorId);

    for (const anchorId of anchorIds) {
      // Record anchor activation
      try {
        this.db.prepare(`
          UPDATE anchors
          SET activation_count = activation_count + 1,
              last_activated_at = datetime('now')
          WHERE id = ?
        `).run(anchorId);
      } catch {
        // Non-critical — continue
      }

      // Reinforce edges connecting this anchor to result nodes
      const edges = this.db.prepare(`
        SELECT id, target_id, weight
        FROM weighted_edges
        WHERE source_id = ? AND source_type = 'anchor'
      `).all(anchorId) as Array<{ id: string; target_id: string; weight: number }>;

      for (const edge of edges) {
        if (resultNodeIds.has(edge.target_id)) {
          // Hebbian reinforcement: w_new = w_old + lr * (1 - w_old)
          const newWeight = Math.min(1.0, edge.weight + learningRate * (1.0 - edge.weight));
          this.db.prepare(`
            UPDATE weighted_edges
            SET weight = ?,
                activation_count = activation_count + 1,
                last_activated_at = datetime('now')
            WHERE id = ?
          `).run(newWeight, edge.id);
          reinforced++;
        }
      }
    }

    return reinforced;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildEmptyDiagnostics(
  totalStart: number,
  stages: PipelineStage[],
): UnifiedRecallDiagnostics {
  return {
    embeddingTimeMs: 0,
    anchorSearchTimeMs: 0,
    expansionTimeMs: 0,
    rerankTimeMs: 0,
    llmRerankTimeMs: 0,
    bfsExpansionTimeMs: 0,
    reinforceTimeMs: 0,
    totalTimeMs: round2(performance.now() - totalStart),
    anchorsCompared: 0,
    anchorsMatched: 0,
    nodesExpanded: 0,
    bfsNodesAdded: 0,
    edgesReinforced: 0,
    stages,
  };
}
