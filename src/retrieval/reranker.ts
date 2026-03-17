/**
 * ReRanker — re-ranks coarse retrieval results using graph-based signals
 * and Level 0/Level 1 content enrichment.
 *
 * The re-ranking pipeline:
 *   1. Graph signal: Traverse weighted edges from activated anchors to
 *      collect graph-based scores (BFS weight accumulation).
 *   2. Content signal: For fact nodes with summary/frontmatter, compute
 *      a lightweight keyword overlap score against the query.
 *   3. Combine: final_score = α * coarse + β * graph + γ * content
 *   4. Enrich: Replace raw content with Level 0/Level 1 where available.
 *
 * This produces brain-like behavior: coarse cosine similarity finds
 * the right neighborhood, then graph re-ranking amplifies items that
 * are strongly associated via Hebbian-weighted edges.
 */

import type Database from 'better-sqlite3';
import type { ScoredMemoryItem } from './types.js';
import type { AnchorMatch } from './vector-searcher.js';
import { GraphTraverser, type GraphTraversalResult } from './graph-traverser.js';

// ─── Configuration ───────────────────────────────────────────────

export interface ReRankerConfig {
  /** Weight for coarse (vector) score [0, 1]. Default: 0.5 */
  coarseWeight: number;
  /** Weight for graph traversal score [0, 1]. Default: 0.35 */
  graphWeight: number;
  /** Weight for content keyword overlap score [0, 1]. Default: 0.15 */
  contentWeight: number;
  /** Maximum graph traversal depth for re-ranking. Default: 2 */
  graphMaxDepth: number;
  /** Minimum edge weight to follow during graph traversal. Default: 0.05 */
  graphMinWeight: number;
  /** Whether to enrich content with summary/frontmatter. Default: true */
  enrichContent: boolean;
  /** Whether to enable graph-based re-ranking. Default: true */
  enableGraphRerank: boolean;
  /** Whether to enable content-based re-ranking. Default: true */
  enableContentRerank: boolean;
}

export const DEFAULT_RERANKER_CONFIG: ReRankerConfig = {
  coarseWeight: 0.5,
  graphWeight: 0.35,
  contentWeight: 0.15,
  graphMaxDepth: 2,
  graphMinWeight: 0.05,
  enrichContent: true,
  enableGraphRerank: true,
  enableContentRerank: true,
};

// ─── Re-Rank Result ──────────────────────────────────────────────

export interface ReRankResult {
  /** Re-ranked items with combined scores */
  items: ScoredMemoryItem[];
  /** Statistics for pipeline traceability */
  stats: ReRankStats;
}

export interface ReRankStats {
  /** Time for graph traversal (ms) */
  graphTimeMs: number;
  /** Time for content scoring (ms) */
  contentTimeMs: number;
  /** Time for score combination (ms) */
  combineTimeMs: number;
  /** Total re-ranking time (ms) */
  totalTimeMs: number;
  /** Number of items with graph signal */
  graphEnrichedCount: number;
  /** Number of items with content signal (summary/frontmatter match) */
  contentEnrichedCount: number;
  /** Number of items whose content was replaced with summary */
  contentReplacedCount: number;
  /** Items re-ranked */
  inputCount: number;
  /** Items after re-ranking */
  outputCount: number;
}

// ─── ReRanker Class ──────────────────────────────────────────────

export class ReRanker {
  readonly config: ReRankerConfig;
  private db: Database.Database;
  private graphTraverser: GraphTraverser;

  constructor(
    db: Database.Database,
    config?: Partial<ReRankerConfig>,
  ) {
    this.db = db;
    this.config = { ...DEFAULT_RERANKER_CONFIG, ...config };
    this.graphTraverser = new GraphTraverser(db);
  }

  /**
   * Re-rank coarse retrieval results using graph + content signals.
   *
   * @param items - Coarse items from vector search (anchor + expanded nodes)
   * @param activatedAnchors - Anchors matched by cosine similarity
   * @param queryText - Original query text (for content scoring)
   * @returns Re-ranked items with combined scores
   */
  async rerank(
    items: ScoredMemoryItem[],
    activatedAnchors: AnchorMatch[],
    queryText: string,
  ): Promise<ReRankResult> {
    const totalStart = performance.now();

    if (items.length === 0) {
      return {
        items: [],
        stats: emptyStats(totalStart),
      };
    }

    // 1. Graph signal: traverse from activated anchors
    let graphScores = new Map<string, number>();
    let graphTimeMs = 0;
    let graphEnrichedCount = 0;

    if (this.config.enableGraphRerank && activatedAnchors.length > 0) {
      const graphStart = performance.now();
      const graphResult = await this.computeGraphScores(activatedAnchors);
      graphScores = graphResult.scores;
      graphEnrichedCount = graphResult.enrichedCount;
      graphTimeMs = round2(performance.now() - graphStart);
    }

    // 2. Content signal: keyword overlap with summary/frontmatter
    let contentScores = new Map<string, number>();
    let contentTimeMs = 0;
    let contentEnrichedCount = 0;

    if (this.config.enableContentRerank) {
      const contentStart = performance.now();
      const contentResult = this.computeContentScores(items, queryText);
      contentScores = contentResult.scores;
      contentEnrichedCount = contentResult.enrichedCount;
      contentTimeMs = round2(performance.now() - contentStart);
    }

    // 3. Combine scores: α * coarse + β * graph + γ * content
    const combineStart = performance.now();
    const { reranked, contentReplacedCount } = this.combineAndEnrich(
      items,
      graphScores,
      contentScores,
    );
    const combineTimeMs = round2(performance.now() - combineStart);

    // 4. Sort by final score descending
    reranked.sort((a, b) => b.score - a.score);

    const totalTimeMs = round2(performance.now() - totalStart);

    return {
      items: reranked,
      stats: {
        graphTimeMs,
        contentTimeMs,
        combineTimeMs,
        totalTimeMs,
        graphEnrichedCount,
        contentEnrichedCount,
        contentReplacedCount,
        inputCount: items.length,
        outputCount: reranked.length,
      },
    };
  }

  // ─── Internal: Graph Score Computation ─────────────────────

  /**
   * Use GraphTraverser to compute graph-based scores from activated anchors.
   * Returns a map of nodeId → graph score.
   */
  private async computeGraphScores(
    activatedAnchors: AnchorMatch[],
  ): Promise<{ scores: Map<string, number>; enrichedCount: number }> {
    const anchorIds = activatedAnchors.map(a => a.anchorId);
    const scores = new Map<string, number>();

    let graphResult: GraphTraversalResult;
    try {
      graphResult = await this.graphTraverser.traverse({
        anchorIds,
        maxDepth: this.config.graphMaxDepth,
        minWeight: this.config.graphMinWeight,
      });
    } catch {
      return { scores, enrichedCount: 0 };
    }

    // Collect scores from facts, episodes, concepts
    for (const sf of graphResult.facts) {
      const existing = scores.get(sf.fact.id);
      if (!existing || sf.score > existing) {
        scores.set(sf.fact.id, sf.score);
      }
    }
    for (const se of graphResult.episodes) {
      const existing = scores.get(se.episode.id);
      if (!existing || se.score > existing) {
        scores.set(se.episode.id, se.score);
      }
    }
    for (const sc of graphResult.concepts) {
      const existing = scores.get(sc.concept.id);
      if (!existing || sc.score > existing) {
        scores.set(sc.concept.id, sc.score);
      }
    }

    // Also add anchor scores (anchor similarity as graph score proxy)
    for (const anchor of activatedAnchors) {
      scores.set(anchor.anchorId, anchor.similarity);
    }

    return { scores, enrichedCount: scores.size };
  }

  // ─── Internal: Content Score Computation ───────────────────

  /**
   * Compute a lightweight keyword overlap score for fact items that have
   * summary/frontmatter. This favors items whose pre-generated summaries
   * share terms with the query.
   */
  private computeContentScores(
    items: ScoredMemoryItem[],
    queryText: string,
  ): { scores: Map<string, number>; enrichedCount: number } {
    const scores = new Map<string, number>();
    const queryTerms = tokenize(queryText);
    if (queryTerms.length === 0) return { scores, enrichedCount: 0 };

    let enrichedCount = 0;

    for (const item of items) {
      if (item.nodeType !== 'fact') continue;

      // Load summary/frontmatter from DB
      const factRow = this.db.prepare(
        'SELECT summary, frontmatter FROM facts WHERE id = ?',
      ).get(item.nodeId) as { summary: string | null; frontmatter: string | null } | undefined;

      if (!factRow) continue;

      const textParts: string[] = [];
      if (factRow.frontmatter) textParts.push(factRow.frontmatter);
      if (factRow.summary) textParts.push(factRow.summary);

      if (textParts.length === 0) continue;

      const docTerms = tokenize(textParts.join(' '));
      if (docTerms.length === 0) continue;

      const overlap = computeTermOverlap(queryTerms, docTerms);
      if (overlap > 0) {
        scores.set(item.nodeId, overlap);
        enrichedCount++;
      }
    }

    return { scores, enrichedCount };
  }

  // ─── Internal: Score Combination + Content Enrichment ──────

  /**
   * Combine coarse, graph, and content scores for each item.
   * Optionally enrich fact content with summary/frontmatter.
   */
  private combineAndEnrich(
    items: ScoredMemoryItem[],
    graphScores: Map<string, number>,
    contentScores: Map<string, number>,
  ): { reranked: ScoredMemoryItem[]; contentReplacedCount: number } {
    const { coarseWeight, graphWeight, contentWeight, enrichContent } = this.config;
    const reranked: ScoredMemoryItem[] = [];
    let contentReplacedCount = 0;

    // Normalize graph scores to [0, 1]
    const maxGraphScore = Math.max(...Array.from(graphScores.values()), 0);
    const normalizedGraph = new Map<string, number>();
    if (maxGraphScore > 0) {
      for (const [id, score] of graphScores) {
        normalizedGraph.set(id, score / maxGraphScore);
      }
    }

    for (const item of items) {
      const coarseScore = item.score;
      const graphScore = normalizedGraph.get(item.nodeId) ?? 0;
      const contentScore = contentScores.get(item.nodeId) ?? 0;

      // Weighted combination
      let finalScore: number;
      if (graphScore > 0 || contentScore > 0) {
        finalScore =
          coarseWeight * coarseScore +
          graphWeight * graphScore +
          contentWeight * contentScore;
      } else {
        // No re-rank signals — keep coarse score (don't penalize)
        finalScore = coarseScore;
      }

      // Clamp to [0, 1]
      finalScore = Math.max(0, Math.min(1, finalScore));

      // Enrich content for facts with summary/frontmatter
      let content = item.content;
      if (enrichContent && item.nodeType === 'fact') {
        const enriched = this.enrichFactContent(item.nodeId, item.content);
        if (enriched !== item.content) {
          content = enriched;
          contentReplacedCount++;
        }
      }

      reranked.push({
        ...item,
        score: round4(finalScore),
        content,
        retrievalMetadata: {
          ...item.retrievalMetadata,
          rerankScores: {
            coarse: round4(coarseScore),
            graph: round4(graphScore),
            content: round4(contentScore),
            final: round4(finalScore),
          },
        },
      });
    }

    return { reranked, contentReplacedCount };
  }

  /**
   * Enrich a fact's display content with its Level 0 (frontmatter) + Level 1 (summary).
   * Format: "[frontmatter] summary\n---\ncontent"
   */
  private enrichFactContent(factId: string, originalContent: string): string {
    const row = this.db.prepare(
      'SELECT summary, frontmatter FROM facts WHERE id = ?',
    ).get(factId) as { summary: string | null; frontmatter: string | null } | undefined;

    if (!row) return originalContent;

    const parts: string[] = [];
    if (row.frontmatter) parts.push(`[${row.frontmatter}]`);
    if (row.summary) parts.push(row.summary);

    if (parts.length === 0) return originalContent;

    return `${parts.join(' ')}\n---\n${originalContent}`;
  }
}

// ─── Pure Helper Functions ────────────────────────────────────────

/**
 * Tokenize text into lowercase terms, removing stop words and short tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Compute term overlap score between query and document term sets.
 * Returns Jaccard-like coefficient in [0, 1].
 */
function computeTermOverlap(queryTerms: string[], docTerms: string[]): number {
  const querySet = new Set(queryTerms);
  const docSet = new Set(docTerms);

  let overlap = 0;
  for (const term of querySet) {
    if (docSet.has(term)) overlap++;
  }

  if (overlap === 0) return 0;

  // Normalized by query length (recall-oriented)
  return overlap / querySet.size;
}

const STOP_WORDS = new Set([
  'the', 'is', 'at', 'in', 'on', 'and', 'or', 'to', 'a', 'an',
  'of', 'for', 'with', 'that', 'this', 'was', 'are', 'has', 'have',
  'had', 'been', 'will', 'can', 'not', 'but', 'from', 'they', 'its',
  'does', 'how', 'what', 'when', 'where', 'which', 'who', 'why',
]);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function emptyStats(totalStart: number): ReRankStats {
  return {
    graphTimeMs: 0,
    contentTimeMs: 0,
    combineTimeMs: 0,
    totalTimeMs: round2(performance.now() - totalStart),
    graphEnrichedCount: 0,
    contentEnrichedCount: 0,
    contentReplacedCount: 0,
    inputCount: 0,
    outputCount: 0,
  };
}
