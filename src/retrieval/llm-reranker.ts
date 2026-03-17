/**
 * LLMReranker — re-ranks retrieval results using LLM relevance judgment.
 *
 * After the coarse embedding-based retrieval finds candidate anchors and
 * expands to connected memory nodes, the LLM examines the query alongside
 * each candidate's content (and anchor context) to produce a refined
 * relevance score.
 *
 * This is the brain-like "cortical re-evaluation" step:
 *   1. Subcortical pattern match (embedding cosine similarity) → coarse candidates
 *   2. **Cortical attention (LLM re-ranking)** → refined relevance
 *
 * The final score blends the coarse embedding score with the LLM relevance:
 *   finalScore = alpha * llmRelevance + (1 - alpha) * coarseScore
 *
 * Design:
 * - Graceful degradation: if LLM fails, returns original items unchanged
 * - Anti-hallucination: validates LLM response IDs against actual candidates
 * - Batch-friendly: sends all candidates in one LLM call (efficient)
 * - Pipeline traceability: returns timing and decision stats
 */

import type { LLMProvider } from '../extraction/llm-provider.js';
import {
  buildRerankRequest,
  parseRerankResponse,
  type RerankCandidate,
  type RerankInput,
  type RerankScore,
} from '../extraction/reranking-prompt.js';
import type { ScoredMemoryItem } from './types.js';
import type { AnchorMatch } from './vector-searcher.js';

// ─── Configuration ───────────────────────────────────────────────

export interface LLMRerankerConfig {
  /**
   * Maximum number of candidates to send to the LLM for re-ranking.
   * Items beyond this limit keep their coarse score unchanged.
   * Default: 20
   */
  maxCandidates: number;

  /**
   * Blending weight for LLM relevance vs coarse score.
   * finalScore = alpha * llmRelevance + (1 - alpha) * coarseScore
   * Default: 0.7 (LLM judgment dominates)
   */
  alpha: number;

  /**
   * Minimum LLM relevance to keep an item.
   * Items below this are filtered out (LLM says "not relevant").
   * Set to 0 to disable filtering.
   * Default: 0.1
   */
  minRelevance: number;

  /**
   * Whether to enable re-ranking. Set to false to skip.
   * Default: true
   */
  enabled: boolean;
}

export const DEFAULT_RERANKER_CONFIG: LLMRerankerConfig = {
  maxCandidates: 20,
  alpha: 0.7,
  minRelevance: 0.1,
  enabled: true,
};

// ─── Result Types ────────────────────────────────────────────────

export interface LLMRerankResult {
  /** Re-ranked and filtered items */
  items: ScoredMemoryItem[];
  /** Diagnostics for pipeline traceability */
  stats: LLMRerankStats;
}

export interface LLMRerankStats {
  /** Time for the LLM re-ranking call (ms) */
  rerankTimeMs: number;
  /** Number of candidates sent to LLM */
  candidatesSent: number;
  /** Number of items returned after re-ranking + filtering */
  itemsReturned: number;
  /** Number of items filtered out by minRelevance threshold */
  itemsFiltered: number;
  /** Whether re-ranking used LLM or was skipped/fell back */
  source: 'llm' | 'passthrough' | 'error_fallback';
  /** Error message if LLM failed */
  error?: string;
}

// ─── LLMReranker Class ──────────────────────────────────────────

export class LLMReranker {
  readonly config: LLMRerankerConfig;

  constructor(
    private readonly llmProvider: LLMProvider,
    config?: Partial<LLMRerankerConfig>,
  ) {
    this.config = { ...DEFAULT_RERANKER_CONFIG, ...config };
  }

  /**
   * Re-rank retrieval results using LLM judgment.
   *
   * @param query - The original user query
   * @param items - Coarse-ranked items from embedding search + expansion
   * @param matchedAnchors - Anchors that were activated (for context)
   * @param configOverride - Per-call config overrides
   * @returns Re-ranked items with stats
   */
  async rerank(
    query: string,
    items: ScoredMemoryItem[],
    matchedAnchors: AnchorMatch[],
    configOverride?: Partial<LLMRerankerConfig>,
  ): Promise<LLMRerankResult> {
    const config = { ...this.config, ...configOverride };
    const start = performance.now();

    // Skip if disabled or no items
    if (!config.enabled || items.length === 0) {
      return {
        items,
        stats: {
          rerankTimeMs: 0,
          candidatesSent: 0,
          itemsReturned: items.length,
          itemsFiltered: 0,
          source: 'passthrough',
        },
      };
    }

    // Build anchor lookup for context
    const anchorLabelMap = new Map<string, string>();
    for (const a of matchedAnchors) {
      anchorLabelMap.set(a.anchorId, a.label);
    }

    // Select candidates (top items by coarse score, up to maxCandidates)
    const candidateItems = items.slice(0, config.maxCandidates);
    const overflowItems = items.slice(config.maxCandidates);

    // Build rerank candidates
    const candidates: RerankCandidate[] = candidateItems.map(item => ({
      id: item.nodeId,
      nodeType: item.nodeType,
      content: item.content,
      anchorLabel: item.retrievalMetadata?.expandedFromAnchor
        ? anchorLabelMap.get(item.retrievalMetadata.expandedFromAnchor as string)
        : item.nodeType === 'anchor'
          ? anchorLabelMap.get(item.nodeId)
          : undefined,
      coarseScore: item.score,
    }));

    try {
      // Build and send LLM request
      const input: RerankInput = { query, candidates };
      const request = buildRerankRequest(input);
      const response = await this.llmProvider.complete(request);
      const rerankTimeMs = round2(performance.now() - start);

      // Parse response
      const candidateIds = new Set(candidates.map(c => c.id));
      const parsed = parseRerankResponse(response.content, candidateIds);

      // Build score lookup
      const scoreMap = new Map<string, RerankScore>();
      for (const s of parsed.scores) {
        scoreMap.set(s.id, s);
      }

      // Blend scores and filter
      const rerankedItems: ScoredMemoryItem[] = [];
      let filtered = 0;

      for (const item of candidateItems) {
        const llmScore = scoreMap.get(item.nodeId);
        if (llmScore) {
          // Blend: alpha * LLM relevance + (1 - alpha) * coarse score
          const blendedScore = round4(
            config.alpha * llmScore.relevance + (1 - config.alpha) * item.score,
          );

          // Filter by minimum relevance
          if (llmScore.relevance < config.minRelevance) {
            filtered++;
            continue;
          }

          rerankedItems.push({
            ...item,
            score: blendedScore,
            retrievalMetadata: {
              ...item.retrievalMetadata,
              llmRelevance: llmScore.relevance,
              llmReason: llmScore.reason,
              coarseScore: item.score,
              rerankBlendAlpha: config.alpha,
            },
          });
        } else {
          // LLM didn't score this item — keep with original score
          rerankedItems.push(item);
        }
      }

      // Add overflow items (not sent to LLM) unchanged
      rerankedItems.push(...overflowItems);

      // Re-sort by blended score
      rerankedItems.sort((a, b) => b.score - a.score);

      return {
        items: rerankedItems,
        stats: {
          rerankTimeMs,
          candidatesSent: candidates.length,
          itemsReturned: rerankedItems.length,
          itemsFiltered: filtered,
          source: 'llm',
        },
      };
    } catch (err) {
      // Graceful degradation: return original items unchanged
      const rerankTimeMs = round2(performance.now() - start);
      const errorMsg = err instanceof Error ? err.message : String(err);

      return {
        items,
        stats: {
          rerankTimeMs,
          candidatesSent: candidates.length,
          itemsReturned: items.length,
          itemsFiltered: 0,
          source: 'error_fallback',
          error: `LLM rerank failed: ${errorMsg}`,
        },
      };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
