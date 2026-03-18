/**
 * Tests for Hybrid Search API — FTS5 + vector reranking endpoint.
 *
 * Covers:
 *   - Validation: request body validation for /search/hybrid
 *   - API integration: HTTP endpoint with mock and real HybridSearcher
 *   - Unit: HybridSearcher search pipeline (FTS5 pre-filter → vector rerank)
 *   - Unit: normalizeFtsRanks, computeEventDecay helpers
 *   - Integration: end-to-end FTS5 + vector hybrid search on MemoryNode data
 *   - 한영 혼용: Korean-English mixed query support
 *   - Scalability: large candidate set handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { MemoryNodeRepository } from '../src/db/memory-node-repo.js';
import { CREATE_MEMORY_NODE_TABLES } from '../src/db/memory-node-schema.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import {
  HybridSearcher,
  normalizeFtsRanks,
  computeEventDecay,
  type HybridSearchConfig,
} from '../src/retrieval/hybrid-searcher.js';
import {
  validateHybridSearchRequest,
  type HybridSearchRequest,
} from '../src/api/schemas.js';
import { createRouter, type RouterDependencies } from '../src/api/router.js';
import { createDatabase } from '../src/db/connection.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { IngestService } from '../src/services/ingest.js';
import type { CreateMemoryNodeInput } from '../src/models/memory-node.js';

// ─── Test Helpers ─────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_MEMORY_NODE_TABLES);
  return db;
}

function makeNodeInput(overrides?: Partial<CreateMemoryNodeInput>): CreateMemoryNodeInput {
  return {
    nodeType: 'semantic',
    nodeRole: 'leaf',
    frontmatter: 'Test node',
    keywords: 'test keyword',
    summary: 'A test summary',
    metadata: { confidence: 0.9 },
    currentEventCounter: 1.0,
    ...overrides,
  };
}

/** Create a normalized embedding vector of specified dimension */
function makeEmbedding(dim: number, seed: number = 0): Float32Array {
  const vec = new Float32Array(dim);
  let hash = seed;
  for (let i = 0; i < dim; i++) {
    hash = (hash * 1664525 + 1013904223) | 0;
    vec[i] = (hash & 0x7fffffff) / 0x7fffffff;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

/** Create a similar embedding (high cosine similarity) */
function makeSimilarEmbedding(base: Float32Array, noise: number = 0.1): Float32Array {
  const vec = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    vec[i] = base[i] + (Math.random() - 0.5) * noise;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

async function request(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

// ═══════════════════════════════════════════════════════════════
// 1. VALIDATION TESTS
// ═══════════════════════════════════════════════════════════════

describe('validateHybridSearchRequest', () => {
  it('returns no errors for valid minimal input', () => {
    const errors = validateHybridSearchRequest({ query: 'TypeScript' });
    expect(errors).toHaveLength(0);
  });

  it('returns no errors for valid full input', () => {
    const errors = validateHybridSearchRequest({
      query: 'React 프레임워크',
      topK: 10,
      minScore: 0.2,
      ftsWeight: 0.3,
      nodeTypeFilter: 'semantic',
      nodeRoleFilter: 'leaf',
      applyDecay: true,
      includeStats: true,
      currentEventCounter: 42.5,
    });
    expect(errors).toHaveLength(0);
  });

  it('requires query field', () => {
    const errors = validateHybridSearchRequest({});
    expect(errors.some(e => e.field === 'query')).toBe(true);
  });

  it('rejects empty query', () => {
    const errors = validateHybridSearchRequest({ query: '   ' });
    expect(errors.some(e => e.field === 'query')).toBe(true);
  });

  it('rejects non-string query', () => {
    const errors = validateHybridSearchRequest({ query: 123 });
    expect(errors.some(e => e.field === 'query')).toBe(true);
  });

  it('rejects non-object body', () => {
    const errors = validateHybridSearchRequest('not an object');
    expect(errors.some(e => e.field === 'body')).toBe(true);
  });

  it('validates topK range', () => {
    expect(validateHybridSearchRequest({ query: 'test', topK: 0 })).toHaveLength(1);
    expect(validateHybridSearchRequest({ query: 'test', topK: 101 })).toHaveLength(1);
    expect(validateHybridSearchRequest({ query: 'test', topK: 50 })).toHaveLength(0);
  });

  it('validates minScore range', () => {
    expect(validateHybridSearchRequest({ query: 'test', minScore: -0.1 })).toHaveLength(1);
    expect(validateHybridSearchRequest({ query: 'test', minScore: 1.5 })).toHaveLength(1);
    expect(validateHybridSearchRequest({ query: 'test', minScore: 0.5 })).toHaveLength(0);
  });

  it('validates ftsWeight range', () => {
    expect(validateHybridSearchRequest({ query: 'test', ftsWeight: -0.1 })).toHaveLength(1);
    expect(validateHybridSearchRequest({ query: 'test', ftsWeight: 1.5 })).toHaveLength(1);
    expect(validateHybridSearchRequest({ query: 'test', ftsWeight: 0.5 })).toHaveLength(0);
  });

  it('validates nodeTypeFilter as string', () => {
    expect(validateHybridSearchRequest({ query: 'test', nodeTypeFilter: 'semantic' })).toHaveLength(0);
    expect(validateHybridSearchRequest({ query: 'test', nodeTypeFilter: 'invalid' })).toHaveLength(1);
  });

  it('validates nodeTypeFilter as array', () => {
    expect(validateHybridSearchRequest({ query: 'test', nodeTypeFilter: ['semantic', 'episodic'] })).toHaveLength(0);
    expect(validateHybridSearchRequest({ query: 'test', nodeTypeFilter: ['semantic', 'invalid'] })).toHaveLength(1);
  });

  it('validates nodeRoleFilter', () => {
    expect(validateHybridSearchRequest({ query: 'test', nodeRoleFilter: 'hub' })).toHaveLength(0);
    expect(validateHybridSearchRequest({ query: 'test', nodeRoleFilter: 'leaf' })).toHaveLength(0);
    expect(validateHybridSearchRequest({ query: 'test', nodeRoleFilter: 'invalid' })).toHaveLength(1);
  });

  it('validates currentEventCounter', () => {
    expect(validateHybridSearchRequest({ query: 'test', currentEventCounter: 10 })).toHaveLength(0);
    expect(validateHybridSearchRequest({ query: 'test', currentEventCounter: -1 })).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. PURE HELPER FUNCTION UNIT TESTS
// ═══════════════════════════════════════════════════════════════

describe('normalizeFtsRanks', () => {
  it('normalizes ranks to [0, 1] range', () => {
    const candidates = [
      { id: 'a', rank: -10 }, // best match (most negative)
      { id: 'b', rank: -5 },
      { id: 'c', rank: -1 },  // worst match
    ];

    const map = normalizeFtsRanks(candidates);
    expect(map.get('a')).toBe(1.0);  // best → 1.0
    expect(map.get('c')).toBe(0.0);  // worst → 0.0
    // rank -5: (maxRank - rank) / range = (-1 - (-5)) / (-1 - (-10)) = 4/9 ≈ 0.4444
    expect(map.get('b')).toBeCloseTo(0.4444, 3);
  });

  it('returns 1.0 for all identical ranks', () => {
    const candidates = [
      { id: 'a', rank: -5 },
      { id: 'b', rank: -5 },
    ];

    const map = normalizeFtsRanks(candidates);
    expect(map.get('a')).toBe(1.0);
    expect(map.get('b')).toBe(1.0);
  });

  it('returns empty map for empty input', () => {
    const map = normalizeFtsRanks([]);
    expect(map.size).toBe(0);
  });

  it('handles single candidate', () => {
    const map = normalizeFtsRanks([{ id: 'a', rank: -3 }]);
    expect(map.get('a')).toBe(1.0);
  });
});

describe('computeEventDecay', () => {
  it('returns 1.0 when no events have elapsed', () => {
    expect(computeEventDecay(10, 10, 50)).toBe(1.0);
  });

  it('returns 0.5 at half-life', () => {
    expect(computeEventDecay(0, 50, 50)).toBeCloseTo(0.5, 5);
  });

  it('returns 0.25 at 2x half-life', () => {
    expect(computeEventDecay(0, 100, 50)).toBeCloseTo(0.25, 5);
  });

  it('never goes below 0', () => {
    const factor = computeEventDecay(0, 1000, 50);
    expect(factor).toBeGreaterThan(0);
    expect(factor).toBeLessThan(0.01);
  });

  it('returns 1.0 when halfLife is 0', () => {
    expect(computeEventDecay(0, 100, 0)).toBe(1.0);
  });

  it('handles negative elapsed (clamped to 0)', () => {
    expect(computeEventDecay(100, 50, 50)).toBe(1.0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. HYBRID SEARCHER UNIT TESTS
// ═══════════════════════════════════════════════════════════════

describe('HybridSearcher', () => {
  let db: Database.Database;
  let repo: MemoryNodeRepository;
  let embedProvider: MockEmbeddingProvider;
  let searcher: HybridSearcher;

  beforeEach(() => {
    db = createTestDb();
    repo = new MemoryNodeRepository(db);
    embedProvider = new MockEmbeddingProvider(64);
    searcher = new HybridSearcher(db, embedProvider, {
      applyDecay: false, // disable decay for unit tests
      ftsMinCandidates: 1,
      minScore: 0.0,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty results for empty query', async () => {
    const result = await searcher.search('');
    expect(result.items).toHaveLength(0);
    expect(result.stats.outputCount).toBe(0);
  });

  it('returns empty results when no nodes exist', async () => {
    const result = await searcher.search('TypeScript');
    expect(result.items).toHaveLength(0);
    expect(result.stats.ftsCandidateCount).toBe(0);
  });

  it('finds nodes via FTS5 keyword matching', async () => {
    // Set a known embedding for the query
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('TypeScript', queryEmb);

    // Create a node with matching keywords and similar embedding
    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.05);
    repo.create(makeNodeInput({
      frontmatter: 'TypeScript 프로젝트 설정',
      keywords: 'TypeScript 타입스크립트 설정 config',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));

    const result = await searcher.search('TypeScript');
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items[0].frontmatter).toContain('TypeScript');
    expect(result.items[0].source).toBe('fts+vector');
  });

  it('uses brute-force fallback when FTS returns too few candidates', async () => {
    // Create node with embedding but keywords that don't match the query
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('similar concept', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.05);
    repo.create(makeNodeInput({
      frontmatter: 'Unrelated label',
      keywords: 'totally different keywords',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));

    // Search with ftsMinCandidates > 0 (default), will trigger fallback
    const fallbackSearcher = new HybridSearcher(db, embedProvider, {
      applyDecay: false,
      ftsMinCandidates: 5,
      minScore: 0.0,
    });

    const result = await fallbackSearcher.search('similar concept');
    expect(result.stats.usedBruteForceFallback).toBe(true);
    // Should still find the node via vector similarity
    if (result.items.length > 0) {
      expect(result.items[0].source).toBe('vector-only');
    }
  });

  it('applies event-based decay when enabled', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('decay test', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);

    // Create a recently activated node
    repo.create(makeNodeInput({
      frontmatter: 'decay test node',
      keywords: 'decay test',
      embedding: nodeEmb,
      embeddingDim: 64,
      currentEventCounter: 90.0,
    }));

    // Search with decay enabled, current counter at 100 (10 events since activation)
    const decaySearcher = new HybridSearcher(db, embedProvider, {
      applyDecay: true,
      decayHalfLife: 50,
      minScore: 0.0,
      ftsMinCandidates: 1,
    });

    const resultWithDecay = await decaySearcher.search('decay test', 100);
    const resultNoDecay = await decaySearcher.search('decay test', undefined, { applyDecay: false });

    if (resultWithDecay.items.length > 0 && resultNoDecay.items.length > 0) {
      // With decay, score should be lower
      expect(resultWithDecay.items[0].score).toBeLessThanOrEqual(resultNoDecay.items[0].score);
      expect(resultWithDecay.items[0].scoreBreakdown.decayFactor).toBeLessThan(1.0);
    }
  });

  it('filters by nodeType', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('filter test', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);

    repo.create(makeNodeInput({
      nodeType: 'semantic',
      frontmatter: 'filter test semantic',
      keywords: 'filter test',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));
    repo.create(makeNodeInput({
      nodeType: 'episodic',
      frontmatter: 'filter test episodic',
      keywords: 'filter test',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));

    const result = await searcher.search('filter test', undefined, {
      nodeTypeFilter: 'semantic',
    });

    // Should only return semantic nodes
    for (const item of result.items) {
      expect(item.nodeType).toBe('semantic');
    }
  });

  it('filters by nodeRole', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('role filter', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);

    repo.create(makeNodeInput({
      nodeRole: 'leaf',
      frontmatter: 'role filter leaf',
      keywords: 'role filter',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));
    repo.create(makeNodeInput({
      nodeRole: 'hub',
      frontmatter: 'role filter hub',
      keywords: 'role filter',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));

    const result = await searcher.search('role filter', undefined, {
      nodeRoleFilter: 'hub',
    });

    for (const item of result.items) {
      expect(item.nodeRole).toBe('hub');
    }
  });

  it('respects topK limit', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('topk test', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);

    // Create 10 nodes
    for (let i = 0; i < 10; i++) {
      repo.create(makeNodeInput({
        frontmatter: `topk test node ${i}`,
        keywords: 'topk test',
        embedding: nodeEmb,
        embeddingDim: 64,
      }));
    }

    const result = await searcher.search('topk test', undefined, { topK: 3 });
    expect(result.items.length).toBeLessThanOrEqual(3);
  });

  it('returns stats with timing information', async () => {
    const result = await searcher.search('any query');
    expect(result.stats).toBeDefined();
    expect(typeof result.stats.ftsTimeMs).toBe('number');
    expect(typeof result.stats.embeddingTimeMs).toBe('number');
    expect(typeof result.stats.rerankTimeMs).toBe('number');
    expect(typeof result.stats.totalTimeMs).toBe('number');
    expect(typeof result.stats.ftsCandidateCount).toBe('number');
    expect(typeof result.stats.vectorComparisonCount).toBe('number');
    expect(typeof result.stats.outputCount).toBe('number');
  });

  it('includes score breakdown for each item', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('breakdown', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);
    repo.create(makeNodeInput({
      frontmatter: 'breakdown test',
      keywords: 'breakdown',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));

    const result = await searcher.search('breakdown');
    if (result.items.length > 0) {
      const item = result.items[0];
      expect(item.scoreBreakdown).toBeDefined();
      expect(typeof item.scoreBreakdown.ftsScore).toBe('number');
      expect(typeof item.scoreBreakdown.vectorScore).toBe('number');
      expect(typeof item.scoreBreakdown.decayFactor).toBe('number');
      expect(typeof item.scoreBreakdown.combinedBeforeDecay).toBe('number');
    }
  });

  // ─── 한영 혼용 tests ────────────────────────────────────────

  it('searches Korean text (한국어 검색)', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 100));
    embedProvider.setEmbedding('프레임워크', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);
    repo.create(makeNodeInput({
      frontmatter: '사용자는 React 프레임워크를 선호함',
      keywords: 'React 프레임워크 선호 preference',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));

    const result = await searcher.search('프레임워크');
    expect(result.items.length).toBeGreaterThanOrEqual(1);
  });

  it('searches mixed Korean-English (한영 혼용)', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 200));
    embedProvider.setEmbedding('TypeScript 설정', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);
    repo.create(makeNodeInput({
      frontmatter: 'TypeScript 프로젝트 설정 가이드',
      keywords: 'TypeScript 타입스크립트 설정 config guide',
      summary: '타입스크립트 프로젝트 초기 설정 방법',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));

    const result = await searcher.search('TypeScript 설정');
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items[0].frontmatter).toContain('TypeScript');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. API ENDPOINT INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════

describe('POST /search/hybrid API endpoint', () => {
  let db: Database.Database;
  let app: Hono;
  let repo: MemoryNodeRepository;
  let embedProvider: MockEmbeddingProvider;
  let ingestService: IngestService;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    repo = new MemoryNodeRepository(db);
    embedProvider = new MockEmbeddingProvider(64);
    const convRepo = new ConversationRepository(db);
    ingestService = new IngestService(convRepo);

    const hybridSearcher = new HybridSearcher(db, embedProvider, {
      applyDecay: false,
      ftsMinCandidates: 1,
      minScore: 0.0,
    });

    app = createRouter({
      ingestService,
      hybridSearcher,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('returns 200 with empty results when no data', async () => {
    const res = await request(app, 'POST', '/search/hybrid', {
      query: 'TypeScript',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.items).toEqual([]);
    expect(body.totalItems).toBe(0);
    expect(body.query).toBe('TypeScript');
  });

  it('returns 400 for missing query', async () => {
    const res = await request(app, 'POST', '/search/hybrid', {});
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for empty query', async () => {
    const res = await request(app, 'POST', '/search/hybrid', { query: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid topK', async () => {
    const res = await request(app, 'POST', '/search/hybrid', {
      query: 'test',
      topK: 0,
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid nodeTypeFilter', async () => {
    const res = await request(app, 'POST', '/search/hybrid', {
      query: 'test',
      nodeTypeFilter: 'invalid_type',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid nodeRoleFilter', async () => {
    const res = await request(app, 'POST', '/search/hybrid', {
      query: 'test',
      nodeRoleFilter: 'invalid_role',
    });
    expect(res.status).toBe(400);
  });

  it('returns search results with correct structure', async () => {
    // Insert test data
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('React', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);
    repo.create(makeNodeInput({
      nodeType: 'semantic',
      frontmatter: 'React 프레임워크 사용',
      keywords: 'React 리액트 frontend',
      summary: 'React를 사용한 프론트엔드 개발',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));

    const res = await request(app, 'POST', '/search/hybrid', {
      query: 'React',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.totalItems).toBeGreaterThanOrEqual(1);
    expect(body.query).toBe('React');

    const items = body.items as any[];
    if (items.length > 0) {
      const item = items[0];
      expect(item.nodeId).toBeDefined();
      expect(item.nodeType).toBe('semantic');
      expect(item.nodeRole).toBe('leaf');
      expect(item.frontmatter).toContain('React');
      expect(typeof item.score).toBe('number');
      expect(item.scoreBreakdown).toBeDefined();
      expect(typeof item.scoreBreakdown.ftsScore).toBe('number');
      expect(typeof item.scoreBreakdown.vectorScore).toBe('number');
      expect(typeof item.scoreBreakdown.decayFactor).toBe('number');
      expect(item.source).toBeDefined();
    }
  });

  it('includes stats when includeStats=true', async () => {
    const res = await request(app, 'POST', '/search/hybrid', {
      query: 'test',
      includeStats: true,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.stats).toBeDefined();
    const stats = body.stats as Record<string, unknown>;
    expect(typeof stats.ftsTimeMs).toBe('number');
    expect(typeof stats.embeddingTimeMs).toBe('number');
    expect(typeof stats.totalTimeMs).toBe('number');
  });

  it('omits stats when includeStats is not set', async () => {
    const res = await request(app, 'POST', '/search/hybrid', {
      query: 'test',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.stats).toBeUndefined();
  });

  it('respects topK parameter', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('many nodes', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);
    for (let i = 0; i < 10; i++) {
      repo.create(makeNodeInput({
        frontmatter: `many nodes result ${i}`,
        keywords: 'many nodes',
        embedding: nodeEmb,
        embeddingDim: 64,
      }));
    }

    const res = await request(app, 'POST', '/search/hybrid', {
      query: 'many nodes',
      topK: 3,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body.items as any[]).length).toBeLessThanOrEqual(3);
  });

  it('supports nodeTypeFilter parameter', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('type filter api', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);
    repo.create(makeNodeInput({
      nodeType: 'semantic',
      frontmatter: 'type filter api semantic',
      keywords: 'type filter api',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));
    repo.create(makeNodeInput({
      nodeType: 'episodic',
      frontmatter: 'type filter api episodic',
      keywords: 'type filter api',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));

    const res = await request(app, 'POST', '/search/hybrid', {
      query: 'type filter api',
      nodeTypeFilter: 'semantic',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    for (const item of body.items as any[]) {
      expect(item.nodeType).toBe('semantic');
    }
  });

  it('returns 503 when hybridSearcher is not configured', async () => {
    const appNoSearcher = createRouter({ ingestService });

    const res = await request(appNoSearcher, 'POST', '/search/hybrid', {
      query: 'test',
    });

    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('SERVICE_UNAVAILABLE');
  });

  it('handles Korean-only query (한국어 전용)', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 300));
    embedProvider.setEmbedding('배포 전략', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);
    repo.create(makeNodeInput({
      frontmatter: '배포 전략 수립',
      keywords: '배포 deploy 전략 strategy',
      summary: '프로덕션 배포를 위한 전략을 수립했다',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));

    const res = await request(app, 'POST', '/search/hybrid', {
      query: '배포 전략',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body.items as any[]).length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. END-TO-END INTEGRATION TEST
// ═══════════════════════════════════════════════════════════════

describe('Hybrid Search E2E Integration', () => {
  let db: Database.Database;
  let repo: MemoryNodeRepository;
  let embedProvider: MockEmbeddingProvider;
  let searcher: HybridSearcher;

  beforeEach(() => {
    db = createTestDb();
    repo = new MemoryNodeRepository(db);
    embedProvider = new MockEmbeddingProvider(64);
    searcher = new HybridSearcher(db, embedProvider, {
      applyDecay: false,
      ftsMinCandidates: 1,
      minScore: 0.0,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('ranks results by combined FTS + vector score', async () => {
    // Create a specific query embedding
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('test query', queryEmb);

    // Node A: strong FTS match + strong vector match
    const embA = makeSimilarEmbedding(new Float32Array(queryEmb), 0.01);
    repo.create(makeNodeInput({
      frontmatter: 'test query exact match',
      keywords: 'test query exact match keyword',
      embedding: embA,
      embeddingDim: 64,
    }));

    // Node B: weaker FTS match but still matches
    const embB = makeSimilarEmbedding(new Float32Array(queryEmb), 0.5);
    repo.create(makeNodeInput({
      frontmatter: 'something else mentioning test',
      keywords: 'test other topic unrelated',
      embedding: embB,
      embeddingDim: 64,
    }));

    const result = await searcher.search('test query');

    // Results should be ordered by score descending
    if (result.items.length >= 2) {
      expect(result.items[0].score).toBeGreaterThanOrEqual(result.items[1].score);
    }
  });

  it('searchByEmbedding works with pre-computed embedding', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 42));

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);
    repo.create(makeNodeInput({
      frontmatter: 'pre-computed embedding test',
      keywords: 'precomputed embedding test',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));

    const result = await searcher.searchByEmbedding(
      queryEmb,
      'precomputed embedding test',
    );

    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.stats.embeddingTimeMs).toBe(0); // No embedding generation
  });

  it('handles multiple node types in a single search', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('mixed types', queryEmb);

    const nodeEmb = makeSimilarEmbedding(new Float32Array(queryEmb), 0.02);

    repo.create(makeNodeInput({
      nodeType: 'semantic',
      frontmatter: 'mixed types semantic fact',
      keywords: 'mixed types semantic',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));
    repo.create(makeNodeInput({
      nodeType: 'episodic',
      frontmatter: 'mixed types episodic event',
      keywords: 'mixed types episodic',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));
    repo.create(makeNodeInput({
      nodeType: 'procedural',
      frontmatter: 'mixed types procedural howto',
      keywords: 'mixed types procedural',
      embedding: nodeEmb,
      embeddingDim: 64,
    }));

    const result = await searcher.search('mixed types');
    expect(result.items.length).toBe(3);

    // All types should be present
    const types = new Set(result.items.map(i => i.nodeType));
    expect(types.has('semantic')).toBe(true);
    expect(types.has('episodic')).toBe(true);
    expect(types.has('procedural')).toBe(true);
  });

  it('nodes without embeddings get FTS-only scores', async () => {
    embedProvider.setEmbedding('no embedding', Array.from(makeEmbedding(64, 42)));

    // Node without embedding
    repo.create(makeNodeInput({
      frontmatter: 'no embedding node',
      keywords: 'no embedding test',
      // No embedding set
    }));

    const result = await searcher.search('no embedding');
    // Should still find via FTS, but vectorScore will be 0
    if (result.items.length > 0) {
      expect(result.items[0].scoreBreakdown.vectorScore).toBe(0);
      expect(result.items[0].scoreBreakdown.ftsScore).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. SCALABILITY TESTS
// ═══════════════════════════════════════════════════════════════

describe('Hybrid Search Scalability', () => {
  let db: Database.Database;
  let repo: MemoryNodeRepository;
  let embedProvider: MockEmbeddingProvider;
  let searcher: HybridSearcher;

  beforeEach(() => {
    db = createTestDb();
    repo = new MemoryNodeRepository(db);
    embedProvider = new MockEmbeddingProvider(64);
    searcher = new HybridSearcher(db, embedProvider, {
      applyDecay: false,
      ftsMinCandidates: 1,
      minScore: 0.0,
      ftsMaxCandidates: 50,
      topK: 10,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('handles 1000 nodes efficiently', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('scale test', queryEmb);

    // Insert 1000 nodes in batch
    const baseEmb = new Float32Array(queryEmb);
    const txn = db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        const emb = makeEmbedding(64, i);
        repo.create(makeNodeInput({
          frontmatter: `scale test node ${i}`,
          keywords: `scale test keyword${i}`,
          embedding: emb,
          embeddingDim: 64,
        }));
      }
    });
    txn();

    const start = performance.now();
    const result = await searcher.search('scale test');
    const elapsed = performance.now() - start;

    // Should complete in reasonable time (<2 seconds for 1000 nodes)
    expect(elapsed).toBeLessThan(2000);
    expect(result.items.length).toBeLessThanOrEqual(10); // topK limit
    expect(result.stats.ftsCandidateCount).toBeLessThanOrEqual(50); // ftsMaxCandidates limit
  });

  it('FTS5 pre-filtering reduces vector comparisons', async () => {
    const queryEmb = Array.from(makeEmbedding(64, 42));
    embedProvider.setEmbedding('narrow query', queryEmb);

    // Insert 100 nodes, only 5 match the query keyword
    const txn = db.transaction(() => {
      for (let i = 0; i < 100; i++) {
        const keywords = i < 5 ? 'narrow query matching' : `unrelated topic${i}`;
        repo.create(makeNodeInput({
          frontmatter: `node ${i}`,
          keywords,
          embedding: makeEmbedding(64, i),
          embeddingDim: 64,
        }));
      }
    });
    txn();

    const result = await searcher.search('narrow query');
    // FTS should narrow candidates significantly
    expect(result.stats.ftsCandidateCount).toBeLessThan(100);
    // Vector comparisons should match FTS candidates (not all 100)
    expect(result.stats.vectorComparisonCount).toBeLessThanOrEqual(result.stats.ftsCandidateCount);
  });
});
