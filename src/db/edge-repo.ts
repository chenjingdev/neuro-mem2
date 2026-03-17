/**
 * Repository for Memory Edge storage (graph relationships).
 * Edges connect episodes, concepts, and facts with Hebbian-style weights.
 *
 * Includes Anchor CRUD operations for creating, updating, decaying,
 * and pruning edges based on computed Hebbian weights.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { MemoryEdge, CreateEdgeInput, EdgeType } from '../models/memory-edge.js';
import type {
  UpsertEdgeInput,
  WeightMergeStrategy,
  DecayOptions,
  DecayResult,
  EdgeEndpoints,
  BulkWeightUpdate,
  EdgeQueryFilter,
} from '../models/anchor.js';

export class EdgeRepository {
  constructor(private db: Database.Database) {}

  // ─── Basic CRUD ──────────────────────────────────────────────────

  /**
   * Create a single edge between two memory nodes.
   */
  createEdge(input: CreateEdgeInput): MemoryEdge {
    const now = new Date().toISOString();
    const id = uuidv4();

    const edge: MemoryEdge = {
      id,
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      targetId: input.targetId,
      targetType: input.targetType,
      edgeType: input.edgeType,
      weight: input.weight ?? 0.5,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };

    this.db.prepare(`
      INSERT INTO memory_edges (id, source_id, source_type, target_id, target_type,
        edge_type, weight, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      edge.id,
      edge.sourceId,
      edge.sourceType,
      edge.targetId,
      edge.targetType,
      edge.edgeType,
      edge.weight,
      edge.createdAt,
      edge.updatedAt,
      edge.metadata ? JSON.stringify(edge.metadata) : null
    );

    return edge;
  }

  /**
   * Save a batch of edges (transactional).
   */
  saveEdges(inputs: CreateEdgeInput[]): MemoryEdge[] {
    if (inputs.length === 0) return [];

    const edges: MemoryEdge[] = [];
    const now = new Date().toISOString();

    const insert = this.db.prepare(`
      INSERT INTO memory_edges (id, source_id, source_type, target_id, target_type,
        edge_type, weight, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      for (const input of inputs) {
        const id = uuidv4();
        const edge: MemoryEdge = {
          id,
          sourceId: input.sourceId,
          sourceType: input.sourceType,
          targetId: input.targetId,
          targetType: input.targetType,
          edgeType: input.edgeType,
          weight: input.weight ?? 0.5,
          createdAt: now,
          updatedAt: now,
          metadata: input.metadata,
        };

        insert.run(
          edge.id,
          edge.sourceId,
          edge.sourceType,
          edge.targetId,
          edge.targetType,
          edge.edgeType,
          edge.weight,
          edge.createdAt,
          edge.updatedAt,
          edge.metadata ? JSON.stringify(edge.metadata) : null
        );

        edges.push(edge);
      }
    });

    txn();
    return edges;
  }

  /**
   * Get an edge by ID.
   */
  getEdge(edgeId: string): MemoryEdge | null {
    const row = this.db.prepare(`
      SELECT id, source_id, source_type, target_id, target_type,
        edge_type, weight, created_at, updated_at, metadata
      FROM memory_edges WHERE id = ?
    `).get(edgeId) as EdgeRow | undefined;

    if (!row) return null;
    return this.rowToEdge(row);
  }

  /**
   * Get all outgoing edges from a node.
   */
  getOutgoingEdges(sourceId: string): MemoryEdge[] {
    const rows = this.db.prepare(`
      SELECT id, source_id, source_type, target_id, target_type,
        edge_type, weight, created_at, updated_at, metadata
      FROM memory_edges WHERE source_id = ?
      ORDER BY weight DESC
    `).all(sourceId) as EdgeRow[];

    return rows.map(r => this.rowToEdge(r));
  }

  /**
   * Get all incoming edges to a node.
   */
  getIncomingEdges(targetId: string): MemoryEdge[] {
    const rows = this.db.prepare(`
      SELECT id, source_id, source_type, target_id, target_type,
        edge_type, weight, created_at, updated_at, metadata
      FROM memory_edges WHERE target_id = ?
      ORDER BY weight DESC
    `).all(targetId) as EdgeRow[];

    return rows.map(r => this.rowToEdge(r));
  }

  /**
   * Get all edges connected to a node (both directions).
   */
  getConnectedEdges(nodeId: string): MemoryEdge[] {
    const rows = this.db.prepare(`
      SELECT id, source_id, source_type, target_id, target_type,
        edge_type, weight, created_at, updated_at, metadata
      FROM memory_edges WHERE source_id = ? OR target_id = ?
      ORDER BY weight DESC
    `).all(nodeId, nodeId) as EdgeRow[];

    return rows.map(r => this.rowToEdge(r));
  }

  /**
   * Get edges by type.
   */
  getEdgesByType(edgeType: string): MemoryEdge[] {
    const rows = this.db.prepare(`
      SELECT id, source_id, source_type, target_id, target_type,
        edge_type, weight, created_at, updated_at, metadata
      FROM memory_edges WHERE edge_type = ?
      ORDER BY weight DESC
    `).all(edgeType) as EdgeRow[];

    return rows.map(r => this.rowToEdge(r));
  }

  /**
   * Update the Hebbian weight of an edge.
   * Weight is clamped to [0, 1].
   */
  updateWeight(edgeId: string, newWeight: number): void {
    const clamped = Math.max(0, Math.min(1, newWeight));
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE memory_edges SET weight = ?, updated_at = ? WHERE id = ?
    `).run(clamped, now, edgeId);
  }

  /**
   * Strengthen an edge weight by a delta (Hebbian reinforcement).
   * Uses: new_weight = old_weight + delta * (1 - old_weight) to approach 1 asymptotically.
   */
  reinforceEdge(edgeId: string, delta: number = 0.1): MemoryEdge | null {
    const edge = this.getEdge(edgeId);
    if (!edge) return null;

    const newWeight = edge.weight + delta * (1 - edge.weight);
    this.updateWeight(edgeId, newWeight);

    return { ...edge, weight: Math.max(0, Math.min(1, newWeight)), updatedAt: new Date().toISOString() };
  }

  /**
   * Count all edges.
   */
  countEdges(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memory_edges').get() as { cnt: number };
    return row.cnt;
  }

  // ─── Anchor CRUD Operations ──────────────────────────────────────

  /**
   * Find an edge by its endpoint pair and type.
   * Uses the UNIQUE(source_id, target_id, edge_type) constraint.
   */
  findEdgeByEndpoints(endpoints: EdgeEndpoints): MemoryEdge | null {
    const row = this.db.prepare(`
      SELECT id, source_id, source_type, target_id, target_type,
        edge_type, weight, created_at, updated_at, metadata
      FROM memory_edges
      WHERE source_id = ? AND target_id = ? AND edge_type = ?
    `).get(endpoints.sourceId, endpoints.targetId, endpoints.edgeType) as EdgeRow | undefined;

    if (!row) return null;
    return this.rowToEdge(row);
  }

  /**
   * Upsert an edge: create if not exists, update weight if exists.
   * This is the primary anchor operation — ensures edges are created or
   * reinforced based on computed Hebbian weights.
   *
   * @param input - Edge data with weight
   * @param strategy - How to merge weights when edge already exists (default: 'hebbian')
   * @returns The created or updated edge
   */
  upsertEdge(input: UpsertEdgeInput, strategy: WeightMergeStrategy = 'hebbian'): MemoryEdge {
    const existing = this.findEdgeByEndpoints({
      sourceId: input.sourceId,
      targetId: input.targetId,
      edgeType: input.edgeType,
    });

    if (!existing) {
      // Create new edge
      return this.createEdge({
        sourceId: input.sourceId,
        sourceType: input.sourceType,
        targetId: input.targetId,
        targetType: input.targetType,
        edgeType: input.edgeType,
        weight: Math.max(0, Math.min(1, input.weight)),
        metadata: input.metadata,
      });
    }

    // Merge weight according to strategy
    const mergedWeight = this.mergeWeight(existing.weight, input.weight, strategy);
    const clamped = Math.max(0, Math.min(1, mergedWeight));
    const now = new Date().toISOString();

    // Merge metadata if both exist
    const mergedMetadata = input.metadata
      ? { ...(existing.metadata ?? {}), ...input.metadata }
      : existing.metadata;

    this.db.prepare(`
      UPDATE memory_edges SET weight = ?, updated_at = ?, metadata = ? WHERE id = ?
    `).run(
      clamped,
      now,
      mergedMetadata ? JSON.stringify(mergedMetadata) : null,
      existing.id
    );

    return {
      ...existing,
      weight: clamped,
      updatedAt: now,
      metadata: mergedMetadata,
    };
  }

  /**
   * Batch upsert edges (transactional).
   * Creates new edges or updates existing ones based on the merge strategy.
   */
  upsertEdges(inputs: UpsertEdgeInput[], strategy: WeightMergeStrategy = 'hebbian'): MemoryEdge[] {
    if (inputs.length === 0) return [];

    const results: MemoryEdge[] = [];

    const txn = this.db.transaction(() => {
      for (const input of inputs) {
        results.push(this.upsertEdge(input, strategy));
      }
    });

    txn();
    return results;
  }

  /**
   * Delete a single edge by ID.
   * @returns true if the edge was deleted, false if not found
   */
  deleteEdge(edgeId: string): boolean {
    const result = this.db.prepare('DELETE FROM memory_edges WHERE id = ?').run(edgeId);
    return result.changes > 0;
  }

  /**
   * Delete an edge by its endpoint pair and type.
   * @returns true if the edge was deleted, false if not found
   */
  deleteEdgeByEndpoints(endpoints: EdgeEndpoints): boolean {
    const result = this.db.prepare(`
      DELETE FROM memory_edges
      WHERE source_id = ? AND target_id = ? AND edge_type = ?
    `).run(endpoints.sourceId, endpoints.targetId, endpoints.edgeType);
    return result.changes > 0;
  }

  /**
   * Delete all edges connected to a node (both directions).
   * Used when a memory node is removed.
   * @returns number of edges deleted
   */
  deleteEdgesByNode(nodeId: string): number {
    const result = this.db.prepare(`
      DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?
    `).run(nodeId, nodeId);
    return result.changes;
  }

  /**
   * Delete all edges below a weight threshold (pruning weak connections).
   * @returns number of edges pruned
   */
  pruneEdgesBelowWeight(threshold: number, edgeTypes?: EdgeType[]): number {
    if (edgeTypes && edgeTypes.length > 0) {
      const placeholders = edgeTypes.map(() => '?').join(', ');
      const result = this.db.prepare(`
        DELETE FROM memory_edges
        WHERE weight < ? AND edge_type IN (${placeholders})
      `).run(threshold, ...edgeTypes);
      return result.changes;
    }

    const result = this.db.prepare(`
      DELETE FROM memory_edges WHERE weight < ?
    `).run(threshold);
    return result.changes;
  }

  /**
   * Apply time-based decay to edge weights (Hebbian forgetting).
   * Decays weights multiplicatively: new_weight = old_weight * factor.
   * Optionally prunes edges that fall below a threshold after decay.
   */
  decayWeights(options: DecayOptions): DecayResult {
    const { factor, maxWeight, edgeTypes, pruneBelow } = options;
    const now = new Date().toISOString();

    let decayedCount = 0;
    let prunedCount = 0;

    const txn = this.db.transaction(() => {
      // Build the WHERE clause for decay
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (maxWeight !== undefined) {
        conditions.push('weight <= ?');
        params.push(maxWeight);
      }

      if (edgeTypes && edgeTypes.length > 0) {
        const placeholders = edgeTypes.map(() => '?').join(', ');
        conditions.push(`edge_type IN (${placeholders})`);
        params.push(...edgeTypes);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Apply decay
      const updateResult = this.db.prepare(`
        UPDATE memory_edges
        SET weight = MAX(0.0, weight * ?), updated_at = ?
        ${whereClause}
      `).run(factor, now, ...params);

      decayedCount = updateResult.changes;

      // Prune if threshold specified
      if (pruneBelow !== undefined) {
        const pruneConditions = [...conditions];
        const pruneParams: (string | number)[] = [...params];

        // Add weight condition (note: weights have already been decayed)
        pruneConditions.push('weight < ?');
        pruneParams.push(pruneBelow);

        const pruneWhere = `WHERE ${pruneConditions.join(' AND ')}`;
        const pruneResult = this.db.prepare(`
          DELETE FROM memory_edges ${pruneWhere}
        `).run(...pruneParams);

        prunedCount = pruneResult.changes;
      }
    });

    txn();
    return { decayedCount, prunedCount };
  }

  /**
   * Bulk update weights for multiple edges (transactional).
   * Useful for batch anchor recalculation.
   */
  bulkUpdateWeights(updates: BulkWeightUpdate[]): number {
    if (updates.length === 0) return 0;

    let updatedCount = 0;
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      UPDATE memory_edges SET weight = ?, updated_at = ? WHERE id = ?
    `);

    const txn = this.db.transaction(() => {
      for (const { edgeId, newWeight } of updates) {
        const clamped = Math.max(0, Math.min(1, newWeight));
        const result = stmt.run(clamped, now, edgeId);
        if (result.changes > 0) updatedCount++;
      }
    });

    txn();
    return updatedCount;
  }

  /**
   * Query edges with flexible filters.
   * Supports filtering by node types, edge types, weight range, and limit.
   */
  queryEdges(filter: EdgeQueryFilter): MemoryEdge[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filter.limit ? `LIMIT ?` : '';
    if (filter.limit) params.push(filter.limit);

    const rows = this.db.prepare(`
      SELECT id, source_id, source_type, target_id, target_type,
        edge_type, weight, created_at, updated_at, metadata
      FROM memory_edges
      ${whereClause}
      ORDER BY weight DESC
      ${limitClause}
    `).all(...params) as EdgeRow[];

    return rows.map(r => this.rowToEdge(r));
  }

  /**
   * Get neighbor node IDs reachable from a given node, optionally filtered.
   * Returns unique neighbor IDs sorted by highest edge weight.
   */
  getNeighborIds(nodeId: string, filter?: { edgeTypes?: EdgeType[]; minWeight?: number }): string[] {
    const conditions: string[] = ['(source_id = ? OR target_id = ?)'];
    const params: (string | number)[] = [nodeId, nodeId];

    if (filter?.edgeTypes && filter.edgeTypes.length > 0) {
      const placeholders = filter.edgeTypes.map(() => '?').join(', ');
      conditions.push(`edge_type IN (${placeholders})`);
      params.push(...filter.edgeTypes);
    }
    if (filter?.minWeight !== undefined) {
      conditions.push('weight >= ?');
      params.push(filter.minWeight);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const rows = this.db.prepare(`
      SELECT source_id, target_id, weight
      FROM memory_edges
      ${whereClause}
      ORDER BY weight DESC
    `).all(...params) as { source_id: string; target_id: string; weight: number }[];

    // Collect unique neighbor IDs (the "other" end of each edge)
    const seen = new Set<string>();
    const neighbors: string[] = [];

    for (const row of rows) {
      const neighbor = row.source_id === nodeId ? row.target_id : row.source_id;
      if (!seen.has(neighbor)) {
        seen.add(neighbor);
        neighbors.push(neighbor);
      }
    }

    return neighbors;
  }

  /**
   * Update edge metadata without changing the weight.
   */
  updateMetadata(edgeId: string, metadata: Record<string, unknown>): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE memory_edges SET metadata = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(metadata), now, edgeId);
    return result.changes > 0;
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  /**
   * Merge two weights according to the chosen strategy.
   */
  private mergeWeight(oldWeight: number, newWeight: number, strategy: WeightMergeStrategy): number {
    switch (strategy) {
      case 'replace':
        return newWeight;
      case 'max':
        return Math.max(oldWeight, newWeight);
      case 'average':
        return (oldWeight + newWeight) / 2;
      case 'hebbian':
        // Hebbian reinforcement: use newWeight as the delta
        // new = old + delta * (1 - old) → approaches 1 asymptotically
        return oldWeight + newWeight * (1 - oldWeight);
      default:
        return newWeight;
    }
  }

  private rowToEdge(r: EdgeRow): MemoryEdge {
    return {
      id: r.id,
      sourceId: r.source_id,
      sourceType: r.source_type as MemoryEdge['sourceType'],
      targetId: r.target_id,
      targetType: r.target_type as MemoryEdge['targetType'],
      edgeType: r.edge_type as MemoryEdge['edgeType'],
      weight: r.weight,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    };
  }
}

interface EdgeRow {
  id: string;
  source_id: string;
  source_type: string;
  target_id: string;
  target_type: string;
  edge_type: string;
  weight: number;
  created_at: string;
  updated_at: string;
  metadata: string | null;
}
