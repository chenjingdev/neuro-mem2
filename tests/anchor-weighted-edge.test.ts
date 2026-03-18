/**
 * Tests for Anchor and WeightedEdge data models, schemas, and repositories.
 *
 * Sub-AC 4.1: Anchor 및 WeightedEdge 데이터 모델/스키마 정의
 * - Anchor CRUD (create, read, update, delete)
 * - Anchor embedding storage/retrieval
 * - WeightedEdge CRUD
 * - Hebbian reinforcement and decay
 * - Batch co-activation
 * - Query filters
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import type { Anchor, CreateAnchorInput } from '../src/models/anchor.js';
import type { WeightedEdge, CreateWeightedEdgeInput } from '../src/models/weighted-edge.js';
import { ANCHOR_TYPES } from '../src/models/anchor.js';
import { WEIGHTED_EDGE_TYPES } from '../src/models/weighted-edge.js';

describe('Anchor & WeightedEdge Models', () => {
  let db: Database.Database;
  let anchorRepo: AnchorRepository;
  let weightedEdgeRepo: WeightedEdgeRepository;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    anchorRepo = new AnchorRepository(db);
    weightedEdgeRepo = new WeightedEdgeRepository(db);
  });

  // ── Anchor Type Constants ──

  describe('Anchor type constants', () => {
    it('should define all anchor types', () => {
      expect(ANCHOR_TYPES).toContain('entity');
      expect(ANCHOR_TYPES).toContain('topic');
      expect(ANCHOR_TYPES).toContain('temporal');
      expect(ANCHOR_TYPES).toContain('composite');
      expect(ANCHOR_TYPES).toHaveLength(4);
    });

    it('should define all weighted edge types', () => {
      // Existing edge types
      expect(WEIGHTED_EDGE_TYPES).toContain('episode_mentions_concept');
      expect(WEIGHTED_EDGE_TYPES).toContain('concept_related_to');
      expect(WEIGHTED_EDGE_TYPES).toContain('fact_supports_concept');
      expect(WEIGHTED_EDGE_TYPES).toContain('episode_contains_fact');
      expect(WEIGHTED_EDGE_TYPES).toContain('temporal_next');
      expect(WEIGHTED_EDGE_TYPES).toContain('derived_from');
      // Anchor-specific
      expect(WEIGHTED_EDGE_TYPES).toContain('anchor_to_fact');
      expect(WEIGHTED_EDGE_TYPES).toContain('anchor_to_episode');
      expect(WEIGHTED_EDGE_TYPES).toContain('anchor_to_concept');
      expect(WEIGHTED_EDGE_TYPES).toContain('anchor_to_anchor');
      expect(WEIGHTED_EDGE_TYPES).toContain('query_activated');
      expect(WEIGHTED_EDGE_TYPES).toHaveLength(11);
    });
  });

  // ── Anchor CRUD ──

  describe('AnchorRepository CRUD', () => {
    it('should create an anchor with required fields', () => {
      const input: CreateAnchorInput = {
        label: 'TypeScript Migration',
        description: 'Project migration from JavaScript to TypeScript',
        anchorType: 'topic',
      };

      const anchor = anchorRepo.createAnchor(input);

      expect(anchor.id).toBeDefined();
      expect(anchor.label).toBe('TypeScript Migration');
      expect(anchor.description).toBe('Project migration from JavaScript to TypeScript');
      expect(anchor.anchorType).toBe('topic');
      expect(anchor.aliases).toEqual([]);
      expect(anchor.embedding).toBeUndefined();
      expect(anchor.embeddingDim).toBeUndefined();
      expect(anchor.activationCount).toBe(0);
      expect(anchor.lastActivatedAt).toBeUndefined();
      expect(anchor.createdAt).toBeDefined();
      expect(anchor.updatedAt).toBeDefined();
    });

    it('should create an anchor with aliases and metadata', () => {
      const anchor = anchorRepo.createAnchor({
        label: 'React',
        description: 'React.js frontend framework',
        anchorType: 'entity',
        aliases: ['ReactJS', 'React.js'],
        metadata: { source: 'extraction' },
      });

      expect(anchor.aliases).toEqual(['ReactJS', 'React.js']);
      expect(anchor.metadata).toEqual({ source: 'extraction' });
    });

    it('should create an anchor with embedding vector', () => {
      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      const anchor = anchorRepo.createAnchor({
        label: 'Database Design',
        description: 'Database schema and optimization topics',
        anchorType: 'topic',
        embedding,
      });

      expect(anchor.embedding).toBeDefined();
      expect(anchor.embeddingDim).toBe(5);
      expect(anchor.embedding!.length).toBe(5);
      expect(anchor.embedding![0]).toBeCloseTo(0.1);
      expect(anchor.embedding![4]).toBeCloseTo(0.5);
    });

    it('should retrieve an anchor by ID', () => {
      const created = anchorRepo.createAnchor({
        label: 'Auth Service',
        description: 'Authentication and authorization service',
        anchorType: 'entity',
      });

      const retrieved = anchorRepo.getAnchor(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.label).toBe('Auth Service');
    });

    it('should return null for non-existent anchor', () => {
      expect(anchorRepo.getAnchor('non-existent-id')).toBeNull();
    });

    it('should find anchor by label (case-insensitive)', () => {
      anchorRepo.createAnchor({
        label: 'TypeScript',
        description: 'TypeScript programming language',
        anchorType: 'entity',
      });

      const found = anchorRepo.findByLabel('typescript');
      expect(found).not.toBeNull();
      expect(found!.label).toBe('TypeScript');
    });

    it('should retrieve anchors by type', () => {
      anchorRepo.createAnchor({ label: 'React', description: 'React framework', anchorType: 'entity' });
      anchorRepo.createAnchor({ label: 'Vue', description: 'Vue framework', anchorType: 'entity' });
      anchorRepo.createAnchor({ label: 'Perf Tuning', description: 'Performance tuning', anchorType: 'topic' });

      const entities = anchorRepo.getByType('entity');
      expect(entities).toHaveLength(2);

      const topics = anchorRepo.getByType('topic');
      expect(topics).toHaveLength(1);
    });

    it('should list anchors as refs (without embeddings)', () => {
      anchorRepo.createAnchor({ label: 'A', description: 'd', anchorType: 'entity' });
      anchorRepo.createAnchor({ label: 'B', description: 'd', anchorType: 'topic' });

      const refs = anchorRepo.listAnchors();
      expect(refs).toHaveLength(2);
      expect(refs[0]).toHaveProperty('id');
      expect(refs[0]).toHaveProperty('label');
      expect(refs[0]).toHaveProperty('anchorType');
      expect(refs[0]).toHaveProperty('activationCount');
      // Should NOT have embedding
      expect(refs[0]).not.toHaveProperty('embedding');
    });

    it('should list anchors with limit', () => {
      for (let i = 0; i < 5; i++) {
        anchorRepo.createAnchor({ label: `Anchor ${i}`, description: 'd', anchorType: 'entity' });
      }

      const refs = anchorRepo.listAnchors(3);
      expect(refs).toHaveLength(3);
    });

    it('should update anchor fields', () => {
      const anchor = anchorRepo.createAnchor({
        label: 'Old Label',
        description: 'Old description',
        anchorType: 'topic',
      });

      const updated = anchorRepo.updateAnchor(anchor.id, {
        label: 'New Label',
        description: 'New description',
      });

      expect(updated).not.toBeNull();
      expect(updated!.label).toBe('New Label');
      expect(updated!.description).toBe('New description');
    });

    it('should add aliases (additive)', () => {
      const anchor = anchorRepo.createAnchor({
        label: 'React',
        description: 'React.js',
        anchorType: 'entity',
        aliases: ['ReactJS'],
      });

      const updated = anchorRepo.updateAnchor(anchor.id, {
        addAliases: ['React.js', 'ReactJS'], // ReactJS already exists, should not duplicate
      });

      expect(updated!.aliases).toEqual(['ReactJS', 'React.js']);
    });

    it('should record activation', () => {
      const anchor = anchorRepo.createAnchor({
        label: 'Test',
        description: 'Test anchor',
        anchorType: 'entity',
      });
      expect(anchor.activationCount).toBe(0);
      expect(anchor.lastActivatedAt).toBeUndefined();

      const activated = anchorRepo.recordActivation(anchor.id);
      expect(activated!.activationCount).toBe(1);
      expect(activated!.lastActivatedAt).toBeDefined();

      const activated2 = anchorRepo.recordActivation(anchor.id);
      expect(activated2!.activationCount).toBe(2);
    });

    it('should delete an anchor', () => {
      const anchor = anchorRepo.createAnchor({
        label: 'To Delete',
        description: 'Will be deleted',
        anchorType: 'entity',
      });

      expect(anchorRepo.deleteAnchor(anchor.id)).toBe(true);
      expect(anchorRepo.getAnchor(anchor.id)).toBeNull();
    });

    it('should return false when deleting non-existent anchor', () => {
      expect(anchorRepo.deleteAnchor('non-existent')).toBe(false);
    });

    it('should count anchors', () => {
      expect(anchorRepo.countAnchors()).toBe(0);
      anchorRepo.createAnchor({ label: 'A', description: 'd', anchorType: 'entity' });
      anchorRepo.createAnchor({ label: 'B', description: 'd', anchorType: 'topic' });
      expect(anchorRepo.countAnchors()).toBe(2);
    });

    it('should round-trip embedding vectors accurately', () => {
      const embedding = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        embedding[i] = Math.random() * 2 - 1; // [-1, 1]
      }

      const anchor = anchorRepo.createAnchor({
        label: 'Embedding Test',
        description: 'Test embedding round-trip',
        anchorType: 'topic',
        embedding,
      });

      const retrieved = anchorRepo.getAnchor(anchor.id);
      expect(retrieved!.embedding).toBeDefined();
      expect(retrieved!.embeddingDim).toBe(128);
      for (let i = 0; i < 128; i++) {
        expect(retrieved!.embedding![i]).toBeCloseTo(embedding[i], 5);
      }
    });
  });

  // ── WeightedEdge CRUD ──

  describe('WeightedEdgeRepository CRUD', () => {
    let anchorId: string;
    let factId: string;

    beforeEach(() => {
      // Create test anchor
      const anchor = anchorRepo.createAnchor({
        label: 'Test Anchor',
        description: 'For edge testing',
        anchorType: 'entity',
      });
      anchorId = anchor.id;
      factId = 'fake-fact-id-001';
    });

    it('should create a weighted edge with defaults', () => {
      const input: CreateWeightedEdgeInput = {
        sourceId: anchorId,
        sourceType: 'anchor',
        targetId: factId,
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
      };

      const edge = weightedEdgeRepo.createEdge(input);

      expect(edge.id).toBeDefined();
      expect(edge.sourceId).toBe(anchorId);
      expect(edge.sourceType).toBe('anchor');
      expect(edge.targetId).toBe(factId);
      expect(edge.targetType).toBe('fact');
      expect(edge.edgeType).toBe('anchor_to_fact');
      expect(edge.weight).toBe(0.5);
      expect(edge.initialWeight).toBe(0.5);
      expect(edge.learningRate).toBe(0.1);
      expect(edge.decayRate).toBe(0.01);
      expect(edge.activationCount).toBe(0);
      expect(edge.lastActivatedAt).toBeUndefined();
    });

    it('should create a weighted edge with custom parameters', () => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: anchorId,
        sourceType: 'anchor',
        targetId: factId,
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.8,
        learningRate: 0.2,
        decayRate: 0.05,
        metadata: { reason: 'strong semantic match' },
      });

      expect(edge.weight).toBe(0.8);
      expect(edge.initialWeight).toBe(0.8);
      expect(edge.learningRate).toBe(0.2);
      expect(edge.decayRate).toBe(0.05);
      expect(edge.metadata).toEqual({ reason: 'strong semantic match' });
    });

    it('should retrieve a weighted edge by ID', () => {
      const created = weightedEdgeRepo.createEdge({
        sourceId: anchorId,
        sourceType: 'anchor',
        targetId: factId,
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
      });

      const retrieved = weightedEdgeRepo.getEdge(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.sourceId).toBe(anchorId);
    });

    it('should return null for non-existent edge', () => {
      expect(weightedEdgeRepo.getEdge('non-existent')).toBeNull();
    });

    it('should find edge by endpoints', () => {
      weightedEdgeRepo.createEdge({
        sourceId: anchorId,
        sourceType: 'anchor',
        targetId: factId,
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
      });

      const found = weightedEdgeRepo.findEdge(anchorId, factId, 'anchor_to_fact');
      expect(found).not.toBeNull();
      expect(found!.sourceId).toBe(anchorId);
      expect(found!.targetId).toBe(factId);
    });

    it('should save batch of edges transactionally', () => {
      const inputs: CreateWeightedEdgeInput[] = [
        { sourceId: anchorId, sourceType: 'anchor', targetId: 'fact-1', targetType: 'fact', edgeType: 'anchor_to_fact' },
        { sourceId: anchorId, sourceType: 'anchor', targetId: 'fact-2', targetType: 'fact', edgeType: 'anchor_to_fact' },
        { sourceId: anchorId, sourceType: 'anchor', targetId: 'ep-1', targetType: 'episode', edgeType: 'anchor_to_episode' },
      ];

      const edges = weightedEdgeRepo.saveEdges(inputs);
      expect(edges).toHaveLength(3);
      expect(weightedEdgeRepo.countEdges()).toBe(3);
    });

    it('should return empty array for empty batch', () => {
      expect(weightedEdgeRepo.saveEdges([])).toEqual([]);
    });

    it('should get outgoing edges ordered by weight', () => {
      weightedEdgeRepo.createEdge({
        sourceId: anchorId, sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.3,
      });
      weightedEdgeRepo.createEdge({
        sourceId: anchorId, sourceType: 'anchor',
        targetId: 'f2', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.9,
      });

      const edges = weightedEdgeRepo.getOutgoingEdges(anchorId);
      expect(edges).toHaveLength(2);
      expect(edges[0].weight).toBe(0.9); // Higher weight first
      expect(edges[1].weight).toBe(0.3);
    });

    it('should get incoming edges', () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: factId, targetType: 'fact',
        edgeType: 'anchor_to_fact',
      });
      weightedEdgeRepo.createEdge({
        sourceId: 'a2', sourceType: 'anchor',
        targetId: factId, targetType: 'fact',
        edgeType: 'anchor_to_fact',
      });

      const edges = weightedEdgeRepo.getIncomingEdges(factId);
      expect(edges).toHaveLength(2);
    });

    it('should get connected edges (both directions)', () => {
      weightedEdgeRepo.createEdge({
        sourceId: anchorId, sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact',
      });
      weightedEdgeRepo.createEdge({
        sourceId: 'other-anchor', sourceType: 'anchor',
        targetId: anchorId, targetType: 'anchor',
        edgeType: 'anchor_to_anchor',
      });

      const edges = weightedEdgeRepo.getConnectedEdges(anchorId);
      expect(edges).toHaveLength(2);
    });

    it('should delete a weighted edge', () => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: anchorId, sourceType: 'anchor',
        targetId: factId, targetType: 'fact',
        edgeType: 'anchor_to_fact',
      });

      expect(weightedEdgeRepo.deleteEdge(edge.id)).toBe(true);
      expect(weightedEdgeRepo.getEdge(edge.id)).toBeNull();
    });

    it('should enforce unique constraint on (source_id, target_id, edge_type)', () => {
      weightedEdgeRepo.createEdge({
        sourceId: anchorId, sourceType: 'anchor',
        targetId: factId, targetType: 'fact',
        edgeType: 'anchor_to_fact',
      });

      expect(() => {
        weightedEdgeRepo.createEdge({
          sourceId: anchorId, sourceType: 'anchor',
          targetId: factId, targetType: 'fact',
          edgeType: 'anchor_to_fact',
        });
      }).toThrow();
    });
  });

  // ── Hebbian Reinforcement ──

  describe('Hebbian reinforcement', () => {
    let edgeId: string;

    beforeEach(() => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: 'anchor-1',
        sourceType: 'anchor',
        targetId: 'fact-1',
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.5,
        learningRate: 0.1,
      });
      edgeId = edge.id;
    });

    it('should reinforce edge weight using Hebbian rule', () => {
      const result = weightedEdgeRepo.reinforceEdge(edgeId);

      expect(result).not.toBeNull();
      expect(result!.previousWeight).toBe(0.5);
      // New formula: w_new = w_old + lr * WEIGHT_CAP * headroom
      // headroom = (100 - 0.5) / 100 = 0.995
      // delta = 0.1 * 100 * 0.995 = 9.95
      // w_new = 0.5 + 9.95 = 10.45
      expect(result!.newWeight).toBeCloseTo(10.45, 1);
      expect(result!.activationCount).toBe(1);

      // Verify persisted
      const edge = weightedEdgeRepo.getEdge(edgeId);
      expect(edge!.weight).toBeCloseTo(10.45, 1);
      expect(edge!.activationCount).toBe(1);
      expect(edge!.lastActivatedAt).toBeDefined();
    });

    it('should approach WEIGHT_CAP asymptotically with repeated reinforcement', () => {
      let weight = 0.5;
      for (let i = 0; i < 20; i++) {
        const result = weightedEdgeRepo.reinforceEdge(edgeId);
        weight = result!.newWeight;
      }

      // After 20 reinforcements, should approach WEIGHT_CAP (100)
      expect(weight).toBeGreaterThan(85);
      expect(weight).toBeLessThanOrEqual(100);
    });

    it('should allow override learning rate', () => {
      const result = weightedEdgeRepo.reinforceEdge(edgeId, 0.5);

      // New formula: delta = 0.5 * 100 * ((100 - 0.5) / 100) = 49.75
      // w_new = 0.5 + 49.75 = 50.25
      expect(result!.newWeight).toBeCloseTo(50.25, 1);
    });

    it('should return null for non-existent edge', () => {
      expect(weightedEdgeRepo.reinforceEdge('non-existent')).toBeNull();
    });

    it('should batch reinforce multiple edges', () => {
      const edge2 = weightedEdgeRepo.createEdge({
        sourceId: 'anchor-1', sourceType: 'anchor',
        targetId: 'fact-2', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.3,
      });

      const results = weightedEdgeRepo.batchReinforce({
        edgeIds: [edgeId, edge2.id],
      });

      expect(results).toHaveLength(2);
      expect(results[0].activationCount).toBe(1);
      expect(results[1].activationCount).toBe(1);
      expect(results[0].newWeight).toBeGreaterThan(0.5);
      expect(results[1].newWeight).toBeGreaterThan(0.3);
    });
  });

  // ── Weight Decay ──

  describe('Weight decay', () => {
    it('should apply event-based decay to all edges', () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 80, decayRate: 0.5, currentEvent: 0,
      });
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f2', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 50, decayRate: 0.5, currentEvent: 0,
      });

      // 10 events pass: decayAmount = 0.5 * 10 = 5
      const result = weightedEdgeRepo.applyDecay({ currentEvent: 10 });
      expect(result.decayedCount).toBe(2);

      // Verify weights decreased by decayAmount (shield was 0)
      const edges = weightedEdgeRepo.getOutgoingEdges('a1');
      expect(edges[0].weight).toBeCloseTo(75); // 80 - 5
      expect(edges[1].weight).toBeCloseTo(45); // 50 - 5
    });

    it('should prune edges below threshold', () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 80, decayRate: 0.1, currentEvent: 0,
      });
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f2', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 5, decayRate: 1.0, currentEvent: 0,
      });

      // 10 events: edge2 decayAmount = 1.0 * 10 = 10 → weight = 5 - 10 → 0
      const result = weightedEdgeRepo.applyDecay({ currentEvent: 10, pruneBelow: 1 });
      expect(result.prunedCount).toBe(1);
      expect(weightedEdgeRepo.countEdges()).toBe(1);
    });

    it('should not decay edges with zero decay rate', () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 80, decayRate: 0.0, currentEvent: 0,
      });

      weightedEdgeRepo.applyDecay({ currentEvent: 10 });

      const edge = weightedEdgeRepo.getOutgoingEdges('a1')[0];
      expect(edge.weight).toBeCloseTo(80); // Unchanged
    });
  });

  // ── Query Filters ──

  describe('WeightedEdge query filters', () => {
    beforeEach(() => {
      weightedEdgeRepo.createEdge({
        sourceId: 'anchor-a', sourceType: 'anchor',
        targetId: 'fact-1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.9,
      });
      weightedEdgeRepo.createEdge({
        sourceId: 'anchor-a', sourceType: 'anchor',
        targetId: 'ep-1', targetType: 'episode',
        edgeType: 'anchor_to_episode', weight: 0.6,
      });
      weightedEdgeRepo.createEdge({
        sourceId: 'anchor-a', sourceType: 'anchor',
        targetId: 'concept-1', targetType: 'concept',
        edgeType: 'anchor_to_concept', weight: 0.3,
      });
      weightedEdgeRepo.createEdge({
        sourceId: 'anchor-a', sourceType: 'anchor',
        targetId: 'anchor-b', targetType: 'anchor',
        edgeType: 'anchor_to_anchor', weight: 0.7,
      });
    });

    it('should filter by source ID', () => {
      const edges = weightedEdgeRepo.queryEdges({ sourceId: 'anchor-a' });
      expect(edges).toHaveLength(4);
    });

    it('should filter by target type', () => {
      const edges = weightedEdgeRepo.queryEdges({ targetType: 'fact' });
      expect(edges).toHaveLength(1);
      expect(edges[0].targetId).toBe('fact-1');
    });

    it('should filter by edge types', () => {
      const edges = weightedEdgeRepo.queryEdges({
        edgeTypes: ['anchor_to_fact', 'anchor_to_episode'],
      });
      expect(edges).toHaveLength(2);
    });

    it('should filter by minimum weight', () => {
      const edges = weightedEdgeRepo.queryEdges({ minWeight: 0.7 });
      expect(edges).toHaveLength(2); // 0.9 and 0.7
    });

    it('should filter by weight range', () => {
      const edges = weightedEdgeRepo.queryEdges({ minWeight: 0.5, maxWeight: 0.8 });
      expect(edges).toHaveLength(2); // 0.6 and 0.7
    });

    it('should limit results', () => {
      const edges = weightedEdgeRepo.queryEdges({ limit: 2 });
      expect(edges).toHaveLength(2);
    });

    it('should order by weight descending by default', () => {
      const edges = weightedEdgeRepo.queryEdges({});
      expect(edges[0].weight).toBe(0.9);
      expect(edges[1].weight).toBe(0.7);
    });

    it('should order by weight ascending', () => {
      const edges = weightedEdgeRepo.queryEdges({ orderBy: 'weight_asc' });
      expect(edges[0].weight).toBe(0.3);
    });
  });

  // ── Schema Integrity ──

  describe('Schema integrity', () => {
    it('should enforce anchor label uniqueness (case-insensitive)', () => {
      anchorRepo.createAnchor({
        label: 'TypeScript',
        description: 'TS lang',
        anchorType: 'entity',
      });

      expect(() => {
        anchorRepo.createAnchor({
          label: 'typescript', // same label, different case
          description: 'TS lang again',
          anchorType: 'entity',
        });
      }).toThrow();
    });

    it('should enforce valid anchor_type', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO anchors (id, label, description, anchor_type, created_at, updated_at)
          VALUES ('x', 'test', 'desc', 'invalid_type', '2024-01-01', '2024-01-01')
        `).run();
      }).toThrow();
    });

    it('should enforce weight bounds on weighted_edges', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO weighted_edges (id, source_id, source_type, target_id, target_type,
            edge_type, weight, initial_weight, shield, learning_rate, decay_rate,
            activation_count, last_activated_at_event, created_at, updated_at)
          VALUES ('x', 'a', 'anchor', 'b', 'fact', 'anchor_to_fact',
            150, 0.5, 0, 0.1, 0.01, 0, 0, '2024-01-01', '2024-01-01')
        `).run();
      }).toThrow();
    });

    it('should enforce valid edge_type on weighted_edges', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO weighted_edges (id, source_id, source_type, target_id, target_type,
            edge_type, weight, initial_weight, learning_rate, decay_rate,
            activation_count, created_at, updated_at)
          VALUES ('x', 'a', 'anchor', 'b', 'fact', 'invalid_edge_type',
            0.5, 0.5, 0.1, 0.01, 0, '2024-01-01', '2024-01-01')
        `).run();
      }).toThrow();
    });

    it('should enforce valid source_type on weighted_edges', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO weighted_edges (id, source_id, source_type, target_id, target_type,
            edge_type, weight, initial_weight, learning_rate, decay_rate,
            activation_count, created_at, updated_at)
          VALUES ('x', 'a', 'invalid', 'b', 'fact', 'anchor_to_fact',
            0.5, 0.5, 0.1, 0.01, 0, '2024-01-01', '2024-01-01')
        `).run();
      }).toThrow();
    });
  });

  // ── MemoryNodeType includes 'anchor' ──

  describe('MemoryNodeType extension', () => {
    it('should accept anchor as source_type in memory_edges table', () => {
      // The existing memory_edges table should also accept 'anchor'
      expect(() => {
        db.prepare(`
          INSERT INTO memory_edges (id, source_id, source_type, target_id, target_type,
            edge_type, weight, created_at, updated_at)
          VALUES ('test-edge', 'anchor-1', 'anchor', 'fact-1', 'fact',
            'derived_from', 0.5, '2024-01-01', '2024-01-01')
        `).run();
      }).not.toThrow();
    });
  });
});
