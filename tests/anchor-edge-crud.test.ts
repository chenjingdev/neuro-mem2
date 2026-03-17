/**
 * Tests for Anchor Edge CRUD Operations.
 *
 * Sub-AC 4.3: Anchor가 계산된 가중치로 그래프 저장소에
 * 엣지를 생성·갱신·삭제하는 CRUD 오퍼레이션
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { EdgeRepository } from '../src/db/edge-repo.js';
import type { CreateEdgeInput } from '../src/models/memory-edge.js';
import type {
  UpsertEdgeInput,
  WeightMergeStrategy,
  DecayOptions,
  BulkWeightUpdate,
  EdgeQueryFilter,
} from '../src/models/anchor.js';

describe('Anchor Edge CRUD Operations', () => {
  let db: Database.Database;
  let edgeRepo: EdgeRepository;

  // Helpers to create test data
  const factId1 = 'fact-aaa-111';
  const factId2 = 'fact-bbb-222';
  const conceptId1 = 'concept-aaa-111';
  const conceptId2 = 'concept-bbb-222';
  const episodeId1 = 'episode-aaa-111';

  function makeEdge(overrides: Partial<CreateEdgeInput> = {}): CreateEdgeInput {
    return {
      sourceId: factId1,
      sourceType: 'fact',
      targetId: conceptId1,
      targetType: 'concept',
      edgeType: 'fact_supports_concept',
      weight: 0.5,
      ...overrides,
    };
  }

  function makeUpsert(overrides: Partial<UpsertEdgeInput> = {}): UpsertEdgeInput {
    return {
      sourceId: factId1,
      sourceType: 'fact',
      targetId: conceptId1,
      targetType: 'concept',
      edgeType: 'fact_supports_concept',
      weight: 0.5,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    edgeRepo = new EdgeRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ─── findEdgeByEndpoints ─────────────────────────────────────────

  describe('findEdgeByEndpoints', () => {
    it('returns null when no matching edge exists', () => {
      const result = edgeRepo.findEdgeByEndpoints({
        sourceId: factId1,
        targetId: conceptId1,
        edgeType: 'fact_supports_concept',
      });
      expect(result).toBeNull();
    });

    it('finds an edge by its source, target, and type', () => {
      const created = edgeRepo.createEdge(makeEdge());

      const found = edgeRepo.findEdgeByEndpoints({
        sourceId: factId1,
        targetId: conceptId1,
        edgeType: 'fact_supports_concept',
      });

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.weight).toBe(0.5);
    });

    it('distinguishes edges with different types between same endpoints', () => {
      edgeRepo.createEdge(makeEdge({ edgeType: 'fact_supports_concept', weight: 0.3 }));
      edgeRepo.createEdge(makeEdge({ edgeType: 'derived_from', weight: 0.7 }));

      const fact = edgeRepo.findEdgeByEndpoints({
        sourceId: factId1,
        targetId: conceptId1,
        edgeType: 'fact_supports_concept',
      });
      const derived = edgeRepo.findEdgeByEndpoints({
        sourceId: factId1,
        targetId: conceptId1,
        edgeType: 'derived_from',
      });

      expect(fact!.weight).toBe(0.3);
      expect(derived!.weight).toBe(0.7);
    });
  });

  // ─── upsertEdge ──────────────────────────────────────────────────

  describe('upsertEdge', () => {
    it('creates a new edge when none exists', () => {
      const edge = edgeRepo.upsertEdge(makeUpsert({ weight: 0.6 }));

      expect(edge.weight).toBe(0.6);
      expect(edge.sourceId).toBe(factId1);
      expect(edge.targetId).toBe(conceptId1);
      expect(edgeRepo.countEdges()).toBe(1);
    });

    it('updates existing edge with hebbian strategy (default)', () => {
      // Create initial edge with weight 0.5
      edgeRepo.createEdge(makeEdge({ weight: 0.5 }));

      // Upsert with delta 0.3 — hebbian: 0.5 + 0.3 * (1 - 0.5) = 0.65
      const updated = edgeRepo.upsertEdge(makeUpsert({ weight: 0.3 }));

      expect(updated.weight).toBeCloseTo(0.65, 5);
      expect(edgeRepo.countEdges()).toBe(1); // No duplicate created
    });

    it('updates existing edge with replace strategy', () => {
      edgeRepo.createEdge(makeEdge({ weight: 0.5 }));

      const updated = edgeRepo.upsertEdge(makeUpsert({ weight: 0.8 }), 'replace');

      expect(updated.weight).toBe(0.8);
    });

    it('updates existing edge with max strategy', () => {
      edgeRepo.createEdge(makeEdge({ weight: 0.7 }));

      // New weight 0.3 < existing 0.7, so keep 0.7
      const kept = edgeRepo.upsertEdge(makeUpsert({ weight: 0.3 }), 'max');
      expect(kept.weight).toBe(0.7);

      // New weight 0.9 > existing 0.7, so use 0.9
      const raised = edgeRepo.upsertEdge(makeUpsert({ weight: 0.9 }), 'max');
      expect(raised.weight).toBe(0.9);
    });

    it('updates existing edge with average strategy', () => {
      edgeRepo.createEdge(makeEdge({ weight: 0.4 }));

      const updated = edgeRepo.upsertEdge(makeUpsert({ weight: 0.8 }), 'average');

      expect(updated.weight).toBeCloseTo(0.6, 5);
    });

    it('clamps weight to [0, 1] on create', () => {
      const edge = edgeRepo.upsertEdge(makeUpsert({ weight: 1.5 }));
      expect(edge.weight).toBe(1.0);
    });

    it('clamps weight to [0, 1] on update', () => {
      edgeRepo.createEdge(makeEdge({ weight: 0.9 }));

      // Hebbian: 0.9 + 0.5 * (1 - 0.9) = 0.95, still within [0,1]
      const updated = edgeRepo.upsertEdge(makeUpsert({ weight: 0.5 }));
      expect(updated.weight).toBeLessThanOrEqual(1.0);
      expect(updated.weight).toBeGreaterThanOrEqual(0.0);
    });

    it('merges metadata on update', () => {
      edgeRepo.createEdge(makeEdge({ metadata: { source: 'batch' } }));

      const updated = edgeRepo.upsertEdge(
        makeUpsert({ weight: 0.1, metadata: { coActivation: true } })
      );

      expect(updated.metadata).toEqual({ source: 'batch', coActivation: true });
    });
  });

  // ─── upsertEdges (batch) ─────────────────────────────────────────

  describe('upsertEdges', () => {
    it('handles empty input', () => {
      const results = edgeRepo.upsertEdges([]);
      expect(results).toEqual([]);
    });

    it('batch upserts multiple edges transactionally', () => {
      const inputs: UpsertEdgeInput[] = [
        makeUpsert({ sourceId: factId1, targetId: conceptId1, weight: 0.5 }),
        makeUpsert({ sourceId: factId2, targetId: conceptId2, weight: 0.7 }),
        makeUpsert({ sourceId: episodeId1, sourceType: 'episode', targetId: conceptId1, edgeType: 'episode_mentions_concept', weight: 0.6 }),
      ];

      const results = edgeRepo.upsertEdges(inputs);

      expect(results).toHaveLength(3);
      expect(edgeRepo.countEdges()).toBe(3);
    });

    it('mixes creates and updates in a batch', () => {
      // Pre-create one edge
      edgeRepo.createEdge(makeEdge({ sourceId: factId1, targetId: conceptId1, weight: 0.3 }));

      const inputs: UpsertEdgeInput[] = [
        makeUpsert({ sourceId: factId1, targetId: conceptId1, weight: 0.2 }), // Update (hebbian)
        makeUpsert({ sourceId: factId2, targetId: conceptId2, weight: 0.8 }), // Create new
      ];

      const results = edgeRepo.upsertEdges(inputs, 'hebbian');

      expect(results).toHaveLength(2);
      expect(edgeRepo.countEdges()).toBe(2);

      // First should be hebbian update: 0.3 + 0.2 * (1 - 0.3) = 0.44
      expect(results[0].weight).toBeCloseTo(0.44, 5);
      // Second should be new with weight 0.8
      expect(results[1].weight).toBe(0.8);
    });
  });

  // ─── deleteEdge ──────────────────────────────────────────────────

  describe('deleteEdge', () => {
    it('returns false for non-existent edge', () => {
      expect(edgeRepo.deleteEdge('nonexistent-id')).toBe(false);
    });

    it('deletes an edge by ID and returns true', () => {
      const edge = edgeRepo.createEdge(makeEdge());

      expect(edgeRepo.deleteEdge(edge.id)).toBe(true);
      expect(edgeRepo.getEdge(edge.id)).toBeNull();
      expect(edgeRepo.countEdges()).toBe(0);
    });
  });

  // ─── deleteEdgeByEndpoints ───────────────────────────────────────

  describe('deleteEdgeByEndpoints', () => {
    it('returns false when no matching edge exists', () => {
      expect(edgeRepo.deleteEdgeByEndpoints({
        sourceId: factId1,
        targetId: conceptId1,
        edgeType: 'fact_supports_concept',
      })).toBe(false);
    });

    it('deletes by source+target+type combination', () => {
      edgeRepo.createEdge(makeEdge());

      const deleted = edgeRepo.deleteEdgeByEndpoints({
        sourceId: factId1,
        targetId: conceptId1,
        edgeType: 'fact_supports_concept',
      });

      expect(deleted).toBe(true);
      expect(edgeRepo.countEdges()).toBe(0);
    });
  });

  // ─── deleteEdgesByNode ───────────────────────────────────────────

  describe('deleteEdgesByNode', () => {
    it('returns 0 when node has no edges', () => {
      expect(edgeRepo.deleteEdgesByNode('nonexistent')).toBe(0);
    });

    it('deletes all edges connected to a node (both directions)', () => {
      // conceptId1 is target of 2 edges and source of 1
      edgeRepo.createEdge(makeEdge({ sourceId: factId1, targetId: conceptId1 }));
      edgeRepo.createEdge(makeEdge({ sourceId: factId2, targetId: conceptId1 }));
      edgeRepo.createEdge(makeEdge({
        sourceId: conceptId1, sourceType: 'concept',
        targetId: conceptId2, targetType: 'concept',
        edgeType: 'concept_related_to',
      }));
      // Unrelated edge
      edgeRepo.createEdge(makeEdge({
        sourceId: episodeId1, sourceType: 'episode',
        targetId: conceptId2, targetType: 'concept',
        edgeType: 'episode_mentions_concept',
      }));

      const deleted = edgeRepo.deleteEdgesByNode(conceptId1);

      expect(deleted).toBe(3);
      expect(edgeRepo.countEdges()).toBe(1); // Only unrelated edge remains
    });
  });

  // ─── pruneEdgesBelowWeight ───────────────────────────────────────

  describe('pruneEdgesBelowWeight', () => {
    it('prunes edges below a weight threshold', () => {
      edgeRepo.createEdge(makeEdge({ sourceId: factId1, weight: 0.1 }));
      edgeRepo.createEdge(makeEdge({ sourceId: factId2, weight: 0.3 }));
      edgeRepo.createEdge(makeEdge({
        sourceId: episodeId1, sourceType: 'episode',
        edgeType: 'episode_mentions_concept',
        weight: 0.8,
      }));

      const pruned = edgeRepo.pruneEdgesBelowWeight(0.25);

      expect(pruned).toBe(1); // Only the 0.1 edge
      expect(edgeRepo.countEdges()).toBe(2);
    });

    it('prunes only specified edge types', () => {
      edgeRepo.createEdge(makeEdge({ sourceId: factId1, weight: 0.1, edgeType: 'fact_supports_concept' }));
      edgeRepo.createEdge(makeEdge({
        sourceId: episodeId1, sourceType: 'episode',
        edgeType: 'episode_mentions_concept',
        weight: 0.1,
      }));

      const pruned = edgeRepo.pruneEdgesBelowWeight(0.2, ['fact_supports_concept']);

      expect(pruned).toBe(1); // Only the fact_supports_concept edge
      expect(edgeRepo.countEdges()).toBe(1); // episode_mentions_concept survives
    });

    it('returns 0 when nothing to prune', () => {
      edgeRepo.createEdge(makeEdge({ weight: 0.8 }));
      expect(edgeRepo.pruneEdgesBelowWeight(0.5)).toBe(0);
    });
  });

  // ─── decayWeights ────────────────────────────────────────────────

  describe('decayWeights', () => {
    it('decays all edges by a factor', () => {
      edgeRepo.createEdge(makeEdge({ sourceId: factId1, weight: 0.8 }));
      edgeRepo.createEdge(makeEdge({ sourceId: factId2, weight: 0.6 }));

      const result = edgeRepo.decayWeights({ factor: 0.9 });

      expect(result.decayedCount).toBe(2);
      expect(result.prunedCount).toBe(0);

      const edges = edgeRepo.getEdgesByType('fact_supports_concept');
      const weights = edges.map(e => e.weight).sort();
      expect(weights[0]).toBeCloseTo(0.54, 2); // 0.6 * 0.9
      expect(weights[1]).toBeCloseTo(0.72, 2); // 0.8 * 0.9
    });

    it('decays only edges of specified types', () => {
      edgeRepo.createEdge(makeEdge({ sourceId: factId1, weight: 0.8, edgeType: 'fact_supports_concept' }));
      edgeRepo.createEdge(makeEdge({
        sourceId: episodeId1, sourceType: 'episode',
        edgeType: 'episode_mentions_concept',
        weight: 0.8,
      }));

      edgeRepo.decayWeights({ factor: 0.5, edgeTypes: ['fact_supports_concept'] });

      const factEdges = edgeRepo.getEdgesByType('fact_supports_concept');
      const epEdges = edgeRepo.getEdgesByType('episode_mentions_concept');

      expect(factEdges[0].weight).toBeCloseTo(0.4, 2); // Decayed
      expect(epEdges[0].weight).toBe(0.8); // Unchanged
    });

    it('prunes edges after decay when pruneBelow is set', () => {
      edgeRepo.createEdge(makeEdge({ sourceId: factId1, weight: 0.2 }));
      edgeRepo.createEdge(makeEdge({ sourceId: factId2, weight: 0.8 }));

      const result = edgeRepo.decayWeights({ factor: 0.5, pruneBelow: 0.15 });

      expect(result.decayedCount).toBe(2);
      expect(result.prunedCount).toBe(1); // 0.2 * 0.5 = 0.1 < 0.15
      expect(edgeRepo.countEdges()).toBe(1);
    });

    it('respects maxWeight filter', () => {
      edgeRepo.createEdge(makeEdge({ sourceId: factId1, weight: 0.3 }));
      edgeRepo.createEdge(makeEdge({ sourceId: factId2, weight: 0.9 }));

      edgeRepo.decayWeights({ factor: 0.5, maxWeight: 0.5 });

      const edges = edgeRepo.getEdgesByType('fact_supports_concept');
      const bySource = Object.fromEntries(edges.map(e => [e.sourceId, e.weight]));

      expect(bySource[factId1]).toBeCloseTo(0.15, 2); // Decayed
      expect(bySource[factId2]).toBe(0.9); // Unchanged (above maxWeight)
    });
  });

  // ─── bulkUpdateWeights ───────────────────────────────────────────

  describe('bulkUpdateWeights', () => {
    it('handles empty input', () => {
      expect(edgeRepo.bulkUpdateWeights([])).toBe(0);
    });

    it('updates multiple edge weights in a single transaction', () => {
      const e1 = edgeRepo.createEdge(makeEdge({ sourceId: factId1, weight: 0.3 }));
      const e2 = edgeRepo.createEdge(makeEdge({ sourceId: factId2, weight: 0.5 }));

      const updates: BulkWeightUpdate[] = [
        { edgeId: e1.id, newWeight: 0.7 },
        { edgeId: e2.id, newWeight: 0.9 },
      ];

      const count = edgeRepo.bulkUpdateWeights(updates);
      expect(count).toBe(2);

      expect(edgeRepo.getEdge(e1.id)!.weight).toBeCloseTo(0.7, 5);
      expect(edgeRepo.getEdge(e2.id)!.weight).toBeCloseTo(0.9, 5);
    });

    it('clamps weights to [0, 1]', () => {
      const e1 = edgeRepo.createEdge(makeEdge({ weight: 0.5 }));

      edgeRepo.bulkUpdateWeights([
        { edgeId: e1.id, newWeight: 1.5 },
      ]);

      expect(edgeRepo.getEdge(e1.id)!.weight).toBe(1.0);
    });

    it('skips non-existent edge IDs gracefully', () => {
      const e1 = edgeRepo.createEdge(makeEdge({ weight: 0.5 }));

      const count = edgeRepo.bulkUpdateWeights([
        { edgeId: e1.id, newWeight: 0.8 },
        { edgeId: 'nonexistent', newWeight: 0.9 },
      ]);

      expect(count).toBe(1); // Only 1 actually updated
    });
  });

  // ─── queryEdges ──────────────────────────────────────────────────

  describe('queryEdges', () => {
    beforeEach(() => {
      edgeRepo.createEdge(makeEdge({ sourceId: factId1, weight: 0.3 }));
      edgeRepo.createEdge(makeEdge({ sourceId: factId2, weight: 0.7 }));
      edgeRepo.createEdge(makeEdge({
        sourceId: episodeId1, sourceType: 'episode',
        edgeType: 'episode_mentions_concept',
        weight: 0.9,
      }));
    });

    it('returns all edges with empty filter', () => {
      const edges = edgeRepo.queryEdges({});
      expect(edges).toHaveLength(3);
    });

    it('filters by sourceType', () => {
      const edges = edgeRepo.queryEdges({ sourceType: 'fact' });
      expect(edges).toHaveLength(2);
    });

    it('filters by edgeTypes', () => {
      const edges = edgeRepo.queryEdges({ edgeTypes: ['episode_mentions_concept'] });
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(episodeId1);
    });

    it('filters by minWeight', () => {
      const edges = edgeRepo.queryEdges({ minWeight: 0.5 });
      expect(edges).toHaveLength(2);
    });

    it('filters by maxWeight', () => {
      const edges = edgeRepo.queryEdges({ maxWeight: 0.5 });
      expect(edges).toHaveLength(1);
    });

    it('respects limit', () => {
      const edges = edgeRepo.queryEdges({ limit: 2 });
      expect(edges).toHaveLength(2);
      // Ordered by weight DESC
      expect(edges[0].weight).toBe(0.9);
    });

    it('combines multiple filters', () => {
      const edges = edgeRepo.queryEdges({
        sourceType: 'fact',
        minWeight: 0.5,
        edgeTypes: ['fact_supports_concept'],
      });
      expect(edges).toHaveLength(1);
      expect(edges[0].weight).toBe(0.7);
    });
  });

  // ─── getNeighborIds ──────────────────────────────────────────────

  describe('getNeighborIds', () => {
    beforeEach(() => {
      // conceptId1 connects to factId1, factId2, episodeId1
      edgeRepo.createEdge(makeEdge({
        sourceId: factId1, sourceType: 'fact',
        targetId: conceptId1, targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.8,
      }));
      edgeRepo.createEdge(makeEdge({
        sourceId: factId2, sourceType: 'fact',
        targetId: conceptId1, targetType: 'concept',
        edgeType: 'fact_supports_concept', weight: 0.3,
      }));
      edgeRepo.createEdge(makeEdge({
        sourceId: conceptId1, sourceType: 'concept',
        targetId: episodeId1, targetType: 'episode',
        edgeType: 'derived_from', weight: 0.6,
      }));
    });

    it('returns all neighbor IDs sorted by weight', () => {
      const neighbors = edgeRepo.getNeighborIds(conceptId1);
      expect(neighbors).toHaveLength(3);
      // factId1 (0.8), episodeId1 (0.6), factId2 (0.3) — order by edge weight
      expect(neighbors[0]).toBe(factId1);
      expect(neighbors[1]).toBe(episodeId1);
      expect(neighbors[2]).toBe(factId2);
    });

    it('filters by edge type', () => {
      const neighbors = edgeRepo.getNeighborIds(conceptId1, {
        edgeTypes: ['fact_supports_concept'],
      });
      expect(neighbors).toHaveLength(2);
      expect(neighbors).toContain(factId1);
      expect(neighbors).toContain(factId2);
    });

    it('filters by minimum weight', () => {
      const neighbors = edgeRepo.getNeighborIds(conceptId1, { minWeight: 0.5 });
      expect(neighbors).toHaveLength(2); // factId1 (0.8) and episodeId1 (0.6)
    });

    it('returns empty array for isolated node', () => {
      expect(edgeRepo.getNeighborIds('isolated-node')).toEqual([]);
    });
  });

  // ─── updateMetadata ──────────────────────────────────────────────

  describe('updateMetadata', () => {
    it('updates metadata on an existing edge', () => {
      const edge = edgeRepo.createEdge(makeEdge({ metadata: { old: true } }));

      const updated = edgeRepo.updateMetadata(edge.id, { new: true, version: 2 });
      expect(updated).toBe(true);

      const fetched = edgeRepo.getEdge(edge.id)!;
      expect(fetched.metadata).toEqual({ new: true, version: 2 });
    });

    it('returns false for non-existent edge', () => {
      expect(edgeRepo.updateMetadata('nonexistent', { x: 1 })).toBe(false);
    });
  });

  // ─── Integration: Hebbian reinforcement cycle ────────────────────

  describe('Hebbian reinforcement lifecycle', () => {
    it('creates → reinforces → decays → prunes an edge', () => {
      // 1. Create via upsert
      const edge = edgeRepo.upsertEdge(makeUpsert({ weight: 0.4 }));
      expect(edge.weight).toBe(0.4);

      // 2. Reinforce via upsert (hebbian): 0.4 + 0.3 * (1 - 0.4) = 0.58
      const reinforced = edgeRepo.upsertEdge(makeUpsert({ weight: 0.3 }));
      expect(reinforced.weight).toBeCloseTo(0.58, 5);

      // 3. Reinforce again: 0.58 + 0.2 * (1 - 0.58) = 0.664
      const again = edgeRepo.upsertEdge(makeUpsert({ weight: 0.2 }));
      expect(again.weight).toBeCloseTo(0.664, 3);

      // 4. Apply decay: 0.664 * 0.5 ≈ 0.332
      edgeRepo.decayWeights({ factor: 0.5 });
      const decayed = edgeRepo.getEdge(again.id)!;
      expect(decayed.weight).toBeCloseTo(0.332, 2);

      // 5. Heavy decay: 0.332 * 0.2 ≈ 0.066
      edgeRepo.decayWeights({ factor: 0.2 });
      const heavyDecay = edgeRepo.getEdge(again.id)!;
      expect(heavyDecay.weight).toBeCloseTo(0.066, 2);

      // 6. Prune below 0.1 — edge should be removed
      const pruned = edgeRepo.pruneEdgesBelowWeight(0.1);
      expect(pruned).toBe(1);
      expect(edgeRepo.countEdges()).toBe(0);
    });

    it('reinforceEdge uses asymptotic approach to 1', () => {
      const edge = edgeRepo.createEdge(makeEdge({ weight: 0.5 }));

      // Reinforce multiple times — weight should approach 1 but never exceed
      let current = edge;
      for (let i = 0; i < 20; i++) {
        current = edgeRepo.reinforceEdge(current.id, 0.1)!;
      }

      expect(current.weight).toBeLessThanOrEqual(1.0);
      expect(current.weight).toBeGreaterThan(0.85);
    });
  });
});
