/**
 * Co-Retrieval Tracker — records memory pair co-activations during retrieval.
 *
 * After each dual-path recall, this tracker:
 * 1. Logs a co-retrieval event (the full result set for the query)
 * 2. Increments pair frequencies for all node pairs in the result set
 *
 * The tracker is designed to be called after retrieval merging is complete,
 * operating on the final MergedMemoryItem[] result set. It is intentionally
 * decoupled from the retriever itself to keep retrieval fast and allow
 * tracking to be disabled without modifying retrieval logic.
 *
 * Usage:
 *   const tracker = new CoRetrievalTracker(db);
 *   const result = await retriever.recall(query);
 *   tracker.track(query.queryText, result.items);
 */

import type Database from 'better-sqlite3';
import type { MergedMemoryItem } from './types.js';
import type { MemoryNodeType } from '../models/memory-edge.js';
import type { CoRetrievalEvent, CoRetrievalPairFilter, CoRetrievalStats } from '../models/co-retrieval.js';
import { CoRetrievalRepository } from '../db/co-retrieval-repo.js';

// ─── Configuration ───────────────────────────────────────────

export interface CoRetrievalTrackerConfig {
  /** Minimum number of results to trigger co-retrieval tracking (default: 2) */
  minResultsToTrack: number;
  /** Maximum number of top results to track pairs for (default: 20) */
  maxPairsResultCount: number;
  /** Whether tracking is enabled (default: true) */
  enabled: boolean;
}

export const DEFAULT_CO_RETRIEVAL_TRACKER_CONFIG: CoRetrievalTrackerConfig = {
  minResultsToTrack: 2,
  maxPairsResultCount: 20,
  enabled: true,
};

// ─── Track Result ────────────────────────────────────────────

export interface TrackResult {
  /** Whether tracking was performed */
  tracked: boolean;
  /** The event ID if tracking was performed */
  eventId?: string;
  /** Number of pairs updated */
  pairsUpdated: number;
}

// ─── CoRetrievalTracker ─────────────────────────────────────

export class CoRetrievalTracker {
  private repo: CoRetrievalRepository;
  private config: CoRetrievalTrackerConfig;

  constructor(
    db: Database.Database,
    config?: Partial<CoRetrievalTrackerConfig>,
  ) {
    this.repo = new CoRetrievalRepository(db);
    this.config = { ...DEFAULT_CO_RETRIEVAL_TRACKER_CONFIG, ...config };
  }

  /**
   * Track a co-retrieval event from a recall result.
   *
   * Records:
   * 1. A co-retrieval event (immutable log entry)
   * 2. Pair frequency increments for all (nodeA, nodeB) pairs
   *
   * @param queryText - The query that produced these results
   * @param items - The merged retrieval results
   * @param metadata - Optional metadata to attach to the event
   */
  track(
    queryText: string,
    items: MergedMemoryItem[],
    metadata?: Record<string, unknown>,
  ): TrackResult {
    if (!this.config.enabled) {
      return { tracked: false, pairsUpdated: 0 };
    }

    if (items.length < this.config.minResultsToTrack) {
      return { tracked: false, pairsUpdated: 0 };
    }

    // Limit to top N results for pair tracking
    const trackableItems = items.slice(0, this.config.maxPairsResultCount);
    const nodeIds = trackableItems.map(item => item.nodeId);

    // Build node type map for pair tracking
    const nodeTypeMap = new Map<string, MemoryNodeType>();
    for (const item of trackableItems) {
      nodeTypeMap.set(item.nodeId, item.nodeType);
    }

    // 1. Log the co-retrieval event
    const event = this.repo.recordEvent({
      queryText,
      retrievedNodeIds: nodeIds,
      metadata,
    });

    // 2. Increment pair frequencies
    const pairsUpdated = this.repo.incrementPairs(nodeIds, nodeTypeMap);

    return {
      tracked: true,
      eventId: event.id,
      pairsUpdated,
    };
  }

  // ── Query API ──

  /**
   * Get top co-retrieved partners for a given memory node.
   */
  getTopPartners(nodeId: string, limit: number = 10) {
    return this.repo.getTopPartners(nodeId, limit);
  }

  /**
   * Get the pair frequency between two specific nodes.
   */
  getPairFrequency(nodeId1: string, nodeId2: string): number {
    const pair = this.repo.getPair(nodeId1, nodeId2);
    return pair?.frequency ?? 0;
  }

  /**
   * Query co-retrieval pairs with filters.
   */
  queryPairs(filter: CoRetrievalPairFilter = {}) {
    return this.repo.queryPairs(filter);
  }

  /**
   * Get recent co-retrieval events.
   */
  getRecentEvents(limit: number = 50): CoRetrievalEvent[] {
    return this.repo.getRecentEvents(limit);
  }

  /**
   * Get co-retrieval statistics.
   */
  getStats(): CoRetrievalStats {
    return this.repo.getStats();
  }

  // ── Maintenance ──

  /**
   * Prune old events (pair frequencies are preserved).
   */
  pruneEvents(olderThan: string): number {
    return this.repo.pruneEvents(olderThan);
  }

  /**
   * Remove low-frequency pairs (noise reduction).
   */
  pruneLowFrequencyPairs(minFrequency: number): number {
    return this.repo.pruneLowFrequencyPairs(minFrequency);
  }
}
