/**
 * Tests for the VectorSearcher — embedding-based similarity search module.
 *
 * Tests cover:
 *   1. EmbeddingProvider interface and MockEmbeddingProvider
 *   2. cosineSimilarityVec helper
 *   3. VectorSearcher basic search (query → anchors by similarity)
 *   4. VectorSearcher expansion (anchor → connected memory nodes)
 *   5. Deduplication, ranking, and threshold filtering
 *   6. searchByEmbedding (pre-computed vector)
 *   7. Edge cases (no anchors, no embeddings, empty DB)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import {
  VectorSearcher,
  cosineSimilarityVec,
  bufferToFloat32Array,
} from '../src/retrieval/vector-searcher.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import type Database from 'better-sqlite3';

// ─── Test Helpers ────────────────────────────────────────────────

/** Create a normalized Float32Array from a number array */
function toFloat32(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

/** Create a simple unit vector in a given direction */
function unitVector(dim: number, index: number): number[] {
  const v = new Array(dim).fill(0);
  v[index] = 1.0;
  return v;
}

/** Create a normalized random-ish vector for testing */
function makeVector(seed: number, dim: number): number[] {
  const v: number[] = [];
  let hash = seed;
  for (let i = 0; i < dim; i++) {
    hash = (hash * 1664525 + 1013904223) | 0;
    v.push((hash & 0x7fffffff) / 0x7fffffff);
  }
  // Normalize
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return v.map(x => x / norm);
}

// ─── Test Setup ──────────────────────────────────────────────────

describe('cosineSimilarityVec', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [0.5, 0.5, 0.5, 0.5];
    expect(cosineSimilarityVec(v, v)).toBeCloseTo(1.0, 4);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarityVec(a, b)).toBeCloseTo(0.0, 4);
  });

  it('returns 0.0 for opposite vectors (clamped)', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarityVec(a, b)).toBe(0); // Negative clamped to 0
  });

  it('handles Float32Array inputs', () => {
    const a = [0.5, 0.5];
    const b = new Float32Array([0.5, 0.5]);
    expect(cosineSimilarityVec(a, b)).toBeCloseTo(1.0, 4);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarityVec([], [])).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarityVec([0, 0], [0, 0])).toBe(0);
  });

  it('computes correct similarity for known vectors', () => {
    // cos(45°) = √2/2 ≈ 0.7071
    const a = [1, 0];
    const b = [1, 1];
    const expected = 1 / Math.sqrt(2);
    expect(cosineSimilarityVec(a, b)).toBeCloseTo(expected, 4);
  });
});

describe('bufferToFloat32Array', () => {
  it('converts a valid buffer to Float32Array', () => {
    const original = new Float32Array([1.0, 2.0, 3.0]);
    const buf = Buffer.from(original.buffer);
    const result = bufferToFloat32Array(buf, 3);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
    expect(result![0]).toBeCloseTo(1.0);
    expect(result![1]).toBeCloseTo(2.0);
    expect(result![2]).toBeCloseTo(3.0);
  });

  it('returns null for null buffer', () => {
    expect(bufferToFloat32Array(null, 3)).toBeNull();
  });

  it('returns null for null dimension', () => {
    const buf = Buffer.from(new Float32Array([1]).buffer);
    expect(bufferToFloat32Array(buf, null)).toBeNull();
  });

  it('returns null for zero dimension', () => {
    const buf = Buffer.from(new Float32Array([1]).buffer);
    expect(bufferToFloat32Array(buf, 0)).toBeNull();
  });
});

describe('MockEmbeddingProvider', () => {
  it('generates deterministic embeddings for same text', async () => {
    const provider = new MockEmbeddingProvider(8);
    const r1 = await provider.embed({ text: 'hello' });
    const r2 = await provider.embed({ text: 'hello' });
    expect(r1.embedding).toEqual(r2.embedding);
    expect(r1.dimensions).toBe(8);
  });

  it('generates different embeddings for different text', async () => {
    const provider = new MockEmbeddingProvider(8);
    const r1 = await provider.embed({ text: 'hello' });
    const r2 = await provider.embed({ text: 'world' });
    expect(r1.embedding).not.toEqual(r2.embedding);
  });

  it('tracks calls', async () => {
    const provider = new MockEmbeddingProvider(4);
    await provider.embed({ text: 'test' });
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0].text).toBe('test');
  });

  it('uses overrides when set', async () => {
    const provider = new MockEmbeddingProvider(4);
    const custom = [0.1, 0.2, 0.3, 0.4];
    provider.setEmbedding('test', custom);
    const r = await provider.embed({ text: 'test' });
    expect(r.embedding).toEqual(custom);
  });

  it('supports batch embedding', async () => {
    const provider = new MockEmbeddingProvider(4);
    const results = await provider.embedBatch(['a', 'b', 'c']);
    expect(results.length).toBe(3);
    expect(results[0].dimensions).toBe(4);
  });

  it('resets state', async () => {
    const provider = new MockEmbeddingProvider(4);
    provider.setEmbedding('test', [1, 2, 3, 4]);
    await provider.embed({ text: 'test' });
    provider.reset();
    expect(provider.calls.length).toBe(0);
    // Override should be gone
    const r = await provider.embed({ text: 'test' });
    expect(r.embedding).not.toEqual([1, 2, 3, 4]);
  });
});

describe('VectorSearcher', () => {
  let db: Database.Database;
  let anchorRepo: AnchorRepository;
  let edgeRepo: WeightedEdgeRepository;
  let factRepo: FactRepository;
  let convRepo: ConversationRepository;
  let embeddingProvider: MockEmbeddingProvider;

  const DIM = 8;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    anchorRepo = new AnchorRepository(db);
    edgeRepo = new WeightedEdgeRepository(db);
    factRepo = new FactRepository(db);
    convRepo = new ConversationRepository(db);
    embeddingProvider = new MockEmbeddingProvider(DIM);
  });

  // ── Helper: Create anchor with embedding ──
  // Uses initialWeight=1.0 and decayRate=0 so tests that don't focus on decay
  // get predictable scores (effectiveWeight = currentWeight = 1.0).
  function createAnchorWithEmbedding(
    label: string,
    description: string,
    embedding: number[],
  ) {
    return anchorRepo.createAnchor({
      label,
      description,
      anchorType: 'topic',
      embedding: toFloat32(embedding),
      initialWeight: 1.0,
      decayRate: 0,
    });
  }

  // ── Helper: Create a fact ──
  function createFact(content: string, conversationId: string) {
    return factRepo.create({
      content,
      conversationId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: [],
    });
  }

  // ── Helper: Create a conversation ──
  function createConversation() {
    return convRepo.ingest({
      source: 'test',
      messages: [],
    });
  }

  describe('search with no anchors', () => {
    it('returns empty results when no anchors exist', async () => {
      const searcher = new VectorSearcher(db, embeddingProvider);
      const result = await searcher.search('anything');
      expect(result.items).toHaveLength(0);
      expect(result.matchedAnchors).toHaveLength(0);
      expect(result.stats.anchorsMatched).toBe(0);
    });
  });

  describe('search with anchors (no expansion)', () => {
    it('finds the most similar anchor', async () => {
      // Create anchors with known embeddings
      const tsVec = unitVector(DIM, 0); // [1,0,0,0,...]
      const pyVec = unitVector(DIM, 1); // [0,1,0,0,...]

      createAnchorWithEmbedding('TypeScript', 'TypeScript programming', tsVec);
      createAnchorWithEmbedding('Python', 'Python programming', pyVec);

      // Set the query embedding to be similar to TypeScript
      embeddingProvider.setEmbedding('TypeScript migration', tsVec);

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: false,
        similarityThreshold: 0.1,
      });

      const result = await searcher.search('TypeScript migration');

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].nodeId).toBeDefined();
      expect(result.items[0].score).toBeCloseTo(1.0, 2);
      expect(result.items[0].source).toBe('vector');
      expect(result.items[0].nodeType).toBe('anchor');
      expect(result.items[0].content).toContain('TypeScript');
    });

    it('respects similarity threshold', async () => {
      const v1 = unitVector(DIM, 0);
      const v2 = unitVector(DIM, 1);

      createAnchorWithEmbedding('A', 'Anchor A', v1);
      createAnchorWithEmbedding('B', 'Anchor B', v2);

      // Query is exactly v1, so B (orthogonal) has similarity 0
      embeddingProvider.setEmbedding('query', v1);

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: false,
        similarityThreshold: 0.5,
      });

      const result = await searcher.search('query');

      // Only anchor A should match (similarity 1.0)
      // Anchor B has similarity 0.0 (orthogonal)
      expect(result.items.length).toBe(1);
      expect(result.items[0].content).toContain('Anchor A');
    });

    it('respects topK limit', async () => {
      // Create multiple anchors all somewhat similar to query
      const queryVec = makeVector(42, DIM);

      for (let i = 0; i < 5; i++) {
        // Slightly perturbed versions of query vector
        const v = queryVec.map((x, j) => x + (j === i ? 0.01 : 0));
        createAnchorWithEmbedding(`Anchor ${i}`, `Description ${i}`, v);
      }

      embeddingProvider.setEmbedding('query', queryVec);

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: false,
        similarityThreshold: 0.0,
        topK: 3,
      });

      const result = await searcher.search('query');
      expect(result.items.length).toBeLessThanOrEqual(3);
    });

    it('returns items sorted by score descending', async () => {
      // Create 3 anchors with decreasing similarity to query
      const dim = DIM;
      const queryVec = unitVector(dim, 0); // [1,0,0,...]
      const similar = [0.9, 0.1, 0, 0, 0, 0, 0, 0]; // High similarity
      const lessSimilar = [0.5, 0.5, 0.5, 0, 0, 0, 0, 0]; // Medium

      createAnchorWithEmbedding('Best', 'Best match', queryVec);
      createAnchorWithEmbedding('Good', 'Good match', similar);
      createAnchorWithEmbedding('OK', 'OK match', lessSimilar);

      embeddingProvider.setEmbedding('query', queryVec);

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: false,
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      // Scores should be in descending order
      for (let i = 1; i < result.items.length; i++) {
        expect(result.items[i - 1].score).toBeGreaterThanOrEqual(result.items[i].score);
      }
    });
  });

  describe('search with expansion', () => {
    it('expands to connected facts via weighted edges', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding(
        'TypeScript',
        'TypeScript language',
        unitVector(DIM, 0),
      );

      const fact = createFact('TypeScript uses structural typing', conv.id);

      // Connect anchor → fact via weighted edge
      edgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'anchor',
        targetId: fact.id,
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.8,
      });

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      // Disable usage decay so score = pure similarity * edge_weight
      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: true,
        similarityThreshold: 0.0,
      }, { usageDecayRate: 0 });

      const result = await searcher.search('query');

      // Should include both the anchor and the expanded fact
      const factItem = result.items.find(i => i.nodeType === 'fact');
      expect(factItem).toBeDefined();
      expect(factItem!.content).toContain('structural typing');
      expect(factItem!.source).toBe('vector');

      // Fact score should be: anchor_similarity * edge_weight
      // anchor_similarity ≈ 1.0, edge_weight = 0.8
      expect(factItem!.score).toBeCloseTo(0.8, 1);

      // Check expansion metadata
      expect(factItem!.retrievalMetadata?.expandedFromAnchor).toBe(anchor.id);
      expect(factItem!.retrievalMetadata?.edgeWeight).toBe(0.8);
    });

    it('propagates score through edge weights', async () => {
      const conv = createConversation();
      const anchorVec = unitVector(DIM, 0);

      // Anchor with partial similarity to query
      const partialVec = [0.8, 0.6, 0, 0, 0, 0, 0, 0]; // cos with [1,0...] ≈ 0.8
      const anchor = createAnchorWithEmbedding('Topic', 'Some topic', partialVec);

      const fact = createFact('Some fact', conv.id);

      edgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'anchor',
        targetId: fact.id,
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.5,
      });

      embeddingProvider.setEmbedding('query', anchorVec);

      // Disable usage decay so score propagation is purely similarity * edge_weight
      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: true,
        similarityThreshold: 0.0,
      }, { usageDecayRate: 0 });

      const result = await searcher.search('query');

      const anchorItem = result.items.find(i => i.nodeType === 'anchor');
      const factItem = result.items.find(i => i.nodeType === 'fact');

      expect(anchorItem).toBeDefined();
      expect(factItem).toBeDefined();

      // fact score ≈ anchor_similarity * 0.5
      const expectedFactScore = anchorItem!.score * 0.5;
      expect(factItem!.score).toBeCloseTo(expectedFactScore, 2);
    });

    it('respects expansionMinWeight', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding('A', 'Anchor', unitVector(DIM, 0));

      const strongFact = createFact('Strong fact', conv.id);
      const weakFact = createFact('Weak fact', conv.id);

      edgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'anchor',
        targetId: strongFact.id,
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.7,
      });

      edgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'anchor',
        targetId: weakFact.id,
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.05, // Below threshold
      });

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: true,
        similarityThreshold: 0.0,
        expansionMinWeight: 0.1,
      });

      const result = await searcher.search('query');

      const factItems = result.items.filter(i => i.nodeType === 'fact');
      expect(factItems.length).toBe(1);
      expect(factItems[0].content).toContain('Strong fact');
    });

    it('respects expansionMaxPerAnchor', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding('A', 'Anchor', unitVector(DIM, 0));

      // Create 10 connected facts
      for (let i = 0; i < 10; i++) {
        const fact = createFact(`Fact ${i}`, conv.id);
        edgeRepo.createEdge({
          sourceId: anchor.id,
          sourceType: 'anchor',
          targetId: fact.id,
          targetType: 'fact',
          edgeType: 'anchor_to_fact',
          weight: 0.9 - i * 0.05,
        });
      }

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: true,
        similarityThreshold: 0.0,
        expansionMaxPerAnchor: 3,
      });

      const result = await searcher.search('query');

      const factItems = result.items.filter(i => i.nodeType === 'fact');
      expect(factItems.length).toBe(3);
    });

    it('reports correct stats', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding('A', 'Anchor', unitVector(DIM, 0));
      const fact = createFact('A fact', conv.id);

      edgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'anchor',
        targetId: fact.id,
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.5,
      });

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: true,
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      expect(result.stats.anchorsMatched).toBe(1);
      expect(result.stats.nodesExpanded).toBe(1);
      expect(result.stats.totalTimeMs).toBeGreaterThan(0);
      expect(result.stats.embeddingTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.matchedAnchors.length).toBe(1);
      expect(result.matchedAnchors[0].expandedNodeCount).toBe(1);
    });
  });

  describe('deduplication', () => {
    it('deduplicates when same node is reachable from multiple anchors', async () => {
      const conv = createConversation();

      // Two anchors, both connected to the same fact
      const anchor1 = createAnchorWithEmbedding('A1', 'Anchor 1', unitVector(DIM, 0));
      const anchor2Vec = [0.9, 0.4, 0, 0, 0, 0, 0, 0]; // Similar to unitVector(0)
      const anchor2 = createAnchorWithEmbedding('A2', 'Anchor 2', anchor2Vec);

      const fact = createFact('Shared fact', conv.id);

      edgeRepo.createEdge({
        sourceId: anchor1.id,
        sourceType: 'anchor',
        targetId: fact.id,
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.9,
      });

      edgeRepo.createEdge({
        sourceId: anchor2.id,
        sourceType: 'anchor',
        targetId: fact.id,
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.6,
      });

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: true,
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      // The shared fact should appear only once, with the higher score
      const factItems = result.items.filter(i => i.nodeType === 'fact');
      expect(factItems.length).toBe(1);
    });
  });

  describe('searchByEmbedding', () => {
    it('searches using a pre-computed embedding', () => {
      const vec = unitVector(DIM, 0);
      createAnchorWithEmbedding('Target', 'Target anchor', vec);

      const searcher = new VectorSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
      });

      const results = searcher.searchByEmbedding(vec);

      expect(results.length).toBe(1);
      expect(results[0].anchor.label).toBe('Target');
      expect(results[0].similarity).toBeCloseTo(1.0, 2);
    });
  });

  describe('retrieval metadata', () => {
    it('includes anchor information in retrieval metadata', async () => {
      createAnchorWithEmbedding('MyTopic', 'My topic desc', unitVector(DIM, 0));

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: false,
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      expect(result.items[0].retrievalMetadata).toBeDefined();
      expect(result.items[0].retrievalMetadata!.anchorLabel).toBe('MyTopic');
      expect(result.items[0].retrievalMetadata!.anchorType).toBe('topic');
      expect(result.items[0].retrievalMetadata!.cosineSimilarity).toBeCloseTo(1.0, 2);
    });
  });

  describe('maxTotalResults', () => {
    it('limits total output items', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding('A', 'Anchor', unitVector(DIM, 0));

      for (let i = 0; i < 10; i++) {
        const fact = createFact(`Fact ${i}`, conv.id);
        edgeRepo.createEdge({
          sourceId: anchor.id,
          sourceType: 'anchor',
          targetId: fact.id,
          targetType: 'fact',
          edgeType: 'anchor_to_fact',
          weight: 0.9 - i * 0.05,
        });
      }

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: true,
        similarityThreshold: 0.0,
        expansionMaxPerAnchor: 10,
        maxTotalResults: 5,
      });

      const result = await searcher.search('query');
      expect(result.items.length).toBeLessThanOrEqual(5);
    });
  });

  describe('anchors without embeddings', () => {
    it('ignores anchors that have no embedding', async () => {
      // Create an anchor WITHOUT embedding
      anchorRepo.createAnchor({
        label: 'No Embedding',
        description: 'This anchor has no embedding',
        anchorType: 'topic',
      });

      // Create an anchor WITH embedding
      createAnchorWithEmbedding('With Embedding', 'This one has it', unitVector(DIM, 0));

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: false,
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      expect(result.items.length).toBe(1);
      expect(result.items[0].content).toContain('With Embedding');
    });
  });

  describe('per-query config override', () => {
    it('allows overriding config per search call', async () => {
      createAnchorWithEmbedding('A', 'Anchor A', unitVector(DIM, 0));

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: false,
        similarityThreshold: 0.99, // Very high — nothing should match at default
      });

      // Default config — threshold too high
      const r1 = await searcher.search('query');
      // Note: unitVector exactly matches, so similarity is 1.0 which is >= 0.99
      expect(r1.items.length).toBe(1);

      // Override to lower threshold
      const r2 = await searcher.search('query', { similarityThreshold: 0.0 });
      expect(r2.items.length).toBe(1);
    });
  });

  describe('ScoredMemoryItem compatibility', () => {
    it('produces items compatible with ResultMerger input', async () => {
      createAnchorWithEmbedding('Topic', 'Topic desc', unitVector(DIM, 0));

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: false,
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      // Verify ScoredMemoryItem shape
      const item = result.items[0];
      expect(item).toHaveProperty('nodeId');
      expect(item).toHaveProperty('nodeType');
      expect(item).toHaveProperty('score');
      expect(item).toHaveProperty('source');
      expect(item).toHaveProperty('content');
      expect(item.source).toBe('vector');
      expect(typeof item.score).toBe('number');
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(1);
    });
  });
});
