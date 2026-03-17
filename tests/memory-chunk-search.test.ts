/**
 * Tests for MemoryChunkSearcher — direct vector similarity search on memory chunks.
 *
 * Tests cover:
 *   1. MemoryEmbeddingRepository CRUD (upsert, get, delete, count, staleness)
 *   2. MemoryChunkSearcher basic search (query → top-k similar chunks)
 *   3. Node type filtering (facts only, episodes only, etc.)
 *   4. Similarity threshold filtering
 *   5. TopK limiting
 *   6. Superseded fact filtering
 *   7. searchByEmbedding (pre-computed vector)
 *   8. Edge cases (no embeddings, empty DB, deleted nodes)
 *   9. ScoredMemoryItem shape compatibility with ResultMerger
 *  10. Performance stats reporting
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from '../src/db/connection.js';
import { MemoryEmbeddingRepository } from '../src/db/memory-embedding-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { EpisodeRepository } from '../src/db/episode-repo.js';
import { ConceptRepository } from '../src/db/concept-repo.js';
import {
  MemoryChunkSearcher,
  DEFAULT_CHUNK_SEARCH_CONFIG,
} from '../src/retrieval/memory-chunk-searcher.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import type { Episode } from '../src/models/episode.js';
import type Database from 'better-sqlite3';

// ─── Test Helpers ────────────────────────────────────────────────

/** Create a unit vector in a given direction */
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
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return v.map(x => x / norm);
}

/** Simple content hash for testing */
function simpleHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16);
}

// ─── Test Setup ──────────────────────────────────────────────────

describe('MemoryEmbeddingRepository', () => {
  let db: Database.Database;
  let embRepo: MemoryEmbeddingRepository;

  const DIM = 8;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    embRepo = new MemoryEmbeddingRepository(db);
  });

  describe('upsert', () => {
    it('creates a new embedding', () => {
      const vec = new Float32Array(unitVector(DIM, 0));
      const result = embRepo.upsert({
        nodeId: 'fact-1',
        nodeType: 'fact',
        embedding: vec,
        contentHash: 'abc123',
        model: 'test-model',
      });

      expect(result.id).toBeDefined();
      expect(result.nodeId).toBe('fact-1');
      expect(result.nodeType).toBe('fact');
      expect(result.embeddingDim).toBe(DIM);
      expect(result.contentHash).toBe('abc123');
      expect(result.model).toBe('test-model');
      expect(result.createdAt).toBeDefined();
    });

    it('updates an existing embedding', () => {
      const vec1 = new Float32Array(unitVector(DIM, 0));
      const vec2 = new Float32Array(unitVector(DIM, 1));

      const r1 = embRepo.upsert({
        nodeId: 'fact-1',
        nodeType: 'fact',
        embedding: vec1,
        contentHash: 'hash1',
      });

      const r2 = embRepo.upsert({
        nodeId: 'fact-1',
        nodeType: 'fact',
        embedding: vec2,
        contentHash: 'hash2',
      });

      // Same ID, updated content
      expect(r2.id).toBe(r1.id);
      expect(r2.contentHash).toBe('hash2');
      expect(r2.createdAt).toBe(r1.createdAt); // Preserved
    });

    it('defaults model to unknown', () => {
      const vec = new Float32Array(unitVector(DIM, 0));
      const result = embRepo.upsert({
        nodeId: 'fact-1',
        nodeType: 'fact',
        embedding: vec,
        contentHash: 'abc',
      });
      expect(result.model).toBe('unknown');
    });
  });

  describe('getByNode', () => {
    it('returns null for non-existent node', () => {
      expect(embRepo.getByNode('nonexist', 'fact')).toBeNull();
    });

    it('returns the stored embedding', () => {
      const vec = new Float32Array(unitVector(DIM, 0));
      embRepo.upsert({
        nodeId: 'fact-1',
        nodeType: 'fact',
        embedding: vec,
        contentHash: 'hash',
      });

      const result = embRepo.getByNode('fact-1', 'fact');
      expect(result).not.toBeNull();
      expect(result!.embedding.length).toBe(DIM);
      expect(result!.embedding[0]).toBeCloseTo(1.0);
    });
  });

  describe('delete', () => {
    it('returns false for non-existent', () => {
      expect(embRepo.delete('nonexist', 'fact')).toBe(false);
    });

    it('deletes existing embedding', () => {
      const vec = new Float32Array(unitVector(DIM, 0));
      embRepo.upsert({
        nodeId: 'fact-1',
        nodeType: 'fact',
        embedding: vec,
        contentHash: 'hash',
      });

      expect(embRepo.delete('fact-1', 'fact')).toBe(true);
      expect(embRepo.getByNode('fact-1', 'fact')).toBeNull();
    });
  });

  describe('count', () => {
    it('returns 0 for empty table', () => {
      expect(embRepo.count()).toBe(0);
    });

    it('counts all embeddings', () => {
      const vec = new Float32Array(unitVector(DIM, 0));
      embRepo.upsert({ nodeId: 'f1', nodeType: 'fact', embedding: vec, contentHash: 'h1' });
      embRepo.upsert({ nodeId: 'e1', nodeType: 'episode', embedding: vec, contentHash: 'h2' });
      expect(embRepo.count()).toBe(2);
    });

    it('counts by type', () => {
      const vec = new Float32Array(unitVector(DIM, 0));
      embRepo.upsert({ nodeId: 'f1', nodeType: 'fact', embedding: vec, contentHash: 'h1' });
      embRepo.upsert({ nodeId: 'f2', nodeType: 'fact', embedding: vec, contentHash: 'h2' });
      embRepo.upsert({ nodeId: 'e1', nodeType: 'episode', embedding: vec, contentHash: 'h3' });
      expect(embRepo.count('fact')).toBe(2);
      expect(embRepo.count('episode')).toBe(1);
    });
  });

  describe('isStale', () => {
    it('returns true for non-existent embedding', () => {
      expect(embRepo.isStale('nonexist', 'fact', 'hash')).toBe(true);
    });

    it('returns false when hash matches', () => {
      const vec = new Float32Array(unitVector(DIM, 0));
      embRepo.upsert({ nodeId: 'f1', nodeType: 'fact', embedding: vec, contentHash: 'current' });
      expect(embRepo.isStale('f1', 'fact', 'current')).toBe(false);
    });

    it('returns true when hash differs', () => {
      const vec = new Float32Array(unitVector(DIM, 0));
      embRepo.upsert({ nodeId: 'f1', nodeType: 'fact', embedding: vec, contentHash: 'old' });
      expect(embRepo.isStale('f1', 'fact', 'new')).toBe(true);
    });
  });
});

describe('MemoryChunkSearcher', () => {
  let db: Database.Database;
  let embRepo: MemoryEmbeddingRepository;
  let factRepo: FactRepository;
  let convRepo: ConversationRepository;
  let episodeRepo: EpisodeRepository;
  let conceptRepo: ConceptRepository;
  let embeddingProvider: MockEmbeddingProvider;
  let conversationId: string;

  const DIM = 8;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    embRepo = new MemoryEmbeddingRepository(db);
    factRepo = new FactRepository(db);
    convRepo = new ConversationRepository(db);
    episodeRepo = new EpisodeRepository(db);
    conceptRepo = new ConceptRepository(db);
    embeddingProvider = new MockEmbeddingProvider(DIM);

    // Create a conversation for facts
    const conv = convRepo.ingest({
      source: 'test',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    });
    conversationId = conv.id;
  });

  // ── Helpers ──

  function createFactWithEmbedding(content: string, embedding: number[]) {
    const fact = factRepo.create({
      content,
      conversationId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: [],
    });

    embRepo.upsert({
      nodeId: fact.id,
      nodeType: 'fact',
      embedding: new Float32Array(embedding),
      contentHash: simpleHash(content),
      model: 'test',
    });

    return fact;
  }

  function createEpisodeWithEmbedding(title: string, desc: string, embedding: number[]) {
    const episode: Episode = {
      id: uuidv4(),
      conversationId,
      type: 'action',
      title,
      description: desc,
      startTurnIndex: 0,
      endTurnIndex: 1,
      sourceMessageIds: ['msg-1'],
      actors: ['user'],
      createdAt: new Date().toISOString(),
    };
    episodeRepo.saveEpisodes([episode]);

    embRepo.upsert({
      nodeId: episode.id,
      nodeType: 'episode',
      embedding: new Float32Array(embedding),
      contentHash: simpleHash(title + desc),
      model: 'test',
    });

    return episode;
  }

  function createConceptWithEmbedding(name: string, desc: string, embedding: number[]) {
    const concept = conceptRepo.createConcept({
      name,
      description: desc,
      aliases: [],
      category: 'technology',
      relevance: 0.8,
      sourceConversationId: conversationId,
    });

    embRepo.upsert({
      nodeId: concept.id,
      nodeType: 'concept',
      embedding: new Float32Array(embedding),
      contentHash: simpleHash(name + desc),
      model: 'test',
    });

    return concept;
  }

  describe('search with no embeddings', () => {
    it('returns empty results when no embeddings exist', async () => {
      const searcher = new MemoryChunkSearcher(db, embeddingProvider);
      const result = await searcher.search('anything');
      expect(result.items).toHaveLength(0);
      expect(result.stats.chunksMatched).toBe(0);
    });
  });

  describe('basic search', () => {
    it('finds the most similar fact', async () => {
      const tsVec = unitVector(DIM, 0);
      const pyVec = unitVector(DIM, 1);

      createFactWithEmbedding('TypeScript uses structural typing', tsVec);
      createFactWithEmbedding('Python uses duck typing', pyVec);

      // Query embedding similar to TypeScript
      embeddingProvider.setEmbedding('TypeScript migration', tsVec);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.1,
      });

      const result = await searcher.search('TypeScript migration');

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].content).toContain('structural typing');
      expect(result.items[0].score).toBeCloseTo(1.0, 2);
      expect(result.items[0].source).toBe('vector');
      expect(result.items[0].nodeType).toBe('fact');
    });

    it('searches across all node types', async () => {
      const v0 = unitVector(DIM, 0);
      const v1 = unitVector(DIM, 1);
      const v2 = unitVector(DIM, 2);

      createFactWithEmbedding('A fact about TypeScript', v0);
      createEpisodeWithEmbedding('Migration', 'Migrated to TypeScript', v1);
      createConceptWithEmbedding('TypeScript', 'A typed superset of JS', v2);

      // Query is close to v0 (fact)
      embeddingProvider.setEmbedding('query', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      // Should find all three (all have embeddings)
      expect(result.items.length).toBe(3);
      // Most similar should be the fact
      expect(result.items[0].nodeType).toBe('fact');
      expect(result.items[0].score).toBeCloseTo(1.0, 2);
    });

    it('returns items sorted by score descending', async () => {
      const queryVec = unitVector(DIM, 0);
      const similar = [0.9, 0.1, 0, 0, 0, 0, 0, 0]; // High similarity
      const lessSimilar = [0.5, 0.5, 0.5, 0, 0, 0, 0, 0]; // Medium

      createFactWithEmbedding('Best match', queryVec);
      createFactWithEmbedding('Good match', similar);
      createFactWithEmbedding('OK match', lessSimilar);

      embeddingProvider.setEmbedding('query', queryVec);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      for (let i = 1; i < result.items.length; i++) {
        expect(result.items[i - 1].score).toBeGreaterThanOrEqual(result.items[i].score);
      }
    });
  });

  describe('similarity threshold', () => {
    it('filters out chunks below threshold', async () => {
      const v0 = unitVector(DIM, 0);
      const v1 = unitVector(DIM, 1); // Orthogonal = similarity 0

      createFactWithEmbedding('Matches query', v0);
      createFactWithEmbedding('Does not match', v1);

      embeddingProvider.setEmbedding('query', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.5,
      });

      const result = await searcher.search('query');

      expect(result.items.length).toBe(1);
      expect(result.items[0].content).toContain('Matches query');
    });
  });

  describe('topK limiting', () => {
    it('limits results to topK', async () => {
      const queryVec = makeVector(42, DIM);

      // Create 10 slightly similar facts
      for (let i = 0; i < 10; i++) {
        const v = queryVec.map((x, j) => x + (j === i % DIM ? 0.01 : 0));
        createFactWithEmbedding(`Fact ${i}`, v);
      }

      embeddingProvider.setEmbedding('query', queryVec);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
        topK: 3,
      });

      const result = await searcher.search('query');
      expect(result.items.length).toBeLessThanOrEqual(3);
    });
  });

  describe('node type filtering', () => {
    it('filters to facts only', async () => {
      const v0 = unitVector(DIM, 0);

      createFactWithEmbedding('A fact', v0);
      createEpisodeWithEmbedding('An episode', 'Description', v0);
      createConceptWithEmbedding('A concept', 'Description', v0);

      embeddingProvider.setEmbedding('query', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
        nodeTypes: ['fact'],
      });

      const result = await searcher.search('query');

      expect(result.items.length).toBe(1);
      expect(result.items[0].nodeType).toBe('fact');
    });

    it('filters to episodes and concepts', async () => {
      const v0 = unitVector(DIM, 0);

      createFactWithEmbedding('A fact', v0);
      createEpisodeWithEmbedding('An episode', 'Description', v0);
      createConceptWithEmbedding('A concept', 'Description', v0);

      embeddingProvider.setEmbedding('query', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
        nodeTypes: ['episode', 'concept'],
      });

      const result = await searcher.search('query');

      expect(result.items.length).toBe(2);
      const types = result.items.map(i => i.nodeType);
      expect(types).toContain('episode');
      expect(types).toContain('concept');
      expect(types).not.toContain('fact');
    });
  });

  describe('superseded fact filtering', () => {
    it('excludes superseded facts by default', async () => {
      const v0 = unitVector(DIM, 0);
      const oldFact = createFactWithEmbedding('Old fact', v0);
      // Create replacement fact (needed for FK constraint)
      const newFact = factRepo.create({
        content: 'New fact',
        conversationId,
        sourceMessageIds: ['msg-1'],
        sourceTurnIndex: 1,
        confidence: 0.9,
        category: 'technical',
        entities: [],
      });

      // Supersede the old fact
      factRepo.supersede(oldFact.id, newFact.id);

      embeddingProvider.setEmbedding('query', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
        includeSuperseded: false,
      });

      const result = await searcher.search('query');

      // Embedding matches, but fact is superseded → filtered out in content load
      expect(result.items.length).toBe(0);
    });

    it('includes superseded facts when configured', async () => {
      const v0 = unitVector(DIM, 0);
      const oldFact = createFactWithEmbedding('Old fact', v0);
      const newFact = factRepo.create({
        content: 'New fact',
        conversationId,
        sourceMessageIds: ['msg-1'],
        sourceTurnIndex: 1,
        confidence: 0.9,
        category: 'technical',
        entities: [],
      });

      factRepo.supersede(oldFact.id, newFact.id);

      embeddingProvider.setEmbedding('query', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
        includeSuperseded: true,
      });

      const result = await searcher.search('query');
      expect(result.items.length).toBe(1);
    });
  });

  describe('searchByEmbedding', () => {
    it('searches using a pre-computed embedding', () => {
      const v0 = unitVector(DIM, 0);
      createFactWithEmbedding('TypeScript fact', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
      });

      const result = searcher.searchByEmbedding(v0);

      expect(result.items.length).toBe(1);
      expect(result.items[0].content).toContain('TypeScript fact');
      expect(result.items[0].score).toBeCloseTo(1.0, 2);
      expect(result.stats.embeddingTimeMs).toBe(0); // No embedding generation
    });

    it('supports per-query config override', () => {
      const v0 = unitVector(DIM, 0);
      const v1 = unitVector(DIM, 1);

      createFactWithEmbedding('Fact A', v0);
      createFactWithEmbedding('Fact B', v1);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.99, // Very high
      });

      // With default high threshold
      const r1 = searcher.searchByEmbedding(v0);
      expect(r1.items.length).toBe(1); // Only exact match

      // Override to low threshold
      const r2 = searcher.searchByEmbedding(v0, { similarityThreshold: 0.0 });
      expect(r2.items.length).toBe(2); // Both match
    });
  });

  describe('retrieval metadata', () => {
    it('includes search method in metadata', async () => {
      const v0 = unitVector(DIM, 0);
      createFactWithEmbedding('A fact', v0);

      embeddingProvider.setEmbedding('query', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      expect(result.items[0].retrievalMetadata).toBeDefined();
      expect(result.items[0].retrievalMetadata!.searchMethod).toBe('direct_chunk');
      expect(result.items[0].retrievalMetadata!.cosineSimilarity).toBeCloseTo(1.0, 2);
    });
  });

  describe('stats reporting', () => {
    it('reports correct stats', async () => {
      const v0 = unitVector(DIM, 0);
      createFactWithEmbedding('Fact 1', v0);
      createFactWithEmbedding('Fact 2', unitVector(DIM, 1));

      embeddingProvider.setEmbedding('query', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.5,
      });

      const result = await searcher.search('query');

      expect(result.stats.embeddingTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.stats.searchTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.stats.contentLoadTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.stats.totalTimeMs).toBeGreaterThan(0);
      expect(result.stats.chunksCompared).toBe(2); // Both checked
      expect(result.stats.chunksMatched).toBe(1); // Only v0 above threshold
    });
  });

  describe('edge cases', () => {
    it('handles deleted nodes gracefully', async () => {
      const v0 = unitVector(DIM, 0);
      const fact = createFactWithEmbedding('A fact', v0);

      // Delete the fact from facts table but leave embedding
      db.prepare('DELETE FROM facts WHERE id = ?').run(fact.id);

      embeddingProvider.setEmbedding('query', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      // Embedding matches but content load fails → filtered out
      expect(result.items.length).toBe(0);
    });

    it('handles empty query string', async () => {
      const v0 = unitVector(DIM, 0);
      createFactWithEmbedding('A fact', v0);

      // Mock will generate some embedding for empty string
      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('');
      // Should work without error (results depend on mock embedding)
      expect(result.items).toBeDefined();
      expect(result.stats).toBeDefined();
    });
  });

  describe('ScoredMemoryItem compatibility', () => {
    it('produces items compatible with ResultMerger input', async () => {
      const v0 = unitVector(DIM, 0);
      createFactWithEmbedding('Compatible fact', v0);

      embeddingProvider.setEmbedding('query', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');
      const item = result.items[0];

      // Verify ScoredMemoryItem shape
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

  describe('default config', () => {
    it('has sensible defaults', () => {
      expect(DEFAULT_CHUNK_SEARCH_CONFIG.topK).toBe(20);
      expect(DEFAULT_CHUNK_SEARCH_CONFIG.similarityThreshold).toBe(0.3);
      expect(DEFAULT_CHUNK_SEARCH_CONFIG.nodeTypes).toEqual([]);
      expect(DEFAULT_CHUNK_SEARCH_CONFIG.includeSuperseded).toBe(false);
    });
  });

  describe('content formatting', () => {
    it('formats episode content as [title] description', async () => {
      const v0 = unitVector(DIM, 0);
      createEpisodeWithEmbedding('Migration', 'Migrated codebase to TS', v0);

      embeddingProvider.setEmbedding('query', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');
      expect(result.items[0].content).toBe('[Migration] Migrated codebase to TS');
    });

    it('formats concept content as [name] description', async () => {
      const v0 = unitVector(DIM, 0);
      createConceptWithEmbedding('TypeScript', 'A typed superset of JavaScript', v0);

      embeddingProvider.setEmbedding('query', v0);

      const searcher = new MemoryChunkSearcher(db, embeddingProvider, {
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');
      expect(result.items[0].content).toBe('[TypeScript] A typed superset of JavaScript');
    });
  });
});
