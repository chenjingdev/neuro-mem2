/**
 * AnchorScorer — orchestrates relevance scoring between memory nodes
 * and manages Hebbian-weighted edge creation/reinforcement through anchors.
 *
 * This module ties together EdgeScorer signals with the Anchor/WeightedEdge
 * persistence layer to:
 *
 * 1. Score relevance between any two memory nodes (fact, episode, concept, anchor)
 * 2. Create or upsert weighted edges based on multi-signal scoring
 * 3. Apply Hebbian co-activation reinforcement when nodes are retrieved together
 * 4. Batch-score a new node against existing anchors to auto-link
 *
 * Scoring signals combined:
 *   - Temporal proximity (exponential decay on creation-time distance)
 *   - Semantic similarity (cosine on embeddings, Jaccard fallback)
 *   - Co-occurrence frequency (shared conversation Jaccard)
 *   - Entity overlap (shared entity Jaccard)
 *
 * The Hebbian reinforcement rule:
 *   w_new = w_old + learningRate * relevanceScore * (1 - w_old)
 *
 * This ensures weights approach 1.0 asymptotically for frequently
 * co-activated, semantically related node pairs.
 */

import {
  EdgeScorer,
  type MemoryNodeDescriptor,
  type ScoreBreakdown,
  type EdgeScorerConfig,
} from './edge-scorer.js';

import type { WeightedNodeType, WeightedEdgeType } from '../models/weighted-edge.js';

// ────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────

/** Configuration for the AnchorScorer */
export interface AnchorScorerConfig {
  /** EdgeScorer configuration (scoring weights, half-life, threshold) */
  edgeScorerConfig?: Partial<EdgeScorerConfig>;
  /** Default learning rate for Hebbian reinforcement (default: 0.1) */
  defaultLearningRate: number;
  /** Default decay rate for new edges (default: 0.01) */
  defaultDecayRate: number;
  /**
   * Minimum relevance score to create an edge (default: 0.1).
   * Below this, the pair is considered unrelated.
   */
  minEdgeCreationThreshold: number;
  /**
   * Maximum number of edges to create per batch scoring operation (default: 50).
   * Prevents explosion when linking a node against many candidates.
   */
  maxEdgesPerBatch: number;
}

export const DEFAULT_ANCHOR_SCORER_CONFIG: AnchorScorerConfig = {
  defaultLearningRate: 0.1,
  defaultDecayRate: 0.01,
  minEdgeCreationThreshold: 0.1,
  maxEdgesPerBatch: 50,
};

// ────────────────────────────────────────────────────────
// Scoring result types
// ────────────────────────────────────────────────────────

/** Result of scoring a pair of nodes for anchor linkage */
export interface AnchorScoringResult {
  /** Source node ID */
  sourceId: string;
  /** Source node type */
  sourceType: WeightedNodeType;
  /** Target node ID */
  targetId: string;
  /** Target node type */
  targetType: WeightedNodeType;
  /** Computed edge type based on node types */
  edgeType: WeightedEdgeType;
  /** Detailed score breakdown */
  breakdown: ScoreBreakdown;
  /** Suggested initial weight for edge creation */
  suggestedWeight: number;
  /** Whether this pair should be linked (score >= threshold) */
  shouldLink: boolean;
}

/** Result of Hebbian co-activation reinforcement */
export interface ReinforcementResult {
  /** Edge identifier (sourceId + targetId + edgeType) */
  sourceId: string;
  targetId: string;
  edgeType: WeightedEdgeType;
  /** Weight before reinforcement */
  previousWeight: number;
  /** Weight after reinforcement */
  newWeight: number;
  /** The delta applied */
  delta: number;
  /** The relevance score used for scaling */
  relevanceScore: number;
}

/** Summary of a batch scoring operation */
export interface BatchScoringResult {
  /** All scored pairs */
  scoredPairs: AnchorScoringResult[];
  /** Pairs that passed the threshold (should be linked) */
  linkedPairs: AnchorScoringResult[];
  /** Total candidates evaluated */
  totalEvaluated: number;
  /** Number that passed the threshold */
  linkedCount: number;
  /** Average score across all evaluated pairs */
  averageScore: number;
  /** Highest scoring pair */
  topPair: AnchorScoringResult | null;
}

// ────────────────────────────────────────────────────────
// Edge type inference
// ────────────────────────────────────────────────────────

/**
 * Infer the WeightedEdgeType from source and target node types.
 *
 * Rules (hub/leaf model):
 * - hub → leaf  = 'about'   (anchor describes a memory node)
 * - hub → hub   = 'related' (inter-anchor association)
 * - leaf → leaf = 'related' (memory node association)
 * - leaf → hub  = 'about'   (memory node references an anchor)
 */
export function inferEdgeType(
  sourceType: WeightedNodeType,
  targetType: WeightedNodeType,
): WeightedEdgeType {
  if (sourceType === 'hub' && targetType === 'leaf') return 'about';
  if (sourceType === 'hub' && targetType === 'hub') return 'related';
  if (sourceType === 'leaf' && targetType === 'leaf') return 'related';
  if (sourceType === 'leaf' && targetType === 'hub') return 'about';

  // Fallback (shouldn't be reached with hub/leaf types)
  return 'related';
}

// ────────────────────────────────────────────────────────
// AnchorScorer class
// ────────────────────────────────────────────────────────

/**
 * Orchestrates relevance scoring between memory nodes and produces
 * edge creation/reinforcement decisions.
 *
 * Usage:
 *   const scorer = new AnchorScorer();
 *
 *   // Score a single pair
 *   const result = scorer.scorePair(nodeA, nodeB);
 *   if (result.shouldLink) {
 *     edgeRepo.createEdge({ weight: result.suggestedWeight, ... });
 *   }
 *
 *   // Score one node against many candidates
 *   const batch = scorer.scoreBatch(newNode, existingNodes);
 *   for (const pair of batch.linkedPairs) {
 *     edgeRepo.createEdge({ weight: pair.suggestedWeight, ... });
 *   }
 *
 *   // Reinforce an existing edge after co-activation
 *   const reinforced = scorer.reinforceWeight(0.5, nodeA, nodeB);
 */
export class AnchorScorer {
  readonly config: AnchorScorerConfig;
  private readonly edgeScorer: EdgeScorer;

  constructor(config?: Partial<AnchorScorerConfig>) {
    this.config = {
      ...DEFAULT_ANCHOR_SCORER_CONFIG,
      ...config,
    };
    this.edgeScorer = new EdgeScorer(this.config.edgeScorerConfig);
  }

  /**
   * Score relevance between two memory nodes and determine if they
   * should be linked with a weighted edge.
   *
   * Returns a detailed result including signal breakdown, suggested
   * weight, and whether the pair meets the linking threshold.
   */
  scorePair(
    nodeA: MemoryNodeDescriptor,
    nodeB: MemoryNodeDescriptor,
  ): AnchorScoringResult {
    const breakdown = this.edgeScorer.score(nodeA, nodeB);

    const sourceType = nodeA.type as WeightedNodeType;
    const targetType = nodeB.type as WeightedNodeType;
    const edgeType = inferEdgeType(sourceType, targetType);

    // Suggested weight: combined score with a minimum floor of 0.1
    // to prevent newly created edges from being immediately pruned
    const suggestedWeight = breakdown.score >= this.config.minEdgeCreationThreshold
      ? Math.max(0.1, breakdown.score)
      : 0;

    return {
      sourceId: nodeA.id,
      sourceType,
      targetId: nodeB.id,
      targetType,
      edgeType,
      breakdown,
      suggestedWeight,
      shouldLink: breakdown.score >= this.config.minEdgeCreationThreshold,
    };
  }

  /**
   * Score a reference node against multiple candidates.
   *
   * Returns results sorted by score descending, limited to maxEdgesPerBatch.
   * Only pairs meeting the threshold are included in `linkedPairs`.
   */
  scoreBatch(
    reference: MemoryNodeDescriptor,
    candidates: MemoryNodeDescriptor[],
  ): BatchScoringResult {
    // Score all candidates (exclude self)
    const scoredPairs = candidates
      .filter(c => c.id !== reference.id)
      .map(candidate => this.scorePair(reference, candidate))
      .sort((a, b) => b.breakdown.score - a.breakdown.score);

    const linkedPairs = scoredPairs
      .filter(p => p.shouldLink)
      .slice(0, this.config.maxEdgesPerBatch);

    const totalScore = scoredPairs.reduce((sum, p) => sum + p.breakdown.score, 0);
    const averageScore = scoredPairs.length > 0
      ? Math.round((totalScore / scoredPairs.length) * 10000) / 10000
      : 0;

    return {
      scoredPairs,
      linkedPairs,
      totalEvaluated: scoredPairs.length,
      linkedCount: linkedPairs.length,
      averageScore,
      topPair: linkedPairs.length > 0 ? linkedPairs[0] : null,
    };
  }

  /**
   * Compute Hebbian reinforcement for an existing edge weight.
   *
   * When two nodes are co-activated during retrieval, their connecting
   * edge should be strengthened proportionally to their current relevance.
   *
   * Formula: w_new = w_old + learningRate * relevanceScore * (1 - w_old)
   *
   * This ensures:
   * - Highly relevant co-activations strengthen the edge more
   * - Weight approaches 1.0 asymptotically (never exceeds it)
   * - Already-strong edges receive diminishing reinforcement
   *
   * @param currentWeight - Current edge weight [0, 1]
   * @param nodeA - First co-activated node
   * @param nodeB - Second co-activated node
   * @param learningRate - Override learning rate (uses default if omitted)
   * @returns Reinforcement result with old/new weight and delta
   */
  reinforceWeight(
    currentWeight: number,
    nodeA: MemoryNodeDescriptor,
    nodeB: MemoryNodeDescriptor,
    learningRate?: number,
  ): ReinforcementResult {
    const lr = learningRate ?? this.config.defaultLearningRate;
    const breakdown = this.edgeScorer.score(nodeA, nodeB);
    const relevanceScore = breakdown.score;

    const sourceType = nodeA.type as WeightedNodeType;
    const targetType = nodeB.type as WeightedNodeType;
    const edgeType = inferEdgeType(sourceType, targetType);

    // Hebbian rule scaled by relevance:
    // delta = lr * relevanceScore * (1 - currentWeight)
    const headroom = 1.0 - Math.max(0, Math.min(1, currentWeight));
    const delta = lr * relevanceScore * headroom;
    const newWeight = Math.min(1.0, Math.max(0, currentWeight + delta));

    return {
      sourceId: nodeA.id,
      targetId: nodeB.id,
      edgeType,
      previousWeight: currentWeight,
      newWeight: Math.round(newWeight * 10000) / 10000,
      delta: Math.round(delta * 10000) / 10000,
      relevanceScore,
    };
  }

  /**
   * Compute raw relevance score between two nodes (convenience).
   * Returns just the combined score [0, 1].
   */
  computeRelevance(
    nodeA: MemoryNodeDescriptor,
    nodeB: MemoryNodeDescriptor,
  ): number {
    return this.edgeScorer.score(nodeA, nodeB).score;
  }

  /**
   * Compute the Hebbian delta without needing full node descriptors.
   *
   * Useful when you already have the relevance score and just need
   * to compute the weight update.
   *
   * Formula: delta = learningRate * relevanceScore * (1 - currentWeight)
   *
   * @param currentWeight - Current edge weight [0, 1]
   * @param relevanceScore - Pre-computed relevance score [0, 1]
   * @param learningRate - Learning rate (uses default if omitted)
   * @returns The delta to add to the current weight
   */
  computeHebbianDelta(
    currentWeight: number,
    relevanceScore: number,
    learningRate?: number,
  ): number {
    const lr = learningRate ?? this.config.defaultLearningRate;
    const clamped = Math.max(0, Math.min(1, currentWeight));
    const headroom = 1.0 - clamped;
    return lr * relevanceScore * headroom;
  }

  /**
   * Apply Hebbian delta to a weight (convenience).
   *
   * @param currentWeight - Current weight
   * @param relevanceScore - Relevance score for scaling
   * @param learningRate - Optional learning rate override
   * @returns New weight clamped to [0, 1]
   */
  applyHebbianUpdate(
    currentWeight: number,
    relevanceScore: number,
    learningRate?: number,
  ): number {
    const delta = this.computeHebbianDelta(currentWeight, relevanceScore, learningRate);
    return Math.min(1.0, Math.max(0, currentWeight + delta));
  }

  /**
   * Batch reinforce multiple edge weights from co-activation.
   *
   * Given a set of nodes that were co-activated in a retrieval pass,
   * compute reinforcement for all pairwise edges.
   *
   * @param currentWeights - Map of edge key to current weight
   *   Key format: `${sourceId}:${targetId}:${edgeType}`
   * @param activatedNodes - Nodes co-activated in this retrieval
   * @param learningRate - Override learning rate
   * @returns Array of reinforcement results
   */
  batchReinforce(
    currentWeights: Map<string, number>,
    activatedNodes: MemoryNodeDescriptor[],
    learningRate?: number,
  ): ReinforcementResult[] {
    const results: ReinforcementResult[] = [];

    for (let i = 0; i < activatedNodes.length; i++) {
      for (let j = i + 1; j < activatedNodes.length; j++) {
        const nodeA = activatedNodes[i];
        const nodeB = activatedNodes[j];

        const sourceType = nodeA.type as WeightedNodeType;
        const targetType = nodeB.type as WeightedNodeType;
        const edgeType = inferEdgeType(sourceType, targetType);
        const key = `${nodeA.id}:${nodeB.id}:${edgeType}`;

        const currentWeight = currentWeights.get(key) ?? 0;
        const result = this.reinforceWeight(currentWeight, nodeA, nodeB, learningRate);
        results.push(result);
      }
    }

    return results;
  }

  /** Expose the underlying EdgeScorer for advanced usage */
  getEdgeScorer(): EdgeScorer {
    return this.edgeScorer;
  }
}
