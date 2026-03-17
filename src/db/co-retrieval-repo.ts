/**
 * Co-Retrieval Repository — SQLite persistence for co-retrieval events
 * and pair frequency counters.
 *
 * This repository provides:
 * - Event logging: immutable record of each retrieval result set
 * - Pair frequency: upsert-style counter for each unique (nodeA, nodeB) pair
 * - Query: find top co-retrieved pairs for a given node
 * - Stats: aggregate statistics about co-retrieval patterns
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  CoRetrievalEvent,
  RecordCoRetrievalInput,
  CoRetrievalPair,
  CoRetrievalPairRef,
  CoRetrievalPairFilter,
  CoRetrievalStats,
} from '../models/co-retrieval.js';
import type { MemoryNodeType } from '../models/memory-edge.js';

// ─── Row types for SQLite results ────────────────────────────

interface EventRow {
  id: string;
  query_text: string;
  retrieved_node_ids: string;
  result_count: number;
  created_at: string;
  metadata: string | null;
}

interface PairRow {
  id: string;
  node_a_id: string;
  node_a_type: string;
  node_b_id: string;
  node_b_type: string;
  frequency: number;
  first_seen_at: string;
  last_seen_at: string;
}

interface StatsRow {
  total_events: number;
  total_pairs: number;
  max_frequency: number;
  avg_frequency: number;
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Normalize a pair into canonical order: (smaller, larger) by lexicographic comparison.
 */
function canonicalPair(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

function rowToEvent(row: EventRow): CoRetrievalEvent {
  return {
    id: row.id,
    queryText: row.query_text,
    retrievedNodeIds: JSON.parse(row.retrieved_node_ids),
    resultCount: row.result_count,
    createdAt: row.created_at,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

function rowToPair(row: PairRow): CoRetrievalPair {
  return {
    id: row.id,
    nodeAId: row.node_a_id,
    nodeAType: row.node_a_type as MemoryNodeType,
    nodeBId: row.node_b_id,
    nodeBType: row.node_b_type as MemoryNodeType,
    frequency: row.frequency,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

// ─── Repository ──────────────────────────────────────────────

export class CoRetrievalRepository {
  private stmts: ReturnType<CoRetrievalRepository['prepareStatements']>;

  constructor(private db: Database.Database) {
    this.stmts = this.prepareStatements();
  }

  // ── Event Logging ──

  /**
   * Record a co-retrieval event and update pair frequencies.
   * Returns the created event.
   */
  recordEvent(input: RecordCoRetrievalInput): CoRetrievalEvent {
    const id = uuidv4();
    const now = new Date().toISOString();

    const event: CoRetrievalEvent = {
      id,
      queryText: input.queryText,
      retrievedNodeIds: input.retrievedNodeIds,
      resultCount: input.retrievedNodeIds.length,
      createdAt: now,
      metadata: input.metadata,
    };

    this.stmts.insertEvent.run(
      id,
      input.queryText,
      JSON.stringify(input.retrievedNodeIds),
      input.retrievedNodeIds.length,
      now,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );

    return event;
  }

  /**
   * Get a co-retrieval event by ID.
   */
  getEvent(id: string): CoRetrievalEvent | null {
    const row = this.stmts.getEvent.get(id) as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  /**
   * Get recent co-retrieval events (most recent first).
   */
  getRecentEvents(limit: number = 50): CoRetrievalEvent[] {
    const rows = this.stmts.getRecentEvents.all(limit) as EventRow[];
    return rows.map(rowToEvent);
  }

  // ── Pair Frequency ──

  /**
   * Increment the frequency for all pairs in a set of co-retrieved node IDs.
   * Uses canonical ordering (nodeA < nodeB) for deduplication.
   *
   * @param nodeIds - Array of retrieved node IDs
   * @param nodeTypeMap - Map of nodeId → nodeType for type tracking
   * @returns Number of pairs upserted
   */
  incrementPairs(
    nodeIds: string[],
    nodeTypeMap: Map<string, MemoryNodeType>,
  ): number {
    if (nodeIds.length < 2) return 0;

    const now = new Date().toISOString();
    let count = 0;

    // Generate all unique pairs in canonical order
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const [a, b] = canonicalPair(nodeIds[i], nodeIds[j]);
        const typeA = nodeTypeMap.get(a) ?? 'fact';
        const typeB = nodeTypeMap.get(b) ?? 'fact';

        // Try UPDATE first (increment), then INSERT if no row updated
        const updated = this.stmts.incrementPair.run(now, a, b);
        if (updated.changes === 0) {
          const id = uuidv4();
          this.stmts.insertPair.run(id, a, typeA, b, typeB, 1, now, now);
        }
        count++;
      }
    }

    return count;
  }

  /**
   * Get a specific pair by both node IDs (order-independent).
   */
  getPair(nodeId1: string, nodeId2: string): CoRetrievalPair | null {
    const [a, b] = canonicalPair(nodeId1, nodeId2);
    const row = this.stmts.getPair.get(a, b) as PairRow | undefined;
    return row ? rowToPair(row) : null;
  }

  /**
   * Query co-retrieval pairs with filters.
   */
  queryPairs(filter: CoRetrievalPairFilter = {}): CoRetrievalPair[] {
    const limit = filter.limit ?? 50;
    const orderCol = filter.orderBy === 'recency' ? 'last_seen_at' : 'frequency';

    // Build dynamic query based on filters
    let sql = 'SELECT * FROM co_retrieval_pairs WHERE 1=1';
    const params: unknown[] = [];

    if (filter.nodeId) {
      sql += ' AND (node_a_id = ? OR node_b_id = ?)';
      params.push(filter.nodeId, filter.nodeId);
    }

    if (filter.minFrequency !== undefined) {
      sql += ' AND frequency >= ?';
      params.push(filter.minFrequency);
    }

    if (filter.nodeType) {
      sql += ' AND (node_a_type = ? OR node_b_type = ?)';
      params.push(filter.nodeType, filter.nodeType);
    }

    sql += ` ORDER BY ${orderCol} DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as PairRow[];
    return rows.map(rowToPair);
  }

  /**
   * Get top co-retrieved partners for a given node (by frequency).
   */
  getTopPartners(nodeId: string, limit: number = 10): CoRetrievalPairRef[] {
    const rows = this.stmts.getTopPartners.all(nodeId, nodeId, limit) as PairRow[];
    return rows.map(row => ({
      nodeAId: row.node_a_id,
      nodeBId: row.node_b_id,
      frequency: row.frequency,
      lastSeenAt: row.last_seen_at,
    }));
  }

  // ── Statistics ──

  /**
   * Get aggregate statistics about co-retrieval patterns.
   */
  getStats(): CoRetrievalStats {
    const eventCount = this.stmts.countEvents.get() as { cnt: number };
    const pairStats = this.stmts.pairStats.get() as StatsRow | undefined;

    return {
      totalEvents: eventCount.cnt,
      totalPairs: pairStats?.total_pairs ?? 0,
      maxFrequency: pairStats?.max_frequency ?? 0,
      avgFrequency: pairStats?.avg_frequency ?? 0,
    };
  }

  // ── Cleanup ──

  /**
   * Delete co-retrieval events older than the specified date.
   * Pair frequencies are preserved (they aggregate over time).
   */
  pruneEvents(olderThan: string): number {
    const result = this.stmts.pruneEvents.run(olderThan);
    return result.changes;
  }

  /**
   * Delete pairs with frequency below threshold.
   */
  pruneLowFrequencyPairs(minFrequency: number): number {
    const result = this.stmts.pruneLowFrequencyPairs.run(minFrequency);
    return result.changes;
  }

  // ── Prepared Statements ──

  private prepareStatements() {
    return {
      insertEvent: this.db.prepare(`
        INSERT INTO co_retrieval_events (id, query_text, retrieved_node_ids, result_count, created_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `),

      getEvent: this.db.prepare(`
        SELECT * FROM co_retrieval_events WHERE id = ?
      `),

      getRecentEvents: this.db.prepare(`
        SELECT * FROM co_retrieval_events ORDER BY created_at DESC LIMIT ?
      `),

      incrementPair: this.db.prepare(`
        UPDATE co_retrieval_pairs
        SET frequency = frequency + 1, last_seen_at = ?
        WHERE node_a_id = ? AND node_b_id = ?
      `),

      insertPair: this.db.prepare(`
        INSERT INTO co_retrieval_pairs (id, node_a_id, node_a_type, node_b_id, node_b_type, frequency, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),

      getPair: this.db.prepare(`
        SELECT * FROM co_retrieval_pairs WHERE node_a_id = ? AND node_b_id = ?
      `),

      getTopPartners: this.db.prepare(`
        SELECT * FROM co_retrieval_pairs
        WHERE node_a_id = ? OR node_b_id = ?
        ORDER BY frequency DESC
        LIMIT ?
      `),

      countEvents: this.db.prepare(`
        SELECT COUNT(*) as cnt FROM co_retrieval_events
      `),

      pairStats: this.db.prepare(`
        SELECT
          COUNT(*) as total_pairs,
          COALESCE(MAX(frequency), 0) as max_frequency,
          COALESCE(AVG(frequency), 0) as avg_frequency
        FROM co_retrieval_pairs
      `),

      pruneEvents: this.db.prepare(`
        DELETE FROM co_retrieval_events WHERE created_at < ?
      `),

      pruneLowFrequencyPairs: this.db.prepare(`
        DELETE FROM co_retrieval_pairs WHERE frequency < ?
      `),
    };
  }
}
