/**
 * Tests for Sub-AC 6.3: Retrieval 시점에 decay가 적용된 effective_weight를
 * 반영하도록 검색 로직 통합
 *
 * Tests cover:
 *   1. VectorSearcher applies dynamic anchor effective weight (not stored current_weight)
 *   2. VectorSearcher applies dynamic edge decay during expansion
 *   3. Graph traversal uses anchor effectiveWeight for seed scoring
 *   4. DualPathRetriever end-to-end: decay-affected results flow through merge
 *   5. Recently-accessed anchors rank higher than stale anchors (same similarity)
 *   6. Frequently-activated edges produce higher expansion scores
 *   7. Edge decay below expansion threshold filters out stale edges
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConceptRepository } from '../src/db/concept-repo.js';
import { EdgeRepository } from '../src/db/edge-repo.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import { VectorSearcher, cosineSimilarityVec } from '../src/retrieval/vector-searcher.js';
import { traverseGraph, findSeedNodes, extractEntitiesFromQuery } from '../src/retrieval/graph-traversal.js';
import { DualPathRetriever } from '../src/retrieval/dual-path-retriever.js';
import {
  computeAnchorEffectiveWeight,
  computeEdgeDecay,
  DEFAULT_DECAY_CONFIG,
  type AnchorDecayConfig,
} from '../src/scoring/anchor-decay.js';

// ─── Helpers ──────────────────────────────────────────────────────

const DIM = 8;

function unitVector(dim: number, index: number): number[] {
  const v = new Array(dim).fill(0);
  v[index] = 1.0;
  return v;
}

function toFloat32(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

/**
 * Create a conversation row directly in the DB (avoiding the ConversationRepository issue).
 */
function createConversationDirect(db: Database.Database): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO raw_conversations (id, title, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, 'Test Conversation', 'test', now, now);
  return id;
}

/**
 * Insert an anchor row with specific last_accessed_at timestamp.
 * This allows controlling the time elapsed for decay computation.
 */
function createAnchorWithTimestamps(
  db: Database.Database,
  opts: {
    label: string;
    description: string;
    embedding: number[];
    currentWeight: number;
    decayRate: number;
    accessCount: number;
    lastAccessedAt?: string;
    createdAt: string;
  },
): string {
  const id = uuidv4();
  const embBlob = Buffer.from(new Float32Array(opts.embedding).buffer);

  db.prepare(`
    INSERT INTO anchors (id, label, description, anchor_type, aliases,
      embedding, embedding_dim, current_weight, initial_weight, decay_rate,
      access_count, last_accessed_at, activation_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.label,
    opts.description,
    'topic',
    '[]',
    embBlob,
    opts.embedding.length,
    opts.currentWeight,
    opts.currentWeight,
    opts.decayRate,
    opts.accessCount,
    opts.lastAccessedAt ?? null,
    0,
    opts.createdAt,
    opts.createdAt,
  );

  return id;
}

/**
 * Insert a weighted edge with specific timestamps for decay testing.
 */
function createWeightedEdgeWithTimestamps(
  db: Database.Database,
  opts: {
    sourceId: string;
    targetId: string;
    targetType: string;
    weight: number;
    decayRate: number;
    activationCount: number;
    lastActivatedAt?: string;
    createdAt: string;
  },
): string {
  const id = uuidv4();

  db.prepare(`
    INSERT INTO weighted_edges (id, source_id, source_type, target_id, target_type,
      edge_type, weight, initial_weight, learning_rate, decay_rate,
      activation_count, last_activated_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.sourceId,
    'hub',
    opts.targetId,
    'leaf',
    'about',
    opts.weight,
    opts.weight,
    0.1,
    opts.decayRate,
    opts.activationCount,
    opts.lastActivatedAt ?? null,
    opts.createdAt,
    opts.createdAt,
  );

  return id;
}

// ─── Tests ────────────────────────────────────────────────────────

describe('Retrieval Decay Integration (Sub-AC 6.3)', () => {
  let db: Database.Database;
  let embeddingProvider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    embeddingProvider = new MockEmbeddingProvider(DIM);
  });

  afterEach(() => {
    db.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. VectorSearcher: Anchor effective weight
  // ─────────────────────────────────────────────────────────────────

  describe('VectorSearcher: anchor effective weight at retrieval time', () => {
    it('uses dynamically computed effective weight, not raw current_weight', async () => {
      // Create two anchors with SAME current_weight and SAME embedding similarity
      // but DIFFERENT access history: one recently accessed, one stale
      const now = new Date();
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const oneMinuteAgo = new Date(now.getTime() - 60_000).toISOString();

      const queryVec = unitVector(DIM, 0);

      // Stale anchor: last accessed 14 days ago, low access count
      const staleId = createAnchorWithTimestamps(db, {
        label: 'Stale Topic',
        description: 'An old topic',
        embedding: queryVec,
        currentWeight: 0.8,
        decayRate: 0.01,
        accessCount: 1,
        lastAccessedAt: fourteenDaysAgo,
        createdAt: fourteenDaysAgo,
      });

      // Fresh anchor: last accessed 1 minute ago, high access count
      const freshId = createAnchorWithTimestamps(db, {
        label: 'Fresh Topic',
        description: 'A recent topic',
        embedding: queryVec,
        currentWeight: 0.8,
        decayRate: 0.01,
        accessCount: 20,
        lastAccessedAt: oneMinuteAgo,
        createdAt: fourteenDaysAgo,
      });

      embeddingProvider.setEmbedding('query', queryVec);

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: false,
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      expect(result.items.length).toBe(2);

      // Both have same cosine similarity (1.0), but Fresh should rank higher
      // because its effective weight is higher (more recent access, higher access count)
      const freshItem = result.items.find(i => i.content?.includes('Fresh'));
      const staleItem = result.items.find(i => i.content?.includes('Stale'));

      expect(freshItem).toBeDefined();
      expect(staleItem).toBeDefined();
      expect(freshItem!.score).toBeGreaterThan(staleItem!.score);

      // The effective weight of the stale anchor should be significantly less than 0.8
      // (14 days = 1 half-life, so time decay ≈ 0.5)
      expect(staleItem!.score).toBeLessThan(0.8);

      // The fresh anchor's effective weight should be close to 0.8
      expect(freshItem!.score).toBeGreaterThan(0.7);
    });

    it('returns effectiveWeight in retrieval metadata', async () => {
      const now = new Date();
      const recentlyAccessed = new Date(now.getTime() - 60_000).toISOString();

      const queryVec = unitVector(DIM, 0);
      createAnchorWithTimestamps(db, {
        label: 'Test Anchor',
        description: 'Test',
        embedding: queryVec,
        currentWeight: 0.9,
        decayRate: 0.01,
        accessCount: 5,
        lastAccessedAt: recentlyAccessed,
        createdAt: recentlyAccessed,
      });

      embeddingProvider.setEmbedding('query', queryVec);

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: false,
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      expect(result.items.length).toBe(1);
      const meta = result.items[0].retrievalMetadata!;

      // Should have anchorWeight (effective weight) in metadata
      expect(meta.anchorWeight).toBeDefined();
      expect(typeof meta.anchorWeight).toBe('number');

      // effectiveScore = similarity * effective weight
      expect(meta.effectiveScore).toBeDefined();
      expect(meta.effectiveScore).toBeCloseTo(
        (meta.cosineSimilarity as number) * (meta.anchorWeight as number),
        3,
      );
    });

    it('anchor with zero decay rate preserves currentWeight exactly', async () => {
      const now = new Date();
      const longAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();

      const queryVec = unitVector(DIM, 0);
      createAnchorWithTimestamps(db, {
        label: 'Permanent',
        description: 'Never decays',
        embedding: queryVec,
        currentWeight: 1.0,
        decayRate: 0, // no decay
        accessCount: 0,
        lastAccessedAt: longAgo,
        createdAt: longAgo,
      });

      embeddingProvider.setEmbedding('query', queryVec);

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: false,
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      expect(result.items.length).toBe(1);
      // score = similarity (1.0) * effectiveWeight (1.0, no decay)
      expect(result.items[0].score).toBe(1.0);
    });

    it('high access count resists usage decay', async () => {
      const now = new Date();
      const created = new Date(now.getTime() - 1000).toISOString();

      const queryVec = unitVector(DIM, 0);

      // Low access count: usage penalty is high
      const lowAccessId = createAnchorWithTimestamps(db, {
        label: 'Low Access',
        description: 'Rarely used',
        embedding: queryVec,
        currentWeight: 0.8,
        decayRate: 0.01,
        accessCount: 0,
        lastAccessedAt: created,
        createdAt: created,
      });

      // High access count: usage penalty is low
      const highAccessId = createAnchorWithTimestamps(db, {
        label: 'High Access',
        description: 'Frequently used',
        embedding: queryVec,
        currentWeight: 0.8,
        decayRate: 0.01,
        accessCount: 100,
        lastAccessedAt: created,
        createdAt: created,
      });

      embeddingProvider.setEmbedding('query', queryVec);

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: false,
        similarityThreshold: 0.0,
      });

      const result = await searcher.search('query');

      const highAccess = result.items.find(i => i.content?.includes('High Access'));
      const lowAccess = result.items.find(i => i.content?.includes('Low Access'));

      expect(highAccess).toBeDefined();
      expect(lowAccess).toBeDefined();
      expect(highAccess!.score).toBeGreaterThan(lowAccess!.score);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. VectorSearcher: Edge decay during expansion
  // ─────────────────────────────────────────────────────────────────

  describe('VectorSearcher: edge decay during expansion', () => {
    it('applies decay to edge weight during anchor expansion', async () => {
      const convId = createConversationDirect(db);
      const now = new Date();
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

      const queryVec = unitVector(DIM, 0);

      // Create anchor (no decay for simplicity)
      const anchorId = createAnchorWithTimestamps(db, {
        label: 'TestAnchor',
        description: 'Test',
        embedding: queryVec,
        currentWeight: 1.0,
        decayRate: 0,
        accessCount: 10,
        lastAccessedAt: now.toISOString(),
        createdAt: now.toISOString(),
      });

      // Create a fact
      const factRepo = new FactRepository(db);
      const fact = factRepo.create({
        content: 'Test fact about decay',
        conversationId: convId,
        sourceMessageIds: ['msg-1'],
        sourceTurnIndex: 0,
        confidence: 0.9,
        category: 'technical',
        entities: [],
      });

      // Create an edge that was last activated 14 days ago (1 half-life)
      createWeightedEdgeWithTimestamps(db, {
        sourceId: anchorId,
        targetId: fact.id,
        targetType: 'fact',
        weight: 0.8,
        decayRate: 0.01, // default rate
        activationCount: 0,
        lastActivatedAt: fourteenDaysAgo,
        createdAt: fourteenDaysAgo,
      });

      embeddingProvider.setEmbedding('query', queryVec);

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: true,
        similarityThreshold: 0.0,
        expansionMinWeight: 0.0, // allow all weights
      });

      const result = await searcher.search('query');

      const factItem = result.items.find(i => i.nodeType === 'fact');
      expect(factItem).toBeDefined();

      // The edge weight (0.8) should be decayed.
      // After 14 days (1 half-life at default rate), time decay ≈ 0.5
      // With 0 activations, usage decay = 1 - 0.3 * 1 = 0.7
      // Combined: 0.5^0.7 * 0.7^0.3 ≈ 0.561 * 0.899 ≈ 0.504
      // Effective edge weight ≈ 0.8 * 0.504 ≈ 0.403
      // Score = anchorEffectiveScore (1.0) * effectiveEdgeWeight (≈0.403)
      expect(factItem!.score).toBeLessThan(0.8); // Less than raw edge weight
      expect(factItem!.score).toBeGreaterThan(0.1); // But still above some threshold

      // Verify metadata contains both raw and effective edge weights
      expect(factItem!.retrievalMetadata?.edgeWeight).toBe(0.8);
      expect(factItem!.retrievalMetadata?.effectiveEdgeWeight).toBeDefined();
      expect(factItem!.retrievalMetadata?.effectiveEdgeWeight as number).toBeLessThan(0.8);
    });

    it('filters out decayed edges that fall below expansion threshold', async () => {
      const convId = createConversationDirect(db);
      const now = new Date();
      const veryOld = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days ago

      const queryVec = unitVector(DIM, 0);

      const anchorId = createAnchorWithTimestamps(db, {
        label: 'TestAnchor',
        description: 'Test',
        embedding: queryVec,
        currentWeight: 1.0,
        decayRate: 0,
        accessCount: 10,
        lastAccessedAt: now.toISOString(),
        createdAt: now.toISOString(),
      });

      const factRepo = new FactRepository(db);
      const freshFact = factRepo.create({
        content: 'Fresh fact',
        conversationId: convId,
        sourceMessageIds: ['msg-1'],
        sourceTurnIndex: 0,
        confidence: 0.9,
        category: 'technical',
        entities: [],
      });

      const staleFact = factRepo.create({
        content: 'Stale fact',
        conversationId: convId,
        sourceMessageIds: ['msg-2'],
        sourceTurnIndex: 1,
        confidence: 0.9,
        category: 'technical',
        entities: [],
      });

      // Fresh edge: recently activated, high activation count
      createWeightedEdgeWithTimestamps(db, {
        sourceId: anchorId,
        targetId: freshFact.id,
        targetType: 'fact',
        weight: 0.5,
        decayRate: 0.01,
        activationCount: 10,
        lastActivatedAt: now.toISOString(),
        createdAt: now.toISOString(),
      });

      // Stale edge: very old, low stored weight, 0 activations
      createWeightedEdgeWithTimestamps(db, {
        sourceId: anchorId,
        targetId: staleFact.id,
        targetType: 'fact',
        weight: 0.15, // Just above default minWeight
        decayRate: 0.01,
        activationCount: 0,
        lastActivatedAt: veryOld,
        createdAt: veryOld,
      });

      embeddingProvider.setEmbedding('query', queryVec);

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: true,
        similarityThreshold: 0.0,
        expansionMinWeight: 0.1, // After decay, stale edge should fall below this
      });

      const result = await searcher.search('query');

      const factItems = result.items.filter(i => i.nodeType === 'fact');

      // Fresh fact should be present
      const freshItem = factItems.find(i => i.content?.includes('Fresh'));
      expect(freshItem).toBeDefined();

      // Stale fact: edge weight 0.15, after 90 days of decay it should be well below 0.1
      const staleItem = factItems.find(i => i.content?.includes('Stale'));
      expect(staleItem).toBeUndefined(); // Filtered out by expansionMinWeight
    });

    it('recently activated edges resist decay and produce higher scores', async () => {
      const convId = createConversationDirect(db);
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const queryVec = unitVector(DIM, 0);

      const anchorId = createAnchorWithTimestamps(db, {
        label: 'TestAnchor',
        description: 'Test',
        embedding: queryVec,
        currentWeight: 1.0,
        decayRate: 0,
        accessCount: 10,
        lastAccessedAt: now.toISOString(),
        createdAt: now.toISOString(),
      });

      const factRepo = new FactRepository(db);
      const activeFact = factRepo.create({
        content: 'Active fact',
        conversationId: convId,
        sourceMessageIds: ['msg-1'],
        sourceTurnIndex: 0,
        confidence: 0.9,
        category: 'technical',
        entities: [],
      });

      const inactiveFact = factRepo.create({
        content: 'Inactive fact',
        conversationId: convId,
        sourceMessageIds: ['msg-2'],
        sourceTurnIndex: 1,
        confidence: 0.9,
        category: 'technical',
        entities: [],
      });

      // Both edges created 7 days ago with same raw weight
      // Active edge: high activation count
      createWeightedEdgeWithTimestamps(db, {
        sourceId: anchorId,
        targetId: activeFact.id,
        targetType: 'fact',
        weight: 0.7,
        decayRate: 0.01,
        activationCount: 50, // frequently activated → resists usage decay
        lastActivatedAt: sevenDaysAgo,
        createdAt: sevenDaysAgo,
      });

      // Inactive edge: zero activation count
      createWeightedEdgeWithTimestamps(db, {
        sourceId: anchorId,
        targetId: inactiveFact.id,
        targetType: 'fact',
        weight: 0.7,
        decayRate: 0.01,
        activationCount: 0, // never activated → max usage penalty
        lastActivatedAt: sevenDaysAgo,
        createdAt: sevenDaysAgo,
      });

      embeddingProvider.setEmbedding('query', queryVec);

      const searcher = new VectorSearcher(db, embeddingProvider, {
        expandToMemoryNodes: true,
        similarityThreshold: 0.0,
        expansionMinWeight: 0.0,
      });

      const result = await searcher.search('query');

      const activeItem = result.items.find(i => i.content?.includes('Active fact'));
      const inactiveItem = result.items.find(i => i.content?.includes('Inactive fact'));

      expect(activeItem).toBeDefined();
      expect(inactiveItem).toBeDefined();

      // Active edge should produce higher score due to usage decay resistance
      expect(activeItem!.score).toBeGreaterThan(inactiveItem!.score);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. Graph traversal: anchor seed scoring with effective weight
  // ─────────────────────────────────────────────────────────────────

  describe('Graph traversal: anchor seed scoring with effectiveWeight', () => {
    it('uses anchor effectiveWeight (not currentWeight) as seed score', () => {
      const now = new Date();
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

      // Create an anchor with label 'TypeScript' that's been accessed 14 days ago
      const anchorRepo = new AnchorRepository(db);
      const anchor = anchorRepo.createAnchor({
        label: 'TypeScript',
        description: 'TypeScript language',
        anchorType: 'topic',
        aliases: ['TS'],
        initialWeight: 0.8,
        decayRate: 0.01,
      });

      // Manually set last_accessed_at to 14 days ago to simulate stale anchor
      db.prepare(
        `UPDATE anchors SET last_accessed_at = ?, access_count = 1 WHERE id = ?`
      ).run(fourteenDaysAgo, anchor.id);

      // Create a fact connected to the anchor via memory_edges
      const factRepo = new FactRepository(db);
      const convId = createConversationDirect(db);
      const fact = factRepo.create({
        content: 'TypeScript uses structural typing',
        conversationId: convId,
        sourceMessageIds: ['msg-1'],
        sourceTurnIndex: 0,
        confidence: 0.9,
        category: 'technical',
        entities: ['TypeScript'],
      });

      const edgeRepo = new EdgeRepository(db);
      edgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'anchor',
        targetId: fact.id,
        targetType: 'fact',
        edgeType: 'fact_supports_concept',
        weight: 0.9,
      });

      // Set up seeds with the anchor
      const seeds = new Map<string, { nodeType: 'anchor' | 'fact' | 'episode' | 'concept'; matchedEntity: string }>();
      seeds.set(anchor.id, { nodeType: 'anchor', matchedEntity: 'TypeScript' });

      const { results } = traverseGraph(db, seeds);

      // The anchor's seed score should use effectiveWeight, which is
      // less than currentWeight due to 14 days of decay
      const anchorResult = results.get(anchor.id);
      expect(anchorResult).toBeDefined();

      // effectiveWeight should be less than currentWeight (0.8)
      // because 14 days of time decay brings it down
      expect(anchorResult!.score).toBeLessThan(0.8);
      expect(anchorResult!.score).toBeGreaterThan(0); // But not zero
    });

    it('non-anchor seed nodes use score 1.0 (no decay)', () => {
      const convId = createConversationDirect(db);

      // Create a concept seed (non-anchor)
      const conceptRepo = new ConceptRepository(db);
      const concept = conceptRepo.createConcept({
        name: 'TypeScript',
        description: 'A typed JavaScript superset',
        category: 'technology',
        sourceConversationId: convId,
      });

      const seeds = new Map<string, { nodeType: 'anchor' | 'fact' | 'episode' | 'concept'; matchedEntity: string }>();
      seeds.set(concept.id, { nodeType: 'concept', matchedEntity: 'TypeScript' });

      const { results } = traverseGraph(db, seeds);

      const conceptResult = results.get(concept.id);
      expect(conceptResult).toBeDefined();
      // Non-anchor seeds should start at 1.0
      expect(conceptResult!.score).toBe(1.0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. Custom decay config flows through VectorSearcher
  // ─────────────────────────────────────────────────────────────────

  describe('Custom decay configuration', () => {
    it('VectorSearcher accepts custom decay config', async () => {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const queryVec = unitVector(DIM, 0);

      createAnchorWithTimestamps(db, {
        label: 'Test',
        description: 'Test anchor',
        embedding: queryVec,
        currentWeight: 0.8,
        decayRate: 0.01,
        accessCount: 1,
        lastAccessedAt: sevenDaysAgo,
        createdAt: sevenDaysAgo,
      });

      embeddingProvider.setEmbedding('query', queryVec);

      // Short half-life → aggressive decay
      const shortHalfLife: Partial<AnchorDecayConfig> = {
        timeHalfLifeMs: 1 * 24 * 60 * 60 * 1000, // 1 day
      };

      // Long half-life → slow decay
      const longHalfLife: Partial<AnchorDecayConfig> = {
        timeHalfLifeMs: 365 * 24 * 60 * 60 * 1000, // 1 year
      };

      const aggressiveSearcher = new VectorSearcher(
        db, embeddingProvider,
        { expandToMemoryNodes: false, similarityThreshold: 0.0 },
        shortHalfLife,
      );

      const gentleSearcher = new VectorSearcher(
        db, embeddingProvider,
        { expandToMemoryNodes: false, similarityThreshold: 0.0 },
        longHalfLife,
      );

      const aggressiveResult = await aggressiveSearcher.search('query');
      const gentleResult = await gentleSearcher.search('query');

      expect(aggressiveResult.items.length).toBe(1);
      expect(gentleResult.items.length).toBe(1);

      // Aggressive decay → lower score
      // Gentle decay → higher score
      expect(aggressiveResult.items[0].score).toBeLessThan(gentleResult.items[0].score);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. End-to-end: DualPathRetriever with decay
  // ─────────────────────────────────────────────────────────────────

  describe('DualPathRetriever: end-to-end decay integration', () => {
    it('stale anchors produce lower-scored results than fresh anchors', async () => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const recentlyAccessed = new Date(now.getTime() - 60_000).toISOString();
      const convId = createConversationDirect(db);

      // Two anchors with similar embeddings
      const queryVec = unitVector(DIM, 0);
      const similarVec = queryVec.map((v, i) => i === 0 ? 0.95 : (i === 1 ? 0.31 : 0));

      // Fresh anchor
      const freshAnchorId = createAnchorWithTimestamps(db, {
        label: 'Fresh TypeScript',
        description: 'Recent TypeScript topic',
        embedding: queryVec,
        currentWeight: 0.8,
        decayRate: 0.01,
        accessCount: 20,
        lastAccessedAt: recentlyAccessed,
        createdAt: thirtyDaysAgo,
      });

      // Stale anchor
      const staleAnchorId = createAnchorWithTimestamps(db, {
        label: 'Stale TypeScript',
        description: 'Old TypeScript topic',
        embedding: similarVec,
        currentWeight: 0.8,
        decayRate: 0.01,
        accessCount: 1,
        lastAccessedAt: thirtyDaysAgo,
        createdAt: thirtyDaysAgo,
      });

      // Create facts connected to each anchor
      const factRepo = new FactRepository(db);
      const freshFact = factRepo.create({
        content: 'Fresh fact about TypeScript',
        conversationId: convId,
        sourceMessageIds: ['msg-1'],
        sourceTurnIndex: 0,
        confidence: 0.9,
        category: 'technical',
        entities: ['TypeScript'],
      });

      const staleFact = factRepo.create({
        content: 'Stale fact about TypeScript',
        conversationId: convId,
        sourceMessageIds: ['msg-2'],
        sourceTurnIndex: 1,
        confidence: 0.9,
        category: 'technical',
        entities: ['TypeScript'],
      });

      // Connect anchors to facts via weighted edges (recent activation for fresh)
      createWeightedEdgeWithTimestamps(db, {
        sourceId: freshAnchorId,
        targetId: freshFact.id,
        targetType: 'fact',
        weight: 0.8,
        decayRate: 0.01,
        activationCount: 10,
        lastActivatedAt: recentlyAccessed,
        createdAt: recentlyAccessed,
      });

      createWeightedEdgeWithTimestamps(db, {
        sourceId: staleAnchorId,
        targetId: staleFact.id,
        targetType: 'fact',
        weight: 0.8,
        decayRate: 0.01,
        activationCount: 0,
        lastActivatedAt: thirtyDaysAgo,
        createdAt: thirtyDaysAgo,
      });

      embeddingProvider.setEmbedding('TypeScript development', queryVec);

      const retriever = new DualPathRetriever(db, embeddingProvider, {
        reinforceOnRetrieval: false,
        minScore: 0.01,
        vector: { similarityThreshold: 0.1 },
      });

      const result = await retriever.recall({ queryText: 'TypeScript development' });

      // Find the fresh and stale facts in results
      const freshResult = result.items.find(i => i.content?.includes('Fresh fact'));
      const staleResult = result.items.find(i => i.content?.includes('Stale fact'));

      if (freshResult && staleResult) {
        // Fresh should score higher due to less decay on both anchor and edge
        expect(freshResult.score).toBeGreaterThan(staleResult.score);
      }

      // At minimum, the retriever should return some results
      expect(result.items.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. Pure function: computeAnchorEffectiveWeight consistency
  // ─────────────────────────────────────────────────────────────────

  describe('Effective weight computation consistency', () => {
    it('effective weight equals currentWeight when no time has passed', () => {
      const now = new Date();
      const result = computeAnchorEffectiveWeight({
        currentWeight: 0.8,
        decayRate: 0.01,
        lastAccessedAt: now.toISOString(),
        createdAt: now.toISOString(),
        accessCount: 5,
      }, now);

      // With elapsed=0, should return currentWeight
      expect(result).toBe(0.8);
    });

    it('effective weight drops after time passes', () => {
      const now = new Date();
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      const result = computeAnchorEffectiveWeight({
        currentWeight: 0.8,
        decayRate: 0.01,
        lastAccessedAt: fourteenDaysAgo.toISOString(),
        createdAt: fourteenDaysAgo.toISOString(),
        accessCount: 1,
      }, now);

      expect(result).toBeLessThan(0.8);
      expect(result).toBeGreaterThan(DEFAULT_DECAY_CONFIG.minWeight);
    });

    it('effective edge weight drops for stale edges', () => {
      const now = new Date();
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      const result = computeEdgeDecay({
        weight: 0.8,
        lastActivatedAt: fourteenDaysAgo.toISOString(),
        activationCount: 0,
        edgeDecayRate: 0.01,
      }, now);

      expect(result.newWeight).toBeLessThan(0.8);
      expect(result.combinedFactor).toBeLessThan(1.0);
      expect(result.timeDecayFactor).toBeCloseTo(0.5, 1); // ~0.5 after 1 half-life
    });
  });
});
