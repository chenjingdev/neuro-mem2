/**
 * Repository for memory chunk embeddings.
 *
 * Manages the storage and retrieval of vector embeddings for facts,
 * episodes, and concepts. These embeddings enable direct cosine
 * similarity search on memory chunks without requiring anchor intermediaries.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { MemoryNodeType } from '../models/memory-edge.js';

// ─── Types ──────────────────────────────────────────────────────

export interface MemoryEmbedding {
  id: string;
  nodeId: string;
  nodeType: MemoryNodeType;
  embedding: Float32Array;
  embeddingDim: number;
  contentHash: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoreEmbeddingInput {
  nodeId: string;
  nodeType: MemoryNodeType;
  embedding: Float32Array;
  contentHash: string;
  model?: string;
}

export interface EmbeddingRow {
  id: string;
  node_id: string;
  node_type: string;
  embedding: Buffer;
  embedding_dim: number;
  content_hash: string;
  model: string;
  created_at: string;
  updated_at: string;
}

// ─── Repository ─────────────────────────────────────────────────

export class MemoryEmbeddingRepository {
  constructor(private db: Database.Database) {}

  /**
   * Store or update an embedding for a memory node.
   * Uses UPSERT to handle updates when the content changes.
   */
  upsert(input: StoreEmbeddingInput): MemoryEmbedding {
    const now = new Date().toISOString();
    const embeddingBuffer = Buffer.from(input.embedding.buffer, input.embedding.byteOffset, input.embedding.byteLength);
    const dim = input.embedding.length;
    const model = input.model ?? 'unknown';

    // Try to find existing
    const existing = this.db.prepare(
      'SELECT id, created_at FROM memory_embeddings WHERE node_id = ? AND node_type = ?',
    ).get(input.nodeId, input.nodeType) as { id: string; created_at: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE memory_embeddings
        SET embedding = ?, embedding_dim = ?, content_hash = ?, model = ?, updated_at = ?
        WHERE id = ?
      `).run(embeddingBuffer, dim, input.contentHash, model, now, existing.id);

      return {
        id: existing.id,
        nodeId: input.nodeId,
        nodeType: input.nodeType as MemoryNodeType,
        embedding: input.embedding,
        embeddingDim: dim,
        contentHash: input.contentHash,
        model,
        createdAt: existing.created_at,
        updatedAt: now,
      };
    }

    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO memory_embeddings (id, node_id, node_type, embedding, embedding_dim, content_hash, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.nodeId, input.nodeType, embeddingBuffer, dim, input.contentHash, model, now, now);

    return {
      id,
      nodeId: input.nodeId,
      nodeType: input.nodeType as MemoryNodeType,
      embedding: input.embedding,
      embeddingDim: dim,
      contentHash: input.contentHash,
      model,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Get the embedding for a specific memory node.
   */
  getByNode(nodeId: string, nodeType: MemoryNodeType): MemoryEmbedding | null {
    const row = this.db.prepare(
      'SELECT * FROM memory_embeddings WHERE node_id = ? AND node_type = ?',
    ).get(nodeId, nodeType) as EmbeddingRow | undefined;

    return row ? this.rowToModel(row) : null;
  }

  /**
   * Get all embeddings of a given node type for brute-force search.
   * Returns raw rows for efficiency (avoids creating Float32Array per row).
   */
  getAllByType(nodeType?: MemoryNodeType): EmbeddingRow[] {
    if (nodeType) {
      return this.db.prepare(
        'SELECT * FROM memory_embeddings WHERE node_type = ?',
      ).all(nodeType) as EmbeddingRow[];
    }
    return this.db.prepare(
      'SELECT * FROM memory_embeddings',
    ).all() as EmbeddingRow[];
  }

  /**
   * Delete the embedding for a memory node.
   */
  delete(nodeId: string, nodeType: MemoryNodeType): boolean {
    const result = this.db.prepare(
      'DELETE FROM memory_embeddings WHERE node_id = ? AND node_type = ?',
    ).run(nodeId, nodeType);
    return result.changes > 0;
  }

  /**
   * Count embeddings, optionally filtered by type.
   */
  count(nodeType?: MemoryNodeType): number {
    if (nodeType) {
      const row = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM memory_embeddings WHERE node_type = ?',
      ).get(nodeType) as { cnt: number };
      return row.cnt;
    }
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM memory_embeddings',
    ).get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Check if a node's embedding is stale (content changed since embedding).
   */
  isStale(nodeId: string, nodeType: MemoryNodeType, currentHash: string): boolean {
    const row = this.db.prepare(
      'SELECT content_hash FROM memory_embeddings WHERE node_id = ? AND node_type = ?',
    ).get(nodeId, nodeType) as { content_hash: string } | undefined;
    if (!row) return true; // No embedding = stale
    return row.content_hash !== currentHash;
  }

  // ─── Internal ───────────────────────────────────────────────

  private rowToModel(row: EmbeddingRow): MemoryEmbedding {
    const embedding = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding_dim,
    );

    return {
      id: row.id,
      nodeId: row.node_id,
      nodeType: row.node_type as MemoryNodeType,
      embedding,
      embeddingDim: row.embedding_dim,
      contentHash: row.content_hash,
      model: row.model,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
