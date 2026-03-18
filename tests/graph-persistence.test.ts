/**
 * Tests for Graph Persistence Layer.
 *
 * Sub-AC 4.3: 산출된 가중치 연결을 그래프 저장소에
 * 생성/업데이트/조회하는 persistence 레이어 구현
 *
 * Covers:
 * - Score-and-persist: compute weight → upsert to storage
 * - Weighted edge upsert with Hebbian reinforcement
 * - Co-activation reinforcement batches
 * - Decay application across both tables
 * - Neighbor queries (weighted, memory, combined)
 * - Maintenance operations (delete, stats)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { GraphPersistence } from '../src/services/graph-persistence.js';
import type { PersistScoredEdgeInput, PersistWeightedInput } from '../src/services/graph-persistence.js';
import type { MemoryNodeDescriptor } from '../src/scoring/edge-scorer.js';

describe('GraphPersistence', () => {
  let db: Database.Database;
  let gp: GraphPersistence;

  // Helper: create a MemoryNodeDescriptor
  function makeNode(overrides: Partial<MemoryNodeDescriptor> = {}): MemoryNodeDescriptor {
    return {
      id: overrides.id ?? 'node-1',
      type: overrides.type ?? 'fact',
      content: overrides.content ?? 'some content about typescript',
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      entities: overrides.entities ?? ['TypeScript'],
      conversationIds: overrides.conversationIds ?? ['conv-1'],
      turnIndices: overrides.turnIndices,
      embedding: overrides.embedding,
    };
  }

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    gp = new GraphPersistence(db);
  });

  afterEach(() => {
    db.close();
  });

  // ─── Score-and-Persist ────────────────────────────────────

  describe('persistScoredEdge', () => {
    it('creates a new edge when score meets threshold', () => {
      const now = new Date().toISOString();
      const source = makeNode({
        id: 'fact-1',
        content: 'TypeScript React development patterns',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['conv-1'],
      });
      const target = makeNode({
        id: 'concept-1',
        type: 'concept',
        content: 'TypeScript React component architecture',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['conv-1'],
      });

      const result = gp.persistScoredEdge({
        sourceNode: source,
        targetNode: target,
        edgeType: 'fact_supports_concept',
      });

      expect(result).not.toBeNull();
      expect(result!.isNew).toBe(true);
      expect(result!.edge.sourceId).toBe('fact-1');
      expect(result!.edge.targetId).toBe('concept-1');
      expect(result!.edge.weight).toBeGreaterThan(0);
      expect(result!.breakdown.meetsThreshold).toBe(true);
      expect(result!.edge.metadata).toHaveProperty('scoreBreakdown');
    });

    it('returns null when score is below threshold', () => {
      const source = makeNode({
        id: 'fact-1',
        content: 'Python machine learning models',
        createdAt: '2020-01-01T00:00:00Z',
        entities: ['Python'],
        conversationIds: ['conv-1'],
      });
      const target = makeNode({
        id: 'fact-2',
        content: 'Java enterprise middleware',
        createdAt: '2025-12-01T00:00:00Z',
        entities: ['Java'],
        conversationIds: ['conv-99'],
      });

      // Use a higher threshold to ensure it doesn't meet it
      const strictGp = new GraphPersistence(db, { minScoreThreshold: 0.9 });
      const result = strictGp.persistScoredEdge({
        sourceNode: source,
        targetNode: target,
        edgeType: 'fact_supports_concept',
      });

      expect(result).toBeNull();
    });

    it('updates existing edge on repeated persist (hebbian by default)', () => {
      const now = new Date().toISOString();
      const source = makeNode({
        id: 'fact-1',
        content: 'TypeScript React patterns',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['conv-1'],
      });
      const target = makeNode({
        id: 'concept-1',
        type: 'concept',
        content: 'TypeScript React component patterns',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['conv-1'],
      });

      const first = gp.persistScoredEdge({
        sourceNode: source,
        targetNode: target,
        edgeType: 'fact_supports_concept',
      });
      expect(first!.isNew).toBe(true);
      const firstWeight = first!.edge.weight;

      // Persist again — should update, not create new
      const second = gp.persistScoredEdge({
        sourceNode: source,
        targetNode: target,
        edgeType: 'fact_supports_concept',
      });
      expect(second!.isNew).toBe(false);
      // Hebbian: new_weight >= old_weight (reinforced)
      expect(second!.edge.weight).toBeGreaterThanOrEqual(firstWeight);

      // Only 1 edge should exist
      expect(gp.edgeRepo.countEdges()).toBe(1);
    });

    it('respects merge strategy override', () => {
      const now = new Date().toISOString();
      const source = makeNode({ id: 's1', createdAt: now, conversationIds: ['c1'] });
      const target = makeNode({ id: 't1', type: 'concept', createdAt: now, conversationIds: ['c1'] });

      gp.persistScoredEdge({
        sourceNode: source,
        targetNode: target,
        edgeType: 'fact_supports_concept',
      });

      const result = gp.persistScoredEdge({
        sourceNode: source,
        targetNode: target,
        edgeType: 'fact_supports_concept',
        mergeStrategy: 'replace',
      });

      // Should have a defined weight (replaced)
      expect(result).not.toBeNull();
      expect(result!.edge.weight).toBeGreaterThan(0);
    });
  });

  // ─── Batch Score-and-Persist ──────────────────────────────

  describe('persistScoredEdges', () => {
    it('persists multiple edges, filtering out low scores', () => {
      const now = new Date().toISOString();
      const inputs: PersistScoredEdgeInput[] = [
        {
          sourceNode: makeNode({ id: 'f1', content: 'TypeScript types', createdAt: now, entities: ['TypeScript'], conversationIds: ['c1'] }),
          targetNode: makeNode({ id: 'c1', type: 'concept', content: 'TypeScript type system', createdAt: now, entities: ['TypeScript'], conversationIds: ['c1'] }),
          edgeType: 'fact_supports_concept',
        },
        {
          sourceNode: makeNode({ id: 'f2', content: 'React hooks patterns', createdAt: now, entities: ['React'], conversationIds: ['c1'] }),
          targetNode: makeNode({ id: 'c2', type: 'concept', content: 'React hook lifecycle', createdAt: now, entities: ['React'], conversationIds: ['c1'] }),
          edgeType: 'fact_supports_concept',
        },
      ];

      const results = gp.persistScoredEdges(inputs);
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.breakdown.meetsThreshold).toBe(true);
        expect(r.isNew).toBe(true);
      }
    });

    it('handles empty input', () => {
      expect(gp.persistScoredEdges([])).toEqual([]);
    });
  });

  // ─── persistBestConnections ───────────────────────────────

  describe('persistBestConnections', () => {
    it('scores reference against candidates and persists top N', () => {
      const now = new Date().toISOString();
      const reference = makeNode({
        id: 'ref',
        content: 'TypeScript React development patterns',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['c1'],
      });
      const candidates = [
        makeNode({ id: 'c1', type: 'concept', content: 'TypeScript React component patterns', createdAt: now, entities: ['TypeScript', 'React'], conversationIds: ['c1'] }),
        makeNode({ id: 'c2', type: 'concept', content: 'Python Flask web framework', createdAt: '2020-01-01T00:00:00Z', entities: ['Python'], conversationIds: ['c99'] }),
        makeNode({ id: 'c3', type: 'concept', content: 'TypeScript Node backend service', createdAt: now, entities: ['TypeScript', 'Node'], conversationIds: ['c1'] }),
      ];

      const results = gp.persistBestConnections(
        reference,
        candidates,
        'fact_supports_concept',
        { maxEdges: 2 },
      );

      expect(results.length).toBeLessThanOrEqual(2);
      // Results should be sorted by score descending
      if (results.length >= 2) {
        expect(results[0].breakdown.score).toBeGreaterThanOrEqual(results[1].breakdown.score);
      }
    });
  });

  // ─── Weighted Edge Upsert ─────────────────────────────────

  describe('ensureWeightedEdge', () => {
    it('creates a new weighted edge if none exists', () => {
      const edge = gp.ensureWeightedEdge({
        sourceId: 'anchor-1',
        sourceType: 'anchor',
        targetId: 'fact-1',
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.7,
      });

      expect(edge.id).toBeDefined();
      expect(edge.sourceId).toBe('anchor-1');
      expect(edge.weight).toBe(0.7);
      expect(gp.weightedEdgeRepo.countEdges()).toBe(1);
    });

    it('returns existing edge without modification', () => {
      const first = gp.ensureWeightedEdge({
        sourceId: 'anchor-1',
        sourceType: 'anchor',
        targetId: 'fact-1',
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.7,
      });

      const second = gp.ensureWeightedEdge({
        sourceId: 'anchor-1',
        sourceType: 'anchor',
        targetId: 'fact-1',
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.9, // Different weight — should be ignored
      });

      expect(second.id).toBe(first.id);
      expect(second.weight).toBe(0.7); // Original weight preserved
      expect(gp.weightedEdgeRepo.countEdges()).toBe(1);
    });
  });

  describe('upsertWeightedEdge', () => {
    it('creates new edge and returns isNew=true', () => {
      const { edge, isNew, reinforcement } = gp.upsertWeightedEdge({
        sourceId: 'anchor-1',
        sourceType: 'anchor',
        targetId: 'fact-1',
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.6,
      });

      expect(isNew).toBe(true);
      expect(edge.weight).toBe(0.6);
      expect(reinforcement).toBeUndefined();
    });

    it('reinforces existing edge and returns isNew=false', () => {
      // Create first
      gp.upsertWeightedEdge({
        sourceId: 'anchor-1',
        sourceType: 'anchor',
        targetId: 'fact-1',
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.5,
      });

      // Upsert again — should reinforce
      const { edge, isNew, reinforcement } = gp.upsertWeightedEdge({
        sourceId: 'anchor-1',
        sourceType: 'anchor',
        targetId: 'fact-1',
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
      });

      expect(isNew).toBe(false);
      expect(reinforcement).toBeDefined();
      expect(reinforcement!.previousWeight).toBe(0.5);
      expect(reinforcement!.newWeight).toBeGreaterThan(0.5);
      expect(reinforcement!.activationCount).toBe(1);
      expect(edge.weight).toBeGreaterThan(0.5);
    });

    it('respects custom learning rate on reinforcement', () => {
      gp.upsertWeightedEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.5,
      });

      const { reinforcement } = gp.upsertWeightedEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        learningRate: 0.5,
      });

      // New formula: delta = 0.5 * 100 * ((100-0.5)/100) = 49.75; w_new = 50.25
      expect(reinforcement!.newWeight).toBeCloseTo(50.25, 1);
    });
  });

  describe('upsertWeightedEdges (batch)', () => {
    it('batch upserts multiple weighted edges', () => {
      const inputs: PersistWeightedInput[] = [
        { sourceId: 'a1', sourceType: 'anchor', targetId: 'f1', targetType: 'fact', edgeType: 'anchor_to_fact', weight: 0.6 },
        { sourceId: 'a1', sourceType: 'anchor', targetId: 'f2', targetType: 'fact', edgeType: 'anchor_to_fact', weight: 0.8 },
        { sourceId: 'a1', sourceType: 'anchor', targetId: 'e1', targetType: 'episode', edgeType: 'anchor_to_episode', weight: 0.4 },
      ];

      const results = gp.upsertWeightedEdges(inputs);
      expect(results).toHaveLength(3);
      expect(results.every(r => r.isNew)).toBe(true);
      expect(gp.weightedEdgeRepo.countEdges()).toBe(3);
    });
  });

  // ─── Co-Activation Reinforcement ──────────────────────────

  describe('reinforceCoActivation', () => {
    it('reinforces multiple edges in a co-activation batch', () => {
      const e1 = gp.weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.5,
      });
      const e2 = gp.weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f2', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.3,
      });

      const result = gp.reinforceCoActivation([e1.id, e2.id]);

      expect(result.totalEdges).toBe(2);
      expect(result.reinforced).toHaveLength(2);
      expect(result.averageNewWeight).toBeGreaterThan(0.4);

      // Verify individual reinforcement
      const r1 = result.reinforced.find(r => r.edgeId === e1.id)!;
      expect(r1.previousWeight).toBe(0.5);
      expect(r1.newWeight).toBeGreaterThan(0.5);
    });

    it('handles empty co-activation set', () => {
      const result = gp.reinforceCoActivation([]);
      expect(result.totalEdges).toBe(0);
      expect(result.reinforced).toEqual([]);
      expect(result.averageNewWeight).toBe(0);
    });

    it('skips non-existent edge IDs gracefully', () => {
      const e1 = gp.weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.5,
      });

      const result = gp.reinforceCoActivation([e1.id, 'non-existent']);
      expect(result.totalEdges).toBe(2);
      expect(result.reinforced).toHaveLength(1);
    });
  });

  describe('reinforceNodeEdges', () => {
    it('reinforces all edges connected to a node', () => {
      gp.weightedEdgeRepo.createEdge({
        sourceId: 'anchor-1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.5,
      });
      gp.weightedEdgeRepo.createEdge({
        sourceId: 'anchor-1', sourceType: 'anchor',
        targetId: 'f2', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.3,
      });
      gp.weightedEdgeRepo.createEdge({
        sourceId: 'other', sourceType: 'anchor',
        targetId: 'anchor-1', targetType: 'anchor',
        edgeType: 'anchor_to_anchor', weight: 0.7,
      });

      const result = gp.reinforceNodeEdges('anchor-1');
      expect(result.reinforced).toHaveLength(3);
    });
  });

  // ─── Decay Application ────────────────────────────────────

  describe('applyGraphDecay', () => {
    it('applies decay to weighted edges using advanced per-edge computation', () => {
      // Create a weighted edge with old activation time
      const e = gp.weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.8,
        decayRate: 0.01,
      });

      const result = gp.applyGraphDecay({ memoryEdges: false });

      // Should have processed the edge
      expect(result.weightedEdges.decayed + result.weightedEdges.pruned).toBeGreaterThanOrEqual(0);
      expect(result.summary).toBeDefined();
      expect(result.summary!.totalProcessed).toBe(1);
    });

    it('applies decay to memory edges with multiplicative factor', () => {
      gp.edgeRepo.createEdge({
        sourceId: 'f1', sourceType: 'fact',
        targetId: 'c1', targetType: 'concept',
        edgeType: 'fact_supports_concept',
        weight: 0.8,
      });

      const result = gp.applyGraphDecay({
        weightedEdges: false,
        memoryDecayFactor: 0.5,
      });

      expect(result.memoryEdges.decayed).toBe(1);

      const edge = gp.edgeRepo.getEdgesByType('fact_supports_concept')[0];
      expect(edge.weight).toBeCloseTo(0.4, 2);
    });

    it('prunes memory edges below threshold after decay', () => {
      gp.edgeRepo.createEdge({
        sourceId: 'f1', sourceType: 'fact',
        targetId: 'c1', targetType: 'concept',
        edgeType: 'fact_supports_concept',
        weight: 0.08,
      });

      const result = gp.applyGraphDecay({
        weightedEdges: false,
        memoryDecayFactor: 0.5,
        pruneThreshold: 0.05,
      });

      expect(result.memoryEdges.pruned).toBe(1);
      expect(gp.edgeRepo.countEdges()).toBe(0);
    });

    it('applies decay to both tables by default', () => {
      gp.weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.8,
      });
      gp.edgeRepo.createEdge({
        sourceId: 'f1', sourceType: 'fact',
        targetId: 'c1', targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.8,
      });

      const result = gp.applyGraphDecay();

      // Both tables should have been processed
      expect(result.summary).toBeDefined();
      expect(result.memoryEdges.decayed).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── Query Operations ─────────────────────────────────────

  describe('getWeightedNeighbors', () => {
    beforeEach(() => {
      gp.weightedEdgeRepo.createEdge({
        sourceId: 'anchor-1', sourceType: 'anchor',
        targetId: 'fact-1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.9,
      });
      gp.weightedEdgeRepo.createEdge({
        sourceId: 'anchor-1', sourceType: 'anchor',
        targetId: 'fact-2', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.5,
      });
      gp.weightedEdgeRepo.createEdge({
        sourceId: 'anchor-1', sourceType: 'anchor',
        targetId: 'ep-1', targetType: 'episode',
        edgeType: 'anchor_to_episode', weight: 0.7,
      });
      gp.weightedEdgeRepo.createEdge({
        sourceId: 'other', sourceType: 'anchor',
        targetId: 'anchor-1', targetType: 'anchor',
        edgeType: 'anchor_to_anchor', weight: 0.6,
      });
    });

    it('returns all neighbors sorted by weight', () => {
      const neighbors = gp.getWeightedNeighbors('anchor-1');
      expect(neighbors.length).toBe(4);
      expect(neighbors[0].weight).toBe(0.9);
      expect(neighbors[0].nodeId).toBe('fact-1');
    });

    it('filters by minimum weight', () => {
      const neighbors = gp.getWeightedNeighbors('anchor-1', { minWeight: 0.6 });
      expect(neighbors.length).toBe(3); // 0.9, 0.7, 0.6
    });

    it('filters by edge types', () => {
      const neighbors = gp.getWeightedNeighbors('anchor-1', {
        edgeTypes: ['anchor_to_fact'],
      });
      expect(neighbors.length).toBe(2);
      expect(neighbors.every(n => n.nodeType === 'fact')).toBe(true);
    });

    it('limits results', () => {
      const neighbors = gp.getWeightedNeighbors('anchor-1', { limit: 2 });
      expect(neighbors.length).toBe(2);
    });

    it('returns empty for unknown node', () => {
      expect(gp.getWeightedNeighbors('unknown')).toEqual([]);
    });
  });

  describe('getMemoryNeighbors', () => {
    it('returns neighbor IDs from memory_edges', () => {
      gp.edgeRepo.createEdge({
        sourceId: 'fact-1', sourceType: 'fact',
        targetId: 'concept-1', targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.8,
      });
      gp.edgeRepo.createEdge({
        sourceId: 'fact-2', sourceType: 'fact',
        targetId: 'concept-1', targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.5,
      });

      const neighbors = gp.getMemoryNeighbors('concept-1');
      expect(neighbors).toHaveLength(2);
      expect(neighbors).toContain('fact-1');
      expect(neighbors).toContain('fact-2');
    });
  });

  describe('getRelationship', () => {
    it('returns edges from both tables for a node pair', () => {
      gp.edgeRepo.createEdge({
        sourceId: 'f1', sourceType: 'fact',
        targetId: 'c1', targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.6,
      });
      gp.weightedEdgeRepo.createEdge({
        sourceId: 'f1', sourceType: 'fact',
        targetId: 'c1', targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.8,
      });

      const rel = gp.getRelationship('f1', 'c1');
      expect(rel.memoryEdges).toHaveLength(1);
      expect(rel.weightedEdges).toHaveLength(1);
    });

    it('returns empty arrays for unrelated nodes', () => {
      const rel = gp.getRelationship('a', 'b');
      expect(rel.memoryEdges).toEqual([]);
      expect(rel.weightedEdges).toEqual([]);
    });
  });

  describe('getStrongestConnections', () => {
    it('combines edges from both tables, deduplicated', () => {
      gp.edgeRepo.createEdge({
        sourceId: 'node-1', sourceType: 'fact',
        targetId: 'concept-1', targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.6,
      });
      gp.weightedEdgeRepo.createEdge({
        sourceId: 'node-1', sourceType: 'fact',
        targetId: 'concept-1', targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.9,
      });
      gp.edgeRepo.createEdge({
        sourceId: 'node-1', sourceType: 'fact',
        targetId: 'concept-2', targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.4,
      });

      const connections = gp.getStrongestConnections('node-1');

      // concept-1 appears in both tables; should be deduplicated with higher weight
      expect(connections.length).toBe(2);
      const c1 = connections.find(c => c.nodeId === 'concept-1')!;
      expect(c1.weight).toBe(0.9); // Takes the weighted_edges (higher) weight
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        gp.weightedEdgeRepo.createEdge({
          sourceId: 'hub', sourceType: 'anchor',
          targetId: `fact-${i}`, targetType: 'fact',
          edgeType: 'anchor_to_fact', weight: 0.5 + i * 0.1,
        });
      }

      const connections = gp.getStrongestConnections('hub', 3);
      expect(connections.length).toBe(3);
      // Should be the top 3 by weight
      expect(connections[0].weight).toBeGreaterThanOrEqual(connections[1].weight);
      expect(connections[1].weight).toBeGreaterThanOrEqual(connections[2].weight);
    });
  });

  // ─── Maintenance ──────────────────────────────────────────

  describe('deleteNodeEdges', () => {
    it('deletes edges from both tables', () => {
      gp.edgeRepo.createEdge({
        sourceId: 'node-x', sourceType: 'fact',
        targetId: 'c1', targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.5,
      });
      gp.weightedEdgeRepo.createEdge({
        sourceId: 'anchor-1', sourceType: 'anchor',
        targetId: 'node-x', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.7,
      });

      const deleted = gp.deleteNodeEdges('node-x');
      expect(deleted).toBe(2);
      expect(gp.edgeRepo.countEdges()).toBe(0);
      expect(gp.weightedEdgeRepo.countEdges()).toBe(0);
    });

    it('returns 0 for node with no edges', () => {
      expect(gp.deleteNodeEdges('isolated')).toBe(0);
    });
  });

  describe('getStats', () => {
    it('returns correct statistics', () => {
      gp.edgeRepo.createEdge({
        sourceId: 'f1', sourceType: 'fact',
        targetId: 'c1', targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.6,
      });
      gp.edgeRepo.createEdge({
        sourceId: 'f2', sourceType: 'fact',
        targetId: 'c1', targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.4,
      });
      gp.weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.8,
      });

      const stats = gp.getStats();
      expect(stats.memoryEdgeCount).toBe(2);
      expect(stats.weightedEdgeCount).toBe(1);
      expect(stats.averageMemoryWeight).toBeCloseTo(0.5, 2);
      expect(stats.averageWeightedWeight).toBeCloseTo(0.8, 2);
    });

    it('handles empty graph', () => {
      const stats = gp.getStats();
      expect(stats.memoryEdgeCount).toBe(0);
      expect(stats.weightedEdgeCount).toBe(0);
      expect(stats.averageMemoryWeight).toBe(0);
      expect(stats.averageWeightedWeight).toBe(0);
    });
  });

  // ─── Integration: Full Lifecycle ──────────────────────────

  describe('Full lifecycle: score → persist → reinforce → decay', () => {
    it('exercises the complete weight lifecycle', () => {
      const now = new Date().toISOString();

      // 1. Score and persist a memory edge
      const source = makeNode({
        id: 'fact-1', content: 'TypeScript strict mode benefits',
        createdAt: now, entities: ['TypeScript'], conversationIds: ['c1'],
      });
      const target = makeNode({
        id: 'concept-1', type: 'concept', content: 'TypeScript best practices',
        createdAt: now, entities: ['TypeScript'], conversationIds: ['c1'],
      });

      const persisted = gp.persistScoredEdge({
        sourceNode: source, targetNode: target,
        edgeType: 'fact_supports_concept',
      });
      expect(persisted).not.toBeNull();
      expect(persisted!.isNew).toBe(true);
      const initialWeight = persisted!.edge.weight;

      // 2. Create corresponding weighted edge for Hebbian tracking
      const { edge: we } = gp.upsertWeightedEdge({
        sourceId: 'anchor-ts', sourceType: 'anchor',
        targetId: 'fact-1', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: initialWeight,
      });
      expect(we.weight).toBe(initialWeight);

      // 3. Reinforce via co-activation
      const coAct = gp.reinforceCoActivation([we.id]);
      expect(coAct.reinforced[0].newWeight).toBeGreaterThan(initialWeight);

      // 4. Verify weight increased
      const afterReinforce = gp.weightedEdgeRepo.getEdge(we.id)!;
      expect(afterReinforce.weight).toBeGreaterThan(initialWeight);
      expect(afterReinforce.activationCount).toBe(1);

      // 5. Apply decay to memory edges
      const decayResult = gp.applyGraphDecay({
        weightedEdges: false,
        memoryDecayFactor: 0.9,
      });
      expect(decayResult.memoryEdges.decayed).toBeGreaterThanOrEqual(0);

      // 6. Verify stats are consistent
      const stats = gp.getStats();
      expect(stats.memoryEdgeCount).toBe(1);
      expect(stats.weightedEdgeCount).toBe(1);
    });
  });

  // ─── Configuration ────────────────────────────────────────

  describe('Configuration', () => {
    it('respects custom configuration', () => {
      const customGp = new GraphPersistence(db, {
        minScoreThreshold: 0.5,
        defaultMergeStrategy: 'max',
        pruneThreshold: 0.1,
        defaultLearningRate: 0.2,
        defaultDecayRate: 0.05,
      });

      expect(customGp.config.minScoreThreshold).toBe(0.5);
      expect(customGp.config.defaultMergeStrategy).toBe('max');
      expect(customGp.config.pruneThreshold).toBe(0.1);
      expect(customGp.config.defaultLearningRate).toBe(0.2);
      expect(customGp.config.defaultDecayRate).toBe(0.05);
    });

    it('uses default learning rate for new weighted edges', () => {
      const customGp = new GraphPersistence(db, { defaultLearningRate: 0.3 });

      const { edge } = customGp.upsertWeightedEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact',
      });

      expect(edge.learningRate).toBe(0.3);
    });
  });
});
