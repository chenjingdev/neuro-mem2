/**
 * MemoryNodeRepository — data access layer for the unified MemoryNode table.
 *
 * Supports:
 * - CRUD operations with 4-layer progressive depth
 * - FTS5 full-text search (한영 혼용)
 * - Embedding-based vector search (brute-force cosine similarity)
 * - FTS5 + vector hybrid search (pre-filter then rerank)
 * - Hub node management
 * - Event-based lifecycle tracking
 * - Batch operations for scalability (수십만 노드 대응)
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  MemoryNode,
  MemoryNodeRef,
  MemoryNodeL1,
  MemoryNodeL2,
  CreateMemoryNodeInput,
  UpdateMemoryNodeInput,
  MemoryNodeFilter,
  MemoryNodeType,
  MemoryNodeTypeNullable,
  MemoryNodeRole,
  MemoryNodeMetadata,
} from '../models/memory-node.js';
import { normalizeKeywords, buildFtsMatchQuery, buildColumnFtsQuery } from '../utils/keyword-normalizer.js';

// ─── Row Type (SQLite → TypeScript mapping) ──────────────────────

interface MemoryNodeRow {
  id: string;
  node_type: string | null;
  node_role: string;
  frontmatter: string;
  keywords: string;
  embedding: Buffer | null;
  embedding_dim: number | null;
  metadata: string;
  summary: string;
  source_message_ids: string;
  conversation_id: string | null;
  source_turn_index: number | null;
  created_at_event: number;
  last_activated_at_event: number;
  activation_count: number;
  created_at: string;
  updated_at: string;
}

// ─── Repository ──────────────────────────────────────────────────

export class MemoryNodeRepository {
  constructor(private db: Database.Database) {}

  // ═══════════════════════════════════════════════════════════════
  // CREATE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create a single MemoryNode.
   */
  create(input: CreateMemoryNodeInput): MemoryNode {
    const id = randomUUID();
    const now = new Date().toISOString();
    const eventCounter = input.currentEventCounter ?? 0;

    const embeddingBlob = input.embedding
      ? Buffer.from(input.embedding.buffer, input.embedding.byteOffset, input.embedding.byteLength)
      : null;

    const stmt = this.db.prepare(`
      INSERT INTO memory_nodes (
        id, node_type, node_role,
        frontmatter, keywords, embedding, embedding_dim,
        metadata, summary,
        source_message_ids, conversation_id, source_turn_index,
        created_at_event, last_activated_at_event, activation_count,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, 0,
        ?, ?
      )
    `);

    // Normalize keywords before storage: lowercase, deduplicate, sort
    const normalizedKeywords = normalizeKeywords(input.keywords);

    stmt.run(
      id, input.nodeType, input.nodeRole ?? 'leaf',
      input.frontmatter, normalizedKeywords, embeddingBlob, input.embeddingDim ?? null,
      JSON.stringify(input.metadata ?? {}), input.summary,
      JSON.stringify(input.sourceMessageIds ?? []), input.conversationId ?? null, input.sourceTurnIndex ?? null,
      eventCounter, eventCounter,
      now, now,
    );

    return this.getById(id)!;
  }

  /**
   * Batch create multiple MemoryNodes in a single transaction.
   */
  createBatch(inputs: CreateMemoryNodeInput[]): MemoryNode[] {
    const ids: string[] = [];
    const txn = this.db.transaction(() => {
      for (const input of inputs) {
        const node = this.create(input);
        ids.push(node.id);
      }
    });
    txn();
    return ids.map(id => this.getById(id)!);
  }

  // ═══════════════════════════════════════════════════════════════
  // READ — Progressive Depth
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get full MemoryNode by ID (all layers).
   */
  getById(id: string): MemoryNode | null {
    const row = this.db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id) as MemoryNodeRow | undefined;
    return row ? this.rowToNode(row) : null;
  }

  /**
   * Get multiple nodes by IDs (preserves order).
   */
  getByIds(ids: string[]): MemoryNode[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM memory_nodes WHERE id IN (${placeholders})`
    ).all(...ids) as MemoryNodeRow[];

    const byId = new Map(rows.map(r => [r.id, this.rowToNode(r)]));
    return ids.map(id => byId.get(id)).filter((n): n is MemoryNode => n != null);
  }

  /**
   * Get L0 references only (cheapest — for large result sets).
   */
  getRefsById(ids: string[]): MemoryNodeRef[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, node_type, node_role, frontmatter, keywords, activation_count, last_activated_at_event
       FROM memory_nodes WHERE id IN (${placeholders})`
    ).all(...ids) as Pick<MemoryNodeRow, 'id' | 'node_type' | 'node_role' | 'frontmatter' | 'keywords' | 'activation_count' | 'last_activated_at_event'>[];

    return rows.map(r => ({
      id: r.id,
      nodeType: (r.node_type as MemoryNodeTypeNullable) ?? null,
      nodeRole: r.node_role as MemoryNodeRole,
      frontmatter: r.frontmatter,
      keywords: r.keywords,
      activationCount: r.activation_count,
      lastActivatedAtEvent: r.last_activated_at_event,
    }));
  }

  /**
   * Get L0+L1 (ref + metadata, no summary).
   */
  getL1ById(id: string): MemoryNodeL1 | null {
    const row = this.db.prepare(
      `SELECT id, node_type, node_role, frontmatter, keywords, metadata, activation_count, last_activated_at_event
       FROM memory_nodes WHERE id = ?`
    ).get(id) as (Pick<MemoryNodeRow, 'id' | 'node_type' | 'node_role' | 'frontmatter' | 'keywords' | 'metadata' | 'activation_count' | 'last_activated_at_event'>) | undefined;

    if (!row) return null;
    return {
      id: row.id,
      nodeType: (row.node_type as MemoryNodeTypeNullable) ?? null,
      nodeRole: row.node_role as MemoryNodeRole,
      frontmatter: row.frontmatter,
      keywords: row.keywords,
      activationCount: row.activation_count,
      lastActivatedAtEvent: row.last_activated_at_event,
      metadata: JSON.parse(row.metadata) as MemoryNodeMetadata,
    };
  }

  /**
   * Get L0+L1+L2 (ref + metadata + summary).
   */
  getL2ById(id: string): MemoryNodeL2 | null {
    const row = this.db.prepare(
      `SELECT id, node_type, node_role, frontmatter, keywords, metadata, summary, activation_count, last_activated_at_event
       FROM memory_nodes WHERE id = ?`
    ).get(id) as (Pick<MemoryNodeRow, 'id' | 'node_type' | 'node_role' | 'frontmatter' | 'keywords' | 'metadata' | 'summary' | 'activation_count' | 'last_activated_at_event'>) | undefined;

    if (!row) return null;
    return {
      id: row.id,
      nodeType: (row.node_type as MemoryNodeTypeNullable) ?? null,
      nodeRole: row.node_role as MemoryNodeRole,
      frontmatter: row.frontmatter,
      keywords: row.keywords,
      activationCount: row.activation_count,
      lastActivatedAtEvent: row.last_activated_at_event,
      metadata: JSON.parse(row.metadata) as MemoryNodeMetadata,
      summary: row.summary,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // QUERY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Query memory nodes with filters.
   */
  query(filter: MemoryNodeFilter): MemoryNode[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.nodeType !== undefined) {
      if (Array.isArray(filter.nodeType)) {
        const nonNull = filter.nodeType.filter((t): t is MemoryNodeType => t !== null);
        const hasNull = filter.nodeType.includes(null);
        const parts: string[] = [];
        if (nonNull.length > 0) {
          const placeholders = nonNull.map(() => '?').join(',');
          parts.push(`node_type IN (${placeholders})`);
          params.push(...nonNull);
        }
        if (hasNull) parts.push('node_type IS NULL');
        if (parts.length > 0) conditions.push(`(${parts.join(' OR ')})`);
      } else if (filter.nodeType === null) {
        conditions.push('node_type IS NULL');
      } else {
        conditions.push('node_type = ?');
        params.push(filter.nodeType);
      }
    }

    if (filter.nodeRole) {
      if (Array.isArray(filter.nodeRole)) {
        const placeholders = filter.nodeRole.map(() => '?').join(',');
        conditions.push(`node_role IN (${placeholders})`);
        params.push(...filter.nodeRole);
      } else {
        conditions.push('node_role = ?');
        params.push(filter.nodeRole);
      }
    }

    if (filter.conversationId) {
      conditions.push('conversation_id = ?');
      params.push(filter.conversationId);
    }

    if (filter.minActivationCount != null) {
      conditions.push('activation_count >= ?');
      params.push(filter.minActivationCount);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let orderBy = 'ORDER BY created_at DESC';
    if (filter.orderBy === 'activation_desc') orderBy = 'ORDER BY activation_count DESC';
    else if (filter.orderBy === 'recent_first') orderBy = 'ORDER BY updated_at DESC';
    else if (filter.orderBy === 'created_first') orderBy = 'ORDER BY created_at ASC';

    const limit = filter.limit ? `LIMIT ${filter.limit}` : '';

    const rows = this.db.prepare(
      `SELECT * FROM memory_nodes ${where} ${orderBy} ${limit}`
    ).all(...params) as MemoryNodeRow[];

    return rows.map(r => this.rowToNode(r));
  }

  /**
   * Get all hub nodes (for graph visualization and anchor matching).
   */
  getHubs(nodeType?: MemoryNodeTypeNullable): MemoryNode[] {
    if (nodeType !== undefined) {
      if (nodeType === null) {
        return (this.db.prepare(
          `SELECT * FROM memory_nodes WHERE node_role = 'hub' AND node_type IS NULL ORDER BY activation_count DESC`
        ).all() as MemoryNodeRow[]).map(r => this.rowToNode(r));
      }
      return (this.db.prepare(
        `SELECT * FROM memory_nodes WHERE node_role = 'hub' AND node_type = ? ORDER BY activation_count DESC`
      ).all(nodeType) as MemoryNodeRow[]).map(r => this.rowToNode(r));
    }
    return (this.db.prepare(
      `SELECT * FROM memory_nodes WHERE node_role = 'hub' ORDER BY activation_count DESC`
    ).all() as MemoryNodeRow[]).map(r => this.rowToNode(r));
  }

  /**
   * Find hub by frontmatter label (case-insensitive).
   */
  findHubByLabel(label: string): MemoryNode | null {
    const row = this.db.prepare(
      `SELECT * FROM memory_nodes WHERE node_role = 'hub' AND LOWER(frontmatter) = LOWER(?)`
    ).get(label) as MemoryNodeRow | undefined;
    return row ? this.rowToNode(row) : null;
  }

  /**
   * Count nodes by type and/or role.
   */
  count(nodeType?: MemoryNodeTypeNullable, nodeRole?: MemoryNodeRole): number {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (nodeType !== undefined) {
      if (nodeType === null) { conditions.push('node_type IS NULL'); }
      else { conditions.push('node_type = ?'); params.push(nodeType); }
    }
    if (nodeRole) { conditions.push('node_role = ?'); params.push(nodeRole); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM memory_nodes ${where}`).get(...params) as { cnt: number };
    return row.cnt;
  }

  // ═══════════════════════════════════════════════════════════════
  // PAGINATED QUERIES — Progressive Depth Layer Loading
  // ═══════════════════════════════════════════════════════════════

  /**
   * Paginated L0 refs listing (lightweight — for large result sets and UI).
   */
  listRefs(opts: {
    limit?: number;
    offset?: number;
    nodeType?: MemoryNodeTypeNullable;
    nodeRole?: MemoryNodeRole;
    orderBy?: 'activation_desc' | 'recent_first' | 'created_first';
  } = {}): { items: MemoryNodeRef[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.nodeType !== undefined) {
      if (opts.nodeType === null) {
        conditions.push('node_type IS NULL');
      } else {
        conditions.push('node_type = ?');
        params.push(opts.nodeType);
      }
    }
    if (opts.nodeRole) {
      conditions.push('node_role = ?');
      params.push(opts.nodeRole);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memory_nodes ${where}`
    ).get(...params) as { cnt: number };

    let orderBy = 'ORDER BY created_at DESC';
    if (opts.orderBy === 'activation_desc') orderBy = 'ORDER BY activation_count DESC';
    else if (opts.orderBy === 'recent_first') orderBy = 'ORDER BY updated_at DESC';
    else if (opts.orderBy === 'created_first') orderBy = 'ORDER BY created_at ASC';

    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT id, node_type, node_role, frontmatter, keywords, activation_count, last_activated_at_event
       FROM memory_nodes ${where} ${orderBy} LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Pick<MemoryNodeRow, 'id' | 'node_type' | 'node_role' | 'frontmatter' | 'keywords' | 'activation_count' | 'last_activated_at_event'>[];

    return {
      items: rows.map(r => ({
        id: r.id,
        nodeType: (r.node_type as MemoryNodeTypeNullable) ?? null,
        nodeRole: r.node_role as MemoryNodeRole,
        frontmatter: r.frontmatter,
        keywords: r.keywords,
        activationCount: r.activation_count,
        lastActivatedAtEvent: r.last_activated_at_event,
      })),
      total: countRow.cnt,
    };
  }

  /**
   * Paginated L1 listing (refs + metadata).
   */
  listL1(opts: {
    limit?: number;
    offset?: number;
    nodeType?: MemoryNodeTypeNullable;
    nodeRole?: MemoryNodeRole;
    orderBy?: 'activation_desc' | 'recent_first' | 'created_first';
  } = {}): { items: MemoryNodeL1[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.nodeType !== undefined) {
      if (opts.nodeType === null) {
        conditions.push('node_type IS NULL');
      } else {
        conditions.push('node_type = ?');
        params.push(opts.nodeType);
      }
    }
    if (opts.nodeRole) {
      conditions.push('node_role = ?');
      params.push(opts.nodeRole);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memory_nodes ${where}`
    ).get(...params) as { cnt: number };

    let orderBy = 'ORDER BY created_at DESC';
    if (opts.orderBy === 'activation_desc') orderBy = 'ORDER BY activation_count DESC';
    else if (opts.orderBy === 'recent_first') orderBy = 'ORDER BY updated_at DESC';
    else if (opts.orderBy === 'created_first') orderBy = 'ORDER BY created_at ASC';

    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT id, node_type, node_role, frontmatter, keywords, metadata, activation_count, last_activated_at_event
       FROM memory_nodes ${where} ${orderBy} LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Pick<MemoryNodeRow, 'id' | 'node_type' | 'node_role' | 'frontmatter' | 'keywords' | 'metadata' | 'activation_count' | 'last_activated_at_event'>[];

    return {
      items: rows.map(r => ({
        id: r.id,
        nodeType: (r.node_type as MemoryNodeTypeNullable) ?? null,
        nodeRole: r.node_role as MemoryNodeRole,
        frontmatter: r.frontmatter,
        keywords: r.keywords,
        activationCount: r.activation_count,
        lastActivatedAtEvent: r.last_activated_at_event,
        metadata: JSON.parse(r.metadata) as MemoryNodeMetadata,
      })),
      total: countRow.cnt,
    };
  }

  /**
   * Get L0 refs for a batch of IDs (for lazy-loading children at L0 depth).
   */
  getRefsByIds(ids: string[]): MemoryNodeRef[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, node_type, node_role, frontmatter, keywords, activation_count, last_activated_at_event
       FROM memory_nodes WHERE id IN (${placeholders})`
    ).all(...ids) as Pick<MemoryNodeRow, 'id' | 'node_type' | 'node_role' | 'frontmatter' | 'keywords' | 'activation_count' | 'last_activated_at_event'>[];

    return rows.map(r => ({
      id: r.id,
      nodeType: (r.node_type as MemoryNodeTypeNullable) ?? null,
      nodeRole: r.node_role as MemoryNodeRole,
      frontmatter: r.frontmatter,
      keywords: r.keywords,
      activationCount: r.activation_count,
      lastActivatedAtEvent: r.last_activated_at_event,
    }));
  }

  /**
   * Get L1 data for a batch of IDs.
   */
  getL1ByIds(ids: string[]): MemoryNodeL1[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, node_type, node_role, frontmatter, keywords, metadata, activation_count, last_activated_at_event
       FROM memory_nodes WHERE id IN (${placeholders})`
    ).all(...ids) as Pick<MemoryNodeRow, 'id' | 'node_type' | 'node_role' | 'frontmatter' | 'keywords' | 'metadata' | 'activation_count' | 'last_activated_at_event'>[];

    return rows.map(r => ({
      id: r.id,
      nodeType: (r.node_type as MemoryNodeTypeNullable) ?? null,
      nodeRole: r.node_role as MemoryNodeRole,
      frontmatter: r.frontmatter,
      keywords: r.keywords,
      activationCount: r.activation_count,
      lastActivatedAtEvent: r.last_activated_at_event,
      metadata: JSON.parse(r.metadata) as MemoryNodeMetadata,
    }));
  }

  /**
   * Get L2 data for a batch of IDs.
   */
  getL2ByIds(ids: string[]): MemoryNodeL2[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, node_type, node_role, frontmatter, keywords, metadata, summary, activation_count, last_activated_at_event
       FROM memory_nodes WHERE id IN (${placeholders})`
    ).all(...ids) as Pick<MemoryNodeRow, 'id' | 'node_type' | 'node_role' | 'frontmatter' | 'keywords' | 'metadata' | 'summary' | 'activation_count' | 'last_activated_at_event'>[];

    return rows.map(r => ({
      id: r.id,
      nodeType: (r.node_type as MemoryNodeTypeNullable) ?? null,
      nodeRole: r.node_role as MemoryNodeRole,
      frontmatter: r.frontmatter,
      keywords: r.keywords,
      activationCount: r.activation_count,
      lastActivatedAtEvent: r.last_activated_at_event,
      metadata: JSON.parse(r.metadata) as MemoryNodeMetadata,
      summary: r.summary,
    }));
  }

  // ═══════════════════════════════════════════════════════════════
  // FTS5 SEARCH (L0 layer — 한영 혼용)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Full-text search across frontmatter + keywords + summary.
   * Returns node IDs ranked by BM25 with column weighting:
   *   frontmatter: 2.0, keywords: 10.0, summary: 1.0
   * Keywords get highest weight since they are pre-normalized search anchors.
   */
  ftsSearch(query: string, limit: number = 50): { id: string; rank: number }[] {
    if (!query.trim()) return [];

    const matchExpr = buildFtsMatchQuery(query);
    if (!matchExpr) return [];

    const rows = this.db.prepare(`
      SELECT mn.id, bm25(memory_nodes_fts, 2.0, 10.0, 1.0) AS rank
      FROM memory_nodes_fts fts
      JOIN memory_nodes mn ON mn.rowid = fts.rowid
      WHERE memory_nodes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(matchExpr, limit) as { id: string; rank: number }[];

    return rows;
  }

  /**
   * Keyword-only FTS5 search (targets the keywords column specifically).
   * Useful for precise keyword matching without frontmatter/summary noise.
   */
  ftsKeywordSearch(query: string, limit: number = 50): { id: string; rank: number }[] {
    if (!query.trim()) return [];

    const matchExpr = buildColumnFtsQuery('keywords', query);
    if (!matchExpr) return [];

    const rows = this.db.prepare(`
      SELECT mn.id, bm25(memory_nodes_fts, 0.0, 10.0, 0.0) AS rank
      FROM memory_nodes_fts fts
      JOIN memory_nodes mn ON mn.rowid = fts.rowid
      WHERE memory_nodes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(matchExpr, limit) as { id: string; rank: number }[];

    return rows;
  }

  /**
   * FTS5 search filtered by node type/role.
   * Uses BM25 column weighting: frontmatter:2, keywords:10, summary:1.
   */
  ftsSearchFiltered(
    query: string,
    opts: { nodeType?: MemoryNodeTypeNullable | MemoryNodeTypeNullable[]; nodeRole?: MemoryNodeRole; limit?: number }
  ): { id: string; rank: number }[] {
    if (!query.trim()) return [];

    const matchExpr = buildFtsMatchQuery(query);
    if (!matchExpr) return [];

    const conditions: string[] = [];
    const params: unknown[] = [matchExpr];

    if (opts.nodeType !== undefined) {
      if (Array.isArray(opts.nodeType)) {
        const nonNull = opts.nodeType.filter((t): t is MemoryNodeType => t !== null);
        const hasNull = opts.nodeType.includes(null);
        const parts: string[] = [];
        if (nonNull.length > 0) {
          const placeholders = nonNull.map(() => '?').join(',');
          parts.push(`mn.node_type IN (${placeholders})`);
          params.push(...nonNull);
        }
        if (hasNull) parts.push('mn.node_type IS NULL');
        if (parts.length > 0) conditions.push(`(${parts.join(' OR ')})`);
      } else if (opts.nodeType === null) {
        conditions.push('mn.node_type IS NULL');
      } else {
        conditions.push('mn.node_type = ?');
        params.push(opts.nodeType);
      }
    }

    if (opts.nodeRole) {
      conditions.push('mn.node_role = ?');
      params.push(opts.nodeRole);
    }

    const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
    params.push(opts.limit ?? 50);

    const rows = this.db.prepare(`
      SELECT mn.id, bm25(memory_nodes_fts, 2.0, 10.0, 1.0) AS rank
      FROM memory_nodes_fts fts
      JOIN memory_nodes mn ON mn.rowid = fts.rowid
      WHERE memory_nodes_fts MATCH ?
      ${where}
      ORDER BY rank
      LIMIT ?
    `).all(...params) as { id: string; rank: number }[];

    return rows;
  }

  // ═══════════════════════════════════════════════════════════════
  // VECTOR SEARCH (L0 layer — embedding)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get all embeddings for brute-force cosine similarity.
   * For large datasets, use ftsSearch first to pre-filter candidates.
   */
  getAllEmbeddings(nodeType?: MemoryNodeTypeNullable): { id: string; embedding: Float32Array }[] {
    let where: string;
    let params: unknown[];
    if (nodeType !== undefined) {
      if (nodeType === null) {
        where = 'WHERE node_type IS NULL AND embedding IS NOT NULL';
        params = [];
      } else {
        where = 'WHERE node_type = ? AND embedding IS NOT NULL';
        params = [nodeType];
      }
    } else {
      where = 'WHERE embedding IS NOT NULL';
      params = [];
    }

    const rows = this.db.prepare(
      `SELECT id, embedding, embedding_dim FROM memory_nodes ${where}`
    ).all(...params) as { id: string; embedding: Buffer; embedding_dim: number }[];

    return rows.map(r => ({
      id: r.id,
      embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding_dim),
    }));
  }

  /**
   * Get embeddings for specific node IDs (for FTS5-prefiltered vector reranking).
   */
  getEmbeddingsByIds(ids: string[]): Map<string, Float32Array> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, embedding, embedding_dim FROM memory_nodes WHERE id IN (${placeholders}) AND embedding IS NOT NULL`
    ).all(...ids) as { id: string; embedding: Buffer; embedding_dim: number }[];

    const map = new Map<string, Float32Array>();
    for (const r of rows) {
      map.set(r.id, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding_dim));
    }
    return map;
  }

  // ═══════════════════════════════════════════════════════════════
  // UPDATE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Update a MemoryNode's mutable fields.
   */
  update(id: string, input: UpdateMemoryNodeInput): MemoryNode | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.frontmatter != null) {
      sets.push('frontmatter = ?');
      params.push(input.frontmatter);
    }
    if (input.keywords != null) {
      sets.push('keywords = ?');
      params.push(normalizeKeywords(input.keywords));
    }
    if (input.embedding != null) {
      sets.push('embedding = ?', 'embedding_dim = ?');
      params.push(
        Buffer.from(input.embedding.buffer, input.embedding.byteOffset, input.embedding.byteLength),
        input.embeddingDim ?? input.embedding.length,
      );
    }
    if (input.metadata != null) {
      const merged = { ...existing.metadata, ...input.metadata };
      sets.push('metadata = ?');
      params.push(JSON.stringify(merged));
    }
    if (input.summary != null) {
      sets.push('summary = ?');
      params.push(input.summary);
    }
    if (input.sourceMessageIds != null) {
      sets.push('source_message_ids = ?');
      params.push(JSON.stringify(input.sourceMessageIds));
    }
    if (input.nodeRole != null) {
      sets.push('node_role = ?');
      params.push(input.nodeRole);
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    this.db.prepare(`UPDATE memory_nodes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getById(id);
  }

  /**
   * Record an activation (retrieval/reinforcement) — increments activation_count
   * and updates last_activated_at_event.
   */
  recordActivation(id: string, currentEventCounter: number): void {
    this.db.prepare(`
      UPDATE memory_nodes
      SET activation_count = activation_count + 1,
          last_activated_at_event = ?,
          updated_at = ?
      WHERE id = ?
    `).run(currentEventCounter, new Date().toISOString(), id);
  }

  /**
   * Batch record activations for multiple nodes.
   */
  recordActivationBatch(ids: string[], currentEventCounter: number): void {
    if (ids.length === 0) return;
    const txn = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE memory_nodes
        SET activation_count = activation_count + 1,
            last_activated_at_event = ?,
            updated_at = ?
        WHERE id = ?
      `);
      const now = new Date().toISOString();
      for (const id of ids) {
        stmt.run(currentEventCounter, now, id);
      }
    });
    txn();
  }

  /**
   * Promote a leaf node to hub role.
   */
  promoteToHub(id: string): MemoryNode | null {
    this.db.prepare(`
      UPDATE memory_nodes SET node_role = 'hub', updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), id);
    return this.getById(id);
  }

  // ═══════════════════════════════════════════════════════════════
  // DELETE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Delete a MemoryNode by ID.
   */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ═══════════════════════════════════════════════════════════════

  private rowToNode(row: MemoryNodeRow): MemoryNode {
    let embedding: Float32Array | undefined;
    if (row.embedding && row.embedding_dim) {
      embedding = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding_dim,
      );
    }

    return {
      id: row.id,
      nodeType: (row.node_type as MemoryNodeTypeNullable) ?? null,
      nodeRole: row.node_role as MemoryNodeRole,
      frontmatter: row.frontmatter,
      keywords: row.keywords,
      embedding,
      embeddingDim: row.embedding_dim ?? undefined,
      metadata: JSON.parse(row.metadata) as MemoryNodeMetadata,
      summary: row.summary,
      sourceMessageIds: JSON.parse(row.source_message_ids) as string[],
      conversationId: row.conversation_id ?? undefined,
      sourceTurnIndex: row.source_turn_index ?? undefined,
      createdAtEvent: row.created_at_event,
      lastActivatedAtEvent: row.last_activated_at_event,
      activationCount: row.activation_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

}
