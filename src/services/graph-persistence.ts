/**
 * Graph Persistence Layer — bridges edge scoring/decay with graph storage.
 *
 * This service orchestrates the full lifecycle of weighted graph connections:
 *   1. Score node pairs → compute initial weights
 *   2. Persist scored edges → create or update (upsert) in storage
 *   3. Reinforce co-activated edges → Hebbian weight strengthening
 *   4. Apply decay → compute and persist decayed weights
 *   5. Query → retrieve weighted neighbors for graph traversal
 *
 * It operates on both the memory_edges table (basic graph) and the
 * weighted_edges table (Hebbian learning parameters) depending on the use case.
 */

import type Database from 'better-sqlite3';
import { EdgeRepository } from '../db/edge-repo.js';
import { WeightedEdgeRepository } from '../db/weighted-edge-repo.js';
import { EdgeScorer, type MemoryNodeDescriptor, type ScoreBreakdown } from '../scoring/edge-scorer.js';
import { AnchorDecay, type DecayComputeResult, type AnchorDecayConfig, type BatchDecaySummary } from '../scoring/anchor-decay.js';
import type { MemoryEdge, CreateEdgeInput, EdgeType } from '../models/memory-edge.js';
import type { UpsertEdgeInput, WeightMergeStrategy, BulkWeightUpdate } from '../models/anchor.js';
import type {
  WeightedEdge,
  CreateWeightedEdgeInput,
  WeightedEdgeFilter,
  ReinforceResult,
  WeightedNodeType,
  WeightedEdgeType,
} from '../models/weighted-edge.js';

// ─── Types ──────────────────────────────────────────────────

/** Input for persisting a scored connection between two memory nodes */
export interface PersistScoredEdgeInput {
  /** Source node descriptor (for scoring) */
  sourceNode: MemoryNodeDescriptor;
  /** Target node descriptor (for scoring) */
  targetNode: MemoryNodeDescriptor;
  /** Edge type to assign */
  edgeType: EdgeType;
  /** Override merge strategy (default: 'hebbian') */
  mergeStrategy?: WeightMergeStrategy;
  /** Optional metadata to attach */
  metadata?: Record<string, unknown>;
}

/** Result from persisting a scored edge */
export interface PersistScoredResult {
  /** The persisted edge */
  edge: MemoryEdge;
  /** Score breakdown from the edge scorer */
  breakdown: ScoreBreakdown;
  /** Whether the edge was newly created (true) or updated (false) */
  isNew: boolean;
}

/** Input for persisting a weighted (Hebbian) edge */
export interface PersistWeightedInput {
  sourceId: string;
  sourceType: WeightedNodeType;
  targetId: string;
  targetType: WeightedNodeType;
  edgeType: WeightedEdgeType;
  /** Initial weight (computed externally or auto-scored) */
  weight?: number;
  /** Learning rate override */
  learningRate?: number;
  /** Decay rate override */
  decayRate?: number;
  metadata?: Record<string, unknown>;
}

/** Result of a co-activation reinforcement batch */
export interface CoActivationResult {
  /** Edges that were reinforced */
  reinforced: ReinforceResult[];
  /** Total edges in the co-activation set */
  totalEdges: number;
  /** Average new weight after reinforcement */
  averageNewWeight: number;
}

/** Result of applying decay to the graph */
export interface GraphDecayResult {
  /** Weighted edges decay result */
  weightedEdges: {
    decayed: number;
    pruned: number;
  };
  /** Memory edges decay result */
  memoryEdges: {
    decayed: number;
    pruned: number;
  };
  /** Summary of per-edge decay computations */
  summary?: BatchDecaySummary;
}

/** Weighted neighbor info returned from graph queries */
export interface WeightedNeighbor {
  /** Node ID */
  nodeId: string;
  /** Node type */
  nodeType: WeightedNodeType;
  /** Edge weight connecting to this neighbor */
  weight: number;
  /** Edge type */
  edgeType: string;
  /** Edge ID (for reinforcement) */
  edgeId: string;
  /** Activation count on the connecting edge */
  activationCount: number;
}

/** Configuration for the graph persistence layer */
export interface GraphPersistenceConfig {
  /** Minimum score threshold for creating edges (default: 0.1) */
  minScoreThreshold: number;
  /** Default merge strategy for upsert operations */
  defaultMergeStrategy: WeightMergeStrategy;
  /** Weight below which edges are pruned during decay */
  pruneThreshold: number;
  /** Default learning rate for new weighted edges */
  defaultLearningRate: number;
  /** Default decay rate for new weighted edges */
  defaultDecayRate: number;
  /** Decay configuration */
  decayConfig?: Partial<AnchorDecayConfig>;
}

const DEFAULT_CONFIG: GraphPersistenceConfig = {
  minScoreThreshold: 0.1,
  defaultMergeStrategy: 'hebbian',
  pruneThreshold: 0.05,
  defaultLearningRate: 0.1,
  defaultDecayRate: 0.01,
};

// ─── GraphPersistence Service ───────────────────────────────

/**
 * Unified persistence layer for the memory graph.
 *
 * Bridges scoring/decay computation with storage, providing
 * a single API for all graph write and query operations.
 */
export class GraphPersistence {
  readonly config: GraphPersistenceConfig;
  readonly edgeRepo: EdgeRepository;
  readonly weightedEdgeRepo: WeightedEdgeRepository;
  readonly scorer: EdgeScorer;
  readonly decay: AnchorDecay;

  constructor(
    db: Database.Database,
    config?: Partial<GraphPersistenceConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.edgeRepo = new EdgeRepository(db);
    this.weightedEdgeRepo = new WeightedEdgeRepository(db);
    this.scorer = new EdgeScorer({
      minScoreThreshold: this.config.minScoreThreshold,
    });
    this.decay = new AnchorDecay(this.config.decayConfig);
  }

  // ─── Score-and-Persist (Memory Edges) ──────────────────────

  /**
   * Score a pair of memory nodes and persist the connection if it meets threshold.
   *
   * This is the primary entry point for creating graph edges from scored node pairs.
   * The scorer computes a combined relevance weight from temporal proximity,
   * semantic similarity, co-occurrence, and entity overlap signals.
   * If the score meets threshold, the edge is upserted into the memory_edges table.
   *
   * @returns Persist result with edge and breakdown, or null if below threshold
   */
  persistScoredEdge(input: PersistScoredEdgeInput): PersistScoredResult | null {
    const breakdown = this.scorer.score(input.sourceNode, input.targetNode);

    if (!breakdown.meetsThreshold) {
      return null;
    }

    const strategy = input.mergeStrategy ?? this.config.defaultMergeStrategy;

    // Check if edge already exists to determine isNew
    const existing = this.edgeRepo.findEdgeByEndpoints({
      sourceId: input.sourceNode.id,
      targetId: input.targetNode.id,
      edgeType: input.edgeType,
    });

    const edge = this.edgeRepo.upsertEdge(
      {
        sourceId: input.sourceNode.id,
        sourceType: input.sourceNode.type,
        targetId: input.targetNode.id,
        targetType: input.targetNode.type,
        edgeType: input.edgeType,
        weight: breakdown.score,
        metadata: {
          ...input.metadata,
          scoreBreakdown: breakdown.signals,
        },
      },
      strategy,
    );

    return {
      edge,
      breakdown,
      isNew: existing === null,
    };
  }

  /**
   * Score and persist multiple node pairs in a batch.
   * Filters out pairs that don't meet the threshold.
   *
   * @returns Array of successful persist results
   */
  persistScoredEdges(inputs: PersistScoredEdgeInput[]): PersistScoredResult[] {
    const results: PersistScoredResult[] = [];

    for (const input of inputs) {
      const result = this.persistScoredEdge(input);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Score a reference node against multiple candidates and persist the best connections.
   *
   * @param reference - The source node
   * @param candidates - Candidate target nodes
   * @param edgeType - Edge type to assign
   * @param options - Additional options
   * @returns Persisted results sorted by score descending
   */
  persistBestConnections(
    reference: MemoryNodeDescriptor,
    candidates: MemoryNodeDescriptor[],
    edgeType: EdgeType,
    options?: {
      maxEdges?: number;
      mergeStrategy?: WeightMergeStrategy;
      metadata?: Record<string, unknown>;
    },
  ): PersistScoredResult[] {
    const scored = this.scorer.scoreMany(reference, candidates);

    const limit = options?.maxEdges ?? scored.length;
    const results: PersistScoredResult[] = [];

    for (const { node, breakdown } of scored.slice(0, limit)) {
      const existing = this.edgeRepo.findEdgeByEndpoints({
        sourceId: reference.id,
        targetId: node.id,
        edgeType,
      });

      const edge = this.edgeRepo.upsertEdge(
        {
          sourceId: reference.id,
          sourceType: reference.type,
          targetId: node.id,
          targetType: node.type,
          edgeType,
          weight: breakdown.score,
          metadata: {
            ...options?.metadata,
            scoreBreakdown: breakdown.signals,
          },
        },
        options?.mergeStrategy ?? this.config.defaultMergeStrategy,
      );

      results.push({ edge, breakdown, isNew: existing === null });
    }

    return results;
  }

  // ─── Weighted Edge Persistence (Hebbian) ───────────────────

  /**
   * Create or find-and-return a weighted edge.
   * If the edge already exists (same source, target, type), returns existing.
   * Otherwise creates a new one with the given parameters.
   */
  ensureWeightedEdge(input: PersistWeightedInput): WeightedEdge {
    const existing = this.weightedEdgeRepo.findEdge(
      input.sourceId,
      input.targetId,
      input.edgeType,
    );

    if (existing) {
      return existing;
    }

    return this.weightedEdgeRepo.createEdge({
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      targetId: input.targetId,
      targetType: input.targetType,
      edgeType: input.edgeType,
      weight: input.weight ?? 0.5,
      learningRate: input.learningRate ?? this.config.defaultLearningRate,
      decayRate: input.decayRate ?? this.config.defaultDecayRate,
      metadata: input.metadata,
    });
  }

  /**
   * Create or update a weighted edge. If existing, reinforce its weight.
   *
   * This is the primary upsert for weighted edges with Hebbian learning.
   * On update, the edge weight is reinforced using the Hebbian rule.
   */
  upsertWeightedEdge(input: PersistWeightedInput): {
    edge: WeightedEdge;
    isNew: boolean;
    reinforcement?: ReinforceResult;
  } {
    const existing = this.weightedEdgeRepo.findEdge(
      input.sourceId,
      input.targetId,
      input.edgeType,
    );

    if (!existing) {
      const edge = this.weightedEdgeRepo.createEdge({
        sourceId: input.sourceId,
        sourceType: input.sourceType,
        targetId: input.targetId,
        targetType: input.targetType,
        edgeType: input.edgeType,
        weight: input.weight ?? 0.5,
        learningRate: input.learningRate ?? this.config.defaultLearningRate,
        decayRate: input.decayRate ?? this.config.defaultDecayRate,
        metadata: input.metadata,
      });

      return { edge, isNew: true };
    }

    // Reinforce existing edge
    const reinforcement = this.weightedEdgeRepo.reinforceEdge(
      existing.id,
      input.learningRate,
    );

    // Re-fetch the updated edge
    const updated = this.weightedEdgeRepo.getEdge(existing.id)!;

    return {
      edge: updated,
      isNew: false,
      reinforcement: reinforcement ?? undefined,
    };
  }

  /**
   * Batch upsert weighted edges.
   */
  upsertWeightedEdges(inputs: PersistWeightedInput[]): Array<{
    edge: WeightedEdge;
    isNew: boolean;
    reinforcement?: ReinforceResult;
  }> {
    return inputs.map(input => this.upsertWeightedEdge(input));
  }

  // ─── Co-Activation Reinforcement ──────────────────────────

  /**
   * Reinforce all edges in a co-activation set.
   *
   * When multiple edges are retrieved together in a single query,
   * they should be reinforced to strengthen their Hebbian association.
   *
   * @param edgeIds - IDs of weighted edges that were co-activated
   * @param learningRate - Optional override learning rate
   * @returns Co-activation result with reinforcement details
   */
  reinforceCoActivation(
    edgeIds: string[],
    learningRate?: number,
  ): CoActivationResult {
    if (edgeIds.length === 0) {
      return { reinforced: [], totalEdges: 0, averageNewWeight: 0 };
    }

    const results = this.weightedEdgeRepo.batchReinforce({
      edgeIds,
      learningRate,
    });

    const avgWeight = results.length > 0
      ? results.reduce((sum, r) => sum + r.newWeight, 0) / results.length
      : 0;

    return {
      reinforced: results,
      totalEdges: edgeIds.length,
      averageNewWeight: Math.round(avgWeight * 10000) / 10000,
    };
  }

  /**
   * Reinforce edges connected to a specific node.
   * Useful after a node is retrieved/activated during a query.
   *
   * @param nodeId - The activated node's ID
   * @param learningRate - Optional override learning rate
   * @returns Reinforcement results for all connected edges
   */
  reinforceNodeEdges(
    nodeId: string,
    learningRate?: number,
  ): CoActivationResult {
    const edges = this.weightedEdgeRepo.getConnectedEdges(nodeId);
    const edgeIds = edges.map(e => e.id);
    return this.reinforceCoActivation(edgeIds, learningRate);
  }

  // ─── Decay Application ────────────────────────────────────

  /**
   * Apply computed decay to all weighted edges.
   *
   * This is a two-step process:
   * 1. Read all weighted edges
   * 2. Compute individual decay for each edge (considering activation count)
   * 3. Batch update the weights
   * 4. Optionally prune edges below threshold
   *
   * Uses the advanced AnchorDecay computation (time + usage decay)
   * for weighted edges, and simple multiplicative decay for memory edges.
   *
   * @returns GraphDecayResult with details of what was decayed/pruned
   */
  applyGraphDecay(options?: {
    /** Apply to weighted_edges table (default: true) */
    weightedEdges?: boolean;
    /** Apply to memory_edges table (default: true) */
    memoryEdges?: boolean;
    /** Multiplicative decay factor for memory_edges (default: 0.95) */
    memoryDecayFactor?: number;
    /** Prune threshold override */
    pruneThreshold?: number;
  }): GraphDecayResult {
    const pruneThreshold = options?.pruneThreshold ?? this.config.pruneThreshold;
    const result: GraphDecayResult = {
      weightedEdges: { decayed: 0, pruned: 0 },
      memoryEdges: { decayed: 0, pruned: 0 },
    };

    // ── Weighted edges: advanced per-edge decay ──
    if (options?.weightedEdges !== false) {
      const allEdges = this.weightedEdgeRepo.queryEdges({});
      if (allEdges.length > 0) {
        const decayInputs = allEdges.map(e => ({
          weight: e.weight,
          lastActivatedAt: e.lastActivatedAt ?? e.createdAt,
          activationCount: e.activationCount,
          edgeDecayRate: e.decayRate,
        }));

        const { results: decayResults, summary } = this.decay.computeBatchDecay(decayInputs);
        result.summary = summary;

        // Build bulk updates
        const updates: BulkWeightUpdate[] = [];
        const toDelete: string[] = [];

        for (let i = 0; i < allEdges.length; i++) {
          const decayResult = decayResults[i];
          if (decayResult.shouldPrune) {
            toDelete.push(allEdges[i].id);
          } else if (decayResult.weightDelta > 0) {
            updates.push({
              edgeId: allEdges[i].id,
              newWeight: decayResult.newWeight,
            });
          }
        }

        // Apply updates
        if (updates.length > 0) {
          // Use weighted edge repo's updateWeight for each
          for (const update of updates) {
            this.weightedEdgeRepo.updateWeight(update.edgeId, update.newWeight);
          }
          result.weightedEdges.decayed = updates.length;
        }

        // Prune
        for (const id of toDelete) {
          this.weightedEdgeRepo.deleteEdge(id);
        }
        result.weightedEdges.pruned = toDelete.length;
      }
    }

    // ── Memory edges: simple multiplicative decay ──
    if (options?.memoryEdges !== false) {
      const factor = options?.memoryDecayFactor ?? 0.95;
      const decayResult = this.edgeRepo.decayWeights({
        factor,
        pruneBelow: pruneThreshold,
      });
      result.memoryEdges.decayed = decayResult.decayedCount;
      result.memoryEdges.pruned = decayResult.prunedCount;
    }

    return result;
  }

  // ─── Query Operations ─────────────────────────────────────

  /**
   * Get weighted neighbors of a node from the weighted_edges table.
   * Returns neighbors sorted by edge weight descending.
   *
   * @param nodeId - The node to query neighbors for
   * @param options - Filter options
   * @returns Weighted neighbor list
   */
  getWeightedNeighbors(
    nodeId: string,
    options?: {
      minWeight?: number;
      edgeTypes?: WeightedEdgeType[];
      limit?: number;
    },
  ): WeightedNeighbor[] {
    const edges = this.weightedEdgeRepo.queryEdges({
      sourceId: nodeId,
      edgeTypes: options?.edgeTypes,
      minWeight: options?.minWeight,
      limit: options?.limit,
      orderBy: 'weight_desc',
    });

    // Also get incoming edges
    const incoming = this.weightedEdgeRepo.getIncomingEdges(nodeId);

    // Merge and deduplicate
    const allEdges = [...edges, ...incoming];
    const seen = new Set<string>();
    const neighbors: WeightedNeighbor[] = [];

    for (const edge of allEdges) {
      // Apply filters to incoming edges too
      if (options?.minWeight !== undefined && edge.weight < options.minWeight) continue;
      if (options?.edgeTypes?.length && !options.edgeTypes.includes(edge.edgeType as WeightedEdgeType)) continue;

      const neighborId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
      const neighborType = edge.sourceId === nodeId ? edge.targetType : edge.sourceType;

      if (seen.has(neighborId)) continue;
      seen.add(neighborId);

      neighbors.push({
        nodeId: neighborId,
        nodeType: neighborType as WeightedNodeType,
        weight: edge.weight,
        edgeType: edge.edgeType,
        edgeId: edge.id,
        activationCount: edge.activationCount,
      });
    }

    // Sort by weight descending
    neighbors.sort((a, b) => b.weight - a.weight);

    // Apply limit
    if (options?.limit) {
      return neighbors.slice(0, options.limit);
    }

    return neighbors;
  }

  /**
   * Get memory edge neighbors of a node from the memory_edges table.
   * Returns neighbor IDs sorted by edge weight.
   */
  getMemoryNeighbors(
    nodeId: string,
    options?: {
      edgeTypes?: EdgeType[];
      minWeight?: number;
    },
  ): string[] {
    return this.edgeRepo.getNeighborIds(nodeId, options);
  }

  /**
   * Get all edge weights for a specific node pair across both tables.
   * Useful for diagnostics and understanding the full relationship.
   */
  getRelationship(sourceId: string, targetId: string): {
    memoryEdges: MemoryEdge[];
    weightedEdges: WeightedEdge[];
  } {
    const memoryEdges: MemoryEdge[] = [];
    const weightedEdges: WeightedEdge[] = [];

    // Check memory_edges in both directions
    const outgoing = this.edgeRepo.getOutgoingEdges(sourceId);
    for (const edge of outgoing) {
      if (edge.targetId === targetId) memoryEdges.push(edge);
    }
    const incoming = this.edgeRepo.getIncomingEdges(sourceId);
    for (const edge of incoming) {
      if (edge.sourceId === targetId) memoryEdges.push(edge);
    }

    // Check weighted_edges in both directions
    const wOutgoing = this.weightedEdgeRepo.getOutgoingEdges(sourceId);
    for (const edge of wOutgoing) {
      if (edge.targetId === targetId) weightedEdges.push(edge);
    }
    const wIncoming = this.weightedEdgeRepo.getIncomingEdges(sourceId);
    for (const edge of wIncoming) {
      if (edge.sourceId === targetId) weightedEdges.push(edge);
    }

    return { memoryEdges, weightedEdges };
  }

  /**
   * Get the strongest connections for a node, combining both tables.
   * Returns edges from both memory_edges and weighted_edges, unified into
   * a common format and sorted by weight.
   *
   * @param nodeId - Node to query
   * @param limit - Max results
   * @returns Weighted neighbors from both tables, deduplicated
   */
  getStrongestConnections(
    nodeId: string,
    limit: number = 20,
  ): WeightedNeighbor[] {
    const neighbors = new Map<string, WeightedNeighbor>();

    // Weighted edges (richer data)
    const weightedEdges = this.weightedEdgeRepo.getConnectedEdges(nodeId);
    for (const edge of weightedEdges) {
      const neighborId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
      const neighborType = edge.sourceId === nodeId ? edge.targetType : edge.sourceType;

      const existing = neighbors.get(neighborId);
      if (!existing || edge.weight > existing.weight) {
        neighbors.set(neighborId, {
          nodeId: neighborId,
          nodeType: neighborType as WeightedNodeType,
          weight: edge.weight,
          edgeType: edge.edgeType,
          edgeId: edge.id,
          activationCount: edge.activationCount,
        });
      }
    }

    // Memory edges (supplement with basic connections)
    const memoryEdges = this.edgeRepo.getConnectedEdges(nodeId);
    for (const edge of memoryEdges) {
      const neighborId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
      const neighborType = edge.sourceId === nodeId ? edge.targetType : edge.sourceType;

      if (!neighbors.has(neighborId)) {
        neighbors.set(neighborId, {
          nodeId: neighborId,
          nodeType: neighborType as WeightedNodeType,
          weight: edge.weight,
          edgeType: edge.edgeType,
          edgeId: edge.id,
          activationCount: 0,
        });
      }
    }

    // Sort by weight and limit
    return Array.from(neighbors.values())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
  }

  // ─── Maintenance ──────────────────────────────────────────

  /**
   * Delete all edges (both tables) connected to a node.
   * Used when a memory node is removed.
   *
   * @returns Total edges deleted across both tables
   */
  deleteNodeEdges(nodeId: string): number {
    const memoryDeleted = this.edgeRepo.deleteEdgesByNode(nodeId);

    const weightedEdges = this.weightedEdgeRepo.getConnectedEdges(nodeId);
    let weightedDeleted = 0;
    for (const edge of weightedEdges) {
      if (this.weightedEdgeRepo.deleteEdge(edge.id)) weightedDeleted++;
    }

    return memoryDeleted + weightedDeleted;
  }

  /**
   * Get graph statistics for diagnostics.
   */
  getStats(): {
    memoryEdgeCount: number;
    weightedEdgeCount: number;
    averageMemoryWeight: number;
    averageWeightedWeight: number;
  } {
    const memoryCount = this.edgeRepo.countEdges();
    const weightedCount = this.weightedEdgeRepo.countEdges();

    // Compute averages
    const memoryEdges = this.edgeRepo.queryEdges({});
    const weightedEdges = this.weightedEdgeRepo.queryEdges({});

    const avgMemory = memoryEdges.length > 0
      ? memoryEdges.reduce((s, e) => s + e.weight, 0) / memoryEdges.length
      : 0;
    const avgWeighted = weightedEdges.length > 0
      ? weightedEdges.reduce((s, e) => s + e.weight, 0) / weightedEdges.length
      : 0;

    return {
      memoryEdgeCount: memoryCount,
      weightedEdgeCount: weightedCount,
      averageMemoryWeight: Math.round(avgMemory * 10000) / 10000,
      averageWeightedWeight: Math.round(avgWeighted * 10000) / 10000,
    };
  }
}
