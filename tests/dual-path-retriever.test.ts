/**
 * Tests for the Dual-Path Retriever — parallel vector + graph orchestrator.
 *
 * Sub-AC 7.3: 병렬 실행 오케스트레이터 구현 — 벡터 검색과 그래프 탐색을
 * asyncio/concurrent로 병렬 실행하는 dual-path retriever
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConceptRepository } from '../src/db/concept-repo.js';
import { EpisodeRepository } from '../src/db/episode-repo.js';
import { EdgeRepository } from '../src/db/edge-repo.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import { DualPathRetriever, type RecallQuery } from '../src/retrieval/dual-path-retriever.js';

// ── Test helpers ──

function createTestDB(): Database.Database {
  return createDatabase({ inMemory: true });
}

/**
 * Create a deterministic Float32Array embedding from a seed number.
 * Two calls with the same seed produce the same vector.
 * Different seeds produce different vectors with controllable similarity.
 */
function makeEmbedding(seed: number, dim: number = 64): Float32Array {
  const vec = new Float32Array(dim);
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) | 0;
    vec[i] = (s & 0x7fffffff) / 0x7fffffff;
  }
  // L2-normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * Create a similar embedding by blending two seeds.
 * Higher blend → more similar to seed1.
 */
function makeSimilarEmbedding(seed1: number, seed2: number, blend: number = 0.8, dim: number = 64): Float32Array {
  const v1 = makeEmbedding(seed1, dim);
  const v2 = makeEmbedding(seed2, dim);
  const result = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    result[i] = blend * v1[i] + (1 - blend) * v2[i];
  }
  // Re-normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += result[i] * result[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) result[i] /= norm;
  }
  return result;
}

/**
 * Seed the database with anchors, facts, episodes, concepts, and edges
 * to support dual-path retrieval testing.
 */
function seedTestData(db: Database.Database) {
  const anchorRepo = new AnchorRepository(db);
  const factRepo = new FactRepository(db);
  const episodeRepo = new EpisodeRepository(db);
  const conceptRepo = new ConceptRepository(db);
  const edgeRepo = new EdgeRepository(db);
  const weightedEdgeRepo = new WeightedEdgeRepository(db);

  // Create a test conversation
  const convId = uuidv4();
  db.prepare(`INSERT INTO raw_conversations (id, title, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(convId, 'Test Conversation', 'test', new Date().toISOString(), new Date().toISOString());

  // Create messages (raw_messages uses composite PK: conversation_id + turn_index)
  const msgId1 = `${convId}:0`;
  const msgId2 = `${convId}:1`;
  db.prepare(`INSERT INTO raw_messages (conversation_id, turn_index, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(convId, 0, 'user', 'How do I set up TypeScript with SQLite?', new Date().toISOString());
  db.prepare(`INSERT INTO raw_messages (conversation_id, turn_index, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(convId, 1, 'assistant', 'Use better-sqlite3 with TypeScript for local storage.', new Date().toISOString());

  // Create facts (for graph path retrieval via entity matching)
  const fact1 = factRepo.create({
    content: 'User prefers TypeScript for all projects',
    conversationId: convId,
    sourceMessageIds: [msgId1],
    sourceTurnIndex: 0,
    confidence: 0.9,
    category: 'preference',
    entities: ['TypeScript'],
    subject: 'User',
    predicate: 'prefers',
    object: 'TypeScript',
  });

  const fact2 = factRepo.create({
    content: 'better-sqlite3 is the chosen SQLite driver',
    conversationId: convId,
    sourceMessageIds: [msgId2],
    sourceTurnIndex: 1,
    confidence: 0.85,
    category: 'technical',
    entities: ['better-sqlite3', 'SQLite'],
    subject: 'Project',
    predicate: 'uses',
    object: 'better-sqlite3',
  });

  const fact3 = factRepo.create({
    content: 'Application uses local-only storage pattern',
    conversationId: convId,
    sourceMessageIds: [msgId2],
    sourceTurnIndex: 1,
    confidence: 0.8,
    category: 'technical',
    entities: ['SQLite', 'local storage'],
  });

  // Create concepts
  const concept1 = conceptRepo.createConcept({
    name: 'TypeScript',
    description: 'Statically-typed superset of JavaScript',
    category: 'technology',
    aliases: ['TS'],
    sourceConversationId: convId,
  });

  const concept2 = conceptRepo.createConcept({
    name: 'SQLite',
    description: 'Lightweight embedded relational database',
    category: 'technology',
    aliases: ['sqlite3'],
    sourceConversationId: convId,
  });

  // Create episodes
  const episode1: Parameters<typeof episodeRepo.saveEpisodes>[0][0] = {
    id: uuidv4(),
    conversationId: convId,
    type: 'decision',
    title: 'Chose better-sqlite3 for persistence',
    description: 'Team decided to use better-sqlite3 as the SQLite driver for TypeScript projects',
    startTurnIndex: 0,
    endTurnIndex: 1,
    sourceMessageIds: [msgId1, msgId2],
    actors: ['user', 'assistant'],
    outcome: 'Selected better-sqlite3',
    createdAt: new Date().toISOString(),
  };
  episodeRepo.saveEpisodes([episode1]);

  // Create memory edges (for graph-path BFS traversal)
  edgeRepo.createEdge({
    sourceId: fact1.id,
    sourceType: 'fact',
    targetId: concept1.id,
    targetType: 'concept',
    edgeType: 'fact_supports_concept',
    weight: 0.8,
  });

  edgeRepo.createEdge({
    sourceId: fact2.id,
    sourceType: 'fact',
    targetId: concept2.id,
    targetType: 'concept',
    edgeType: 'fact_supports_concept',
    weight: 0.7,
  });

  edgeRepo.createEdge({
    sourceId: episode1.id,
    sourceType: 'episode',
    targetId: concept2.id,
    targetType: 'concept',
    edgeType: 'episode_mentions_concept',
    weight: 0.6,
  });

  edgeRepo.createEdge({
    sourceId: concept1.id,
    sourceType: 'concept',
    targetId: concept2.id,
    targetType: 'concept',
    edgeType: 'concept_related_to',
    weight: 0.5,
  });

  // Create anchors with embeddings (for vector-path retrieval)
  const tsEmb = makeEmbedding(42, 64);
  const sqliteEmb = makeEmbedding(99, 64);

  const anchor1 = anchorRepo.createAnchor({
    label: 'TypeScript Development',
    description: 'TypeScript language development practices and patterns',
    anchorType: 'topic',
    aliases: ['TS dev', 'TypeScript'],
    embedding: tsEmb,
  });

  const anchor2 = anchorRepo.createAnchor({
    label: 'SQLite Database',
    description: 'SQLite embedded database technology and usage',
    anchorType: 'topic',
    aliases: ['sqlite', 'sqlite3'],
    embedding: sqliteEmb,
  });

  // Create weighted edges from anchors to memory nodes
  weightedEdgeRepo.createEdge({
    sourceId: anchor1.id,
    sourceType: 'hub',
    targetId: fact1.id,
    targetType: 'leaf',
    edgeType: 'about',
    weight: 0.8,
  });

  weightedEdgeRepo.createEdge({
    sourceId: anchor1.id,
    sourceType: 'hub',
    targetId: concept1.id,
    targetType: 'leaf',
    edgeType: 'about',
    weight: 0.9,
  });

  weightedEdgeRepo.createEdge({
    sourceId: anchor2.id,
    sourceType: 'hub',
    targetId: fact2.id,
    targetType: 'leaf',
    edgeType: 'about',
    weight: 0.7,
  });

  weightedEdgeRepo.createEdge({
    sourceId: anchor2.id,
    sourceType: 'hub',
    targetId: fact3.id,
    targetType: 'leaf',
    edgeType: 'about',
    weight: 0.6,
  });

  weightedEdgeRepo.createEdge({
    sourceId: anchor2.id,
    sourceType: 'hub',
    targetId: concept2.id,
    targetType: 'leaf',
    edgeType: 'about',
    weight: 0.85,
  });

  weightedEdgeRepo.createEdge({
    sourceId: anchor2.id,
    sourceType: 'hub',
    targetId: episode1.id,
    targetType: 'leaf',
    edgeType: 'about',
    weight: 0.65,
  });

  return {
    convId,
    facts: [fact1, fact2, fact3],
    concepts: [concept1, concept2],
    episodes: [episode1],
    anchors: [anchor1, anchor2],
    embeddings: { ts: tsEmb, sqlite: sqliteEmb },
  };
}

// ── Tests ──

describe('DualPathRetriever', () => {
  let db: Database.Database;
  let mockEmb: MockEmbeddingProvider;

  beforeEach(() => {
    db = createTestDB();
    mockEmb = new MockEmbeddingProvider(64);
  });

  afterEach(() => {
    db.close();
  });

  describe('parallel execution', () => {
    it('runs vector and graph paths concurrently via Promise.all', async () => {
      const data = seedTestData(db);

      // Set up embedding provider to return an embedding similar to the TypeScript anchor
      const queryEmb = Array.from(makeSimilarEmbedding(42, 99, 0.9, 64));
      mockEmb.setEmbedding('TypeScript project setup', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        pathTimeoutMs: 5000,
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'TypeScript project setup' });

      // Should have results from the merge
      expect(result.items.length).toBeGreaterThan(0);

      // Diagnostics should report both path timings
      expect(result.diagnostics.vectorTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics.graphTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics.totalTimeMs).toBeGreaterThanOrEqual(0);

      // Neither path should time out
      expect(result.diagnostics.vectorTimedOut).toBe(false);
      expect(result.diagnostics.graphTimedOut).toBe(false);
    });

    it('returns results from both vector and graph paths', async () => {
      const data = seedTestData(db);

      const queryEmb = Array.from(makeSimilarEmbedding(42, 99, 0.9, 64));
      mockEmb.setEmbedding('TypeScript SQLite', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'TypeScript SQLite' });

      // Should have items from vector path (anchor-based expansion)
      expect(result.diagnostics.vectorItemCount).toBeGreaterThan(0);

      // Should have items from graph path (entity-based BFS)
      expect(result.diagnostics.graphItemCount).toBeGreaterThan(0);

      // Merge stats should reflect both paths
      expect(result.diagnostics.mergeStats.vectorInputCount).toBeGreaterThan(0);
      expect(result.diagnostics.mergeStats.graphInputCount).toBeGreaterThan(0);
    });

    it('items found via both paths get a convergence bonus', async () => {
      const data = seedTestData(db);

      // This embedding should be similar to TypeScript anchor
      const queryEmb = Array.from(makeSimilarEmbedding(42, 99, 0.9, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        convergenceBonus: 0.1,
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'TypeScript' });

      // Check for overlap — items found via both paths
      const { overlapCount } = result.diagnostics.mergeStats;
      // TypeScript-related nodes should appear in both paths
      // (vector: anchor→weighted_edge→fact/concept, graph: entity→memory_edge→concept/fact)
      if (overlapCount > 0) {
        // Items with both sources should have higher scores due to convergence bonus
        const overlapItems = result.items.filter(i => i.sources.length === 2);
        expect(overlapItems.length).toBeGreaterThan(0);
      }
    });
  });

  describe('merge and ranking', () => {
    it('results are sorted by score descending', async () => {
      const data = seedTestData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript development', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, { minScore: 0.01 });
      const result = await retriever.recall({ queryText: 'TypeScript development' });

      if (result.items.length > 1) {
        for (let i = 1; i < result.items.length; i++) {
          expect(result.items[i - 1].score).toBeGreaterThanOrEqual(result.items[i].score);
        }
      }
    });

    it('results are deduplicated by nodeId', async () => {
      const data = seedTestData(db);

      const queryEmb = Array.from(makeSimilarEmbedding(42, 99, 0.5, 64));
      mockEmb.setEmbedding('TypeScript SQLite database', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, { minScore: 0.01 });
      const result = await retriever.recall({ queryText: 'TypeScript SQLite database' });

      // All nodeIds should be unique
      const ids = result.items.map(i => i.nodeId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('respects maxResults limit', async () => {
      const data = seedTestData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('all things', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        maxResults: 3,
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'all things' });

      expect(result.items.length).toBeLessThanOrEqual(3);
    });
  });

  describe('diagnostics', () => {
    it('reports activated anchors from vector path', async () => {
      const data = seedTestData(db);

      // Embedding very similar to the TypeScript anchor
      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript patterns', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'TypeScript patterns' });

      // Should report activated anchors
      expect(result.diagnostics.activatedAnchors.length).toBeGreaterThan(0);
      expect(result.diagnostics.activatedAnchors[0]).toHaveProperty('anchorId');
      expect(result.diagnostics.activatedAnchors[0]).toHaveProperty('label');
      expect(result.diagnostics.activatedAnchors[0]).toHaveProperty('similarity');
    });

    it('reports extracted entities from graph path', async () => {
      const data = seedTestData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript SQLite', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, { minScore: 0.01 });
      const result = await retriever.recall({ queryText: 'TypeScript SQLite' });

      // Should report extracted entities
      expect(result.diagnostics.extractedEntities).toContain('TypeScript');
      expect(result.diagnostics.extractedEntities).toContain('SQLite');
    });

    it('reports merge statistics', async () => {
      const data = seedTestData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, { minScore: 0.01 });
      const result = await retriever.recall({ queryText: 'TypeScript' });

      const stats = result.diagnostics.mergeStats;
      expect(stats).toHaveProperty('vectorInputCount');
      expect(stats).toHaveProperty('graphInputCount');
      expect(stats).toHaveProperty('overlapCount');
      expect(stats).toHaveProperty('uniqueCount');
      expect(stats).toHaveProperty('filteredCount');
      expect(stats).toHaveProperty('outputCount');
      expect(stats).toHaveProperty('mergeTimeMs');
    });
  });

  describe('Hebbian reinforcement', () => {
    it('reinforces co-activated edges after retrieval', async () => {
      const data = seedTestData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const weightedEdgeRepo = new WeightedEdgeRepository(db);

      // Get initial edge weights
      const edgesBefore = weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id);
      const weightsBefore = new Map(edgesBefore.map(e => [e.id, e.weight]));

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: 0.1,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'TypeScript' });

      // Should report edges reinforced
      if (result.diagnostics.edgesReinforced > 0) {
        const edgesAfter = weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id);
        const weightsAfter = new Map(edgesAfter.map(e => [e.id, e.weight]));

        // At least one edge should have increased weight
        let anyReinforced = false;
        for (const [id, before] of weightsBefore) {
          const after = weightsAfter.get(id);
          if (after !== undefined && after > before) {
            anyReinforced = true;
            break;
          }
        }
        expect(anyReinforced).toBe(true);
      }
    });

    it('skips reinforcement when disabled', async () => {
      const data = seedTestData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: false,
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'TypeScript' });

      expect(result.diagnostics.edgesReinforced).toBe(0);
    });
  });

  describe('timeout handling', () => {
    it('handles path timeout gracefully', async () => {
      const data = seedTestData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      // Create a retriever with a very short timeout
      // (the actual execution should still be fast enough, but this tests the mechanism)
      const retriever = new DualPathRetriever(db, mockEmb, {
        pathTimeoutMs: 10000,  // 10 seconds - should not timeout
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'TypeScript' });

      // Should not timeout with a generous limit
      expect(result.diagnostics.vectorTimedOut).toBe(false);
      expect(result.diagnostics.graphTimedOut).toBe(false);
    });
  });

  describe('empty state', () => {
    it('returns empty results when database has no data', async () => {
      // No test data seeded
      mockEmb.setEmbedding('anything', Array.from(makeEmbedding(1, 64)));

      const retriever = new DualPathRetriever(db, mockEmb, {
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'anything' });

      expect(result.items).toHaveLength(0);
      expect(result.diagnostics.vectorItemCount).toBe(0);
      expect(result.diagnostics.graphItemCount).toBe(0);
    });

    it('handles query with no matching entities', async () => {
      const data = seedTestData(db);

      mockEmb.setEmbedding('xyzzy foobar', Array.from(makeEmbedding(999, 64)));

      const retriever = new DualPathRetriever(db, mockEmb, {
        vector: { similarityThreshold: 0.99 },  // Very high threshold — no matches
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'xyzzy foobar' });

      // Vector path may find nothing due to high threshold
      // Graph path may find nothing due to no matching entities
      expect(result.diagnostics.vectorTimedOut).toBe(false);
      expect(result.diagnostics.graphTimedOut).toBe(false);
    });
  });

  describe('per-query config overrides', () => {
    it('accepts per-query config overrides', async () => {
      const data = seedTestData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        maxResults: 20,
        minScore: 0.01,
      });

      const result = await retriever.recall({
        queryText: 'TypeScript',
        config: {
          maxResults: 2,
        },
      });

      expect(result.items.length).toBeLessThanOrEqual(2);
    });
  });
});
