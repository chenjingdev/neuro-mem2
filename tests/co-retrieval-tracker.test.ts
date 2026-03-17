/**
 * Tests for the Co-Retrieval Tracker — records memory pair co-activations
 * during dual-path retrieval and maintains pair frequency counters.
 *
 * Sub-AC 5.1: Co-retrieval 추적 모듈 구현
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { CoRetrievalRepository } from '../src/db/co-retrieval-repo.js';
import { CoRetrievalTracker } from '../src/retrieval/co-retrieval-tracker.js';
import type { MergedMemoryItem } from '../src/retrieval/types.js';
import type { MemoryNodeType } from '../src/models/memory-edge.js';

// ── Test helpers ──

function createTestDB(): Database.Database {
  return createDatabase({ inMemory: true });
}

function makeMergedItem(
  nodeId: string,
  nodeType: MemoryNodeType,
  score: number = 0.5,
): MergedMemoryItem {
  return {
    nodeId,
    nodeType,
    score,
    content: `Content for ${nodeId}`,
    sources: ['vector'],
    sourceScores: { vector: score },
  };
}

// ── Tests ──

describe('CoRetrievalRepository', () => {
  let db: Database.Database;
  let repo: CoRetrievalRepository;

  beforeEach(() => {
    db = createTestDB();
    repo = new CoRetrievalRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('event logging', () => {
    it('records a co-retrieval event', () => {
      const event = repo.recordEvent({
        queryText: 'TypeScript project setup',
        retrievedNodeIds: ['node-a', 'node-b', 'node-c'],
      });

      expect(event.id).toBeDefined();
      expect(event.queryText).toBe('TypeScript project setup');
      expect(event.retrievedNodeIds).toEqual(['node-a', 'node-b', 'node-c']);
      expect(event.resultCount).toBe(3);
      expect(event.createdAt).toBeDefined();
    });

    it('retrieves an event by ID', () => {
      const created = repo.recordEvent({
        queryText: 'test query',
        retrievedNodeIds: ['a', 'b'],
      });

      const found = repo.getEvent(created.id);
      expect(found).not.toBeNull();
      expect(found!.queryText).toBe('test query');
      expect(found!.retrievedNodeIds).toEqual(['a', 'b']);
    });

    it('returns null for nonexistent event', () => {
      expect(repo.getEvent('nonexistent')).toBeNull();
    });

    it('stores optional metadata', () => {
      const event = repo.recordEvent({
        queryText: 'test',
        retrievedNodeIds: ['a'],
        metadata: { vectorTimeMs: 42, graphTimeMs: 15 },
      });

      const found = repo.getEvent(event.id);
      expect(found!.metadata).toEqual({ vectorTimeMs: 42, graphTimeMs: 15 });
    });

    it('gets recent events with limit', () => {
      repo.recordEvent({ queryText: 'first', retrievedNodeIds: ['a'] });
      repo.recordEvent({ queryText: 'second', retrievedNodeIds: ['b'] });
      repo.recordEvent({ queryText: 'third', retrievedNodeIds: ['c'] });

      const events = repo.getRecentEvents(2);
      expect(events).toHaveLength(2);

      // All 3 events exist
      const allEvents = repo.getRecentEvents(10);
      expect(allEvents).toHaveLength(3);
    });
  });

  describe('pair frequency', () => {
    it('creates pair entries for co-retrieved nodes', () => {
      const nodeTypeMap = new Map<string, MemoryNodeType>([
        ['a', 'fact'],
        ['b', 'concept'],
        ['c', 'episode'],
      ]);

      const count = repo.incrementPairs(['a', 'b', 'c'], nodeTypeMap);
      // 3 nodes → 3 pairs: (a,b), (a,c), (b,c)
      expect(count).toBe(3);
    });

    it('increments frequency on repeated co-retrieval', () => {
      const nodeTypeMap = new Map<string, MemoryNodeType>([
        ['a', 'fact'],
        ['b', 'concept'],
      ]);

      repo.incrementPairs(['a', 'b'], nodeTypeMap);
      repo.incrementPairs(['a', 'b'], nodeTypeMap);
      repo.incrementPairs(['a', 'b'], nodeTypeMap);

      const pair = repo.getPair('a', 'b');
      expect(pair).not.toBeNull();
      expect(pair!.frequency).toBe(3);
    });

    it('uses canonical pair ordering (lexicographic)', () => {
      const nodeTypeMap = new Map<string, MemoryNodeType>([
        ['z-node', 'fact'],
        ['a-node', 'concept'],
      ]);

      repo.incrementPairs(['z-node', 'a-node'], nodeTypeMap);

      // Should find the pair regardless of query order
      const pair1 = repo.getPair('z-node', 'a-node');
      const pair2 = repo.getPair('a-node', 'z-node');

      expect(pair1).not.toBeNull();
      expect(pair2).not.toBeNull();
      expect(pair1!.id).toBe(pair2!.id);
      // Canonical: a-node < z-node
      expect(pair1!.nodeAId).toBe('a-node');
      expect(pair1!.nodeBId).toBe('z-node');
    });

    it('returns 0 pairs for single node', () => {
      const nodeTypeMap = new Map<string, MemoryNodeType>([['a', 'fact']]);
      const count = repo.incrementPairs(['a'], nodeTypeMap);
      expect(count).toBe(0);
    });

    it('returns 0 pairs for empty array', () => {
      const count = repo.incrementPairs([], new Map());
      expect(count).toBe(0);
    });

    it('tracks first_seen_at and last_seen_at', () => {
      const nodeTypeMap = new Map<string, MemoryNodeType>([
        ['a', 'fact'],
        ['b', 'concept'],
      ]);

      repo.incrementPairs(['a', 'b'], nodeTypeMap);
      const pair1 = repo.getPair('a', 'b')!;
      expect(pair1.firstSeenAt).toBeDefined();
      expect(pair1.lastSeenAt).toBe(pair1.firstSeenAt);

      // Increment again — last_seen_at should update
      repo.incrementPairs(['a', 'b'], nodeTypeMap);
      const pair2 = repo.getPair('a', 'b')!;
      expect(pair2.firstSeenAt).toBe(pair1.firstSeenAt);
      expect(pair2.lastSeenAt).toBeDefined();
    });

    it('gets top partners by frequency', () => {
      const nodeTypeMap = new Map<string, MemoryNodeType>([
        ['center', 'fact'],
        ['freq3', 'concept'],
        ['freq1', 'episode'],
        ['freq2', 'fact'],
      ]);

      // center+freq3: 3 co-retrievals
      for (let i = 0; i < 3; i++) {
        repo.incrementPairs(['center', 'freq3'], nodeTypeMap);
      }

      // center+freq2: 2 co-retrievals
      for (let i = 0; i < 2; i++) {
        repo.incrementPairs(['center', 'freq2'], nodeTypeMap);
      }

      // center+freq1: 1 co-retrieval
      repo.incrementPairs(['center', 'freq1'], nodeTypeMap);

      const partners = repo.getTopPartners('center', 10);
      expect(partners).toHaveLength(3);
      expect(partners[0].frequency).toBe(3);
      expect(partners[1].frequency).toBe(2);
      expect(partners[2].frequency).toBe(1);
    });
  });

  describe('query pairs with filters', () => {
    beforeEach(() => {
      const nodeTypeMap = new Map<string, MemoryNodeType>([
        ['f1', 'fact'],
        ['f2', 'fact'],
        ['c1', 'concept'],
        ['e1', 'episode'],
      ]);

      // Create pairs with different frequencies
      for (let i = 0; i < 5; i++) repo.incrementPairs(['f1', 'c1'], nodeTypeMap);
      for (let i = 0; i < 3; i++) repo.incrementPairs(['f1', 'f2'], nodeTypeMap);
      repo.incrementPairs(['c1', 'e1'], nodeTypeMap);
    });

    it('filters by nodeId', () => {
      const pairs = repo.queryPairs({ nodeId: 'f1' });
      expect(pairs).toHaveLength(2);
    });

    it('filters by minFrequency', () => {
      const pairs = repo.queryPairs({ minFrequency: 3 });
      expect(pairs).toHaveLength(2); // f1-c1 (5) and f1-f2 (3)
    });

    it('filters by nodeType', () => {
      const pairs = repo.queryPairs({ nodeType: 'episode' });
      expect(pairs).toHaveLength(1); // c1-e1
    });

    it('orders by frequency by default', () => {
      const pairs = repo.queryPairs({});
      expect(pairs[0].frequency).toBeGreaterThanOrEqual(pairs[1].frequency);
    });

    it('respects limit', () => {
      const pairs = repo.queryPairs({ limit: 1 });
      expect(pairs).toHaveLength(1);
    });
  });

  describe('statistics', () => {
    it('returns zeroed stats when empty', () => {
      const stats = repo.getStats();
      expect(stats.totalEvents).toBe(0);
      expect(stats.totalPairs).toBe(0);
      expect(stats.maxFrequency).toBe(0);
      expect(stats.avgFrequency).toBe(0);
    });

    it('returns correct stats after tracking', () => {
      repo.recordEvent({ queryText: 'q1', retrievedNodeIds: ['a', 'b'] });
      repo.recordEvent({ queryText: 'q2', retrievedNodeIds: ['a', 'c'] });

      const nodeTypeMap = new Map<string, MemoryNodeType>([
        ['a', 'fact'],
        ['b', 'concept'],
        ['c', 'episode'],
      ]);
      repo.incrementPairs(['a', 'b'], nodeTypeMap);
      repo.incrementPairs(['a', 'b'], nodeTypeMap);
      repo.incrementPairs(['a', 'c'], nodeTypeMap);

      const stats = repo.getStats();
      expect(stats.totalEvents).toBe(2);
      expect(stats.totalPairs).toBe(2);
      expect(stats.maxFrequency).toBe(2);
      expect(stats.avgFrequency).toBe(1.5);
    });
  });

  describe('cleanup', () => {
    it('prunes events older than a given date', () => {
      repo.recordEvent({ queryText: 'old', retrievedNodeIds: ['a'] });

      // Prune with future date — should remove everything
      const pruned = repo.pruneEvents('2099-01-01T00:00:00.000Z');
      expect(pruned).toBe(1);
      expect(repo.getRecentEvents(10)).toHaveLength(0);
    });

    it('prunes low-frequency pairs', () => {
      const nodeTypeMap = new Map<string, MemoryNodeType>([
        ['a', 'fact'],
        ['b', 'concept'],
        ['c', 'episode'],
      ]);

      // a-b: frequency 3
      for (let i = 0; i < 3; i++) repo.incrementPairs(['a', 'b'], nodeTypeMap);
      // a-c: frequency 1
      repo.incrementPairs(['a', 'c'], nodeTypeMap);

      const pruned = repo.pruneLowFrequencyPairs(2);
      expect(pruned).toBe(1); // a-c removed

      expect(repo.getPair('a', 'b')).not.toBeNull();
      expect(repo.getPair('a', 'c')).toBeNull();
    });
  });
});

describe('CoRetrievalTracker', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDB();
  });

  afterEach(() => {
    db.close();
  });

  describe('track()', () => {
    it('logs event and updates pair frequencies from retrieval results', () => {
      const tracker = new CoRetrievalTracker(db);

      const items: MergedMemoryItem[] = [
        makeMergedItem('fact-1', 'fact', 0.9),
        makeMergedItem('concept-1', 'concept', 0.8),
        makeMergedItem('episode-1', 'episode', 0.7),
      ];

      const result = tracker.track('TypeScript project', items);

      expect(result.tracked).toBe(true);
      expect(result.eventId).toBeDefined();
      // 3 nodes → 3 pairs
      expect(result.pairsUpdated).toBe(3);
    });

    it('skips tracking when disabled', () => {
      const tracker = new CoRetrievalTracker(db, { enabled: false });

      const items = [
        makeMergedItem('a', 'fact'),
        makeMergedItem('b', 'concept'),
      ];

      const result = tracker.track('query', items);
      expect(result.tracked).toBe(false);
      expect(result.pairsUpdated).toBe(0);
    });

    it('skips tracking when fewer results than minimum', () => {
      const tracker = new CoRetrievalTracker(db, { minResultsToTrack: 3 });

      const items = [
        makeMergedItem('a', 'fact'),
        makeMergedItem('b', 'concept'),
      ];

      const result = tracker.track('query', items);
      expect(result.tracked).toBe(false);
    });

    it('limits tracked pairs to maxPairsResultCount', () => {
      const tracker = new CoRetrievalTracker(db, { maxPairsResultCount: 3 });

      // 5 items, but only top 3 should be tracked
      const items = [
        makeMergedItem('a', 'fact', 0.9),
        makeMergedItem('b', 'fact', 0.8),
        makeMergedItem('c', 'concept', 0.7),
        makeMergedItem('d', 'episode', 0.6),
        makeMergedItem('e', 'fact', 0.5),
      ];

      const result = tracker.track('query', items);
      expect(result.tracked).toBe(true);
      // Top 3 items → 3 pairs: (a,b), (a,c), (b,c)
      expect(result.pairsUpdated).toBe(3);
    });

    it('accumulates frequency across multiple retrievals', () => {
      const tracker = new CoRetrievalTracker(db);

      const items = [
        makeMergedItem('fact-1', 'fact'),
        makeMergedItem('concept-1', 'concept'),
      ];

      // Track same pair 3 times
      tracker.track('query 1', items);
      tracker.track('query 2', items);
      tracker.track('query 3', items);

      const freq = tracker.getPairFrequency('fact-1', 'concept-1');
      expect(freq).toBe(3);
    });
  });

  describe('query API', () => {
    it('returns top partners for a node', () => {
      const tracker = new CoRetrievalTracker(db);

      // fact-1 co-retrieved with concept-1 (3 times), episode-1 (1 time)
      for (let i = 0; i < 3; i++) {
        tracker.track('q', [
          makeMergedItem('fact-1', 'fact'),
          makeMergedItem('concept-1', 'concept'),
        ]);
      }
      tracker.track('q', [
        makeMergedItem('fact-1', 'fact'),
        makeMergedItem('episode-1', 'episode'),
      ]);

      const partners = tracker.getTopPartners('fact-1');
      expect(partners).toHaveLength(2);
      expect(partners[0].frequency).toBe(3);
      expect(partners[1].frequency).toBe(1);
    });

    it('returns 0 frequency for unseen pair', () => {
      const tracker = new CoRetrievalTracker(db);
      expect(tracker.getPairFrequency('a', 'b')).toBe(0);
    });

    it('queries pairs with filters', () => {
      const tracker = new CoRetrievalTracker(db);

      for (let i = 0; i < 5; i++) {
        tracker.track('q', [
          makeMergedItem('f1', 'fact'),
          makeMergedItem('c1', 'concept'),
        ]);
      }
      tracker.track('q', [
        makeMergedItem('f1', 'fact'),
        makeMergedItem('e1', 'episode'),
      ]);

      const highFreq = tracker.queryPairs({ minFrequency: 3 });
      expect(highFreq).toHaveLength(1);
      expect(highFreq[0].frequency).toBe(5);
    });

    it('returns recent events', () => {
      const tracker = new CoRetrievalTracker(db);

      tracker.track('query A', [
        makeMergedItem('a', 'fact'),
        makeMergedItem('b', 'concept'),
      ]);
      tracker.track('query B', [
        makeMergedItem('c', 'fact'),
        makeMergedItem('d', 'concept'),
      ]);

      const events = tracker.getRecentEvents(10);
      expect(events).toHaveLength(2);
      const queryTexts = events.map(e => e.queryText);
      expect(queryTexts).toContain('query A');
      expect(queryTexts).toContain('query B');
    });

    it('returns statistics', () => {
      const tracker = new CoRetrievalTracker(db);

      tracker.track('q1', [
        makeMergedItem('a', 'fact'),
        makeMergedItem('b', 'concept'),
        makeMergedItem('c', 'episode'),
      ]);

      const stats = tracker.getStats();
      expect(stats.totalEvents).toBe(1);
      expect(stats.totalPairs).toBe(3);
    });
  });

  describe('maintenance', () => {
    it('prunes old events', () => {
      const tracker = new CoRetrievalTracker(db);

      tracker.track('old query', [
        makeMergedItem('a', 'fact'),
        makeMergedItem('b', 'concept'),
      ]);

      const pruned = tracker.pruneEvents('2099-01-01T00:00:00.000Z');
      expect(pruned).toBe(1);
    });

    it('prunes low-frequency pairs', () => {
      const tracker = new CoRetrievalTracker(db);

      // High frequency pair
      for (let i = 0; i < 5; i++) {
        tracker.track('q', [
          makeMergedItem('a', 'fact'),
          makeMergedItem('b', 'concept'),
        ]);
      }

      // Low frequency pair
      tracker.track('q', [
        makeMergedItem('a', 'fact'),
        makeMergedItem('c', 'episode'),
      ]);

      const pruned = tracker.pruneLowFrequencyPairs(3);
      expect(pruned).toBe(1);
      expect(tracker.getPairFrequency('a', 'b')).toBe(5);
      expect(tracker.getPairFrequency('a', 'c')).toBe(0);
    });
  });
});
