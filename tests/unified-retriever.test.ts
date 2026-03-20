/**
 * Tests for UnifiedRetriever — single-pipeline retrieval that embeds a query
 * locally and finds top-K anchors by cosine similarity.
 *
 * AC 9: Retrieval 시 쿼리를 로컬 임베딩하여 cosine similarity로 top-K anchor를 찾는다
 *
 * Tests cover:
 *   1. Query embedding → cosine similarity → top-K anchor retrieval
 *   2. Expansion to connected memory nodes via weighted edges
 *   3. Score propagation (similarity * anchor weight * edge weight)
 *   4. Similarity threshold filtering
 *   5. Hebbian reinforcement on retrieval
 *   6. Pipeline traceability (diagnostics + stages)
 *   7. Edge cases (no anchors, empty DB)
 *   8. Reuse of existing VectorSearcher + cosine similarity logic
 *   9. Trace hook callback support
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import {
  UnifiedRetriever,
  type UnifiedTraceEvent,
} from '../src/retrieval/unified-retriever.js';
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

describe('UnifiedRetriever', () => {
  let db: Database.Database;
  let anchorRepo: AnchorRepository;
  let edgeRepo: WeightedEdgeRepository;
  let factRepo: FactRepository;
  let convRepo: ConversationRepository;
  let embeddingProvider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    anchorRepo = new AnchorRepository(db);
    edgeRepo = new WeightedEdgeRepository(db);
    factRepo = new FactRepository(db);
    convRepo = new ConversationRepository(db);
    embeddingProvider = new MockEmbeddingProvider(DIM);
  });

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

  function createConversation() {
    return convRepo.ingest({ source: 'test', messages: [] });
  }

  // ── 1. Query → cosine similarity → top-K anchors ──

  describe('query embedding and cosine similarity search', () => {
    it('finds the most similar anchor by cosine similarity', async () => {
      const tsVec = unitVector(DIM, 0);
      const pyVec = unitVector(DIM, 1);

      createAnchorWithEmbedding('TypeScript', 'TypeScript programming', tsVec);
      createAnchorWithEmbedding('Python', 'Python programming', pyVec);

      embeddingProvider.setEmbedding('TypeScript migration', tsVec);

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.1 },
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'TypeScript migration' });

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].content).toContain('TypeScript');
      expect(result.items[0].score).toBeCloseTo(1.0, 2);
      expect(result.items[0].source).toBe('vector');
      expect(result.items[0].nodeType).toBe('anchor');
    });

    it('returns top-K anchors ordered by effective score', async () => {
      const queryVec = unitVector(DIM, 0);
      const similar = [0.9, 0.4, 0, 0, 0, 0, 0, 0];
      const lessSimilar = [0.5, 0.5, 0.5, 0, 0, 0, 0, 0];

      createAnchorWithEmbedding('Best', 'Best match', queryVec);
      createAnchorWithEmbedding('Good', 'Good match', similar);
      createAnchorWithEmbedding('OK', 'OK match', lessSimilar);

      embeddingProvider.setEmbedding('query', queryVec);

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.0 },
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'query' });

      // Scores should be in descending order
      for (let i = 1; i < result.items.length; i++) {
        expect(result.items[i - 1].score).toBeGreaterThanOrEqual(result.items[i].score);
      }

      // Best match should be first
      expect(result.items[0].content).toContain('Best');
    });

    it('respects topK limit', async () => {
      const queryVec = unitVector(DIM, 0);

      for (let i = 0; i < 10; i++) {
        const v = queryVec.map((x, j) => x + (j === i % DIM ? 0.01 : 0));
        createAnchorWithEmbedding(`Anchor ${i}`, `Desc ${i}`, v);
      }

      embeddingProvider.setEmbedding('query', queryVec);

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.0, topK: 3 },
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'query' });
      expect(result.activatedAnchors.length).toBeLessThanOrEqual(3);
    });
  });

  // ── 2. Similarity threshold filtering ──

  describe('similarity threshold', () => {
    it('filters out anchors below the threshold', async () => {
      const v1 = unitVector(DIM, 0);
      const v2 = unitVector(DIM, 1); // orthogonal = similarity 0

      createAnchorWithEmbedding('Match', 'Should match', v1);
      createAnchorWithEmbedding('NoMatch', 'Should not match', v2);

      embeddingProvider.setEmbedding('query', v1);

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.5 },
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'query' });

      expect(result.items.length).toBe(1);
      expect(result.items[0].content).toContain('Match');
    });
  });

  // ── 3. Expansion to connected memory nodes ──

  describe('expansion to connected facts', () => {
    it('expands matched anchors to connected facts via weighted edges', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding(
        'TypeScript',
        'TypeScript lang',
        unitVector(DIM, 0),
      );
      const fact = createFact('TypeScript uses structural typing', conv.id);

      edgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'hub',
        targetId: fact.id,
        targetType: 'leaf',
        edgeType: 'about',
        weight: 0.8,
      });

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: true, similarityThreshold: 0.0 },
        reinforceOnRetrieval: false,
      }, { usageDecayRate: 0 });

      const result = await retriever.recall({ text: 'query' });

      const factItem = result.items.find(i => i.nodeType === 'fact');
      expect(factItem).toBeDefined();
      expect(factItem!.content).toContain('structural typing');
      expect(factItem!.score).toBeCloseTo(0.8, 1);
      expect(factItem!.retrievalMetadata?.expandedFromAnchor).toBe(anchor.id);
    });
  });

  // ── 4. Activated anchors ──

  describe('activated anchors tracking', () => {
    it('reports matched anchors with similarity scores', async () => {
      createAnchorWithEmbedding('Topic A', 'Desc A', unitVector(DIM, 0));
      createAnchorWithEmbedding('Topic B', 'Desc B', unitVector(DIM, 1));

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.1 },
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'query' });

      expect(result.activatedAnchors.length).toBe(1);
      expect(result.activatedAnchors[0].label).toBe('Topic A');
      expect(result.activatedAnchors[0].similarity).toBeCloseTo(1.0, 2);
    });
  });

  // ── 5. Hebbian reinforcement ──

  describe('Hebbian reinforcement on retrieval', () => {
    it('reinforces edges connecting activated anchors to retrieved facts', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding('Topic', 'Topic desc', unitVector(DIM, 0));
      const fact = createFact('A fact', conv.id);

      edgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'hub',
        targetId: fact.id,
        targetType: 'leaf',
        edgeType: 'about',
        weight: 0.5,
      });

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: true, similarityThreshold: 0.0 },
        reinforceOnRetrieval: true,
        reinforcementRate: 0.1,
      }, { usageDecayRate: 0 });

      await retriever.recall({ text: 'query' });

      // Check edge was reinforced: w_new = 0.5 + 0.1 * (1 - 0.5) = 0.55
      const edge = db.prepare(
        'SELECT weight, activation_count FROM weighted_edges WHERE source_id = ?',
      ).get(anchor.id) as { weight: number; activation_count: number };

      expect(edge.weight).toBeCloseTo(0.55, 2);
      expect(edge.activation_count).toBe(1);
    });

    it('records anchor activation on retrieval', async () => {
      const anchor = createAnchorWithEmbedding('Topic', 'Topic desc', unitVector(DIM, 0));

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.0 },
        reinforceOnRetrieval: true,
      });

      await retriever.recall({ text: 'query' });

      const row = db.prepare(
        'SELECT activation_count, last_activated_at FROM anchors WHERE id = ?',
      ).get(anchor.id) as { activation_count: number; last_activated_at: string };

      expect(row.activation_count).toBe(1);
      expect(row.last_activated_at).toBeDefined();
    });

    it('skips reinforcement when disabled', async () => {
      createAnchorWithEmbedding('Topic', 'Topic desc', unitVector(DIM, 0));

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.0 },
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'query' });
      expect(result.diagnostics.edgesReinforced).toBe(0);
    });
  });

  // ── 6. Pipeline traceability ──

  describe('pipeline traceability', () => {
    it('returns diagnostics with timing for each stage', async () => {
      createAnchorWithEmbedding('Topic', 'Topic desc', unitVector(DIM, 0));

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.0 },
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'query' });
      const d = result.diagnostics;

      expect(d.embeddingTimeMs).toBeGreaterThanOrEqual(0);
      expect(d.anchorSearchTimeMs).toBeGreaterThanOrEqual(0);
      expect(d.totalTimeMs).toBeGreaterThan(0);
      expect(d.anchorsMatched).toBe(1);
      expect(d.anchorsCompared).toBeGreaterThanOrEqual(1);

      // Pipeline stages
      expect(d.stages.length).toBeGreaterThanOrEqual(3);
      const stageNames = d.stages.map(s => s.name);
      expect(stageNames).toContain('embed_query');
      expect(stageNames).toContain('anchor_search');
      expect(stageNames).toContain('expansion');
      expect(stageNames).toContain('reinforce');
    });

    it('marks expansion as skipped when no nodes expanded', async () => {
      createAnchorWithEmbedding('Topic', 'Topic desc', unitVector(DIM, 0));

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.0 },
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'query' });

      const expansionStage = result.diagnostics.stages.find(s => s.name === 'expansion');
      expect(expansionStage).toBeDefined();
      expect(expansionStage!.status).toBe('skipped');
    });
  });

  // ── 7. Trace hook ──

  describe('trace hook support', () => {
    it('calls trace hook for each pipeline stage', async () => {
      createAnchorWithEmbedding('Topic', 'Topic desc', unitVector(DIM, 0));
      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const events: UnifiedTraceEvent[] = [];
      const traceHook = (event: UnifiedTraceEvent) => events.push(event);

      const retriever = new UnifiedRetriever(
        db,
        embeddingProvider,
        {
          vector: { expandToMemoryNodes: false, similarityThreshold: 0.0 },
          reinforceOnRetrieval: false,
        },
        undefined,
        traceHook,
      );

      await retriever.recall({ text: 'query' });

      const stageNames = events.map(e => e.stage);
      expect(stageNames).toContain('embed_query');
      expect(stageNames).toContain('anchor_search');
      expect(stageNames).toContain('complete');
    });
  });

  // ── 8. Edge cases ──

  describe('edge cases', () => {
    it('returns empty results when no anchors exist', async () => {
      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'anything' });

      expect(result.items).toHaveLength(0);
      expect(result.activatedAnchors).toHaveLength(0);
      expect(result.diagnostics.anchorsMatched).toBe(0);
    });

    it('returns empty results when no anchors have embeddings', async () => {
      anchorRepo.createAnchor({
        label: 'No Embedding',
        description: 'Anchor without embedding',
        anchorType: 'topic',
      });

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'anything' });

      expect(result.items).toHaveLength(0);
    });

    it('respects maxResults limit', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding('A', 'Anchor', unitVector(DIM, 0));

      for (let i = 0; i < 10; i++) {
        const fact = createFact(`Fact ${i}`, conv.id);
        edgeRepo.createEdge({
          sourceId: anchor.id,
          sourceType: 'hub',
          targetId: fact.id,
          targetType: 'leaf',
          edgeType: 'about',
          weight: 0.9 - i * 0.05,
        });
      }

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: true, similarityThreshold: 0.0, expansionMaxPerAnchor: 10 },
        maxResults: 3,
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'query' });
      expect(result.items.length).toBeLessThanOrEqual(3);
    });

    it('respects minScore threshold', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding('A', 'Anchor', unitVector(DIM, 0));

      const fact = createFact('Low score fact', conv.id);
      edgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'hub',
        targetId: fact.id,
        targetType: 'leaf',
        edgeType: 'about',
        weight: 0.02, // Very low → propagated score will be tiny
      });

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: true, similarityThreshold: 0.0, expansionMinWeight: 0.0 },
        minScore: 0.1,
        reinforceOnRetrieval: false,
      }, { usageDecayRate: 0 });

      const result = await retriever.recall({ text: 'query' });

      // The anchor itself should pass (score ~1.0), but the weak fact should be filtered
      const factItems = result.items.filter(i => i.nodeType === 'fact');
      expect(factItems.length).toBe(0);
    });
  });

  // ── 9. Brain-like associative recall ──

  describe('brain-like associative recall', () => {
    it('recalls related facts via anchor association, not direct text match', async () => {
      const conv = createConversation();

      // Create semantic anchor for "TypeScript"
      const tsVec = unitVector(DIM, 0);
      const tsAnchor = createAnchorWithEmbedding('TypeScript', 'TypeScript programming language', tsVec);

      // Connect various facts to this anchor
      const fact1 = createFact('TypeScript uses structural typing', conv.id);
      const fact2 = createFact('tsc compiler supports incremental builds', conv.id);
      const fact3 = createFact('Interfaces are erased at runtime', conv.id);

      for (const [fact, weight] of [[fact1, 0.9], [fact2, 0.7], [fact3, 0.6]] as const) {
        edgeRepo.createEdge({
          sourceId: tsAnchor.id,
          sourceType: 'hub',
          targetId: fact.id,
          targetType: 'leaf',
          edgeType: 'about',
          weight,
        });
      }

      // Query: "How does TypeScript work?" — doesn't directly match fact text
      embeddingProvider.setEmbedding('How does TypeScript work?', tsVec);

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: true, similarityThreshold: 0.0 },
        reinforceOnRetrieval: false,
      }, { usageDecayRate: 0 });

      const result = await retriever.recall({ text: 'How does TypeScript work?' });

      // Should recall all 3 facts via anchor association
      const factItems = result.items.filter(i => i.nodeType === 'fact');
      expect(factItems.length).toBe(3);

      // Facts should be ranked by edge weight (strongest connection first)
      expect(factItems[0].content).toContain('structural typing');
      expect(factItems[1].content).toContain('incremental builds');
      expect(factItems[2].content).toContain('Interfaces');

      // The activated anchor should be TypeScript
      expect(result.activatedAnchors.length).toBe(1);
      expect(result.activatedAnchors[0].label).toBe('TypeScript');
    });

    it('activates multiple related anchors for a cross-topic query', async () => {
      // Two anchors with partial similarity
      const v1 = [0.8, 0.6, 0, 0, 0, 0, 0, 0];
      const v2 = [0.6, 0.8, 0, 0, 0, 0, 0, 0];

      createAnchorWithEmbedding('Frontend', 'Frontend development', v1);
      createAnchorWithEmbedding('React', 'React framework', v2);

      // Query vector similar to both
      const queryVec = [0.7, 0.7, 0, 0, 0, 0, 0, 0];
      embeddingProvider.setEmbedding('React frontend development', queryVec);

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.5 },
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'React frontend development' });

      // Both anchors should be activated (high similarity to both)
      expect(result.activatedAnchors.length).toBe(2);
    });
  });

  // ── 10. Config override per query ──

  describe('per-query config override', () => {
    it('allows overriding config at query time', async () => {
      createAnchorWithEmbedding('A', 'Anchor A', unitVector(DIM, 0));
      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.99 },
        reinforceOnRetrieval: false,
      });

      // Default config — threshold 0.99, similarity is exactly 1.0 so it matches
      const r1 = await retriever.recall({ text: 'query' });
      expect(r1.items.length).toBe(1);

      // Override with maxResults: 0
      const r2 = await retriever.recall({
        text: 'query',
        config: { maxResults: 0 },
      });
      expect(r2.items.length).toBe(0);
    });
  });
});
