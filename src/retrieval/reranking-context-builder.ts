/**
 * RerankingContextBuilder — collects facts connected to top-K anchors
 * and constructs structured context for LLM re-ranking.
 *
 * This is the bridge between coarse vector retrieval (cosine similarity)
 * and fine-grained LLM re-ranking. Instead of sending raw vector results
 * to the LLM, we gather anchor-linked facts with their multi-level
 * representations (frontmatter / summary / full content) and edge metadata,
 * giving the LLM rich context to judge true relevance.
 *
 * Brain-like behavior: follows anchor → weighted_edge → fact associations,
 * mimicking how activating a concept in memory spreads to related memories
 * through associative links of varying strength.
 */

import type Database from 'better-sqlite3';
import type { AnchorMatch } from './vector-searcher.js';

// ─── Configuration ───────────────────────────────────────────────

export interface RerankingContextConfig {
  /** Maximum facts to collect per anchor. Default: 5 */
  maxFactsPerAnchor: number;
  /** Maximum total facts across all anchors. Default: 20 */
  maxTotalFacts: number;
  /** Minimum edge weight to include a fact. Default: 0.05 */
  minEdgeWeight: number;
  /** Content detail level for context. Default: 'summary' */
  detailLevel: 'frontmatter' | 'summary' | 'full';
  /** Include edge metadata (weight, activation count) in context. Default: true */
  includeEdgeMetadata: boolean;
}

export const DEFAULT_RERANKING_CONTEXT_CONFIG: RerankingContextConfig = {
  maxFactsPerAnchor: 5,
  maxTotalFacts: 20,
  minEdgeWeight: 0.05,
  detailLevel: 'summary',
  includeEdgeMetadata: true,
};

// ─── Result Types ────────────────────────────────────────────────

/** A fact collected from an anchor's weighted edges */
export interface LinkedFact {
  /** Fact ID */
  factId: string;
  /** Full fact content */
  content: string;
  /** Level 0: one-line frontmatter label (if available) */
  frontmatter?: string;
  /** Level 1: short summary (if available) */
  summary?: string;
  /** Fact category (preference, technical, etc.) */
  category: string;
  /** Fact confidence [0, 1] */
  confidence: number;
  /** Edge weight connecting this fact to the anchor [0, 1] */
  edgeWeight: number;
  /** Edge activation count (how often this link was used) */
  edgeActivationCount: number;
  /** Anchor(s) that led to this fact */
  sourceAnchors: Array<{
    anchorId: string;
    anchorLabel: string;
    similarity: number;
    edgeWeight: number;
  }>;
}

/** Context for a single anchor and its connected facts */
export interface AnchorContext {
  /** Anchor ID */
  anchorId: string;
  /** Anchor label */
  label: string;
  /** Cosine similarity to the query */
  similarity: number;
  /** Facts connected via weighted_edges */
  facts: LinkedFact[];
}

/** Complete re-ranking context built from top-K anchors */
export interface RerankingContext {
  /** Original query text */
  query: string;
  /** Per-anchor contexts with connected facts */
  anchorContexts: AnchorContext[];
  /** Deduplicated, globally-ranked facts for LLM consumption */
  rankedFacts: LinkedFact[];
  /** Build statistics */
  stats: RerankingContextStats;
}

export interface RerankingContextStats {
  /** Number of anchors processed */
  anchorsProcessed: number;
  /** Total edges traversed */
  edgesTraversed: number;
  /** Facts found (before dedup) */
  factsFoundRaw: number;
  /** Facts after deduplication */
  factsDeduped: number;
  /** Facts in final output (after limit) */
  factsOutput: number;
  /** Time to build context (ms) */
  buildTimeMs: number;
}

// ─── Context Builder ─────────────────────────────────────────────

export class RerankingContextBuilder {
  private db: Database.Database;
  readonly config: RerankingContextConfig;

  constructor(
    db: Database.Database,
    config?: Partial<RerankingContextConfig>,
  ) {
    this.db = db;
    this.config = { ...DEFAULT_RERANKING_CONTEXT_CONFIG, ...config };
  }

  /**
   * Build re-ranking context from top-K anchor matches.
   *
   * For each anchor, traverses hub→leaf weighted edges to collect
   * connected facts with their multi-level representations. Facts are
   * deduplicated (same fact reachable from multiple anchors — keeps the
   * best edge weight and merges source anchors), then globally ranked by
   * a combined score: anchorSimilarity * edgeWeight.
   */
  buildContext(
    query: string,
    matchedAnchors: AnchorMatch[],
    config?: Partial<RerankingContextConfig>,
  ): RerankingContext {
    const cfg = { ...this.config, ...config };
    const start = performance.now();

    let edgesTraversed = 0;
    let factsFoundRaw = 0;

    const anchorContexts: AnchorContext[] = [];
    // Map factId → LinkedFact for global deduplication
    const globalFactMap = new Map<string, LinkedFact>();

    for (const anchor of matchedAnchors) {
      // Query weighted_edges for hub→leaf connections
      const edges = this.db.prepare(`
        SELECT we.target_id, we.weight, we.activation_count,
               f.content, f.summary, f.frontmatter, f.category, f.confidence
        FROM weighted_edges we
        JOIN facts f ON f.id = we.target_id
        WHERE we.source_id = ?
          AND we.source_type = 'hub'
          AND we.target_type = 'leaf'
          AND we.weight >= ?
          AND f.superseded = 0
        ORDER BY we.weight DESC
        LIMIT ?
      `).all(
        anchor.anchorId,
        cfg.minEdgeWeight,
        cfg.maxFactsPerAnchor,
      ) as FactEdgeRow[];

      edgesTraversed += edges.length;

      const anchorFacts: LinkedFact[] = [];

      for (const edge of edges) {
        factsFoundRaw++;

        const sourceAnchorInfo = {
          anchorId: anchor.anchorId,
          anchorLabel: anchor.label,
          similarity: anchor.similarity,
          edgeWeight: edge.weight,
        };

        const existing = globalFactMap.get(edge.target_id);
        if (existing) {
          // Fact already seen from another anchor — merge source anchors
          existing.sourceAnchors.push(sourceAnchorInfo);
          // Keep the highest edge weight
          if (edge.weight > existing.edgeWeight) {
            existing.edgeWeight = edge.weight;
          }
          anchorFacts.push(existing);
        } else {
          const linkedFact: LinkedFact = {
            factId: edge.target_id,
            content: edge.content,
            frontmatter: edge.frontmatter ?? undefined,
            summary: edge.summary ?? undefined,
            category: edge.category,
            confidence: edge.confidence,
            edgeWeight: edge.weight,
            edgeActivationCount: edge.activation_count,
            sourceAnchors: [sourceAnchorInfo],
          };
          globalFactMap.set(edge.target_id, linkedFact);
          anchorFacts.push(linkedFact);
        }
      }

      anchorContexts.push({
        anchorId: anchor.anchorId,
        label: anchor.label,
        similarity: anchor.similarity,
        facts: anchorFacts,
      });
    }

    // Global ranking: sort by best combined score (max anchor similarity * edge weight)
    const allFacts = Array.from(globalFactMap.values());
    allFacts.sort((a, b) => {
      const scoreA = this.computeCombinedScore(a);
      const scoreB = this.computeCombinedScore(b);
      return scoreB - scoreA;
    });

    const rankedFacts = allFacts.slice(0, cfg.maxTotalFacts);

    const buildTimeMs = Math.round((performance.now() - start) * 100) / 100;

    return {
      query,
      anchorContexts,
      rankedFacts,
      stats: {
        anchorsProcessed: matchedAnchors.length,
        edgesTraversed,
        factsFoundRaw,
        factsDeduped: allFacts.length,
        factsOutput: rankedFacts.length,
        buildTimeMs,
      },
    };
  }

  /**
   * Format re-ranking context into a text prompt suitable for LLM consumption.
   *
   * Uses the configured detailLevel to choose between frontmatter (Level 0),
   * summary (Level 1), or full content for each fact.
   */
  formatForLLM(context: RerankingContext): string {
    const cfg = this.config;
    const lines: string[] = [];

    lines.push(`Query: "${context.query}"`);
    lines.push('');
    lines.push(`Activated anchors: ${context.anchorContexts.length}`);
    lines.push(`Candidate facts: ${context.rankedFacts.length}`);
    lines.push('');

    for (let i = 0; i < context.rankedFacts.length; i++) {
      const fact = context.rankedFacts[i];
      const score = this.computeCombinedScore(fact);

      lines.push(`--- Fact ${i + 1} [score: ${score.toFixed(3)}] ---`);

      // Choose detail level
      const displayContent = this.getDisplayContent(fact, cfg.detailLevel);
      lines.push(`Content: ${displayContent}`);

      lines.push(`Category: ${fact.category}`);
      lines.push(`Confidence: ${fact.confidence}`);

      if (cfg.includeEdgeMetadata) {
        lines.push(`Edge weight: ${fact.edgeWeight.toFixed(3)}`);
        lines.push(`Activations: ${fact.edgeActivationCount}`);
      }

      // Show which anchors led here
      const anchorLabels = fact.sourceAnchors
        .map(a => `${a.anchorLabel} (sim=${a.similarity.toFixed(3)})`)
        .join(', ');
      lines.push(`Via anchors: ${anchorLabels}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  // ─── Internal ──────────────────────────────────────────────────

  /**
   * Compute a combined relevance score for global ranking.
   * Uses the best (max) anchor similarity * edge weight across all source anchors.
   */
  private computeCombinedScore(fact: LinkedFact): number {
    let best = 0;
    for (const src of fact.sourceAnchors) {
      const score = src.similarity * src.edgeWeight;
      if (score > best) best = score;
    }
    return Math.round(best * 10000) / 10000;
  }

  /**
   * Get the appropriate content representation based on detail level.
   * Falls back to the next available level if the requested one is missing.
   */
  private getDisplayContent(
    fact: LinkedFact,
    level: RerankingContextConfig['detailLevel'],
  ): string {
    switch (level) {
      case 'frontmatter':
        return fact.frontmatter ?? fact.summary ?? fact.content;
      case 'summary':
        return fact.summary ?? fact.content;
      case 'full':
      default:
        return fact.content;
    }
  }
}

// ─── Internal Row Types ──────────────────────────────────────────

interface FactEdgeRow {
  target_id: string;
  weight: number;
  activation_count: number;
  content: string;
  summary: string | null;
  frontmatter: string | null;
  category: string;
  confidence: number;
}
