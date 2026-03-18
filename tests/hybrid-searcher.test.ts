/**
 * Tests for HybridSearcher — 2-stage FTS5 pre-filtering + vector reranking pipeline.
 *
 * Verifies:
 * - Stage 1: FTS5 keyword pre-filtering (한영 혼용)
 * - Stage 2: Vector cosine similarity reranking
 * - Combined FTS+vector scoring with configurable weights
 * - Event-based decay integration
 * - Brute-force fallback when FTS returns insufficient candidates
 * - Node type/role filtering
 * - Empty query handling
 * - Score normalization and ranking correctness
 * - normalizeFtsRanks and computeEventDecay pure functions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { MemoryNodeRepository } from '../src/db/memory-node-repo.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import {
  HybridSearcher,
  normalizeFtsRanks,
  computeEventDecay,
  type HybridSearchConfig,
} from '../src/retrieval/hybrid-searcher.js';
import type { CreateMemoryNodeInput } from '../src/models/memory-node.js';

// ─── Test Helpers ────────────────────────────────────────────────

function makeNode(
  overrides: Partial<CreateMemoryNodeInput> & { frontmatter: string },
): CreateMemoryNodeInput {
  return {
    nodeType: 'semantic',
    nodeRole: 'leaf',
    keywords: overrides.frontmatter.toLowerCase(),
    summary: overrides.summary ?? `Summary for ${overrides.frontmatter}`,
    currentEventCounter: 0,
    ...overrides,
  };
}

/**
 * Create a Float32Array embedding from a number array.
 */
function toFloat32(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

/**
 * Generate a simple normalized embedding vector for testing.
 * Uses a seed to generate reproducible embeddings.
 */
function makeEmbedding(seed: number, dim: number = 64): Float32Array {
  const vec = new Float32Array(dim);
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) | 0;
    vec[i] = (s & 0x7fffffff) / 0x7fffffff;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

// ─── Tests ───────────────────────────────────────────────────────

describe('HybridSearcher', () => {
  let db: Database.Database;
  let repo: MemoryNodeRepository;
  let embeddingProvider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    repo = new MemoryNodeRepository(db);
    embeddingProvider = new MockEmbeddingProvider(64);
  });

  afterEach(() => {
    db.close();
  });

  // ─── Empty Query ─────────────────────────────────────────────

  it('returns empty results for blank query', async () => {
    const searcher = new HybridSearcher(db, embeddingProvider);
    const result = await searcher.search('  ');
    expect(result.items).toHaveLength(0);
    expect(result.stats.totalTimeMs).toBe(0);
  });

  // ─── Stage 1: FTS5 Pre-filtering ────────────────────────────

  describe('Stage 1: FTS5 Pre-filtering', () => {
    it('finds nodes by keyword match in frontmatter', async () => {
      repo.create(makeNode({
        frontmatter: 'TypeScript migration strategy',
        keywords: 'typescript migration strategy programming',
        embedding: makeEmbedding(1),
        embeddingDim: 64,
      }));
      repo.create(makeNode({
        frontmatter: 'Python data analysis',
        keywords: 'python data analysis',
        embedding: makeEmbedding(2),
        embeddingDim: 64,
      }));

      // Set mock embedding to be close to seed 1 (TypeScript node)
      embeddingProvider.setEmbedding('TypeScript migration', Array.from(makeEmbedding(1)));

      const searcher = new HybridSearcher(db, embeddingProvider, { minScore: 0 });
      const result = await searcher.search('TypeScript migration');

      expect(result.stats.ftsCandidateCount).toBeGreaterThanOrEqual(1);
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      // TypeScript node should rank first (FTS match + vector match)
      expect(result.items[0].frontmatter).toContain('TypeScript');
    });

    it('supports Korean keyword matching', async () => {
      repo.create(makeNode({
        frontmatter: '프로젝트 마이그레이션 전략',
        keywords: '프로젝트 마이그레이션 전략 한국어',
        embedding: makeEmbedding(10),
        embeddingDim: 64,
      }));
      repo.create(makeNode({
        frontmatter: 'Unrelated English content',
        keywords: 'unrelated english content',
        embedding: makeEmbedding(20),
        embeddingDim: 64,
      }));

      embeddingProvider.setEmbedding('마이그레이션', Array.from(makeEmbedding(10)));

      const searcher = new HybridSearcher(db, embeddingProvider, { minScore: 0 });
      const result = await searcher.search('마이그레이션');

      expect(result.stats.ftsCandidateCount).toBeGreaterThanOrEqual(1);
      // Korean content should be found and ranked higher
      const koreanItem = result.items.find(i => i.frontmatter.includes('마이그레이션'));
      expect(koreanItem).toBeDefined();
    });

    it('returns FTS candidate count in stats', async () => {
      // Create multiple nodes
      for (let i = 0; i < 10; i++) {
        repo.create(makeNode({
          frontmatter: `React component pattern ${i}`,
          keywords: `react component pattern ${i}`,
          embedding: makeEmbedding(100 + i),
          embeddingDim: 64,
        }));
      }

      embeddingProvider.setEmbedding('React component', Array.from(makeEmbedding(100)));

      const searcher = new HybridSearcher(db, embeddingProvider, { minScore: 0 });
      const result = await searcher.search('React component');

      expect(result.stats.ftsCandidateCount).toBe(10);
      expect(result.stats.usedBruteForceFallback).toBe(false);
    });
  });

  // ─── Stage 2: Vector Reranking ──────────────────────────────

  describe('Stage 2: Vector Reranking', () => {
    it('reranks FTS results by vector similarity', async () => {
      // Create two nodes that both match FTS for "database"
      // but have different vector similarity to the query
      const closeEmbedding = makeEmbedding(42);
      const farEmbedding = makeEmbedding(999);

      repo.create(makeNode({
        frontmatter: 'database indexing strategies',
        keywords: 'database indexing strategies sql',
        embedding: closeEmbedding, // Close to query
        embeddingDim: 64,
      }));
      repo.create(makeNode({
        frontmatter: 'database backup procedures',
        keywords: 'database backup procedures recovery',
        embedding: farEmbedding, // Far from query
        embeddingDim: 64,
      }));

      // Query embedding close to seed 42 (indexing node)
      embeddingProvider.setEmbedding('database optimization', Array.from(closeEmbedding));

      const searcher = new HybridSearcher(db, embeddingProvider, {
        minScore: 0,
        ftsWeight: 0.3, // Vector dominates
      });
      const result = await searcher.search('database optimization');

      // Both should be found (FTS matches "database")
      expect(result.items.length).toBeGreaterThanOrEqual(1);

      // Items should have score breakdowns
      for (const item of result.items) {
        expect(item.scoreBreakdown).toBeDefined();
        expect(item.scoreBreakdown.vectorScore).toBeGreaterThanOrEqual(0);
        expect(item.scoreBreakdown.vectorScore).toBeLessThanOrEqual(1);
      }
    });

    it('includes ftsScore and vectorScore in breakdown', async () => {
      repo.create(makeNode({
        frontmatter: 'machine learning basics',
        keywords: 'machine learning basics ai',
        embedding: makeEmbedding(50),
        embeddingDim: 64,
      }));

      embeddingProvider.setEmbedding('machine learning', Array.from(makeEmbedding(50)));

      const searcher = new HybridSearcher(db, embeddingProvider, { minScore: 0 });
      const result = await searcher.search('machine learning');

      expect(result.items.length).toBe(1);
      const item = result.items[0];
      expect(item.source).toBe('fts+vector');
      expect(item.scoreBreakdown.ftsScore).toBe(1); // Only 1 candidate → normalized to 1.0
      expect(item.scoreBreakdown.vectorScore).toBeGreaterThan(0);
    });
  });

  // ─── Combined Scoring ───────────────────────────────────────

  describe('Combined Scoring', () => {
    it('respects ftsWeight configuration', async () => {
      const embedding = makeEmbedding(77);
      repo.create(makeNode({
        frontmatter: 'test node for scoring',
        keywords: 'test node scoring weight',
        embedding,
        embeddingDim: 64,
      }));

      embeddingProvider.setEmbedding('test node', Array.from(embedding));

      // High FTS weight
      const searcherHighFts = new HybridSearcher(db, embeddingProvider, {
        minScore: 0,
        ftsWeight: 0.9,
      });
      const resultHighFts = await searcherHighFts.search('test node');

      // Low FTS weight
      const searcherLowFts = new HybridSearcher(db, embeddingProvider, {
        minScore: 0,
        ftsWeight: 0.1,
      });
      const resultLowFts = await searcherLowFts.search('test node');

      // Both should find the same node
      expect(resultHighFts.items.length).toBe(1);
      expect(resultLowFts.items.length).toBe(1);

      // With ftsWeight=0.9, ftsScore contribution is higher
      // With ftsWeight=0.1, vectorScore contribution is higher
      // Both breakdowns should reflect the weight
      expect(resultHighFts.items[0].scoreBreakdown.ftsScore).toBe(
        resultLowFts.items[0].scoreBreakdown.ftsScore,
      );
    });

    it('filters results below minScore threshold', async () => {
      repo.create(makeNode({
        frontmatter: 'very weak match',
        keywords: 'obscure rare terms',
        embedding: makeEmbedding(1),
        embeddingDim: 64,
      }));

      // Query embedding far from node
      embeddingProvider.setEmbedding('completely different topic', Array.from(makeEmbedding(9999)));

      const searcher = new HybridSearcher(db, embeddingProvider, {
        minScore: 0.9, // Very high threshold
        ftsMinCandidates: 0, // Don't trigger fallback
      });
      const result = await searcher.search('completely different topic');

      // Should be filtered out due to high minScore
      expect(result.items.length).toBe(0);
    });
  });

  // ─── Event-Based Decay ──────────────────────────────────────

  describe('Event-Based Decay', () => {
    it('applies decay penalty based on events since activation', async () => {
      const embedding = makeEmbedding(55);

      // Create a node with old activation (event 0)
      repo.create(makeNode({
        frontmatter: 'old activated node',
        keywords: 'decay test node old',
        embedding,
        embeddingDim: 64,
        currentEventCounter: 0, // Created at event 0
      }));

      embeddingProvider.setEmbedding('decay test', Array.from(embedding));

      const searcher = new HybridSearcher(db, embeddingProvider, {
        minScore: 0,
        applyDecay: true,
        decayHalfLife: 50,
      });

      // Search at event 0 (no decay)
      const resultNoDecay = await searcher.search('decay test', 0);
      // Search at event 100 (significant decay, 2 half-lives)
      const resultWithDecay = await searcher.search('decay test', 100);

      expect(resultNoDecay.items.length).toBe(1);
      expect(resultWithDecay.items.length).toBe(1);

      // Score at event 100 should be significantly lower
      expect(resultWithDecay.items[0].score).toBeLessThan(resultNoDecay.items[0].score);
      expect(resultWithDecay.items[0].scoreBreakdown.decayFactor).toBeLessThan(1.0);
      expect(resultNoDecay.items[0].scoreBreakdown.decayFactor).toBe(1.0);
    });

    it('does not apply decay when applyDecay is false', async () => {
      const embedding = makeEmbedding(66);
      repo.create(makeNode({
        frontmatter: 'no decay node',
        keywords: 'no decay test',
        embedding,
        embeddingDim: 64,
        currentEventCounter: 0,
      }));

      embeddingProvider.setEmbedding('no decay', Array.from(embedding));

      const searcher = new HybridSearcher(db, embeddingProvider, {
        minScore: 0,
        applyDecay: false,
      });

      const result = await searcher.search('no decay', 1000);
      expect(result.items.length).toBe(1);
      expect(result.items[0].scoreBreakdown.decayFactor).toBe(1.0);
    });
  });

  // ─── Brute-Force Fallback ───────────────────────────────────

  describe('Brute-Force Vector Fallback', () => {
    it('triggers fallback when FTS returns fewer than ftsMinCandidates', async () => {
      // Create nodes with embeddings but no FTS-matchable keywords for the query
      const embedding = makeEmbedding(88);
      repo.create(makeNode({
        frontmatter: 'semantically similar content',
        keywords: 'similar content semantics',
        embedding,
        embeddingDim: 64,
      }));

      // Query uses very different keywords but similar embedding
      embeddingProvider.setEmbedding('xyz unique query terms', Array.from(embedding));

      const searcher = new HybridSearcher(db, embeddingProvider, {
        minScore: 0,
        ftsMinCandidates: 5, // FTS will return 0, so fallback triggers
      });

      const result = await searcher.search('xyz unique query terms');

      expect(result.stats.usedBruteForceFallback).toBe(true);
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      // Fallback items should have source = 'vector-only'
      expect(result.items[0].source).toBe('vector-only');
    });

    it('does not trigger fallback when FTS has enough candidates', async () => {
      for (let i = 0; i < 10; i++) {
        repo.create(makeNode({
          frontmatter: `matching keyword content ${i}`,
          keywords: `matching keyword content ${i}`,
          embedding: makeEmbedding(200 + i),
          embeddingDim: 64,
        }));
      }

      embeddingProvider.setEmbedding('matching keyword', Array.from(makeEmbedding(200)));

      const searcher = new HybridSearcher(db, embeddingProvider, {
        minScore: 0,
        ftsMinCandidates: 5,
      });

      const result = await searcher.search('matching keyword');

      expect(result.stats.usedBruteForceFallback).toBe(false);
      expect(result.stats.ftsCandidateCount).toBeGreaterThanOrEqual(5);
    });
  });

  // ─── Node Type/Role Filtering ───────────────────────────────

  describe('Filtering', () => {
    beforeEach(() => {
      repo.create(makeNode({
        nodeType: 'semantic',
        nodeRole: 'leaf',
        frontmatter: 'semantic leaf node',
        keywords: 'filter test semantic leaf',
        embedding: makeEmbedding(300),
        embeddingDim: 64,
      }));
      repo.create(makeNode({
        nodeType: 'episodic',
        nodeRole: 'leaf',
        frontmatter: 'episodic leaf node',
        keywords: 'filter test episodic leaf',
        embedding: makeEmbedding(301),
        embeddingDim: 64,
      }));
      repo.create(makeNode({
        nodeType: 'semantic',
        nodeRole: 'hub',
        frontmatter: 'semantic hub node',
        keywords: 'filter test semantic hub',
        embedding: makeEmbedding(302),
        embeddingDim: 64,
      }));
    });

    it('filters by single nodeType', async () => {
      embeddingProvider.setEmbedding('filter test', Array.from(makeEmbedding(300)));

      const searcher = new HybridSearcher(db, embeddingProvider, {
        minScore: 0,
        nodeTypeFilter: 'episodic',
      });
      const result = await searcher.search('filter test');

      expect(result.items.every(i => i.nodeType === 'episodic')).toBe(true);
    });

    it('filters by nodeType array', async () => {
      embeddingProvider.setEmbedding('filter test', Array.from(makeEmbedding(300)));

      const searcher = new HybridSearcher(db, embeddingProvider, {
        minScore: 0,
        nodeTypeFilter: ['semantic', 'episodic'],
      });
      const result = await searcher.search('filter test');

      expect(result.items.length).toBeGreaterThanOrEqual(2);
    });

    it('filters by nodeRole', async () => {
      embeddingProvider.setEmbedding('filter test', Array.from(makeEmbedding(302)));

      const searcher = new HybridSearcher(db, embeddingProvider, {
        minScore: 0,
        nodeRoleFilter: 'hub',
      });
      const result = await searcher.search('filter test');

      expect(result.items.every(i => i.nodeRole === 'hub')).toBe(true);
    });
  });

  // ─── topK Limiting ──────────────────────────────────────────

  describe('topK Limiting', () => {
    it('limits output to topK results', async () => {
      for (let i = 0; i < 30; i++) {
        repo.create(makeNode({
          frontmatter: `topk test node ${i}`,
          keywords: `topk test node ${i}`,
          embedding: makeEmbedding(400 + i),
          embeddingDim: 64,
        }));
      }

      embeddingProvider.setEmbedding('topk test', Array.from(makeEmbedding(400)));

      const searcher = new HybridSearcher(db, embeddingProvider, {
        minScore: 0,
        topK: 5,
      });
      const result = await searcher.search('topk test');

      expect(result.items.length).toBeLessThanOrEqual(5);
      expect(result.stats.outputCount).toBeLessThanOrEqual(5);
    });
  });

  // ─── searchByEmbedding ─────────────────────────────────────

  describe('searchByEmbedding', () => {
    it('skips embedding generation with pre-computed embedding', async () => {
      const embedding = makeEmbedding(500);
      repo.create(makeNode({
        frontmatter: 'pre-embedded search test',
        keywords: 'pre embedded search test',
        embedding,
        embeddingDim: 64,
      }));

      const searcher = new HybridSearcher(db, embeddingProvider, { minScore: 0 });
      const result = await searcher.searchByEmbedding(
        Array.from(embedding),
        'pre embedded search',
      );

      expect(result.items.length).toBe(1);
      expect(result.stats.embeddingTimeMs).toBe(0); // No embedding generation
      // MockEmbeddingProvider should NOT have been called
      expect(embeddingProvider.calls.length).toBe(0);
    });
  });

  // ─── Stats Correctness ─────────────────────────────────────

  describe('Stats', () => {
    it('reports correct timing stats', async () => {
      repo.create(makeNode({
        frontmatter: 'stats test node',
        keywords: 'stats test timing',
        embedding: makeEmbedding(600),
        embeddingDim: 64,
      }));

      embeddingProvider.setEmbedding('stats test', Array.from(makeEmbedding(600)));

      const searcher = new HybridSearcher(db, embeddingProvider, { minScore: 0 });
      const result = await searcher.search('stats test');

      expect(result.stats.ftsTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.stats.embeddingTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.stats.rerankTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.stats.totalTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.stats.vectorComparisonCount).toBeGreaterThanOrEqual(0);
      expect(result.stats.outputCount).toBe(result.items.length);
    });

    it('reports currentEventCounter in stats', async () => {
      repo.create(makeNode({
        frontmatter: 'counter stats test',
        keywords: 'counter stats test',
        embedding: makeEmbedding(700),
        embeddingDim: 64,
      }));

      embeddingProvider.setEmbedding('counter stats', Array.from(makeEmbedding(700)));

      const searcher = new HybridSearcher(db, embeddingProvider, { minScore: 0 });
      const result = await searcher.search('counter stats', 42);

      expect(result.stats.currentEventCounter).toBe(42);
    });
  });

  // ─── Nodes Without Embeddings ───────────────────────────────

  describe('Nodes without embeddings', () => {
    it('still finds FTS matches without embeddings (vectorScore=0)', async () => {
      // Create node without embedding
      repo.create(makeNode({
        frontmatter: 'no embedding node',
        keywords: 'no embedding node test',
        summary: 'This node has no embedding vector',
      }));

      embeddingProvider.setEmbedding('no embedding', Array.from(makeEmbedding(800)));

      const searcher = new HybridSearcher(db, embeddingProvider, {
        minScore: 0,
        ftsMinCandidates: 0, // Don't trigger fallback
      });
      const result = await searcher.search('no embedding');

      expect(result.items.length).toBe(1);
      expect(result.items[0].scoreBreakdown.vectorScore).toBe(0);
      expect(result.items[0].scoreBreakdown.ftsScore).toBeGreaterThan(0);
    });
  });
});

// ─── Pure Function Tests ────────────────────────────────────────

describe('normalizeFtsRanks', () => {
  it('returns empty map for empty input', () => {
    expect(normalizeFtsRanks([]).size).toBe(0);
  });

  it('normalizes single item to 1.0', () => {
    const result = normalizeFtsRanks([{ id: 'a', rank: -5.0 }]);
    expect(result.get('a')).toBe(1.0);
  });

  it('normalizes best rank to 1.0 and worst to 0.0', () => {
    const result = normalizeFtsRanks([
      { id: 'best', rank: -10.0 },  // Most negative = best
      { id: 'worst', rank: -1.0 },  // Least negative = worst
      { id: 'mid', rank: -5.5 },
    ]);

    expect(result.get('best')).toBe(1.0);
    expect(result.get('worst')).toBe(0.0);
    expect(result.get('mid')).toBeGreaterThan(0);
    expect(result.get('mid')).toBeLessThan(1);
  });

  it('handles identical ranks (all get 1.0)', () => {
    const result = normalizeFtsRanks([
      { id: 'a', rank: -3.0 },
      { id: 'b', rank: -3.0 },
    ]);
    expect(result.get('a')).toBe(1.0);
    expect(result.get('b')).toBe(1.0);
  });
});

describe('computeEventDecay', () => {
  it('returns 1.0 when no events have elapsed', () => {
    expect(computeEventDecay(10, 10, 50)).toBe(1.0);
  });

  it('returns 0.5 at exactly one half-life', () => {
    expect(computeEventDecay(0, 50, 50)).toBeCloseTo(0.5, 5);
  });

  it('returns 0.25 at two half-lives', () => {
    expect(computeEventDecay(0, 100, 50)).toBeCloseTo(0.25, 5);
  });

  it('returns 1.0 when halfLife is 0 (no decay)', () => {
    expect(computeEventDecay(0, 100, 0)).toBe(1.0);
  });

  it('handles negative elapsed (future activation) as 1.0', () => {
    expect(computeEventDecay(100, 50, 50)).toBe(1.0);
  });

  it('approaches 0 for very large elapsed events', () => {
    const factor = computeEventDecay(0, 10000, 50);
    expect(factor).toBeGreaterThan(0);
    expect(factor).toBeLessThan(0.001);
  });

  it('decays slower with larger half-life', () => {
    const fast = computeEventDecay(0, 100, 50);   // halfLife=50
    const slow = computeEventDecay(0, 100, 200);  // halfLife=200
    expect(slow).toBeGreaterThan(fast);
  });
});
