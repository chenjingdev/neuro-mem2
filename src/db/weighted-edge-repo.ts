/**
 * Repository for WeightedEdge storage — retrieval graph edges
 * with Hebbian learning parameters.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  WeightedEdge,
  WeightedEdgeRef,
  CreateWeightedEdgeInput,
  ReinforceResult,
  WeightedEdgeFilter,
  BatchCoActivationInput,
} from '../models/weighted-edge.js';

export class WeightedEdgeRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a single weighted edge.
   */
  createEdge(input: CreateWeightedEdgeInput): WeightedEdge {
    const now = new Date().toISOString();
    const id = uuidv4();
    const weight = input.weight ?? 0.5;

    const edge: WeightedEdge = {
      id,
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      targetId: input.targetId,
      targetType: input.targetType,
      edgeType: input.edgeType,
      weight,
      initialWeight: weight,
      learningRate: input.learningRate ?? 0.1,
      decayRate: input.decayRate ?? 0.01,
      activationCount: 0,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };

    this.db.prepare(`
      INSERT INTO weighted_edges (id, source_id, source_type, target_id, target_type,
        edge_type, weight, initial_weight, learning_rate, decay_rate,
        activation_count, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      edge.id,
      edge.sourceId,
      edge.sourceType,
      edge.targetId,
      edge.targetType,
      edge.edgeType,
      edge.weight,
      edge.initialWeight,
      edge.learningRate,
      edge.decayRate,
      edge.activationCount,
      edge.createdAt,
      edge.updatedAt,
      edge.metadata ? JSON.stringify(edge.metadata) : null,
    );

    return edge;
  }

  /**
   * Save a batch of weighted edges (transactional).
   */
  saveEdges(inputs: CreateWeightedEdgeInput[]): WeightedEdge[] {
    if (inputs.length === 0) return [];

    const edges: WeightedEdge[] = [];
    const now = new Date().toISOString();

    const insert = this.db.prepare(`
      INSERT INTO weighted_edges (id, source_id, source_type, target_id, target_type,
        edge_type, weight, initial_weight, learning_rate, decay_rate,
        activation_count, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      for (const input of inputs) {
        const id = uuidv4();
        const weight = input.weight ?? 0.5;

        const edge: WeightedEdge = {
          id,
          sourceId: input.sourceId,
          sourceType: input.sourceType,
          targetId: input.targetId,
          targetType: input.targetType,
          edgeType: input.edgeType,
          weight,
          initialWeight: weight,
          learningRate: input.learningRate ?? 0.1,
          decayRate: input.decayRate ?? 0.01,
          activationCount: 0,
          createdAt: now,
          updatedAt: now,
          metadata: input.metadata,
        };

        insert.run(
          edge.id, edge.sourceId, edge.sourceType,
          edge.targetId, edge.targetType, edge.edgeType,
          edge.weight, edge.initialWeight, edge.learningRate,
          edge.decayRate, edge.activationCount,
          edge.createdAt, edge.updatedAt,
          edge.metadata ? JSON.stringify(edge.metadata) : null,
        );

        edges.push(edge);
      }
    });

    txn();
    return edges;
  }

  /**
   * Get a weighted edge by ID.
   */
  getEdge(edgeId: string): WeightedEdge | null {
    const row = this.db.prepare(`
      SELECT * FROM weighted_edges WHERE id = ?
    `).get(edgeId) as WeightedEdgeRow | undefined;

    if (!row) return null;
    return this.rowToEdge(row);
  }

  /**
   * Find an edge by its endpoint pair and type.
   */
  findEdge(sourceId: string, targetId: string, edgeType: string): WeightedEdge | null {
    const row = this.db.prepare(`
      SELECT * FROM weighted_edges
      WHERE source_id = ? AND target_id = ? AND edge_type = ?
    `).get(sourceId, targetId, edgeType) as WeightedEdgeRow | undefined;

    if (!row) return null;
    return this.rowToEdge(row);
  }

  /**
   * Get all outgoing edges from a node, ordered by weight.
   */
  getOutgoingEdges(sourceId: string): WeightedEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM weighted_edges WHERE source_id = ?
      ORDER BY weight DESC
    `).all(sourceId) as WeightedEdgeRow[];

    return rows.map(r => this.rowToEdge(r));
  }

  /**
   * Get all incoming edges to a node, ordered by weight.
   */
  getIncomingEdges(targetId: string): WeightedEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM weighted_edges WHERE target_id = ?
      ORDER BY weight DESC
    `).all(targetId) as WeightedEdgeRow[];

    return rows.map(r => this.rowToEdge(r));
  }

  /**
   * Get all edges connected to a node (both directions), ordered by weight.
   */
  getConnectedEdges(nodeId: string): WeightedEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM weighted_edges
      WHERE source_id = ? OR target_id = ?
      ORDER BY weight DESC
    `).all(nodeId, nodeId) as WeightedEdgeRow[];

    return rows.map(r => this.rowToEdge(r));
  }

  /**
   * Query edges with filters.
   */
  queryEdges(filter: WeightedEdgeFilter): WeightedEdge[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.sourceId) {
      conditions.push('source_id = ?');
      params.push(filter.sourceId);
    }
    if (filter.sourceType) {
      conditions.push('source_type = ?');
      params.push(filter.sourceType);
    }
    if (filter.targetType) {
      conditions.push('target_type = ?');
      params.push(filter.targetType);
    }
    if (filter.edgeTypes && filter.edgeTypes.length > 0) {
      const placeholders = filter.edgeTypes.map(() => '?').join(', ');
      conditions.push(`edge_type IN (${placeholders})`);
      params.push(...filter.edgeTypes);
    }
    if (filter.minWeight !== undefined) {
      conditions.push('weight >= ?');
      params.push(filter.minWeight);
    }
    if (filter.maxWeight !== undefined) {
      conditions.push('weight <= ?');
      params.push(filter.maxWeight);
    }
    if (filter.minActivationCount !== undefined) {
      conditions.push('activation_count >= ?');
      params.push(filter.minActivationCount);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    let orderClause: string;
    switch (filter.orderBy) {
      case 'weight_asc': orderClause = 'ORDER BY weight ASC'; break;
      case 'activation_desc': orderClause = 'ORDER BY activation_count DESC'; break;
      case 'recent_first': orderClause = 'ORDER BY last_activated_at DESC NULLS LAST'; break;
      default: orderClause = 'ORDER BY weight DESC';
    }

    const limitClause = filter.limit ? `LIMIT ${filter.limit}` : '';

    const sql = `SELECT * FROM weighted_edges ${whereClause} ${orderClause} ${limitClause}`;
    const rows = this.db.prepare(sql).all(...params) as WeightedEdgeRow[];
    return rows.map(r => this.rowToEdge(r));
  }

  /**
   * Apply Hebbian reinforcement to an edge.
   *
   * Formula: w_new = w_old + learningRate * (1 - w_old)
   * This ensures weight approaches 1.0 asymptotically.
   */
  reinforceEdge(edgeId: string, overrideLearningRate?: number): ReinforceResult | null {
    const edge = this.getEdge(edgeId);
    if (!edge) return null;

    const lr = overrideLearningRate ?? edge.learningRate;
    const newWeight = Math.min(1.0, edge.weight + lr * (1 - edge.weight));
    const now = new Date().toISOString();
    const newActivationCount = edge.activationCount + 1;

    this.db.prepare(`
      UPDATE weighted_edges SET
        weight = ?, activation_count = ?,
        last_activated_at = ?, updated_at = ?
      WHERE id = ?
    `).run(newWeight, newActivationCount, now, now, edgeId);

    return {
      edgeId,
      previousWeight: edge.weight,
      newWeight,
      activationCount: newActivationCount,
    };
  }

  /**
   * Reinforce multiple edges in a single transaction (batch co-activation).
   */
  batchReinforce(input: BatchCoActivationInput): ReinforceResult[] {
    const results: ReinforceResult[] = [];

    const txn = this.db.transaction(() => {
      for (const edgeId of input.edgeIds) {
        const result = this.reinforceEdge(edgeId, input.learningRate);
        if (result) results.push(result);
      }
    });

    txn();
    return results;
  }

  /**
   * Apply time-based decay to all edges.
   * Formula: w_new = w_old * (1 - decayRate)
   * Returns the count of edges that were decayed.
   */
  applyDecay(options?: { pruneBelow?: number }): { decayedCount: number; prunedCount: number } {
    const now = new Date().toISOString();

    // Apply decay: w_new = w * (1 - decay_rate)
    const decayResult = this.db.prepare(`
      UPDATE weighted_edges SET
        weight = MAX(0.0, weight * (1.0 - decay_rate)),
        updated_at = ?
      WHERE decay_rate > 0
    `).run(now);

    let prunedCount = 0;
    if (options?.pruneBelow !== undefined && options.pruneBelow > 0) {
      const pruneResult = this.db.prepare(`
        DELETE FROM weighted_edges WHERE weight < ?
      `).run(options.pruneBelow);
      prunedCount = pruneResult.changes;
    }

    return {
      decayedCount: decayResult.changes,
      prunedCount,
    };
  }

  /**
   * Update the raw weight of an edge (clamped to [0, 1]).
   */
  updateWeight(edgeId: string, newWeight: number): void {
    const clamped = Math.max(0, Math.min(1, newWeight));
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE weighted_edges SET weight = ?, updated_at = ? WHERE id = ?
    `).run(clamped, now, edgeId);
  }

  /**
   * Delete a weighted edge by ID.
   */
  deleteEdge(edgeId: string): boolean {
    const result = this.db.prepare('DELETE FROM weighted_edges WHERE id = ?').run(edgeId);
    return result.changes > 0;
  }

  /**
   * Count all weighted edges.
   */
  countEdges(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM weighted_edges').get() as { cnt: number };
    return row.cnt;
  }

  // ── Private helpers ──

  private rowToEdge(r: WeightedEdgeRow): WeightedEdge {
    return {
      id: r.id,
      sourceId: r.source_id,
      sourceType: r.source_type as WeightedEdge['sourceType'],
      targetId: r.target_id,
      targetType: r.target_type as WeightedEdge['targetType'],
      edgeType: r.edge_type as WeightedEdge['edgeType'],
      weight: r.weight,
      initialWeight: r.initial_weight,
      learningRate: r.learning_rate,
      decayRate: r.decay_rate,
      activationCount: r.activation_count,
      lastActivatedAt: r.last_activated_at ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    };
  }
}

interface WeightedEdgeRow {
  id: string;
  source_id: string;
  source_type: string;
  target_id: string;
  target_type: string;
  edge_type: string;
  weight: number;
  initial_weight: number;
  learning_rate: number;
  decay_rate: number;
  activation_count: number;
  last_activated_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: string | null;
}
