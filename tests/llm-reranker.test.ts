/**
 * Tests for LLM Re-ranking — the "cortical relevance judgment" step in the
 * unified retrieval pipeline.
 *
 * Sub-AC 2 of AC 10: LLM이 anchor+fact context를 보고 query 관련성을 재판정하는
 * re-ranking 프롬프트 및 호출 로직 구현
 *
 * Tests cover:
 *   1. Re-ranking prompt construction (reranking-prompt.ts)
 *   2. LLM response parsing with anti-hallucination validation
 *   3. Score blending (alpha * LLM relevance + (1 - alpha) * coarse score)
 *   4. Filtering by minimum relevance threshold
 *   5. Graceful degradation on LLM failure
 *   6. Passthrough when disabled or no items
 *   7. Integration with UnifiedRetriever pipeline
 *   8. Pipeline traceability (diagnostics + stages)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import {
  buildRerankRequest,
  parseRerankResponse,
  getRerankSystemPrompt,
  type RerankInput,
} from '../src/extraction/reranking-prompt.js';
import {
  LLMReranker,
  DEFAULT_RERANKER_CONFIG,
} from '../src/retrieval/llm-reranker.js';
import {
  UnifiedRetriever,
  type UnifiedTraceEvent,
} from '../src/retrieval/unified-retriever.js';
import type { ScoredMemoryItem } from '../src/retrieval/types.js';
import type { AnchorMatch } from '../src/retrieval/vector-searcher.js';
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

function makeScoredItem(
  nodeId: string,
  score: number,
  content: string,
  nodeType: ScoredMemoryItem['nodeType'] = 'fact',
  metadata?: Record<string, unknown>,
): ScoredMemoryItem {
  return {
    nodeId,
    nodeType,
    score,
    source: 'vector',
    content,
    retrievalMetadata: metadata,
  };
}

function makeAnchorMatch(
  anchorId: string,
  label: string,
  similarity: number,
): AnchorMatch {
  return { anchorId, label, similarity, expandedNodeCount: 0 };
}

// ─── Re-ranking Prompt Tests ─────────────────────────────────────

describe('Reranking Prompt', () => {
  it('builds a valid LLM request with query and candidates', () => {
    const input: RerankInput = {
      query: 'What programming languages does Alice know?',
      candidates: [
        {
          id: 'fact-1',
          nodeType: 'fact',
          content: 'Alice prefers TypeScript for web development',
          anchorLabel: 'Alice',
          coarseScore: 0.85,
        },
        {
          id: 'fact-2',
          nodeType: 'fact',
          content: 'Bob enjoys hiking on weekends',
          coarseScore: 0.3,
        },
      ],
    };

    const request = buildRerankRequest(input);

    expect(request.system).toContain('relevance judge');
    expect(request.prompt).toContain('What programming languages does Alice know?');
    expect(request.prompt).toContain('fact-1');
    expect(request.prompt).toContain('fact-2');
    expect(request.prompt).toContain('Alice prefers TypeScript');
    expect(request.prompt).toContain('[via anchor: "Alice"]');
    expect(request.prompt).toContain('0.850');
    expect(request.responseFormat).toBe('json');
    expect(request.temperature).toBe(0.1);
  });

  it('system prompt instructs scoring range and strict filtering', () => {
    const prompt = getRerankSystemPrompt();
    expect(prompt).toContain('0.9-1.0');
    expect(prompt).toContain('0.0-0.2');
    expect(prompt).toContain('false positive');
    expect(prompt).toContain('JSON');
  });
});

// ─── Response Parsing Tests ──────────────────────────────────────

describe('parseRerankResponse', () => {
  const validIds = new Set(['fact-1', 'fact-2', 'fact-3']);

  it('parses valid JSON response', () => {
    const raw = JSON.stringify({
      scores: [
        { id: 'fact-1', relevance: 0.9, reason: 'Directly relevant' },
        { id: 'fact-2', relevance: 0.1, reason: 'Not relevant' },
      ],
    });

    const result = parseRerankResponse(raw, validIds);
    expect(result.scores).toHaveLength(2);
    expect(result.scores[0]).toEqual({
      id: 'fact-1',
      relevance: 0.9,
      reason: 'Directly relevant',
    });
    expect(result.scores[1]).toEqual({
      id: 'fact-2',
      relevance: 0.1,
      reason: 'Not relevant',
    });
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"scores": [{"id": "fact-1", "relevance": 0.8}]}\n```';
    const result = parseRerankResponse(raw, validIds);
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0].id).toBe('fact-1');
  });

  it('filters out hallucinated IDs not in candidate set', () => {
    const raw = JSON.stringify({
      scores: [
        { id: 'fact-1', relevance: 0.9 },
        { id: 'hallucinated-id', relevance: 0.8 },
        { id: 'fact-2', relevance: 0.5 },
      ],
    });

    const result = parseRerankResponse(raw, validIds);
    expect(result.scores).toHaveLength(2);
    expect(result.scores.map(s => s.id)).toEqual(['fact-1', 'fact-2']);
  });

  it('clamps scores to [0, 1]', () => {
    const raw = JSON.stringify({
      scores: [
        { id: 'fact-1', relevance: 1.5 },
        { id: 'fact-2', relevance: -0.3 },
      ],
    });

    const result = parseRerankResponse(raw, validIds);
    expect(result.scores[0].relevance).toBe(1.0);
    expect(result.scores[1].relevance).toBe(0.0);
  });

  it('handles NaN relevance as 0', () => {
    const raw = JSON.stringify({
      scores: [{ id: 'fact-1', relevance: 'not_a_number' }],
    });

    const result = parseRerankResponse(raw, validIds);
    expect(result.scores[0].relevance).toBe(0.0);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseRerankResponse('not json', validIds)).toThrow(
      'Failed to parse rerank JSON',
    );
  });

  it('throws on non-object response', () => {
    expect(() => parseRerankResponse('"string"', validIds)).toThrow(
      'Rerank response is not an object',
    );
  });

  it('handles missing scores array gracefully', () => {
    const raw = JSON.stringify({ other: 'data' });
    const result = parseRerankResponse(raw, validIds);
    expect(result.scores).toHaveLength(0);
  });

  it('handles reason as optional', () => {
    const raw = JSON.stringify({
      scores: [{ id: 'fact-1', relevance: 0.7 }],
    });

    const result = parseRerankResponse(raw, validIds);
    expect(result.scores[0].reason).toBeUndefined();
  });
});

// ─── LLMReranker Service Tests ───────────────────────────────────

describe('LLMReranker', () => {
  let llmProvider: MockLLMProvider;

  beforeEach(() => {
    llmProvider = new MockLLMProvider();
  });

  it('has sensible default configuration', () => {
    expect(DEFAULT_RERANKER_CONFIG.maxCandidates).toBe(20);
    expect(DEFAULT_RERANKER_CONFIG.alpha).toBe(0.7);
    expect(DEFAULT_RERANKER_CONFIG.minRelevance).toBe(0.1);
    expect(DEFAULT_RERANKER_CONFIG.enabled).toBe(true);
  });

  it('blends LLM relevance with coarse scores using alpha', async () => {
    const reranker = new LLMReranker(llmProvider, { alpha: 0.7 });

    llmProvider.addResponse(JSON.stringify({
      scores: [
        { id: 'fact-1', relevance: 0.9 },
        { id: 'fact-2', relevance: 0.4 },
      ],
    }));

    const items = [
      makeScoredItem('fact-1', 0.8, 'Highly relevant fact'),
      makeScoredItem('fact-2', 0.7, 'Less relevant by LLM'),
    ];

    const result = await reranker.rerank('test query', items, []);

    // fact-1: 0.7 * 0.9 + 0.3 * 0.8 = 0.63 + 0.24 = 0.87
    expect(result.items[0].nodeId).toBe('fact-1');
    expect(result.items[0].score).toBeCloseTo(0.87, 2);

    // fact-2: 0.7 * 0.4 + 0.3 * 0.7 = 0.28 + 0.21 = 0.49
    expect(result.items[1].nodeId).toBe('fact-2');
    expect(result.items[1].score).toBeCloseTo(0.49, 2);

    expect(result.stats.source).toBe('llm');
  });

  it('filters items below minRelevance', async () => {
    const reranker = new LLMReranker(llmProvider, { minRelevance: 0.3 });

    llmProvider.addResponse(JSON.stringify({
      scores: [
        { id: 'fact-1', relevance: 0.9 },
        { id: 'fact-2', relevance: 0.05 }, // Below threshold
      ],
    }));

    const items = [
      makeScoredItem('fact-1', 0.8, 'Relevant'),
      makeScoredItem('fact-2', 0.7, 'False positive'),
    ];

    const result = await reranker.rerank('test query', items, []);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].nodeId).toBe('fact-1');
    expect(result.stats.itemsFiltered).toBe(1);
  });

  it('includes anchor label context in candidates', async () => {
    const reranker = new LLMReranker(llmProvider);

    llmProvider.addResponse(JSON.stringify({
      scores: [{ id: 'fact-1', relevance: 0.8 }],
    }));

    const items = [
      makeScoredItem('fact-1', 0.7, 'Some fact', 'fact', {
        expandedFromAnchor: 'anchor-1',
      }),
    ];

    const anchors = [makeAnchorMatch('anchor-1', 'TypeScript', 0.9)];

    await reranker.rerank('test query', items, anchors);

    // Check the prompt sent to LLM includes anchor context
    expect(llmProvider.calls).toHaveLength(1);
    expect(llmProvider.calls[0].prompt).toContain('TypeScript');
  });

  it('gracefully degrades on LLM failure', async () => {
    const reranker = new LLMReranker(llmProvider);

    // No response queued → will return default '{"facts": []}' which fails parsing
    // Actually let's make the provider throw
    llmProvider.addResponse('INVALID JSON {{{');

    const items = [
      makeScoredItem('fact-1', 0.8, 'Some fact'),
    ];

    const result = await reranker.rerank('test', items, []);

    // Should return original items unchanged
    expect(result.items).toHaveLength(1);
    expect(result.items[0].score).toBe(0.8);
    expect(result.stats.source).toBe('error_fallback');
    expect(result.stats.error).toContain('LLM rerank failed');
  });

  it('passes through when disabled', async () => {
    const reranker = new LLMReranker(llmProvider, { enabled: false });

    const items = [makeScoredItem('fact-1', 0.8, 'Some fact')];
    const result = await reranker.rerank('test', items, []);

    expect(result.items).toEqual(items);
    expect(result.stats.source).toBe('passthrough');
    expect(llmProvider.calls).toHaveLength(0);
  });

  it('passes through when items is empty', async () => {
    const reranker = new LLMReranker(llmProvider);

    const result = await reranker.rerank('test', [], []);

    expect(result.items).toHaveLength(0);
    expect(result.stats.source).toBe('passthrough');
  });

  it('re-sorts items by blended score', async () => {
    const reranker = new LLMReranker(llmProvider, { alpha: 0.7 });

    llmProvider.addResponse(JSON.stringify({
      scores: [
        { id: 'fact-1', relevance: 0.3 },  // LLM says low
        { id: 'fact-2', relevance: 0.95 },  // LLM says high
      ],
    }));

    const items = [
      makeScoredItem('fact-1', 0.9, 'High coarse, low LLM'),
      makeScoredItem('fact-2', 0.5, 'Low coarse, high LLM'),
    ];

    const result = await reranker.rerank('test', items, []);

    // fact-2 should be first because LLM dominates with alpha=0.7
    // fact-2: 0.7 * 0.95 + 0.3 * 0.5 = 0.665 + 0.15 = 0.815
    // fact-1: 0.7 * 0.3 + 0.3 * 0.9 = 0.21 + 0.27 = 0.48
    expect(result.items[0].nodeId).toBe('fact-2');
    expect(result.items[1].nodeId).toBe('fact-1');
  });

  it('keeps items with no LLM score at original score', async () => {
    const reranker = new LLMReranker(llmProvider);

    // LLM only scores fact-1, skips fact-2
    llmProvider.addResponse(JSON.stringify({
      scores: [{ id: 'fact-1', relevance: 0.9 }],
    }));

    const items = [
      makeScoredItem('fact-1', 0.8, 'Scored by LLM'),
      makeScoredItem('fact-2', 0.6, 'Not scored by LLM'),
    ];

    const result = await reranker.rerank('test', items, []);

    expect(result.items).toHaveLength(2);
    // fact-2 keeps original score
    const fact2 = result.items.find(i => i.nodeId === 'fact-2');
    expect(fact2?.score).toBe(0.6);
  });

  it('respects maxCandidates limit', async () => {
    const reranker = new LLMReranker(llmProvider, { maxCandidates: 2 });

    llmProvider.addResponse(JSON.stringify({
      scores: [
        { id: 'fact-1', relevance: 0.9 },
        { id: 'fact-2', relevance: 0.8 },
      ],
    }));

    const items = [
      makeScoredItem('fact-1', 0.9, 'First'),
      makeScoredItem('fact-2', 0.8, 'Second'),
      makeScoredItem('fact-3', 0.7, 'Third - overflow'),
    ];

    const result = await reranker.rerank('test', items, []);

    // fact-3 should be present but keep original score
    expect(result.items).toHaveLength(3);
    expect(result.stats.candidatesSent).toBe(2);
  });

  it('adds retrievalMetadata with LLM details', async () => {
    const reranker = new LLMReranker(llmProvider, { alpha: 0.6 });

    llmProvider.addResponse(JSON.stringify({
      scores: [
        { id: 'fact-1', relevance: 0.85, reason: 'Very relevant' },
      ],
    }));

    const items = [makeScoredItem('fact-1', 0.7, 'A fact')];

    const result = await reranker.rerank('test', items, []);

    const meta = result.items[0].retrievalMetadata;
    expect(meta?.llmRelevance).toBe(0.85);
    expect(meta?.llmReason).toBe('Very relevant');
    expect(meta?.coarseScore).toBe(0.7);
    expect(meta?.rerankBlendAlpha).toBe(0.6);
  });
});

// ─── UnifiedRetriever + Reranker Integration ─────────────────────

describe('UnifiedRetriever with LLM Reranker', () => {
  let db: Database.Database;
  let anchorRepo: AnchorRepository;
  let edgeRepo: WeightedEdgeRepository;
  let factRepo: FactRepository;
  let convRepo: ConversationRepository;
  let mockEmbedding: MockEmbeddingProvider;
  let mockLLM: MockLLMProvider;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    anchorRepo = new AnchorRepository(db);
    edgeRepo = new WeightedEdgeRepository(db);
    factRepo = new FactRepository(db);
    convRepo = new ConversationRepository(db);
    mockEmbedding = new MockEmbeddingProvider(DIM);
    mockLLM = new MockLLMProvider();
  });

  function createConversation() {
    return convRepo.ingest({ source: 'test', messages: [] });
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

  function createAnchorWithEmbedding(label: string, embedding: number[]) {
    return anchorRepo.createAnchor({
      label,
      description: `Anchor: ${label}`,
      anchorType: 'topic',
      embedding: toFloat32(embedding),
      initialWeight: 1.0,
      decayRate: 0,
    });
  }

  it('includes llm_rerank stage in diagnostics when LLM provider is given', async () => {
    const queryVec = unitVector(DIM, 0);
    const anchor = createAnchorWithEmbedding('TypeScript', unitVector(DIM, 0));
    const conv = createConversation();
    const fact = createFact('TypeScript is a statically typed language', conv.id);

    edgeRepo.createEdge({
      sourceId: anchor.id, sourceType: 'anchor',
      targetId: fact.id, targetType: 'fact',
      edgeType: 'anchor_to_fact', weight: 0.8,
    });

    mockEmbedding.setEmbedding('TypeScript features', queryVec);
    mockLLM.addResponse(JSON.stringify({
      scores: [
        { id: anchor.id, relevance: 0.9 },
        { id: fact.id, relevance: 0.85 },
      ],
    }));

    const retriever = new UnifiedRetriever(
      db, mockEmbedding,
      { reinforceOnRetrieval: false },
      undefined, undefined, mockLLM,
    );

    const result = await retriever.recall({ text: 'TypeScript features' });

    // Verify items were found
    expect(result.diagnostics.anchorsMatched).toBeGreaterThan(0);
    expect(result.items.length).toBeGreaterThan(0);

    // Check llm_rerank stage is present and complete
    const llmRerankStage = result.diagnostics.stages.find(s => s.name === 'llm_rerank');
    expect(llmRerankStage).toBeDefined();
    expect(llmRerankStage!.status).toBe('complete');
    expect(llmRerankStage!.detail).toContain('llm');
    expect(result.diagnostics.llmRerankTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.llmRerankStats).toBeDefined();
    expect(result.diagnostics.llmRerankStats!.source).toBe('llm');
  });

  it('LLM reranker changes item order based on LLM judgment', async () => {
    const queryVec = unitVector(DIM, 0);
    const anchor1 = createAnchorWithEmbedding('Topic A', unitVector(DIM, 0));
    const anchor2 = createAnchorWithEmbedding('Topic B', unitVector(DIM, 0));
    const conv = createConversation();
    const fact1 = createFact('Fact about topic A', conv.id);
    const fact2 = createFact('Fact about topic B', conv.id);

    edgeRepo.createEdge({
      sourceId: anchor1.id, sourceType: 'anchor',
      targetId: fact1.id, targetType: 'fact',
      edgeType: 'anchor_to_fact', weight: 0.8,
    });
    edgeRepo.createEdge({
      sourceId: anchor2.id, sourceType: 'anchor',
      targetId: fact2.id, targetType: 'fact',
      edgeType: 'anchor_to_fact', weight: 0.8,
    });

    mockEmbedding.setEmbedding('test query', queryVec);

    // LLM says fact2 is more relevant than fact1
    mockLLM.addResponse(JSON.stringify({
      scores: [
        { id: anchor1.id, relevance: 0.3 },
        { id: fact1.id, relevance: 0.2 },
        { id: anchor2.id, relevance: 0.9 },
        { id: fact2.id, relevance: 0.95 },
      ],
    }));

    const retriever = new UnifiedRetriever(
      db, mockEmbedding,
      { reinforceOnRetrieval: false, llmReranker: { alpha: 0.8 } },
      undefined, undefined, mockLLM,
    );

    const result = await retriever.recall({ text: 'test query' });

    const factItems = result.items.filter(i => i.nodeType === 'fact');
    if (factItems.length >= 2) {
      expect(factItems[0].nodeId).toBe(fact2.id);
    }
  });

  it('skips llm_rerank stage when no LLM provider', async () => {
    const queryVec = unitVector(DIM, 0);
    createAnchorWithEmbedding('TestSkip', unitVector(DIM, 0));

    mockEmbedding.setEmbedding('test', queryVec);

    const retriever = new UnifiedRetriever(
      db, mockEmbedding,
      { reinforceOnRetrieval: false },
    );

    const result = await retriever.recall({ text: 'test' });

    const llmRerankStage = result.diagnostics.stages.find(s => s.name === 'llm_rerank');
    expect(llmRerankStage).toBeDefined();
    expect(llmRerankStage!.status).toBe('skipped');
    expect(result.diagnostics.llmRerankTimeMs).toBe(0);
    expect(result.diagnostics.llmRerankStats).toBeUndefined();
  });

  it('emits llm_rerank trace events', async () => {
    const queryVec = unitVector(DIM, 0);
    const anchor = createAnchorWithEmbedding('TraceTest', unitVector(DIM, 0));
    const conv = createConversation();
    const fact = createFact('Test fact for tracing', conv.id);

    edgeRepo.createEdge({
      sourceId: anchor.id, sourceType: 'anchor',
      targetId: fact.id, targetType: 'fact',
      edgeType: 'anchor_to_fact', weight: 0.8,
    });

    mockEmbedding.setEmbedding('test', queryVec);
    mockLLM.addResponse(JSON.stringify({
      scores: [
        { id: anchor.id, relevance: 0.8 },
        { id: fact.id, relevance: 0.7 },
      ],
    }));

    const events: UnifiedTraceEvent[] = [];
    const traceHook = (e: UnifiedTraceEvent) => events.push(e);

    const retriever = new UnifiedRetriever(
      db, mockEmbedding,
      { reinforceOnRetrieval: false },
      undefined, traceHook, mockLLM,
    );

    await retriever.recall({ text: 'test' });

    const llmRerankEvents = events.filter(e => e.stage === 'llm_rerank');
    expect(llmRerankEvents.length).toBeGreaterThanOrEqual(1);
    const startEvent = llmRerankEvents.find(e => e.status === 'start');
    const completeEvent = llmRerankEvents.find(e => e.status === 'complete');
    expect(startEvent).toBeDefined();
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.detail?.source).toBe('llm');
  });

  it('handles LLM failure gracefully in integrated pipeline', async () => {
    const queryVec = unitVector(DIM, 0);
    const anchor = createAnchorWithEmbedding('FailTest', unitVector(DIM, 0));
    const conv = createConversation();
    const fact = createFact('Test fact for failure', conv.id);

    edgeRepo.createEdge({
      sourceId: anchor.id, sourceType: 'anchor',
      targetId: fact.id, targetType: 'fact',
      edgeType: 'anchor_to_fact', weight: 0.8,
    });

    mockEmbedding.setEmbedding('test', queryVec);
    mockLLM.addResponse('totally broken json {{{');

    const retriever = new UnifiedRetriever(
      db, mockEmbedding,
      { reinforceOnRetrieval: false },
      undefined, undefined, mockLLM,
    );

    const result = await retriever.recall({ text: 'test' });

    expect(result.items.length).toBeGreaterThan(0);

    const llmRerankStage = result.diagnostics.stages.find(s => s.name === 'llm_rerank');
    expect(llmRerankStage).toBeDefined();
    expect(llmRerankStage!.status).toBe('error');
    expect(result.diagnostics.llmRerankStats?.source).toBe('error_fallback');
  });
});
