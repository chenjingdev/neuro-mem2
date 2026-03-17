/**
 * Tests for BFS Expander — weighted-edge BFS expansion from re-judged anchors.
 *
 * AC 11: 재판정된 anchor에서 weighted_edge BFS로 fact를 확장한다
 *
 * Tests cover:
 *   1. BFS discovers facts connected to re-judged anchors via weighted_edges
 *   2. Multi-hop BFS (anchor → fact1 → anchor2 → fact2) discovers indirect facts
 *   3. Deduplication against existing items (no duplicates in results)
 *   4. Score propagation: anchorSimilarity * graphTraversalScore * scoreMultiplier
 *   5. minEdgeWeight threshold filters weak edges
 *   6. maxDepth limits BFS traversal depth
 *   7. Empty anchors → empty result
 *   8. Pipeline traceability (stats: seeds, discovered, added, edges)
 *   9. Integration with UnifiedRetriever pipeline (bfs_expansion stage)
 *  10. BFS items have source='graph' and retrievalMetadata.bfsExpanded=true
 *  11. Reuses existing GraphTraverser for BFS logic
 *  12. Graceful degradation on errors
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { BFSExpander } from '../src/retrieval/bfs-expander.js';
import {
  UnifiedRetriever,
  type UnifiedTraceEvent,
} from '../src/retrieval/unified-retriever.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import type { AnchorMatch } from '../src/retrieval/vector-searcher.js';
import type { ScoredMemoryItem } from '../src/retrieval/types.js';
import type Database from 'better-sqlite3';

// ─── Test Helpers ────────────────────────────────────────────────

const DIM = 8;

function unitVector(dim: number, index: number): number[] {
  const v = new Array(dim).fill(0);
  v[index] = 1.0;
  return v;
}

function toFloat32(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

// ─── Test Setup ──────────────────────────────────────────────────

describe('BFSExpander', () => {
  let db: Database.Database;
  let anchorRepo: AnchorRepository;
  let edgeRepo: WeightedEdgeRepository;
  let factRepo: FactRepository;
  let convRepo: ConversationRepository;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    anchorRepo = new AnchorRepository(db);
    edgeRepo = new WeightedEdgeRepository(db);
    factRepo = new FactRepository(db);
    convRepo = new ConversationRepository(db);
  });

  function createAnchor(label: string, description: string, embedding?: number[]) {
    return anchorRepo.createAnchor({
      label,
      description,
      anchorType: 'topic',
      embedding: embedding ? toFloat32(embedding) : undefined,
      initialWeight: 1.0,
      decayRate: 0,
    });
  }

  function createFact(content: string) {
    const conv = convRepo.ingest({ source: 'test', messages: [] });
    return factRepo.create({
      content,
      conversationId: conv.id,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: [],
    });
  }

  function createEdge(
    sourceId: string,
    sourceType: string,
    targetId: string,
    targetType: string,
    weight: number,
  ) {
    // Determine edge_type based on source→target type combination
    const edgeType =
      sourceType === 'anchor' && targetType === 'fact' ? 'anchor_to_fact' :
      sourceType === 'anchor' && targetType === 'anchor' ? 'anchor_to_anchor' :
      sourceType === 'anchor' && targetType === 'episode' ? 'anchor_to_episode' :
      sourceType === 'anchor' && targetType === 'concept' ? 'anchor_to_concept' :
      'derived_from';
    return edgeRepo.createEdge({
      sourceId,
      sourceType: sourceType as any,
      targetId,
      targetType: targetType as any,
      edgeType: edgeType as any,
      weight,
    });
  }

  function makeAnchorMatch(anchorId: string, label: string, similarity: number): AnchorMatch {
    return {
      anchorId,
      label,
      similarity,
      expandedNodeCount: 0,
    };
  }

  function makeScoredItem(nodeId: string, nodeType: string, score: number): ScoredMemoryItem {
    return {
      nodeId,
      nodeType: nodeType as any,
      score,
      source: 'vector',
      content: `content-${nodeId}`,
    };
  }

  // ── 1. BFS discovers facts connected to anchors ──

  describe('basic BFS expansion', () => {
    it('discovers facts connected to re-judged anchors via weighted_edges', async () => {
      const anchor = createAnchor('TypeScript', 'TS programming', unitVector(DIM, 0));
      const fact1 = createFact('TypeScript supports generics');
      const fact2 = createFact('TypeScript compiles to JavaScript');

      createEdge(anchor.id, 'anchor', fact1.id, 'fact', 0.8);
      createEdge(anchor.id, 'anchor', fact2.id, 'fact', 0.6);

      const expander = new BFSExpander(db);
      const result = await expander.expand(
        [makeAnchorMatch(anchor.id, 'TypeScript', 0.9)],
        [], // no existing items
      );

      expect(result.newItems.length).toBe(2);
      expect(result.newItems[0].nodeType).toBe('fact');
      expect(result.newItems[0].source).toBe('graph');
      expect(result.newItems[0].retrievalMetadata?.bfsExpanded).toBe(true);
      expect(result.stats.seedAnchorsCount).toBe(1);
      expect(result.stats.newNodesAdded).toBe(2);
    });

    it('returns items sorted by score descending', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const fact1 = createFact('Low weight fact');
      const fact2 = createFact('High weight fact');

      createEdge(anchor.id, 'anchor', fact1.id, 'fact', 0.3);
      createEdge(anchor.id, 'anchor', fact2.id, 'fact', 0.9);

      const expander = new BFSExpander(db);
      const result = await expander.expand(
        [makeAnchorMatch(anchor.id, 'TS', 0.9)],
        [],
      );

      expect(result.newItems.length).toBe(2);
      // Higher weight edge → higher score
      expect(result.newItems[0].score).toBeGreaterThan(result.newItems[1].score);
    });
  });

  // ── 2. Multi-hop BFS ──

  describe('multi-hop BFS traversal', () => {
    it('discovers facts via multi-hop: anchor → fact → (via another anchor)', async () => {
      // anchor1 → fact1 (direct), anchor1 → anchor2 → fact2 (2-hop)
      const anchor1 = createAnchor('TypeScript', 'TS', unitVector(DIM, 0));
      const anchor2 = createAnchor('JavaScript', 'JS', unitVector(DIM, 1));
      const fact1 = createFact('TypeScript types');
      const fact2 = createFact('JavaScript runtime');

      createEdge(anchor1.id, 'anchor', fact1.id, 'fact', 0.8);
      createEdge(anchor1.id, 'anchor', anchor2.id, 'anchor', 0.7);
      createEdge(anchor2.id, 'anchor', fact2.id, 'fact', 0.6);

      const expander = new BFSExpander(db, { maxDepth: 3 });
      const result = await expander.expand(
        [makeAnchorMatch(anchor1.id, 'TypeScript', 0.9)],
        [],
      );

      const factIds = result.newItems.map(i => i.nodeId);
      expect(factIds).toContain(fact1.id);
      expect(factIds).toContain(fact2.id);
      expect(result.stats.edgesTraversed).toBeGreaterThanOrEqual(3);
    });
  });

  // ── 3. Deduplication against existing items ──

  describe('deduplication', () => {
    it('excludes items already in the result set', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const fact1 = createFact('Already found fact');
      const fact2 = createFact('New fact from BFS');

      createEdge(anchor.id, 'anchor', fact1.id, 'fact', 0.8);
      createEdge(anchor.id, 'anchor', fact2.id, 'fact', 0.6);

      const existingItems = [makeScoredItem(fact1.id, 'fact', 0.5)];

      const expander = new BFSExpander(db);
      const result = await expander.expand(
        [makeAnchorMatch(anchor.id, 'TS', 0.9)],
        existingItems,
      );

      expect(result.newItems.length).toBe(1);
      expect(result.newItems[0].nodeId).toBe(fact2.id);
      expect(result.stats.totalDiscovered).toBe(2);
      expect(result.stats.newNodesAdded).toBe(1);
    });

    it('excludes anchor IDs themselves from results', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const fact = createFact('A fact');

      createEdge(anchor.id, 'anchor', fact.id, 'fact', 0.8);

      const expander = new BFSExpander(db);
      const result = await expander.expand(
        [makeAnchorMatch(anchor.id, 'TS', 0.9)],
        [],
      );

      // Anchor itself should not appear in results
      const nodeIds = result.newItems.map(i => i.nodeId);
      expect(nodeIds).not.toContain(anchor.id);
    });
  });

  // ── 4. Score propagation ──

  describe('score propagation', () => {
    it('score = graphTraversalScore * anchorSimilarity * scoreMultiplier', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const fact = createFact('A fact');

      createEdge(anchor.id, 'anchor', fact.id, 'fact', 0.8);

      const anchorSim = 0.9;
      const scoreMultiplier = 0.8;
      // GraphTraverser traversal score = anchor.currentWeight * edgeWeight = 1.0 * 0.8 = 0.8
      // Final score = 0.8 * 0.9 * 0.8 = 0.576

      const expander = new BFSExpander(db, { scoreMultiplier });
      const result = await expander.expand(
        [makeAnchorMatch(anchor.id, 'TS', anchorSim)],
        [],
      );

      expect(result.newItems.length).toBe(1);
      const item = result.newItems[0];
      expect(item.retrievalMetadata?.anchorSimilarity).toBe(anchorSim);
      expect(item.retrievalMetadata?.scoreMultiplier).toBe(scoreMultiplier);
      expect(item.score).toBeCloseTo(0.576, 2);
    });
  });

  // ── 5. minEdgeWeight threshold ──

  describe('edge weight threshold', () => {
    it('filters out edges below minEdgeWeight', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const fact1 = createFact('Strong connection');
      const fact2 = createFact('Weak connection');

      createEdge(anchor.id, 'anchor', fact1.id, 'fact', 0.8);
      createEdge(anchor.id, 'anchor', fact2.id, 'fact', 0.05);

      const expander = new BFSExpander(db, { minEdgeWeight: 0.1 });
      const result = await expander.expand(
        [makeAnchorMatch(anchor.id, 'TS', 0.9)],
        [],
      );

      expect(result.newItems.length).toBe(1);
      expect(result.newItems[0].content).toBe('Strong connection');
    });
  });

  // ── 6. maxDepth limits ──

  describe('maxDepth limits', () => {
    it('depth=1 only finds direct neighbors', async () => {
      const anchor1 = createAnchor('A1', 'Anchor1', unitVector(DIM, 0));
      const anchor2 = createAnchor('A2', 'Anchor2', unitVector(DIM, 1));
      const fact1 = createFact('Direct fact');
      const fact2 = createFact('Indirect fact');

      createEdge(anchor1.id, 'anchor', fact1.id, 'fact', 0.8);
      createEdge(anchor1.id, 'anchor', anchor2.id, 'anchor', 0.7);
      createEdge(anchor2.id, 'anchor', fact2.id, 'fact', 0.6);

      const expander = new BFSExpander(db, { maxDepth: 1 });
      const result = await expander.expand(
        [makeAnchorMatch(anchor1.id, 'A1', 0.9)],
        [],
      );

      const factIds = result.newItems.map(i => i.nodeId);
      expect(factIds).toContain(fact1.id);
      expect(factIds).not.toContain(fact2.id);
    });
  });

  // ── 7. Empty anchors ──

  describe('empty inputs', () => {
    it('returns empty result for no anchors', async () => {
      const expander = new BFSExpander(db);
      const result = await expander.expand([], []);

      expect(result.newItems).toHaveLength(0);
      expect(result.stats.seedAnchorsCount).toBe(0);
      expect(result.stats.bfsTimeMs).toBe(0);
    });

    it('returns empty result when anchors have no edges', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));

      const expander = new BFSExpander(db);
      const result = await expander.expand(
        [makeAnchorMatch(anchor.id, 'TS', 0.9)],
        [],
      );

      expect(result.newItems).toHaveLength(0);
      expect(result.stats.seedAnchorsCount).toBe(1);
      expect(result.stats.totalDiscovered).toBe(0);
    });
  });

  // ── 8. Pipeline traceability (stats) ──

  describe('pipeline traceability', () => {
    it('returns detailed stats', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const fact1 = createFact('Fact 1');
      const fact2 = createFact('Fact 2');

      createEdge(anchor.id, 'anchor', fact1.id, 'fact', 0.8);
      createEdge(anchor.id, 'anchor', fact2.id, 'fact', 0.6);

      const expander = new BFSExpander(db);
      const result = await expander.expand(
        [makeAnchorMatch(anchor.id, 'TS', 0.9)],
        [],
      );

      expect(result.stats.seedAnchorsCount).toBe(1);
      expect(result.stats.totalDiscovered).toBe(2);
      expect(result.stats.newNodesAdded).toBe(2);
      expect(result.stats.edgesTraversed).toBeGreaterThanOrEqual(2);
      expect(result.stats.bfsTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ── 9. Integration with UnifiedRetriever ──

  describe('UnifiedRetriever integration', () => {
    it('bfs_expansion stage appears in pipeline diagnostics', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const fact = createFact('TypeScript generics');

      createEdge(anchor.id, 'anchor', fact.id, 'fact', 0.8);

      const embeddingProvider = new MockEmbeddingProvider(DIM);
      embeddingProvider.setEmbedding('TypeScript features', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { similarityThreshold: 0.1, expandToMemoryNodes: false },
        reinforceOnRetrieval: false,
        enableBFSExpansion: true,
      });

      const result = await retriever.recall({ text: 'TypeScript features' });

      // Check bfs_expansion stage exists
      const bfsStage = result.diagnostics.stages.find(s => s.name === 'bfs_expansion');
      expect(bfsStage).toBeDefined();
      expect(bfsStage!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('BFS expansion discovers facts not found in initial vector search', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const fact = createFact('TypeScript generics are powerful');

      createEdge(anchor.id, 'anchor', fact.id, 'fact', 0.7);

      const embeddingProvider = new MockEmbeddingProvider(DIM);
      embeddingProvider.setEmbedding('TypeScript features', unitVector(DIM, 0));

      // Disable vector expansion, enable BFS expansion
      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { similarityThreshold: 0.1, expandToMemoryNodes: false },
        reinforceOnRetrieval: false,
        enableBFSExpansion: true,
      });

      const result = await retriever.recall({ text: 'TypeScript features' });

      // Vector search finds the anchor, BFS expands to the fact
      const factItems = result.items.filter(i => i.nodeType === 'fact');
      expect(factItems.length).toBeGreaterThanOrEqual(1);
      expect(factItems[0].nodeId).toBe(fact.id);
      expect(result.diagnostics.bfsNodesAdded).toBeGreaterThanOrEqual(1);
    });

    it('BFS expansion can be disabled via config', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const fact = createFact('TypeScript fact');
      createEdge(anchor.id, 'anchor', fact.id, 'fact', 0.8);

      const embeddingProvider = new MockEmbeddingProvider(DIM);
      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { similarityThreshold: 0.1, expandToMemoryNodes: false },
        reinforceOnRetrieval: false,
        enableBFSExpansion: false,
      });

      const result = await retriever.recall({ text: 'query' });

      const bfsStage = result.diagnostics.stages.find(s => s.name === 'bfs_expansion');
      expect(bfsStage).toBeDefined();
      expect(bfsStage!.status).toBe('skipped');
      expect(result.diagnostics.bfsNodesAdded).toBe(0);
    });

    it('trace hook receives bfs_expansion events', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const fact = createFact('A fact');
      createEdge(anchor.id, 'anchor', fact.id, 'fact', 0.8);

      const embeddingProvider = new MockEmbeddingProvider(DIM);
      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const traceEvents: UnifiedTraceEvent[] = [];
      const retriever = new UnifiedRetriever(
        db,
        embeddingProvider,
        {
          vector: { similarityThreshold: 0.1, expandToMemoryNodes: false },
          reinforceOnRetrieval: false,
          enableBFSExpansion: true,
        },
        undefined,
        (event) => traceEvents.push(event),
      );

      await retriever.recall({ text: 'query' });

      const bfsEvents = traceEvents.filter(e => e.stage === 'bfs_expansion');
      expect(bfsEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 10. BFS items have correct metadata ──

  describe('metadata correctness', () => {
    it('BFS items have source=graph and bfsExpanded=true', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const fact = createFact('A fact');
      createEdge(anchor.id, 'anchor', fact.id, 'fact', 0.8);

      const expander = new BFSExpander(db);
      const result = await expander.expand(
        [makeAnchorMatch(anchor.id, 'TS', 0.9)],
        [],
      );

      expect(result.newItems[0].source).toBe('graph');
      expect(result.newItems[0].retrievalMetadata?.bfsExpanded).toBe(true);
      expect(result.newItems[0].retrievalMetadata?.bfsDepth).toBeDefined();
      expect(result.newItems[0].retrievalMetadata?.sourceAnchorId).toBe(anchor.id);
    });
  });

  // ── 11. Reuses GraphTraverser ──

  describe('reuses existing GraphTraverser', () => {
    it('BFS results match GraphTraverser behavior (weight accumulation)', async () => {
      const anchor = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const fact = createFact('TS fact');
      createEdge(anchor.id, 'anchor', fact.id, 'fact', 0.8);

      const expander = new BFSExpander(db, { scoreMultiplier: 1.0 });
      const result = await expander.expand(
        [makeAnchorMatch(anchor.id, 'TS', 1.0)],
        [],
      );

      // GraphTraverser: score = anchor.currentWeight(1.0) * edgeWeight(0.8) = 0.8
      // BFS score = graphScore(0.8) * anchorSimilarity(1.0) * multiplier(1.0) = 0.8
      expect(result.newItems[0].score).toBeCloseTo(0.8, 2);
    });
  });

  // ── 12. Multiple anchors expansion ──

  describe('multiple anchor expansion', () => {
    it('expands from multiple re-judged anchors', async () => {
      const anchor1 = createAnchor('TS', 'TypeScript', unitVector(DIM, 0));
      const anchor2 = createAnchor('JS', 'JavaScript', unitVector(DIM, 1));
      const fact1 = createFact('TypeScript types');
      const fact2 = createFact('JavaScript closures');

      createEdge(anchor1.id, 'anchor', fact1.id, 'fact', 0.8);
      createEdge(anchor2.id, 'anchor', fact2.id, 'fact', 0.7);

      const expander = new BFSExpander(db);
      const result = await expander.expand(
        [
          makeAnchorMatch(anchor1.id, 'TS', 0.9),
          makeAnchorMatch(anchor2.id, 'JS', 0.8),
        ],
        [],
      );

      expect(result.newItems.length).toBe(2);
      expect(result.stats.seedAnchorsCount).toBe(2);
      const nodeIds = result.newItems.map(i => i.nodeId);
      expect(nodeIds).toContain(fact1.id);
      expect(nodeIds).toContain(fact2.id);
    });
  });
});
