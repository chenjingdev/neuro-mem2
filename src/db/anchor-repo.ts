/**
 * Repository for Anchor node storage and retrieval.
 * Anchors are semantic hub nodes for dual-path retrieval.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  Anchor,
  AnchorRef,
  CreateAnchorInput,
  UpdateAnchorInput,
} from '../models/anchor.js';
import { computeAnchorEffectiveWeight } from '../scoring/anchor-decay.js';

export class AnchorRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a new anchor node.
   */
  createAnchor(input: CreateAnchorInput): Anchor {
    const now = new Date().toISOString();
    const id = uuidv4();

    const embeddingBlob = input.embedding
      ? Buffer.from(input.embedding.buffer)
      : null;
    const embeddingDim = input.embedding ? input.embedding.length : null;
    const initialWeight = input.initialWeight ?? 0.5;

    const anchor: Anchor = {
      id,
      label: input.label,
      description: input.description,
      anchorType: input.anchorType,
      aliases: input.aliases ?? [],
      embedding: input.embedding,
      embeddingDim: embeddingDim ?? undefined,
      currentWeight: initialWeight,
      initialWeight,
      decayRate: input.decayRate ?? 0.01,
      accessCount: 0,
      activationCount: 0,
      effectiveWeight: initialWeight, // At creation, effective = current (no decay yet)
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };

    this.db.prepare(`
      INSERT INTO anchors (id, label, description, anchor_type, aliases,
        embedding, embedding_dim, current_weight, initial_weight, decay_rate,
        access_count, activation_count, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      anchor.id,
      anchor.label,
      anchor.description,
      anchor.anchorType,
      JSON.stringify(anchor.aliases),
      embeddingBlob,
      embeddingDim,
      anchor.currentWeight,
      anchor.initialWeight,
      anchor.decayRate,
      anchor.accessCount,
      anchor.activationCount,
      anchor.createdAt,
      anchor.updatedAt,
      anchor.metadata ? JSON.stringify(anchor.metadata) : null,
    );

    return anchor;
  }

  /**
   * Get an anchor by ID.
   */
  getAnchor(anchorId: string): Anchor | null {
    const row = this.db.prepare(`
      SELECT id, label, description, anchor_type, aliases,
        embedding, embedding_dim, current_weight, initial_weight, decay_rate,
        access_count, last_accessed_at, activation_count, last_activated_at,
        created_at, updated_at, metadata
      FROM anchors WHERE id = ?
    `).get(anchorId) as AnchorRow | undefined;

    if (!row) return null;
    return this.rowToAnchor(row);
  }

  /**
   * Find an anchor by label (case-insensitive).
   */
  findByLabel(label: string): Anchor | null {
    const row = this.db.prepare(`
      SELECT id, label, description, anchor_type, aliases,
        embedding, embedding_dim, current_weight, initial_weight, decay_rate,
        access_count, last_accessed_at, activation_count, last_activated_at,
        created_at, updated_at, metadata
      FROM anchors WHERE LOWER(label) = LOWER(?)
    `).get(label) as AnchorRow | undefined;

    if (!row) return null;
    return this.rowToAnchor(row);
  }

  /**
   * Get anchors by type.
   */
  getByType(anchorType: string): Anchor[] {
    const rows = this.db.prepare(`
      SELECT id, label, description, anchor_type, aliases,
        embedding, embedding_dim, current_weight, initial_weight, decay_rate,
        access_count, last_accessed_at, activation_count, last_activated_at,
        created_at, updated_at, metadata
      FROM anchors WHERE anchor_type = ?
      ORDER BY current_weight DESC, activation_count DESC
    `).all(anchorType) as AnchorRow[];

    return rows.map(r => this.rowToAnchor(r));
  }

  /**
   * List all anchors (without embeddings for efficiency).
   */
  listAnchors(limit?: number): AnchorRef[] {
    const sql = limit
      ? `SELECT id, label, anchor_type, current_weight, decay_rate, access_count,
                last_accessed_at, activation_count, last_activated_at, created_at
         FROM anchors ORDER BY current_weight DESC, activation_count DESC LIMIT ?`
      : `SELECT id, label, anchor_type, current_weight, decay_rate, access_count,
                last_accessed_at, activation_count, last_activated_at, created_at
         FROM anchors ORDER BY current_weight DESC, activation_count DESC`;

    const rows = (limit
      ? this.db.prepare(sql).all(limit)
      : this.db.prepare(sql).all()) as AnchorRefRow[];

    return rows.map(r => {
      // We need created_at for effective weight fallback; query for it
      const effectiveWeight = computeAnchorEffectiveWeight({
        currentWeight: r.current_weight,
        decayRate: r.decay_rate,
        lastAccessedAt: r.last_accessed_at ?? undefined,
        createdAt: r.created_at,
        accessCount: r.access_count,
      });

      return {
        id: r.id,
        label: r.label,
        anchorType: r.anchor_type as Anchor['anchorType'],
        currentWeight: r.current_weight,
        effectiveWeight,
        accessCount: r.access_count,
        lastAccessedAt: r.last_accessed_at ?? undefined,
        activationCount: r.activation_count,
        lastActivatedAt: r.last_activated_at ?? undefined,
      };
    });
  }

  /**
   * Update an anchor.
   */
  updateAnchor(anchorId: string, input: UpdateAnchorInput): Anchor | null {
    const existing = this.getAnchor(anchorId);
    if (!existing) return null;

    const now = new Date().toISOString();
    let label = existing.label;
    let description = existing.description;
    let aliases = [...existing.aliases];
    let embedding = existing.embedding;
    let embeddingDim = existing.embeddingDim;
    let currentWeight = existing.currentWeight;
    let decayRate = existing.decayRate;
    let accessCount = existing.accessCount;
    let lastAccessedAt = existing.lastAccessedAt;
    let activationCount = existing.activationCount;
    let lastActivatedAt = existing.lastActivatedAt;
    let metadata = existing.metadata;

    if (input.label !== undefined) label = input.label;
    if (input.description !== undefined) description = input.description;
    if (input.addAliases) {
      const newAliases = input.addAliases.filter(a => !aliases.includes(a));
      aliases = [...aliases, ...newAliases];
    }
    if (input.embedding !== undefined) {
      embedding = input.embedding;
      embeddingDim = input.embedding.length;
    }
    if (input.currentWeight !== undefined) {
      currentWeight = Math.max(0, Math.min(1, input.currentWeight));
    }
    if (input.decayRate !== undefined) {
      decayRate = Math.max(0, Math.min(1, input.decayRate));
    }
    if (input.recordAccess) {
      accessCount += 1;
      lastAccessedAt = now;
    }
    if (input.recordActivation) {
      activationCount += 1;
      lastActivatedAt = now;
    }
    if (input.metadata) {
      metadata = { ...(metadata ?? {}), ...input.metadata };
    }

    const embeddingBlob = embedding
      ? Buffer.from(embedding.buffer)
      : null;

    this.db.prepare(`
      UPDATE anchors SET
        label = ?, description = ?, aliases = ?,
        embedding = ?, embedding_dim = ?,
        current_weight = ?, decay_rate = ?,
        access_count = ?, last_accessed_at = ?,
        activation_count = ?, last_activated_at = ?,
        updated_at = ?, metadata = ?
      WHERE id = ?
    `).run(
      label,
      description,
      JSON.stringify(aliases),
      embeddingBlob,
      embeddingDim ?? null,
      currentWeight,
      decayRate,
      accessCount,
      lastAccessedAt ?? null,
      activationCount,
      lastActivatedAt ?? null,
      now,
      metadata ? JSON.stringify(metadata) : null,
      anchorId,
    );

    // Recompute effective weight after update
    const effectiveWeight = computeAnchorEffectiveWeight({
      currentWeight,
      decayRate,
      lastAccessedAt,
      createdAt: existing.createdAt,
      accessCount,
    });

    return {
      ...existing,
      label,
      description,
      aliases,
      embedding,
      embeddingDim,
      currentWeight,
      decayRate,
      accessCount,
      lastAccessedAt,
      activationCount,
      lastActivatedAt,
      effectiveWeight,
      updatedAt: now,
      metadata,
    };
  }

  /**
   * Record an activation (convenience method).
   */
  recordActivation(anchorId: string): Anchor | null {
    return this.updateAnchor(anchorId, { recordActivation: true });
  }

  /**
   * Record a retrieval access (convenience method).
   * Increments accessCount and updates lastAccessedAt.
   */
  recordAccess(anchorId: string): Anchor | null {
    return this.updateAnchor(anchorId, { recordAccess: true });
  }

  /**
   * Get all anchors with their embeddings for vector search.
   * Only returns anchors that have embeddings and weight above threshold.
   */
  getAnchorsWithEmbeddings(minWeight?: number): Anchor[] {
    const threshold = minWeight ?? 0;
    const rows = this.db.prepare(`
      SELECT id, label, description, anchor_type, aliases,
        embedding, embedding_dim, current_weight, initial_weight, decay_rate,
        access_count, last_accessed_at, activation_count, last_activated_at,
        created_at, updated_at, metadata
      FROM anchors
      WHERE embedding IS NOT NULL AND current_weight >= ?
      ORDER BY current_weight DESC
    `).all(threshold) as AnchorRow[];
    return rows.map(r => this.rowToAnchor(r));
  }

  /**
   * Apply time-based decay to all anchor weights.
   * Formula: w_new = w * (1 - decay_rate)
   * Only decays anchors with decay_rate > 0.
   *
   * @returns Number of anchors decayed and pruned
   */
  applyDecay(options?: { pruneBelow?: number }): { decayedCount: number; prunedCount: number } {
    const now = new Date().toISOString();

    const decayResult = this.db.prepare(`
      UPDATE anchors SET
        current_weight = MAX(0.0, current_weight * (1.0 - decay_rate)),
        updated_at = ?
      WHERE decay_rate > 0
    `).run(now);

    let prunedCount = 0;
    if (options?.pruneBelow !== undefined && options.pruneBelow > 0) {
      const pruneResult = this.db.prepare(`
        DELETE FROM anchors WHERE current_weight < ?
      `).run(options.pruneBelow);
      prunedCount = pruneResult.changes;
    }

    return {
      decayedCount: decayResult.changes,
      prunedCount,
    };
  }

  /**
   * Reinforce an anchor's weight using Hebbian rule.
   * Formula: w_new = w + learningRate * (1 - w)
   * This approaches 1.0 asymptotically. Also records an access.
   */
  reinforceWeight(anchorId: string, learningRate: number = 0.1): Anchor | null {
    const existing = this.getAnchor(anchorId);
    if (!existing) return null;

    const newWeight = Math.min(1.0, existing.currentWeight + learningRate * (1 - existing.currentWeight));
    return this.updateAnchor(anchorId, {
      currentWeight: newWeight,
      recordAccess: true,
    });
  }

  /**
   * Get anchors ordered by current weight (for decay analysis / maintenance).
   */
  getByWeightRange(minWeight: number, maxWeight: number, limit?: number): Anchor[] {
    const sql = limit
      ? `SELECT id, label, description, anchor_type, aliases,
           embedding, embedding_dim, current_weight, initial_weight, decay_rate,
           access_count, last_accessed_at, activation_count, last_activated_at,
           created_at, updated_at, metadata
         FROM anchors WHERE current_weight >= ? AND current_weight <= ?
         ORDER BY current_weight DESC LIMIT ?`
      : `SELECT id, label, description, anchor_type, aliases,
           embedding, embedding_dim, current_weight, initial_weight, decay_rate,
           access_count, last_accessed_at, activation_count, last_activated_at,
           created_at, updated_at, metadata
         FROM anchors WHERE current_weight >= ? AND current_weight <= ?
         ORDER BY current_weight DESC`;

    const rows = (limit
      ? this.db.prepare(sql).all(minWeight, maxWeight, limit)
      : this.db.prepare(sql).all(minWeight, maxWeight)) as AnchorRow[];

    return rows.map(r => this.rowToAnchor(r));
  }

  /**
   * Delete an anchor by ID.
   */
  deleteAnchor(anchorId: string): boolean {
    const result = this.db.prepare('DELETE FROM anchors WHERE id = ?').run(anchorId);
    return result.changes > 0;
  }

  /**
   * Count all anchors.
   */
  countAnchors(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM anchors').get() as { cnt: number };
    return row.cnt;
  }

  // ── Private helpers ──

  private rowToAnchor(r: AnchorRow): Anchor {
    let embedding: Float32Array | undefined;
    let embeddingDim: number | undefined;

    if (r.embedding && r.embedding_dim) {
      embedding = new Float32Array(
        r.embedding.buffer,
        r.embedding.byteOffset,
        r.embedding_dim,
      );
      embeddingDim = r.embedding_dim;
    }

    // Compute effective weight dynamically using time + usage decay
    const effectiveWeight = computeAnchorEffectiveWeight({
      currentWeight: r.current_weight,
      decayRate: r.decay_rate,
      lastAccessedAt: r.last_accessed_at ?? undefined,
      createdAt: r.created_at,
      accessCount: r.access_count,
    });

    return {
      id: r.id,
      label: r.label,
      description: r.description,
      anchorType: r.anchor_type as Anchor['anchorType'],
      aliases: JSON.parse(r.aliases),
      embedding,
      embeddingDim,
      currentWeight: r.current_weight,
      initialWeight: r.initial_weight,
      decayRate: r.decay_rate,
      accessCount: r.access_count,
      lastAccessedAt: r.last_accessed_at ?? undefined,
      activationCount: r.activation_count,
      lastActivatedAt: r.last_activated_at ?? undefined,
      effectiveWeight,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    };
  }
}

interface AnchorRow {
  id: string;
  label: string;
  description: string;
  anchor_type: string;
  aliases: string;
  embedding: Buffer | null;
  embedding_dim: number | null;
  current_weight: number;
  initial_weight: number;
  decay_rate: number;
  access_count: number;
  last_accessed_at: string | null;
  activation_count: number;
  last_activated_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: string | null;
}

interface AnchorRefRow {
  id: string;
  label: string;
  anchor_type: string;
  current_weight: number;
  decay_rate: number;
  access_count: number;
  last_accessed_at: string | null;
  activation_count: number;
  last_activated_at: string | null;
  created_at: string;
}
