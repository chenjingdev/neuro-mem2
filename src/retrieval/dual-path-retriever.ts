/**
 * Dual-Path Retriever — parallel orchestrator for vector + graph retrieval.
 *
 * Executes two independent retrieval paths concurrently via Promise.all,
 * then merges results into a unified, ranked context list.
 *
 * Architecture:
 *   Path 1 (Vector): EmbeddingProvider → cosine similarity on anchors → expand via weighted edges
 *   Path 2 (Graph):  Entity extraction → seed discovery → BFS via memory_edges
 *
 *   Both paths produce ScoredMemoryItem[] and run in parallel.
 *   ResultMerger normalizes, deduplicates, and ranks the combined results.
 *   Optionally, Hebbian reinforcement is applied to co-activated edges.
 *
 * Since better-sqlite3 is synchronous, each path wraps its DB operations
 * in a microtask (queueMicrotask) to achieve cooperative scheduling.
 */

import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from './embedding-provider.js';
import type { ScoredMemoryItem, MergedMemoryItem, MergeResult, MergeStats } from './types.js';
import { VectorSearcher, type VectorSearchConfig, type VectorSearchResult } from './vector-searcher.js';
import { QueryGraphTraverser, type GraphTraversalOptions, type GraphTraversalResult as QueryGraphResult } from './graph-traversal.js';
import { ResultMerger } from './result-merger.js';
import { WeightedEdgeRepository } from '../db/weighted-edge-repo.js';
import { AnchorRepository } from '../db/anchor-repo.js';

// ─── Configuration ───────────────────────────────────────

export interface DualPathRetrieverConfig {
  /** Vector path config overrides */
  vector?: Partial<VectorSearchConfig>;
  /** Graph path config overrides */
  graph?: Partial<GraphTraversalOptions>;
  /** Merger config: weight for vector path in merge [0, 1] (default: 0.5) */
  vectorWeight?: number;
  /** Merger config: bonus when both paths agree (default: 0.1) */
  convergenceBonus?: number;
  /** Merger config: minimum merged score threshold (default: 0.05) */
  minScore?: number;
  /** Merger config: max results (default: 20) */
  maxResults?: number;
  /** Score normalization (default: 'minmax') */
  normalization?: 'minmax' | 'none';
  /** Whether to reinforce co-activated edges (default: true) */
  reinforceOnRetrieval?: boolean;
  /** Learning rate for Hebbian reinforcement (default: 0.05) */
  reinforcementRate?: number;
  /** Timeout per path in ms (default: 5000) */
  pathTimeoutMs?: number;
}

export const DEFAULT_DUAL_PATH_CONFIG: DualPathRetrieverConfig = {
  vector: {},
  graph: {},
  vectorWeight: 0.5,
  convergenceBonus: 0.1,
  minScore: 0.05,
  maxResults: 20,
  normalization: 'minmax',
  reinforceOnRetrieval: true,
  reinforcementRate: 0.05,
  pathTimeoutMs: 5000,
};

// ─── Query Input ─────────────────────────────────────────

export interface RecallQuery {
  /** Query text (used for both embedding and entity extraction) */
  queryText: string;
  /** Per-query config overrides */
  config?: Partial<DualPathRetrieverConfig>;
}

// ─── Recall Result ───────────────────────────────────────

export interface RecallResult {
  /** Ranked, merged memory items ready for context injection */
  items: MergedMemoryItem[];
  /** Diagnostic info about the retrieval process */
  diagnostics: RecallDiagnostics;
}

export interface RecallDiagnostics {
  /** Anchors activated via vector path */
  activatedAnchors: Array<{ anchorId: string; label: string; similarity: number }>;
  /** Entities extracted for graph path */
  extractedEntities: string[];
  /** Seed nodes discovered by graph path */
  graphSeedCount: number;
  /** Vector path timing (ms) */
  vectorTimeMs: number;
  /** Graph path timing (ms) */
  graphTimeMs: number;
  /** Total recall timing (ms) */
  totalTimeMs: number;
  /** Items produced by vector path */
  vectorItemCount: number;
  /** Items produced by graph path */
  graphItemCount: number;
  /** Merge statistics */
  mergeStats: MergeStats;
  /** Edges reinforced via Hebbian learning */
  edgesReinforced: number;
  /** Whether vector path timed out */
  vectorTimedOut: boolean;
  /** Whether graph path timed out */
  graphTimedOut: boolean;
}

// ─── Internal path wrappers ──────────────────────────────

interface VectorPathOutput {
  items: ScoredMemoryItem[];
  matchedAnchors: Array<{ anchorId: string; label: string; similarity: number }>;
  timeMs: number;
}

interface GraphPathOutput {
  items: ScoredMemoryItem[];
  extractedEntities: string[];
  seedCount: number;
  timeMs: number;
}

// ─── DualPathRetriever ───────────────────────────────────

export class DualPathRetriever {
  private vectorSearcher: VectorSearcher;
  private queryGraphTraverser: QueryGraphTraverser;
  private resultMerger: ResultMerger;
  private weightedEdgeRepo: WeightedEdgeRepository;
  private anchorRepo: AnchorRepository;
  private config: DualPathRetrieverConfig;

  constructor(
    private db: Database.Database,
    embeddingProvider: EmbeddingProvider,
    config?: Partial<DualPathRetrieverConfig>,
  ) {
    this.config = { ...DEFAULT_DUAL_PATH_CONFIG, ...config };

    this.vectorSearcher = new VectorSearcher(db, embeddingProvider, this.config.vector);
    this.queryGraphTraverser = new QueryGraphTraverser(db, this.config.graph);
    this.resultMerger = new ResultMerger({
      vectorWeight: this.config.vectorWeight ?? 0.5,
      convergenceBonus: this.config.convergenceBonus ?? 0.1,
      minScore: this.config.minScore ?? 0.05,
      maxResults: this.config.maxResults ?? 20,
      normalization: this.config.normalization ?? 'minmax',
    });
    this.weightedEdgeRepo = new WeightedEdgeRepository(db);
    this.anchorRepo = new AnchorRepository(db);
  }

  /**
   * Execute dual-path recall: vector + graph in parallel.
   *
   * 1. Launch vector path and graph path concurrently via Promise.all
   * 2. Both paths produce ScoredMemoryItem[] independently
   * 3. ResultMerger normalizes, deduplicates, and ranks
   * 4. Optionally reinforce co-activated weighted edges (Hebbian)
   */
  async recall(query: RecallQuery): Promise<RecallResult> {
    const totalStart = performance.now();
    const cfg = { ...this.config, ...query.config };
    const timeoutMs = cfg.pathTimeoutMs ?? 5000;

    // Rebuild merger if per-query config changes merge parameters
    const merger = this.getMerger(cfg);

    // ── Phase 1: Parallel path execution ──

    const [vectorTimed, graphTimed] = await Promise.all([
      this.withTimeout(this.executeVectorPath(query.queryText, cfg), timeoutMs),
      this.withTimeout(this.executeGraphPath(query.queryText, cfg), timeoutMs),
    ]);

    const vectorOut = vectorTimed.timedOut ? null : vectorTimed.value;
    const graphOut = graphTimed.timedOut ? null : graphTimed.value;

    const vectorItems = vectorOut?.items ?? [];
    const graphItems = graphOut?.items ?? [];

    // ── Phase 2: Merge via ResultMerger ──

    const mergeResult: MergeResult = merger.merge(vectorItems, graphItems);

    // ── Phase 3: Hebbian reinforcement ──

    let edgesReinforced = 0;
    const anchorIds = (vectorOut?.matchedAnchors ?? []).map(a => a.anchorId);

    if ((cfg.reinforceOnRetrieval ?? true) && mergeResult.items.length > 0 && anchorIds.length > 0) {
      edgesReinforced = this.reinforceEdges(
        anchorIds,
        mergeResult.items,
        cfg.reinforcementRate ?? 0.05,
      );

      // Record anchor activations
      for (const anchorId of anchorIds) {
        this.anchorRepo.recordActivation(anchorId);
      }
    }

    const totalTimeMs = round2(performance.now() - totalStart);

    return {
      items: mergeResult.items,
      diagnostics: {
        activatedAnchors: vectorOut?.matchedAnchors ?? [],
        extractedEntities: graphOut?.extractedEntities ?? [],
        graphSeedCount: graphOut?.seedCount ?? 0,
        vectorTimeMs: vectorOut?.timeMs ?? 0,
        graphTimeMs: graphOut?.timeMs ?? 0,
        totalTimeMs,
        vectorItemCount: vectorItems.length,
        graphItemCount: graphItems.length,
        mergeStats: mergeResult.stats,
        edgesReinforced,
        vectorTimedOut: vectorTimed.timedOut,
        graphTimedOut: graphTimed.timedOut,
      },
    };
  }

  // ── Vector Path Execution ──

  /**
   * Vector path: embed query → search anchors → expand to memory nodes.
   * Wrapped in a microtask for cooperative scheduling with graph path.
   */
  private executeVectorPath(
    queryText: string,
    cfg: DualPathRetrieverConfig,
  ): Promise<VectorPathOutput> {
    return new Promise<VectorPathOutput>((resolve, reject) => {
      queueMicrotask(async () => {
        try {
          const result: VectorSearchResult = await this.vectorSearcher.search(
            queryText,
            cfg.vector,
          );

          resolve({
            items: result.items,
            matchedAnchors: result.matchedAnchors.map(a => ({
              anchorId: a.anchorId,
              label: a.label,
              similarity: a.similarity,
            })),
            timeMs: result.stats.totalTimeMs,
          });
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  // ── Graph Path Execution ──

  /**
   * Graph path: extract entities → discover seeds → BFS via memory_edges.
   * Wrapped in a microtask for cooperative scheduling with vector path.
   */
  private executeGraphPath(
    queryText: string,
    cfg: DualPathRetrieverConfig,
  ): Promise<GraphPathOutput> {
    return new Promise<GraphPathOutput>((resolve, reject) => {
      queueMicrotask(() => {
        try {
          const result: QueryGraphResult = this.queryGraphTraverser.traverse(
            queryText,
            cfg.graph,
          );

          // Convert TraversalResult[] → ScoredMemoryItem[]
          const items: ScoredMemoryItem[] = result.results.map(tr => ({
            nodeId: tr.node.id,
            nodeType: tr.node.nodeType,
            score: tr.score,
            source: 'graph' as const,
            content: getNodeContent(tr.node.data, tr.node.nodeType),
            retrievalMetadata: {
              hops: tr.hops,
              seedEntity: tr.seedEntity,
              pathLength: tr.path.length,
            },
          }));

          resolve({
            items,
            extractedEntities: [
              ...result.extractedEntities.entities,
              ...result.extractedEntities.keyTerms,
            ],
            seedCount: result.seedNodeIds.length,
            timeMs: result.stats.timeMs,
          });
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  // ── Hebbian Reinforcement ──

  /**
   * Reinforce weighted edges connecting activated anchors to
   * retrieved memory nodes (Hebbian co-activation learning).
   */
  private reinforceEdges(
    anchorIds: string[],
    results: MergedMemoryItem[],
    learningRate: number,
  ): number {
    const resultIds = new Set(results.map(r => r.nodeId));
    const edgeIds: string[] = [];

    for (const anchorId of anchorIds) {
      const edges = this.weightedEdgeRepo.getOutgoingEdges(anchorId);
      for (const edge of edges) {
        if (resultIds.has(edge.targetId)) {
          edgeIds.push(edge.id);
        }
      }
    }

    if (edgeIds.length === 0) return 0;

    const reinforced = this.weightedEdgeRepo.batchReinforce({
      edgeIds,
      learningRate,
    });

    return reinforced.length;
  }

  // ── Helpers ──

  /**
   * Get or create a ResultMerger with the appropriate config.
   */
  private getMerger(cfg: DualPathRetrieverConfig): ResultMerger {
    // Use default merger if no query-level overrides
    if (!cfg.vectorWeight && !cfg.convergenceBonus && !cfg.minScore && !cfg.maxResults && !cfg.normalization) {
      return this.resultMerger;
    }

    return new ResultMerger({
      vectorWeight: cfg.vectorWeight ?? 0.5,
      convergenceBonus: cfg.convergenceBonus ?? 0.1,
      minScore: cfg.minScore ?? 0.05,
      maxResults: cfg.maxResults ?? 20,
      normalization: cfg.normalization ?? 'minmax',
    });
  }

  /**
   * Race a promise against a timeout.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<{ value: T | null; timedOut: boolean }> {
    return Promise.race([
      promise.then(value => ({ value, timedOut: false })),
      new Promise<{ value: null; timedOut: boolean }>((resolve) =>
        setTimeout(() => resolve({ value: null, timedOut: true }), timeoutMs),
      ),
    ]);
  }
}

// ─── Pure helpers ────────────────────────────────────────

function round2(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/**
 * Extract text content from a memory node for context injection.
 */
function getNodeContent(data: unknown, nodeType: string): string {
  if (!data) return '';
  const d = data as Record<string, unknown>;

  switch (nodeType) {
    case 'fact':
      return (d.content as string) ?? '';
    case 'episode':
      return (d.description as string) ?? (d.title as string) ?? '';
    case 'concept':
      return (d.description as string) ?? (d.name as string) ?? '';
    case 'anchor':
      return (d.description as string) ?? (d.label as string) ?? '';
    default:
      return '';
  }
}
