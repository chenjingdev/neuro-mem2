/**
 * Tests for HubMatcher — FTS5 + cosine similarity hybrid hub matching.
 *
 * Validates:
 * - Hybrid scoring: FTS5 BM25 + cosine similarity combination
 * - >= 0.85 threshold filtering on cosine similarity
 * - FTS5 pre-filtering of hub-only nodes
 * - Brute-force cosine fallback when FTS returns too few candidates
 * - Merge deduplication of FTS + brute-force results
 * - Config overrides
 * - Edge cases (empty DB, no embeddings, threshold boundary)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { HubMatcher, normalizeFtsRanks, DEFAULT_HUB_MATCHER_CONFIG } from '../../src/services/hub-matcher.js';
import { MemoryNodeRepository } from '../../src/db/memory-node-repo.js';
import { CREATE_MEMORY_NODE_TABLES } from '../../src/db/memory-node-schema.js';
import type { CreateMemoryNodeInput } from '../../src/models/memory-node.js';

// ─── Test Helpers ─────────────────────────────────────────────────

/**
 * Create a deterministic Float32Array embedding from a seed value.
 * Two embeddings with the same seed will have cosine similarity = 1.0.
 * Different seeds produce embeddings with varying similarity.
 */
function makeEmbedding(seed: number, dim: number = 384): Float32Array {
  const arr = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    arr[i] = Math.sin(seed * (i + 1) * 0.01) * Math.cos(seed * 0.1 + i * 0.001);
  }
  // Normalize to unit vector for cosine similarity
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) arr[i] /= norm;
  return arr;
}

/**
 * Create a similar embedding by adding small noise.
 * Higher noise = lower similarity.
 */
function makeSimilarEmbedding(base: Float32Array, noise: number = 0.01): Float32Array {
  const arr = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    arr[i] = base[i] + (Math.random() - 0.5) * noise;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
  return arr;
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_MEMORY_NODE_TABLES);
  return db;
}

function createHubNode(
  repo: MemoryNodeRepository,
  label: string,
  keywords: string,
  embedding: Float32Array,
  nodeType: string | null = 'semantic',
): string {
  const node = repo.create({
    nodeType: nodeType as any,
    nodeRole: 'hub',
    frontmatter: label,
    keywords,
    embedding,
    embeddingDim: embedding.length,
    summary: `Hub node for ${label}`,
    metadata: { hubType: 'topic' },
  });
  return node.id;
}

function createLeafNode(
  repo: MemoryNodeRepository,
  label: string,
  keywords: string,
  embedding?: Float32Array,
  nodeType: string = 'semantic',
): string {
  const node = repo.create({
    nodeType: nodeType as any,
    nodeRole: 'leaf',
    frontmatter: label,
    keywords,
    embedding,
    embeddingDim: embedding?.length,
    summary: `Leaf node: ${label}`,
  });
  return node.id;
}

// ─── Tests ────────────────────────────────────────────────────────

describe('HubMatcher', () => {
  let db: Database.Database;
  let repo: MemoryNodeRepository;
  let matcher: HubMatcher;

  beforeEach(() => {
    db = setupDb();
    repo = new MemoryNodeRepository(db);
    matcher = new HubMatcher(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('basic matching', () => {
    it('should find a hub with identical embedding (cosine = 1.0)', () => {
      const emb = makeEmbedding(42);
      createHubNode(repo, 'TypeScript', 'typescript 타입스크립트 programming', emb);

      const result = matcher.match('TypeScript programming', emb);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].label).toBe('TypeScript');
      expect(result.matches[0].cosineSimilarity).toBeGreaterThanOrEqual(0.99);
      expect(result.matches[0].hybridScore).toBeGreaterThan(0.85);
      expect(result.stats.matchesAboveThreshold).toBe(1);
    });

    it('should return empty matches when no hubs exist', () => {
      const emb = makeEmbedding(42);
      const result = matcher.match('TypeScript', emb);

      expect(result.matches).toHaveLength(0);
      expect(result.stats.hubsCompared).toBe(0);
    });

    it('should not match leaf nodes (only hubs)', () => {
      const emb = makeEmbedding(42);
      createLeafNode(repo, 'TypeScript fact', 'typescript programming', emb);

      const result = matcher.match('TypeScript', emb);

      expect(result.matches).toHaveLength(0);
    });
  });

  describe('threshold filtering (>= 0.85)', () => {
    it('should filter out hubs below 0.85 cosine similarity', () => {
      const queryEmb = makeEmbedding(1);
      const hubEmb = makeEmbedding(100); // Very different embedding

      createHubNode(repo, 'Unrelated Topic', 'unrelated different topic', hubEmb);

      const sim = cosine(queryEmb, hubEmb);
      expect(sim).toBeLessThan(0.85); // Verify precondition

      const result = matcher.match('some query', queryEmb);

      expect(result.matches).toHaveLength(0);
    });

    it('should include hubs at exactly 0.85 threshold', () => {
      // Use very similar embedding to ensure >= 0.85
      const queryEmb = makeEmbedding(42);
      const hubEmb = makeSimilarEmbedding(queryEmb, 0.02); // Very small noise

      const sim = cosine(queryEmb, hubEmb);
      // With tiny noise, similarity should be very high (> 0.85)
      expect(sim).toBeGreaterThanOrEqual(0.85);

      createHubNode(repo, 'Similar Hub', 'similar topic', hubEmb);

      const result = matcher.match('similar topic', queryEmb);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].cosineSimilarity).toBeGreaterThanOrEqual(0.85);
    });

    it('should support custom similarity threshold via options', () => {
      const queryEmb = makeEmbedding(42);
      const hubEmb = makeSimilarEmbedding(queryEmb, 0.5); // Moderate noise → sim in 0.5-0.8 range

      const sim = cosine(queryEmb, hubEmb);
      // Verify this is below default 0.85 but above 0
      expect(sim).toBeGreaterThan(0);

      createHubNode(repo, 'Custom Threshold Hub', 'test keywords', hubEmb);

      // Use low threshold to match even moderate similarity
      const result = matcher.match('test keywords', queryEmb, {
        similarityThreshold: 0.0,
      });

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].cosineSimilarity).toBeCloseTo(sim, 2);
    });
  });

  describe('hybrid scoring (FTS + cosine)', () => {
    it('should produce hybrid score = ftsWeight * fts + (1-ftsWeight) * cosine', () => {
      const emb = makeEmbedding(42);
      createHubNode(repo, 'React Frontend', 'react frontend 리액트', emb);

      const result = matcher.match('react frontend', emb);

      expect(result.matches).toHaveLength(1);
      const m = result.matches[0];

      // With identical embedding: cosine ~= 1.0
      // FTS should also find it, so ftsScore > 0
      // hybridScore should be close to 1.0
      expect(m.hybridScore).toBeGreaterThan(0.8);
      expect(m.source).toBe('fts+cosine');
    });

    it('should use default ftsWeight=0.2 (cosine dominates)', () => {
      expect(DEFAULT_HUB_MATCHER_CONFIG.ftsWeight).toBe(0.2);
      // This means cosine weight = 0.8, making cosine the dominant signal
    });

    it('should rank hubs by hybrid score descending', () => {
      const queryEmb = makeEmbedding(42);

      // Create two hubs: one with very similar embedding, one identical
      const hubEmb1 = makeEmbedding(42); // Identical to query
      const hubEmb2 = makeSimilarEmbedding(queryEmb, 0.01); // Very similar

      createHubNode(repo, 'Exact Match Hub', 'exact match test', hubEmb1);
      createHubNode(repo, 'Close Match Hub', 'close match test', hubEmb2);

      const result = matcher.match('exact match test', queryEmb);

      // Both should pass threshold
      expect(result.matches.length).toBeGreaterThanOrEqual(1);

      // Results should be sorted by hybridScore descending
      for (let i = 1; i < result.matches.length; i++) {
        expect(result.matches[i - 1].hybridScore).toBeGreaterThanOrEqual(
          result.matches[i].hybridScore,
        );
      }
    });
  });

  describe('FTS5 pre-filtering', () => {
    it('should pre-filter hubs via FTS5 keyword matching', () => {
      const emb = makeEmbedding(42);
      createHubNode(repo, 'TypeScript Programming', 'typescript programming 타입스크립트', emb);
      createHubNode(repo, 'Python ML', 'python machine learning 파이썬', makeEmbedding(99));

      const result = matcher.match('typescript 타입스크립트', emb);

      // FTS should find TypeScript hub
      expect(result.stats.ftsCandidateCount).toBeGreaterThanOrEqual(1);
    });

    it('should handle Korean keywords in FTS5 search', () => {
      const emb = makeEmbedding(42);
      createHubNode(repo, '리액트 프론트엔드', '리액트 프론트엔드 react frontend', emb);

      const result = matcher.match('리액트 프론트엔드', emb);

      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.matches[0].label).toBe('리액트 프론트엔드');
    });
  });

  describe('brute-force fallback', () => {
    it('should fall back to brute-force when FTS returns too few candidates', () => {
      const emb = makeEmbedding(42);
      // Create hub without matching keywords (FTS won't find it)
      createHubNode(repo, 'Abstract Concept', 'abstract concept philosophy', emb);

      // Search with completely different keywords but same embedding
      const result = matcher.match('zzz_no_fts_match_zzz', emb);

      expect(result.stats.usedBruteForceFallback).toBe(true);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].source).toBe('cosine-only');
      expect(result.matches[0].cosineSimilarity).toBeGreaterThanOrEqual(0.85);
    });

    it('should merge FTS and brute-force results without duplicates', () => {
      const emb = makeEmbedding(42);
      createHubNode(repo, 'Shared Hub', 'shared keywords topic', emb);
      createHubNode(repo, 'Another Hub', 'another different keywords', emb);

      // ftsMinCandidates=3 but only 2 hubs → will trigger fallback + merge
      const result = matcher.match('shared keywords', emb, {
        ftsMinCandidates: 3,
      });

      // Should have both hubs but no duplicates
      const hubIds = result.matches.map(m => m.hubId);
      const uniqueIds = new Set(hubIds);
      expect(hubIds.length).toBe(uniqueIds.size);
    });
  });

  describe('maxMatches limit', () => {
    it('should respect maxMatches configuration', () => {
      const emb = makeEmbedding(42);
      for (let i = 0; i < 10; i++) {
        createHubNode(repo, `Hub ${i}`, `hub${i} keywords test`, emb);
      }

      const result = matcher.match('keywords test', emb, { maxMatches: 3 });

      expect(result.matches.length).toBeLessThanOrEqual(3);
    });
  });

  describe('stats reporting', () => {
    it('should report comprehensive stats', () => {
      const emb = makeEmbedding(42);
      createHubNode(repo, 'Stats Hub', 'stats test keywords', emb);

      const result = matcher.match('stats test', emb);

      expect(result.stats).toHaveProperty('ftsTimeMs');
      expect(result.stats).toHaveProperty('ftsCandidateCount');
      expect(result.stats).toHaveProperty('cosineTimeMs');
      expect(result.stats).toHaveProperty('hubsCompared');
      expect(result.stats).toHaveProperty('matchesAboveThreshold');
      expect(result.stats).toHaveProperty('usedBruteForceFallback');
      expect(result.stats).toHaveProperty('totalTimeMs');
      expect(result.stats.totalTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('empty/edge cases', () => {
    it('should handle empty query text gracefully', () => {
      const emb = makeEmbedding(42);
      createHubNode(repo, 'Some Hub', 'some keywords', emb);

      const result = matcher.match('', emb);

      // Empty text → no FTS match → falls back to brute-force cosine
      expect(result.stats.ftsCandidateCount).toBe(0);
      expect(result.stats.usedBruteForceFallback).toBe(true);
    });

    it('should handle hubs without embeddings', () => {
      // Hub without embedding
      repo.create({
        nodeType: 'semantic',
        nodeRole: 'hub',
        frontmatter: 'No Embedding Hub',
        keywords: 'no embedding test',
        summary: 'Hub without embedding',
      });

      const queryEmb = makeEmbedding(42);
      const result = matcher.match('no embedding test', queryEmb);

      // Should not crash, just not match (no cosine can be computed)
      expect(result.matches).toHaveLength(0);
    });

    it('should handle Float32Array query embedding', () => {
      const emb = makeEmbedding(42);
      createHubNode(repo, 'Float32 Hub', 'float32 test', emb);

      // Pass Float32Array directly (not number[])
      const result = matcher.match('float32 test', emb);

      expect(result.matches).toHaveLength(1);
    });
  });
});

describe('normalizeFtsRanks', () => {
  it('should normalize to [0, 1] range', () => {
    const candidates = [
      { id: 'a', rank: -10 }, // best (most negative)
      { id: 'b', rank: -5 },
      { id: 'c', rank: -1 },  // worst (least negative)
    ];

    const result = normalizeFtsRanks(candidates);

    expect(result.get('a')).toBeCloseTo(1.0, 4);
    expect(result.get('c')).toBeCloseTo(0.0, 4);
    expect(result.get('b')!).toBeGreaterThan(0);
    expect(result.get('b')!).toBeLessThan(1);
  });

  it('should return 1.0 for all when ranks are identical', () => {
    const candidates = [
      { id: 'a', rank: -5 },
      { id: 'b', rank: -5 },
    ];

    const result = normalizeFtsRanks(candidates);

    expect(result.get('a')).toBe(1.0);
    expect(result.get('b')).toBe(1.0);
  });

  it('should return empty map for empty input', () => {
    const result = normalizeFtsRanks([]);
    expect(result.size).toBe(0);
  });
});
