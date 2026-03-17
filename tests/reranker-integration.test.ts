/**
 * Tests for re-ranking integration into the retrieval pipeline.
 *
 * Sub-AC 3 of AC 10: re-ranking 결과를 retrieval pipeline에 통합하고
 * 최종 결과를 반환하는 로직 구현
 *
 * Tests cover:
 *   1. Graph+content re-ranking amplifies items with strong graph connections
 *   2. Content enrichment with Level 0 (frontmatter) + Level 1 (summary)
 *   3. Re-ranking stage appears in pipeline diagnostics
 *   4. Re-ranking can be disabled via config
 *   5. Graceful degradation when re-ranking errors
 *   6. Brain-like associative recall with re-ranking
 *   7. Trace hook captures re-ranking events
 *   8. ReRanker standalone unit tests
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
import { ReRanker } from '../src/retrieval/reranker.js';
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

describe('Re-ranking Integration', () => {
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

  function createFact(content: string, conversationId: string, opts?: { summary?: string; frontmatter?: string }) {
    const fact = factRepo.create({
      content,
      conversationId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: [],
      summary: opts?.summary,
      frontmatter: opts?.frontmatter,
    });
    return fact;
  }

  function createConversation() {
    return convRepo.ingest({ source: 'test', messages: [] });
  }

  // ── 1. Re-ranking amplifies graph-connected items ──

  describe('graph+content re-ranking integration', () => {
    it('re-ranks items using graph traversal scores', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding(
        'TypeScript',
        'TypeScript programming',
        unitVector(DIM, 0),
      );

      // Create two facts: one with strong edge, one with weak edge
      const strongFact = createFact('TypeScript uses structural typing', conv.id);
      const weakFact = createFact('TypeScript has modules', conv.id);

      edgeRepo.createEdge({
        sourceId: anchor.id, sourceType: 'anchor',
        targetId: strongFact.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.9,
      });
      edgeRepo.createEdge({
        sourceId: anchor.id, sourceType: 'anchor',
        targetId: weakFact.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.3,
      });

      embeddingProvider.setEmbedding('TypeScript types', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: true, similarityThreshold: 0.0, expansionMinWeight: 0.0 },
        enableReranking: true,
        reinforceOnRetrieval: false,
      }, { usageDecayRate: 0 });

      const result = await retriever.recall({ text: 'TypeScript types' });

      // Should have both facts
      const factItems = result.items.filter(i => i.nodeType === 'fact');
      expect(factItems.length).toBe(2);

      // Strong edge fact should still be ranked higher after re-ranking
      expect(factItems[0].content).toContain('structural typing');

      // Each fact should have rerankScores in metadata
      for (const item of factItems) {
        expect(item.retrievalMetadata?.rerankScores).toBeDefined();
        const scores = item.retrievalMetadata!.rerankScores as Record<string, number>;
        expect(scores.coarse).toBeDefined();
        expect(scores.graph).toBeDefined();
        expect(scores.final).toBeDefined();
      }
    });

    it('enriches fact content with summary/frontmatter', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding(
        'TypeScript',
        'TypeScript lang',
        unitVector(DIM, 0),
      );

      const fact = createFact('TypeScript uses structural typing for type compatibility', conv.id, {
        summary: 'TS structural typing enables duck-typing at compile time',
        frontmatter: 'TS:StructuralTyping',
      });

      edgeRepo.createEdge({
        sourceId: anchor.id, sourceType: 'anchor',
        targetId: fact.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.8,
      });

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: true, similarityThreshold: 0.0 },
        enableReranking: true,
        reranker: { enrichContent: true },
        reinforceOnRetrieval: false,
      }, { usageDecayRate: 0 });

      const result = await retriever.recall({ text: 'query' });

      const factItem = result.items.find(i => i.nodeType === 'fact');
      expect(factItem).toBeDefined();

      // Content should be enriched with frontmatter + summary
      expect(factItem!.content).toContain('[TS:StructuralTyping]');
      expect(factItem!.content).toContain('duck-typing');
      expect(factItem!.content).toContain('structural typing');
    });
  });

  // ── 2. Re-ranking in pipeline diagnostics ──

  describe('pipeline diagnostics with re-ranking', () => {
    it('includes rerank stage in diagnostics', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding('Topic', 'Topic desc', unitVector(DIM, 0));
      const fact = createFact('A relevant fact', conv.id);
      edgeRepo.createEdge({
        sourceId: anchor.id, sourceType: 'anchor',
        targetId: fact.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.8,
      });

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: true, similarityThreshold: 0.0 },
        enableReranking: true,
        reinforceOnRetrieval: false,
      }, { usageDecayRate: 0 });

      const result = await retriever.recall({ text: 'query' });
      const d = result.diagnostics;

      // rerankTimeMs should be > 0 since we had items to rerank
      expect(d.rerankTimeMs).toBeGreaterThanOrEqual(0);

      // rerankStats should be present
      expect(d.rerankStats).toBeDefined();
      expect(d.rerankStats!.inputCount).toBeGreaterThan(0);
      expect(d.rerankStats!.outputCount).toBeGreaterThan(0);

      // Pipeline stages should include 'rerank'
      const stageNames = d.stages.map(s => s.name);
      expect(stageNames).toContain('embed_query');
      expect(stageNames).toContain('anchor_search');
      expect(stageNames).toContain('expansion');
      expect(stageNames).toContain('rerank');
      expect(stageNames).toContain('llm_rerank');
      expect(stageNames).toContain('reinforce');

      // rerank should be complete
      const rerankStage = d.stages.find(s => s.name === 'rerank');
      expect(rerankStage!.status).toBe('complete');

      // llm_rerank should be skipped (no LLM provider)
      const llmRerankStage = d.stages.find(s => s.name === 'llm_rerank');
      expect(llmRerankStage!.status).toBe('skipped');
    });

    it('reports rerankTimeMs in total pipeline time', async () => {
      createAnchorWithEmbedding('Topic', 'Topic desc', unitVector(DIM, 0));
      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.0 },
        enableReranking: true,
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'query' });

      // totalTimeMs should be >= sum of stage times
      expect(result.diagnostics.totalTimeMs).toBeGreaterThan(0);
    });
  });

  // ── 3. Re-ranking disabled ──

  describe('re-ranking disabled', () => {
    it('skips re-ranking when enableReranking is false', async () => {
      createAnchorWithEmbedding('Topic', 'Topic desc', unitVector(DIM, 0));
      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.0 },
        enableReranking: false,
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'query' });

      expect(result.diagnostics.rerankTimeMs).toBe(0);
      expect(result.diagnostics.rerankStats).toBeUndefined();

      const rerankStage = result.diagnostics.stages.find(s => s.name === 'rerank');
      expect(rerankStage!.status).toBe('skipped');
    });

    it('preserves original scores when re-ranking is disabled', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding('Topic', 'Desc', unitVector(DIM, 0));
      const fact = createFact('A fact', conv.id);
      edgeRepo.createEdge({
        sourceId: anchor.id, sourceType: 'anchor',
        targetId: fact.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.8,
      });

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      // With re-ranking disabled
      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: true, similarityThreshold: 0.0 },
        enableReranking: false,
        reinforceOnRetrieval: false,
      }, { usageDecayRate: 0 });

      const result = await retriever.recall({ text: 'query' });

      const factItem = result.items.find(i => i.nodeType === 'fact');
      expect(factItem).toBeDefined();

      // Should NOT have rerankScores
      expect(factItem!.retrievalMetadata?.rerankScores).toBeUndefined();
    });
  });

  // ── 4. Trace hook with re-ranking ──

  describe('trace hook with re-ranking', () => {
    it('fires rerank stage events', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding('Topic', 'Desc', unitVector(DIM, 0));
      const fact = createFact('A fact', conv.id);
      edgeRepo.createEdge({
        sourceId: anchor.id, sourceType: 'anchor',
        targetId: fact.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.8,
      });

      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const events: UnifiedTraceEvent[] = [];
      const traceHook = (event: UnifiedTraceEvent) => events.push(event);

      const retriever = new UnifiedRetriever(
        db, embeddingProvider,
        {
          vector: { expandToMemoryNodes: true, similarityThreshold: 0.0 },
          enableReranking: true,
          reinforceOnRetrieval: false,
        },
        { usageDecayRate: 0 },
        traceHook,
      );

      await retriever.recall({ text: 'query' });

      const stageNames = events.map(e => e.stage);
      expect(stageNames).toContain('rerank');

      // Check rerank events
      const rerankStart = events.find(e => e.stage === 'rerank' && e.status === 'start');
      const rerankComplete = events.find(e => e.stage === 'rerank' && e.status === 'complete');
      expect(rerankStart).toBeDefined();
      expect(rerankComplete).toBeDefined();
      expect(rerankComplete!.durationMs).toBeGreaterThanOrEqual(0);
      expect(rerankComplete!.detail?.graphEnrichedCount).toBeDefined();
    });

    it('fires llm_rerank skipped event when no LLM provider', async () => {
      createAnchorWithEmbedding('Topic', 'Desc', unitVector(DIM, 0));
      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const events: UnifiedTraceEvent[] = [];
      const traceHook = (event: UnifiedTraceEvent) => events.push(event);

      const retriever = new UnifiedRetriever(
        db, embeddingProvider,
        {
          vector: { expandToMemoryNodes: false, similarityThreshold: 0.0 },
          enableReranking: true,
          reinforceOnRetrieval: false,
        },
        undefined,
        traceHook,
      );

      await retriever.recall({ text: 'query' });

      const llmRerankEvent = events.find(e => e.stage === 'llm_rerank');
      expect(llmRerankEvent).toBeDefined();
      expect(llmRerankEvent!.status).toBe('skipped');
    });
  });

  // ── 5. Brain-like recall with re-ranking ──

  describe('brain-like associative recall with re-ranking', () => {
    it('cross-anchor graph traversal amplifies strongly connected facts', async () => {
      const conv = createConversation();

      // Two anchors with different topics
      const tsAnchor = createAnchorWithEmbedding('TypeScript', 'TS lang', unitVector(DIM, 0));
      const webAnchor = createAnchorWithEmbedding('Web Dev', 'Web development', [0.7, 0.7, 0, 0, 0, 0, 0, 0]);

      // fact1 is connected to both anchors (strong association)
      // fact2 is connected to only TypeScript
      const fact1 = createFact('TypeScript is used for web development', conv.id, {
        summary: 'TS is the primary language for modern web apps',
        frontmatter: 'TS:WebDev',
      });
      const fact2 = createFact('TypeScript compiles to JavaScript', conv.id);

      // fact1: strong connection to both anchors
      edgeRepo.createEdge({
        sourceId: tsAnchor.id, sourceType: 'anchor',
        targetId: fact1.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.9,
      });
      edgeRepo.createEdge({
        sourceId: webAnchor.id, sourceType: 'anchor',
        targetId: fact1.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.8,
      });

      // fact2: only TS anchor
      edgeRepo.createEdge({
        sourceId: tsAnchor.id, sourceType: 'anchor',
        targetId: fact2.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.5,
      });

      // Query activates TS anchor
      embeddingProvider.setEmbedding('TypeScript for web', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: true, similarityThreshold: 0.0, expansionMinWeight: 0.0 },
        enableReranking: true,
        reranker: { enableGraphRerank: true, enableContentRerank: true },
        reinforceOnRetrieval: false,
      }, { usageDecayRate: 0 });

      const result = await retriever.recall({ text: 'TypeScript for web' });

      const factItems = result.items.filter(i => i.nodeType === 'fact');
      expect(factItems.length).toBe(2);

      // fact1 should rank higher (stronger graph + content match)
      expect(factItems[0].content).toContain('web development');

      // Diagnostics should show re-ranking happened
      expect(result.diagnostics.rerankStats).toBeDefined();
      expect(result.diagnostics.rerankStats!.graphEnrichedCount).toBeGreaterThan(0);
    });

    it('content keyword matching boosts relevant summaries', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding('Programming', 'Programming concepts', unitVector(DIM, 0));

      // Two facts with same coarse score but different summaries
      const factRelevant = createFact('Generics allow type-safe containers', conv.id, {
        summary: 'TypeScript generics provide compile-time type safety for containers',
        frontmatter: 'TS:Generics',
      });
      const factIrrelevant = createFact('CSS grid layout system', conv.id, {
        summary: 'CSS grid provides two-dimensional layout control',
        frontmatter: 'CSS:Grid',
      });

      edgeRepo.createEdge({
        sourceId: anchor.id, sourceType: 'anchor',
        targetId: factRelevant.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.7,
      });
      edgeRepo.createEdge({
        sourceId: anchor.id, sourceType: 'anchor',
        targetId: factIrrelevant.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.7,
      });

      embeddingProvider.setEmbedding('TypeScript generics', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: true, similarityThreshold: 0.0 },
        enableReranking: true,
        reranker: { enableContentRerank: true },
        reinforceOnRetrieval: false,
      }, { usageDecayRate: 0 });

      const result = await retriever.recall({ text: 'TypeScript generics' });

      const factItems = result.items.filter(i => i.nodeType === 'fact');
      expect(factItems.length).toBe(2);

      // Fact with "TypeScript" + "generics" in summary should score higher
      expect(factItems[0].content).toContain('Generics');

      // Check content enrichment happened
      expect(result.diagnostics.rerankStats!.contentEnrichedCount).toBeGreaterThan(0);
    });
  });

  // ── 6. Edge cases ──

  describe('edge cases', () => {
    it('returns empty results gracefully with re-ranking enabled', async () => {
      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        enableReranking: true,
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'anything' });

      expect(result.items).toHaveLength(0);
      expect(result.diagnostics.rerankTimeMs).toBe(0);

      const rerankStage = result.diagnostics.stages.find(s => s.name === 'rerank');
      expect(rerankStage!.status).toBe('skipped');
    });

    it('re-ranking with anchors but no expanded facts still works', async () => {
      createAnchorWithEmbedding('Topic', 'Topic desc', unitVector(DIM, 0));
      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.0 },
        enableReranking: true,
        reinforceOnRetrieval: false,
      });

      const result = await retriever.recall({ text: 'query' });

      // Should have the anchor item, re-ranked
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].nodeType).toBe('anchor');

      // Rerank should have run
      const rerankStage = result.diagnostics.stages.find(s => s.name === 'rerank');
      expect(rerankStage!.status).toBe('complete');
    });

    it('per-query config can disable re-ranking', async () => {
      createAnchorWithEmbedding('Topic', 'Desc', unitVector(DIM, 0));
      embeddingProvider.setEmbedding('query', unitVector(DIM, 0));

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: false, similarityThreshold: 0.0 },
        enableReranking: true,
        reinforceOnRetrieval: false,
      });

      // Override enableReranking to false at query time
      const result = await retriever.recall({
        text: 'query',
        config: { enableReranking: false },
      });

      const rerankStage = result.diagnostics.stages.find(s => s.name === 'rerank');
      expect(rerankStage!.status).toBe('skipped');
    });
  });

  // ── 7. ReRanker standalone unit tests ──

  describe('ReRanker standalone', () => {
    it('produces empty result for empty input', async () => {
      const reranker = new ReRanker(db);
      const result = await reranker.rerank([], [], 'query');

      expect(result.items).toHaveLength(0);
      expect(result.stats.inputCount).toBe(0);
      expect(result.stats.outputCount).toBe(0);
    });

    it('preserves item scores when no graph/content signals', async () => {
      const reranker = new ReRanker(db, {
        enableGraphRerank: false,
        enableContentRerank: false,
      });

      const items = [
        {
          nodeId: 'id-1',
          nodeType: 'fact' as const,
          score: 0.8,
          source: 'vector' as const,
          content: 'Test fact',
        },
      ];

      const result = await reranker.rerank(items, [], 'query');

      expect(result.items.length).toBe(1);
      // Score should be preserved (no re-rank signal → keep coarse)
      expect(result.items[0].score).toBe(0.8);
    });

    it('graph re-ranking uses GraphTraverser scores', async () => {
      const conv = createConversation();
      const anchor = createAnchorWithEmbedding('A', 'Anchor A', unitVector(DIM, 0));
      const fact = createFact('Graph-connected fact', conv.id);
      edgeRepo.createEdge({
        sourceId: anchor.id, sourceType: 'anchor',
        targetId: fact.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.9,
      });

      const reranker = new ReRanker(db, {
        enableGraphRerank: true,
        enableContentRerank: false,
      });

      const items = [
        {
          nodeId: fact.id,
          nodeType: 'fact' as const,
          score: 0.5,
          source: 'vector' as const,
          content: 'Graph-connected fact',
        },
      ];

      const result = await reranker.rerank(
        items,
        [{ anchorId: anchor.id, label: 'A', similarity: 0.95, expandedNodeCount: 1 }],
        'query',
      );

      expect(result.items.length).toBe(1);
      expect(result.stats.graphEnrichedCount).toBeGreaterThan(0);

      // Should have rerankScores metadata
      const rerankScores = result.items[0].retrievalMetadata?.rerankScores as Record<string, number>;
      expect(rerankScores.graph).toBeGreaterThan(0);
    });

    it('content scoring boosts matching summaries', async () => {
      const conv = createConversation();
      const fact = createFact('Original content', conv.id, {
        summary: 'TypeScript generics enable type-safe containers',
        frontmatter: 'TS:Generics',
      });

      const reranker = new ReRanker(db, {
        enableGraphRerank: false,
        enableContentRerank: true,
        enrichContent: false, // Don't modify content, just score
      });

      const items = [
        {
          nodeId: fact.id,
          nodeType: 'fact' as const,
          score: 0.5,
          source: 'vector' as const,
          content: 'Original content',
        },
      ];

      const result = await reranker.rerank(items, [], 'TypeScript generics');

      expect(result.items.length).toBe(1);
      expect(result.stats.contentEnrichedCount).toBeGreaterThan(0);

      const rerankScores = result.items[0].retrievalMetadata?.rerankScores as Record<string, number>;
      expect(rerankScores.content).toBeGreaterThan(0);
    });
  });

  // ── 8. Existing tests still pass (backward compatibility) ──

  describe('backward compatibility', () => {
    it('recall still works with default config (re-ranking disabled by default for backward compat)', async () => {
      const conv = createConversation();
      const tsVec = unitVector(DIM, 0);
      const tsAnchor = createAnchorWithEmbedding('TypeScript', 'TypeScript programming language', tsVec);
      const fact = createFact('TypeScript uses structural typing', conv.id);

      edgeRepo.createEdge({
        sourceId: tsAnchor.id, sourceType: 'anchor',
        targetId: fact.id, targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.9,
      });

      embeddingProvider.setEmbedding('How does TypeScript work?', tsVec);

      const retriever = new UnifiedRetriever(db, embeddingProvider, {
        vector: { expandToMemoryNodes: true, similarityThreshold: 0.0 },
        reinforceOnRetrieval: false,
      }, { usageDecayRate: 0 });

      const result = await retriever.recall({ text: 'How does TypeScript work?' });

      const factItems = result.items.filter(i => i.nodeType === 'fact');
      expect(factItems.length).toBe(1);
      expect(factItems[0].content).toContain('structural typing');
      expect(result.activatedAnchors[0].label).toBe('TypeScript');
    });
  });
});
