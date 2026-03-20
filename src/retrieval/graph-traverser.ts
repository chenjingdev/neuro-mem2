/**
 * Graph Traverser — retrieves memory nodes via weighted edge traversal.
 *
 * Starting from activated anchors, traverses Hebbian-weighted edges
 * to collect connected facts, episodes, and concepts. Supports
 * multi-hop traversal with configurable depth and weight thresholds.
 */

import type Database from 'better-sqlite3';
import type { Fact } from '../models/fact.js';
import type { Episode } from '../models/episode.js';
import type { Concept } from '../models/concept.js';
import type { WeightedEdge } from '../models/weighted-edge.js';
import { AnchorRepository } from '../db/anchor-repo.js';
import { WeightedEdgeRepository } from '../db/weighted-edge-repo.js';
import { FactRepository } from '../db/fact-repo.js';
import { EpisodeRepository } from '../db/episode-repo.js';
import { ConceptRepository } from '../db/concept-repo.js';

// ─── Types ───────────────────────────────────────────────

export interface GraphTraversalInput {
  /** Starting anchor IDs to traverse from */
  anchorIds: string[];
  /** Maximum traversal depth (default: 2) */
  maxDepth?: number;
  /** Minimum edge weight to follow (default: 0.1) */
  minWeight?: number;
  /** Maximum total nodes to collect (default: 50) */
  maxNodes?: number;
  /** Edge types to follow (all if omitted) */
  edgeTypes?: string[];
  /** Node types to collect (all if omitted) */
  nodeTypes?: Array<'fact' | 'episode' | 'concept'>;
}

export interface GraphTraversalResult {
  /** Retrieved facts, ordered by traversal weight */
  facts: ScoredFact[];
  /** Retrieved episodes, ordered by traversal weight */
  episodes: ScoredEpisode[];
  /** Retrieved concepts, ordered by traversal weight */
  concepts: ScoredConcept[];
  /** Edges traversed during search */
  traversedEdges: WeightedEdge[];
  /** Total nodes found */
  totalNodes: number;
  /** Traversal time in milliseconds */
  traversalTimeMs: number;
}

export interface ScoredFact {
  fact: Fact;
  /** Accumulated traversal weight (product of edge weights along path) */
  score: number;
  /** Traversal depth from anchor */
  depth: number;
  /** The anchor this fact was reached from */
  sourceAnchorId: string;
}

export interface ScoredEpisode {
  episode: Episode;
  score: number;
  depth: number;
  sourceAnchorId: string;
}

export interface ScoredConcept {
  concept: Concept;
  score: number;
  depth: number;
  sourceAnchorId: string;
}

// ─── Graph Traverser ─────────────────────────────────────

export class GraphTraverser {
  private anchorRepo: AnchorRepository;
  private weightedEdgeRepo: WeightedEdgeRepository;
  private factRepo: FactRepository;
  private episodeRepo: EpisodeRepository;
  private conceptRepo: ConceptRepository;

  constructor(private db: Database.Database) {
    this.anchorRepo = new AnchorRepository(db);
    this.weightedEdgeRepo = new WeightedEdgeRepository(db);
    this.factRepo = new FactRepository(db);
    this.episodeRepo = new EpisodeRepository(db);
    this.conceptRepo = new ConceptRepository(db);
  }

  /**
   * Traverse the memory graph starting from given anchor IDs.
   * Uses BFS with weight accumulation across hops.
   *
   * The seed weight for each anchor is its current (decay-affected) weight,
   * ensuring that decayed anchors produce lower-scored results through
   * the entire traversal chain:
   *
   *   anchor_currentWeight → edge_weight → next_edge_weight → ...
   *
   * This means stale anchors naturally contribute less to retrieval results
   * even when their edges haven't been individually decayed yet.
   */
  async traverse(input: GraphTraversalInput): Promise<GraphTraversalResult> {
    const start = performance.now();

    const maxDepth = input.maxDepth ?? 2;
    const minWeight = input.minWeight ?? 0.1;
    const maxNodes = input.maxNodes ?? 50;
    const collectTypes = new Set(input.nodeTypes ?? ['fact', 'episode', 'concept']);
    const edgeTypeFilter = input.edgeTypes ? new Set(input.edgeTypes) : null;

    // BFS state
    const visited = new Set<string>();
    const traversedEdges: WeightedEdge[] = [];

    // Collected node IDs with scores (nodeId → { score, depth, sourceAnchorId })
    const factScores = new Map<string, { score: number; depth: number; sourceAnchorId: string }>();
    const episodeScores = new Map<string, { score: number; depth: number; sourceAnchorId: string }>();
    const conceptScores = new Map<string, { score: number; depth: number; sourceAnchorId: string }>();

    let totalCollected = 0;

    // BFS queue: [nodeId, currentDepth, accumulatedWeight, sourceAnchorId]
    type QueueEntry = [string, number, number, string];
    const queue: QueueEntry[] = [];

    // Seed the queue with anchor IDs, using their decay-affected weights
    // instead of a flat 1.0 — this is the key integration point for decay
    for (const anchorId of input.anchorIds) {
      const anchor = this.anchorRepo.getAnchor(anchorId);
      // Use anchor's current (decayed) weight as the seed weight;
      // fallback to 1.0 if anchor not found (shouldn't happen in practice)
      const seedWeight = anchor?.currentWeight ?? 1.0;
      queue.push([anchorId, 0, seedWeight, anchorId]);
      visited.add(anchorId);
    }

    while (queue.length > 0 && totalCollected < maxNodes) {
      const [nodeId, depth, weight, sourceAnchorId] = queue.shift()!;

      if (depth >= maxDepth) continue;

      // Get outgoing edges from this node
      const edges = this.weightedEdgeRepo.getOutgoingEdges(nodeId);

      for (const edge of edges) {
        if (edge.weight < minWeight) continue;
        if (edgeTypeFilter && !edgeTypeFilter.has(edge.edgeType)) continue;

        const targetId = edge.targetId;
        const targetType = edge.targetType;
        const accWeight = weight * edge.weight;

        traversedEdges.push(edge);

        // Check if we've already collected this target with a higher score
        const existingScore = this.getExistingScore(
          targetType as string,
          targetId,
          factScores,
          episodeScores,
          conceptScores,
        );

        if (existingScore !== null && existingScore >= accWeight) {
          continue; // Already found via a better path
        }

        // Collect the target node based on type.
        // DB stores 'hub'/'leaf'; for 'leaf' nodes, resolve entity type by trying each repo.
        // 'hub' nodes are anchors — continue BFS without collecting.
        if (targetType === 'leaf') {
          const resolved = this.resolveLeafType(targetId);
          if (resolved === 'fact' && collectTypes.has('fact')) {
            if (!factScores.has(targetId)) totalCollected++;
            factScores.set(targetId, { score: accWeight, depth: depth + 1, sourceAnchorId });
          } else if (resolved === 'episode' && collectTypes.has('episode')) {
            if (!episodeScores.has(targetId)) totalCollected++;
            episodeScores.set(targetId, { score: accWeight, depth: depth + 1, sourceAnchorId });
          } else if (resolved === 'concept' && collectTypes.has('concept')) {
            if (!conceptScores.has(targetId)) totalCollected++;
            conceptScores.set(targetId, { score: accWeight, depth: depth + 1, sourceAnchorId });
          }
        }
        // 'hub' targets are anchors — enqueue for BFS traversal but don't collect

        // Continue traversal from this node (if not yet visited)
        if (!visited.has(targetId) && depth + 1 < maxDepth) {
          visited.add(targetId);
          queue.push([targetId, depth + 1, accWeight, sourceAnchorId]);
        }
      }
    }

    // Resolve collected IDs to full objects
    const facts = this.resolveFacts(factScores);
    const episodes = this.resolveEpisodes(episodeScores);
    const concepts = this.resolveConcepts(conceptScores);

    const elapsed = performance.now() - start;

    return {
      facts,
      episodes,
      concepts,
      traversedEdges,
      totalNodes: facts.length + episodes.length + concepts.length,
      traversalTimeMs: Math.round(elapsed * 100) / 100,
    };
  }

  // ── Private helpers ──

  private getExistingScore(
    _targetType: string,
    targetId: string,
    factScores: Map<string, { score: number }>,
    episodeScores: Map<string, { score: number }>,
    conceptScores: Map<string, { score: number }>,
  ): number | null {
    // DB stores 'hub'/'leaf'; check all score maps by targetId
    return factScores.get(targetId)?.score
      ?? episodeScores.get(targetId)?.score
      ?? conceptScores.get(targetId)?.score
      ?? null;
  }

  /**
   * Resolve a 'leaf' node's entity type by trying each entity repository.
   * Returns 'fact', 'episode', or 'concept' (or null if not found).
   */
  private resolveLeafType(nodeId: string): 'fact' | 'episode' | 'concept' | null {
    if (this.factRepo.getById(nodeId)) return 'fact';
    if (this.episodeRepo.getEpisode(nodeId)) return 'episode';
    if (this.conceptRepo.getConcept(nodeId)) return 'concept';
    return null;
  }

  private resolveFacts(
    scores: Map<string, { score: number; depth: number; sourceAnchorId: string }>,
  ): ScoredFact[] {
    const results: ScoredFact[] = [];

    for (const [factId, meta] of scores) {
      const fact = this.factRepo.getById(factId);
      if (fact) {
        results.push({
          fact,
          score: meta.score,
          depth: meta.depth,
          sourceAnchorId: meta.sourceAnchorId,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  private resolveEpisodes(
    scores: Map<string, { score: number; depth: number; sourceAnchorId: string }>,
  ): ScoredEpisode[] {
    const results: ScoredEpisode[] = [];

    for (const [episodeId, meta] of scores) {
      const episode = this.episodeRepo.getEpisode(episodeId);
      if (episode) {
        results.push({
          episode,
          score: meta.score,
          depth: meta.depth,
          sourceAnchorId: meta.sourceAnchorId,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  private resolveConcepts(
    scores: Map<string, { score: number; depth: number; sourceAnchorId: string }>,
  ): ScoredConcept[] {
    const results: ScoredConcept[] = [];

    for (const [conceptId, meta] of scores) {
      const concept = this.conceptRepo.getConcept(conceptId);
      if (concept) {
        results.push({
          concept,
          score: meta.score,
          depth: meta.depth,
          sourceAnchorId: meta.sourceAnchorId,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }
}
