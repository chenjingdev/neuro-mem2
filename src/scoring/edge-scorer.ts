/**
 * Edge Scorer — computes relevance weights between memory nodes.
 *
 * Combines multiple signals to produce a single [0, 1] weight:
 *   1. Temporal proximity  — how close in time two nodes were created
 *   2. Semantic similarity — cosine similarity between content embeddings (or Jaccard fallback)
 *   3. Co-occurrence frequency — how often two nodes appear in the same context
 *   4. Entity overlap — shared named entities between nodes
 *
 * The final score is a configurable weighted average of all signals.
 * Each signal is independently useful and can be queried separately.
 */

import type { MemoryNodeType } from '../models/memory-edge.js';

// ────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────

/** Abstract representation of any memory node for scoring purposes */
export interface MemoryNodeDescriptor {
  /** Node ID */
  id: string;
  /** Node type */
  type: MemoryNodeType;
  /** Plain-text content (fact content, episode description, concept description) */
  content: string;
  /** ISO 8601 timestamp of creation */
  createdAt: string;
  /** Named entities referenced by this node */
  entities: string[];
  /** Optional conversation ID(s) this node belongs to */
  conversationIds: string[];
  /** Optional turn indices for temporal ordering within a conversation */
  turnIndices?: number[];
  /** Optional pre-computed embedding vector (if available) */
  embedding?: number[];
}

/** Configuration for the combined scoring weights */
export interface ScoringWeights {
  /** Weight for temporal proximity signal [0, 1] (default: 0.2) */
  temporal: number;
  /** Weight for semantic similarity signal [0, 1] (default: 0.4) */
  semantic: number;
  /** Weight for co-occurrence frequency signal [0, 1] (default: 0.2) */
  coOccurrence: number;
  /** Weight for entity overlap signal [0, 1] (default: 0.2) */
  entityOverlap: number;
}

/** Configuration for the edge scorer */
export interface EdgeScorerConfig {
  /** Combined scoring weights (must sum to 1.0) */
  weights: ScoringWeights;
  /** Half-life for temporal decay in milliseconds (default: 7 days) */
  temporalHalfLifeMs: number;
  /** Minimum score threshold — below this, the edge is not worth creating (default: 0.1) */
  minScoreThreshold: number;
}

/** Detailed breakdown of how a score was computed */
export interface ScoreBreakdown {
  /** Final combined score [0, 1] */
  score: number;
  /** Individual signal scores */
  signals: {
    temporal: number;
    semantic: number;
    coOccurrence: number;
    entityOverlap: number;
  };
  /** The weights used in combination */
  weights: ScoringWeights;
  /** Whether the score meets the minimum threshold */
  meetsThreshold: boolean;
}

/** Co-occurrence data for a pair of nodes */
export interface CoOccurrenceData {
  /** Number of shared conversations */
  sharedConversations: number;
  /** Total conversations for node A */
  totalConversationsA: number;
  /** Total conversations for node B */
  totalConversationsB: number;
}

// ────────────────────────────────────────────────────────
// Default configuration
// ────────────────────────────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  temporal: 0.2,
  semantic: 0.4,
  coOccurrence: 0.2,
  entityOverlap: 0.2,
};

export const DEFAULT_SCORER_CONFIG: EdgeScorerConfig = {
  weights: DEFAULT_SCORING_WEIGHTS,
  temporalHalfLifeMs: SEVEN_DAYS_MS,
  minScoreThreshold: 0.1,
};

// ────────────────────────────────────────────────────────
// Scoring functions (pure, stateless)
// ────────────────────────────────────────────────────────

/**
 * Temporal proximity score using exponential decay.
 *
 * Score = exp(-λ * |t_a - t_b|) where λ = ln(2) / halfLife
 *
 * Two nodes created at the same time → 1.0
 * Two nodes separated by one half-life → 0.5
 * Two nodes far apart → approaches 0.0
 */
export function computeTemporalProximity(
  timestampA: string,
  timestampB: string,
  halfLifeMs: number = SEVEN_DAYS_MS,
): number {
  const tA = new Date(timestampA).getTime();
  const tB = new Date(timestampB).getTime();

  if (isNaN(tA) || isNaN(tB)) return 0;
  if (halfLifeMs <= 0) return 0;

  const deltaMs = Math.abs(tA - tB);
  const lambda = Math.LN2 / halfLifeMs;

  return Math.exp(-lambda * deltaMs);
}

/**
 * Semantic similarity using cosine similarity of embedding vectors.
 * Falls back to Jaccard token overlap if embeddings are not available.
 *
 * @returns Score in [0, 1]
 */
export function computeSemanticSimilarity(
  nodeA: Pick<MemoryNodeDescriptor, 'content' | 'embedding'>,
  nodeB: Pick<MemoryNodeDescriptor, 'content' | 'embedding'>,
): number {
  // If both have embeddings, use cosine similarity
  if (nodeA.embedding?.length && nodeB.embedding?.length) {
    return cosineSimilarity(nodeA.embedding, nodeB.embedding);
  }

  // Fallback: Jaccard similarity on tokenized content
  return jaccardSimilarity(nodeA.content, nodeB.content);
}

/**
 * Cosine similarity between two vectors.
 * Returns value in [-1, 1], clamped to [0, 1] for scoring.
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length === 0 || vecB.length === 0) return 0;

  const minLen = Math.min(vecA.length, vecB.length);
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < minLen; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  // Clamp to [0, 1] — negative cosine means dissimilar, treat as 0
  return Math.max(0, dotProduct / denominator);
}

/**
 * Jaccard similarity between two text strings based on tokenized words.
 * Used as a fallback when embeddings are not available.
 *
 * Score = |intersection| / |union|
 */
export function jaccardSimilarity(textA: string, textB: string): number {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);

  if (tokensA.size === 0 && tokensB.size === 0) return 0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersectionSize++;
  }

  const unionSize = tokensA.size + tokensB.size - intersectionSize;
  if (unionSize === 0) return 0;

  return intersectionSize / unionSize;
}

/**
 * Co-occurrence frequency score.
 *
 * Uses Jaccard coefficient on conversation sets:
 * Score = |shared conversations| / |union of conversations|
 *
 * Nodes that always appear together → 1.0
 * Nodes that never appear together → 0.0
 */
export function computeCoOccurrence(data: CoOccurrenceData): number {
  if (data.sharedConversations < 0) return 0;
  if (data.totalConversationsA <= 0 && data.totalConversationsB <= 0) return 0;

  // Union = A + B - shared
  const union = data.totalConversationsA + data.totalConversationsB - data.sharedConversations;
  if (union <= 0) return 0;

  return Math.min(1, data.sharedConversations / union);
}

/**
 * Compute co-occurrence data from two node descriptors.
 */
export function computeCoOccurrenceFromNodes(
  nodeA: Pick<MemoryNodeDescriptor, 'conversationIds'>,
  nodeB: Pick<MemoryNodeDescriptor, 'conversationIds'>,
): CoOccurrenceData {
  const setA = new Set(nodeA.conversationIds);
  const setB = new Set(nodeB.conversationIds);

  let sharedConversations = 0;
  for (const id of setA) {
    if (setB.has(id)) sharedConversations++;
  }

  return {
    sharedConversations,
    totalConversationsA: setA.size,
    totalConversationsB: setB.size,
  };
}

/**
 * Entity overlap score.
 *
 * Uses Jaccard coefficient on entity sets:
 * Score = |shared entities| / |union of entities|
 *
 * Nodes referencing the same entities → higher score.
 */
export function computeEntityOverlap(
  entitiesA: string[],
  entitiesB: string[],
): number {
  const setA = new Set(entitiesA.map(e => e.toLowerCase()));
  const setB = new Set(entitiesB.map(e => e.toLowerCase()));

  if (setA.size === 0 && setB.size === 0) return 0;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersectionSize = 0;
  for (const entity of setA) {
    if (setB.has(entity)) intersectionSize++;
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  if (unionSize === 0) return 0;

  return intersectionSize / unionSize;
}

// ────────────────────────────────────────────────────────
// EdgeScorer class — combined scoring
// ────────────────────────────────────────────────────────

/**
 * Computes combined relevance weights between memory nodes.
 *
 * Usage:
 *   const scorer = new EdgeScorer();
 *   const result = scorer.score(nodeA, nodeB);
 *   if (result.meetsThreshold) {
 *     edgeRepo.createEdge({ ...edge, weight: result.score });
 *   }
 */
export class EdgeScorer {
  readonly config: EdgeScorerConfig;

  constructor(config?: Partial<EdgeScorerConfig>) {
    this.config = {
      ...DEFAULT_SCORER_CONFIG,
      ...config,
      weights: {
        ...DEFAULT_SCORING_WEIGHTS,
        ...config?.weights,
      },
    };
  }

  /**
   * Compute the combined relevance score between two memory nodes.
   * Returns a detailed breakdown of all signals.
   */
  score(nodeA: MemoryNodeDescriptor, nodeB: MemoryNodeDescriptor): ScoreBreakdown {
    const { weights, temporalHalfLifeMs, minScoreThreshold } = this.config;

    // 1. Temporal proximity
    const temporal = computeTemporalProximity(
      nodeA.createdAt,
      nodeB.createdAt,
      temporalHalfLifeMs,
    );

    // 2. Semantic similarity
    const semantic = computeSemanticSimilarity(nodeA, nodeB);

    // 3. Co-occurrence frequency
    const coOccurrenceData = computeCoOccurrenceFromNodes(nodeA, nodeB);
    const coOccurrence = computeCoOccurrence(coOccurrenceData);

    // 4. Entity overlap
    const entityOverlap = computeEntityOverlap(nodeA.entities, nodeB.entities);

    // Combine with weighted average
    const combined =
      weights.temporal * temporal +
      weights.semantic * semantic +
      weights.coOccurrence * coOccurrence +
      weights.entityOverlap * entityOverlap;

    // Clamp to [0, 1]
    const score = Math.max(0, Math.min(1, Math.round(combined * 1000) / 1000));

    return {
      score,
      signals: { temporal, semantic, coOccurrence, entityOverlap },
      weights,
      meetsThreshold: score >= minScoreThreshold,
    };
  }

  /**
   * Score multiple candidate nodes against a reference node.
   * Returns results sorted by score descending, filtered by threshold.
   */
  scoreMany(
    reference: MemoryNodeDescriptor,
    candidates: MemoryNodeDescriptor[],
    options?: { includeBelow?: boolean },
  ): Array<{ node: MemoryNodeDescriptor; breakdown: ScoreBreakdown }> {
    const results = candidates
      .filter(c => c.id !== reference.id) // Don't score against self
      .map(candidate => ({
        node: candidate,
        breakdown: this.score(reference, candidate),
      }));

    const filtered = options?.includeBelow
      ? results
      : results.filter(r => r.breakdown.meetsThreshold);

    return filtered.sort((a, b) => b.breakdown.score - a.breakdown.score);
  }

  /**
   * Compute the Hebbian reinforcement delta for an edge.
   *
   * When two nodes are co-activated during retrieval, the edge
   * between them should be strengthened. The delta is proportional
   * to the current combined relevance score.
   *
   * Formula: delta = baseRate * relevanceScore
   * Applied as: new_weight = old_weight + delta * (1 - old_weight)
   *
   * @param currentWeight - Current edge weight [0, 1]
   * @param relevanceScore - Current relevance score between the nodes [0, 1]
   * @param baseRate - Base learning rate (default: 0.1)
   * @returns The delta to apply via Hebbian reinforcement
   */
  computeHebbianDelta(
    currentWeight: number,
    relevanceScore: number,
    baseRate: number = 0.1,
  ): number {
    // Scale the reinforcement by relevance — highly relevant co-activations
    // strengthen the edge more than weakly relevant ones.
    return baseRate * relevanceScore;
  }

  /**
   * Compute initial edge weight for a newly discovered relationship.
   * Takes into account the type of relationship and the node types.
   */
  computeInitialWeight(
    nodeA: MemoryNodeDescriptor,
    nodeB: MemoryNodeDescriptor,
  ): number {
    const breakdown = this.score(nodeA, nodeB);
    // Use the combined score as the initial weight, with a minimum of 0.1
    // to ensure newly created edges aren't immediately pruned.
    return Math.max(0.1, breakdown.score);
  }
}

// ────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────

/** Simple word tokenizer with stop word removal */
function tokenize(text: string): Set<string> {
  if (!text) return new Set();

  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));

  return new Set(tokens);
}

/** Common English stop words to filter from token comparison */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'from', 'its',
  'they', 'were', 'will', 'with', 'this', 'that', 'what', 'when', 'which',
  'would', 'there', 'their', 'about', 'each', 'make', 'like', 'than',
  'them', 'then', 'these', 'some', 'could', 'other', 'into', 'more',
  'also', 'back', 'after', 'only', 'come', 'made', 'most', 'over',
  'such', 'just', 'use', 'used', 'using', 'does', 'did',
]);
