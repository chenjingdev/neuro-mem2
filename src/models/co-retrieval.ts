/**
 * Co-retrieval tracking models — records when memory nodes are retrieved
 * together during dual-path recall, enabling Hebbian-style reinforcement
 * of frequently co-activated memory pairs.
 *
 * A co-retrieval event is logged whenever a recall query returns multiple
 * memory nodes. Each unique pair of co-retrieved nodes accumulates a
 * frequency count, which can later be used to:
 *   - Strengthen edges between frequently co-activated nodes
 *   - Discover implicit relationships not captured by extraction
 *   - Tune retrieval ranking via pair affinity scores
 */

import type { MemoryNodeType } from './memory-edge.js';

// ─── Co-Retrieval Event ──────────────────────────────────────

/**
 * A single co-retrieval event: a set of memory nodes returned
 * together for a given query. Immutable after creation.
 */
export interface CoRetrievalEvent {
  /** Unique event identifier (UUID v4) */
  id: string;
  /** The query text that triggered this retrieval */
  queryText: string;
  /** IDs of all memory nodes returned in this retrieval */
  retrievedNodeIds: string[];
  /** Number of nodes in this retrieval result set */
  resultCount: number;
  /** ISO 8601 timestamp of the retrieval event */
  createdAt: string;
  /** Optional metadata (e.g., diagnostics snapshot) */
  metadata?: Record<string, unknown>;
}

/**
 * Input for recording a co-retrieval event.
 */
export interface RecordCoRetrievalInput {
  /** The query text that triggered this retrieval */
  queryText: string;
  /** IDs of all memory nodes returned in this retrieval */
  retrievedNodeIds: string[];
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

// ─── Co-Retrieval Pair Frequency ─────────────────────────────

/**
 * Frequency counter for a specific pair of memory nodes that have
 * been retrieved together. The pair is order-independent:
 * (nodeA, nodeB) is the same as (nodeB, nodeA).
 *
 * The canonical ordering is: nodeA < nodeB (lexicographic).
 */
export interface CoRetrievalPair {
  /** Unique pair identifier (UUID v4) */
  id: string;
  /** First node ID (lexicographically smaller) */
  nodeAId: string;
  /** Type of the first node */
  nodeAType: MemoryNodeType;
  /** Second node ID (lexicographically larger) */
  nodeBId: string;
  /** Type of the second node */
  nodeBType: MemoryNodeType;
  /** Number of times this pair was co-retrieved */
  frequency: number;
  /** ISO 8601 timestamp of first co-retrieval */
  firstSeenAt: string;
  /** ISO 8601 timestamp of most recent co-retrieval */
  lastSeenAt: string;
}

/**
 * Lightweight reference to a co-retrieval pair with its frequency.
 */
export interface CoRetrievalPairRef {
  nodeAId: string;
  nodeBId: string;
  frequency: number;
  lastSeenAt: string;
}

/**
 * Filter options for querying co-retrieval pairs.
 */
export interface CoRetrievalPairFilter {
  /** Filter pairs containing this node ID */
  nodeId?: string;
  /** Minimum frequency threshold */
  minFrequency?: number;
  /** Filter by node type (either side) */
  nodeType?: MemoryNodeType;
  /** Maximum number of results */
  limit?: number;
  /** Order by: 'frequency' (desc) or 'recency' (desc) */
  orderBy?: 'frequency' | 'recency';
}

/**
 * Statistics about co-retrieval tracking.
 */
export interface CoRetrievalStats {
  /** Total number of co-retrieval events logged */
  totalEvents: number;
  /** Total number of unique co-retrieved pairs */
  totalPairs: number;
  /** Maximum pair frequency observed */
  maxFrequency: number;
  /** Average pair frequency */
  avgFrequency: number;
}
