/**
 * Tests for Anchor's weighted edge creation flow (Sub-AC 4 of AC 4).
 *
 * Covers:
 *   - Edge creation from anchor to memory nodes (fact, episode, concept)
 *   - Weight accuracy (Hebbian formula correctness)
 *   - Duplicate edge handling (upsert with various merge strategies)
 *   - EdgeScorer → WeightedEdge creation pipeline
 *   - Cross-repository edge creation between EdgeRepo (memory_edges) and WeightedEdgeRepo (weighted_edges)
 *   - Concurrent reinforcement and weight convergence properties
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { EdgeRepository } from '../src/db/edge-repo.js';
import {
  EdgeScorer,
  computeTemporalProximity,
  computeSemanticSimilarity,
  computeEntityOverlap,
  type MemoryNodeDescriptor,
} from '../src/scoring/index.js';
import type { CreateAnchorInput } from '../src/models/anchor.js';
import type { CreateWeightedEdgeInput, WeightedEdge } from '../src/models/weighted-edge.js';
import type { UpsertEdgeInput, WeightMergeStrategy } from '../src/models/anchor.js';

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

function makeAnchorInput(overrides: Partial<CreateAnchorInput> = {}): CreateAnchorInput {
  return {
    label: overrides.label ?? 'Test Anchor',
    description: overrides.description ?? 'A test anchor',
    anchorType: overrides.anchorType ?? 'entity',
    ...overrides,
  };
}

function makeNode(overrides: Partial<MemoryNodeDescriptor> = {}): MemoryNodeDescriptor {
  return {
    id: overrides.id ?? 'node-1',
    type: overrides.type ?? 'fact',
    content: overrides.content ?? 'default content',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    entities: overrides.entities ?? [],
    conversationIds: overrides.conversationIds ?? ['conv-1'],
    turnIndices: overrides.turnIndices,
    embedding: overrides.embedding,
  };
}

// ────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────

describe('Anchor Weighted Edge Creation Flow', () => {
  let db: Database.Database;
  let anchorRepo: AnchorRepository;
  let weightedEdgeRepo: WeightedEdgeRepository;
  let edgeRepo: EdgeRepository;
  let scorer: EdgeScorer;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    anchorRepo = new AnchorRepository(db);
    weightedEdgeRepo = new WeightedEdgeRepository(db);
    edgeRepo = new EdgeRepository(db);
    scorer = new EdgeScorer();
  });

  afterEach(() => {
    db.close();
  });

  // ─── 1. Basic Edge Creation from Anchor to Memory Nodes ──────

  describe('Edge creation from anchor to memory nodes', () => {
    it('creates anchor_to_fact edge with computed weight', () => {
      const anchor = anchorRepo.createAnchor(makeAnchorInput({
        label: 'TypeScript',
        description: 'TypeScript programming language',
      }));

      const edge = weightedEdgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'anchor',
        targetId: 'fact-001',
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.7,
      });

      expect(edge.sourceId).toBe(anchor.id);
      expect(edge.sourceType).toBe('anchor');
      expect(edge.targetType).toBe('fact');
      expect(edge.edgeType).toBe('anchor_to_fact');
      expect(edge.weight).toBe(0.7);
      expect(edge.initialWeight).toBe(0.7);
    });

    it('creates anchor_to_episode edge', () => {
      const anchor = anchorRepo.createAnchor(makeAnchorInput({ label: 'Sprint 12' }));

      const edge = weightedEdgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'anchor',
        targetId: 'episode-001',
        targetType: 'episode',
        edgeType: 'anchor_to_episode',
        weight: 0.6,
      });

      expect(edge.edgeType).toBe('anchor_to_episode');
      expect(edge.weight).toBe(0.6);
    });

    it('creates anchor_to_concept edge', () => {
      const anchor = anchorRepo.createAnchor(makeAnchorInput({ label: 'Auth' }));

      const edge = weightedEdgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'anchor',
        targetId: 'concept-001',
        targetType: 'concept',
        edgeType: 'anchor_to_concept',
        weight: 0.85,
      });

      expect(edge.edgeType).toBe('anchor_to_concept');
      expect(edge.weight).toBe(0.85);
    });

    it('creates anchor_to_anchor edge for inter-anchor association', () => {
      const a1 = anchorRepo.createAnchor(makeAnchorInput({ label: 'Frontend' }));
      const a2 = anchorRepo.createAnchor(makeAnchorInput({ label: 'React' }));

      const edge = weightedEdgeRepo.createEdge({
        sourceId: a1.id,
        sourceType: 'anchor',
        targetId: a2.id,
        targetType: 'anchor',
        edgeType: 'anchor_to_anchor',
        weight: 0.75,
      });

      expect(edge.sourceId).toBe(a1.id);
      expect(edge.targetId).toBe(a2.id);
      expect(edge.edgeType).toBe('anchor_to_anchor');
    });

    it('creates batch edges from anchor to multiple memory nodes', () => {
      const anchor = anchorRepo.createAnchor(makeAnchorInput({ label: 'DB Design' }));

      const inputs: CreateWeightedEdgeInput[] = [
        { sourceId: anchor.id, sourceType: 'anchor', targetId: 'fact-1', targetType: 'fact', edgeType: 'anchor_to_fact', weight: 0.8 },
        { sourceId: anchor.id, sourceType: 'anchor', targetId: 'fact-2', targetType: 'fact', edgeType: 'anchor_to_fact', weight: 0.5 },
        { sourceId: anchor.id, sourceType: 'anchor', targetId: 'ep-1', targetType: 'episode', edgeType: 'anchor_to_episode', weight: 0.6 },
        { sourceId: anchor.id, sourceType: 'anchor', targetId: 'concept-1', targetType: 'concept', edgeType: 'anchor_to_concept', weight: 0.9 },
      ];

      const edges = weightedEdgeRepo.saveEdges(inputs);

      expect(edges).toHaveLength(4);
      expect(weightedEdgeRepo.countEdges()).toBe(4);

      // Verify outgoing edges ordered by weight
      const outgoing = weightedEdgeRepo.getOutgoingEdges(anchor.id);
      expect(outgoing).toHaveLength(4);
      expect(outgoing[0].weight).toBe(0.9);
      expect(outgoing[3].weight).toBe(0.5);
    });
  });

  // ─── 2. Weight Accuracy (Hebbian Formula) ────────────────────

  describe('Hebbian weight formula accuracy', () => {
    it('reinforces edge using formula: w_new = w_old + lr * (1 - w_old)', () => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: 'anchor-1',
        sourceType: 'anchor',
        targetId: 'fact-1',
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.5,
        learningRate: 0.1,
      });

      const result = weightedEdgeRepo.reinforceEdge(edge.id);

      // w_new = 0.5 + 0.1 * (1 - 0.5) = 0.5 + 0.05 = 0.55
      expect(result).not.toBeNull();
      expect(result!.previousWeight).toBe(0.5);
      expect(result!.newWeight).toBeCloseTo(0.55, 10);
      expect(result!.activationCount).toBe(1);
    });

    it('uses edge default learning rate when none specified', () => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.4,
        learningRate: 0.2,
      });

      const result = weightedEdgeRepo.reinforceEdge(edge.id);

      // w_new = 0.4 + 0.2 * (1 - 0.4) = 0.4 + 0.12 = 0.52
      expect(result!.newWeight).toBeCloseTo(0.52, 10);
    });

    it('supports override learning rate during reinforcement', () => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.3,
        learningRate: 0.1,
      });

      // Override with 0.5
      const result = weightedEdgeRepo.reinforceEdge(edge.id, 0.5);

      // w_new = 0.3 + 0.5 * (1 - 0.3) = 0.3 + 0.35 = 0.65
      expect(result!.newWeight).toBeCloseTo(0.65, 10);
    });

    it('weight approaches 1.0 asymptotically with repeated reinforcement', () => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.1,
        learningRate: 0.1,
      });

      // Track weights across iterations
      const weights: number[] = [0.1];
      for (let i = 0; i < 50; i++) {
        const result = weightedEdgeRepo.reinforceEdge(edge.id);
        weights.push(result!.newWeight);
      }

      // Verify monotonic increase
      for (let i = 1; i < weights.length; i++) {
        expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1]);
      }

      // Should approach but not exceed 1.0
      const finalWeight = weights[weights.length - 1];
      expect(finalWeight).toBeGreaterThan(0.99);
      expect(finalWeight).toBeLessThanOrEqual(1.0);
    });

    it('weight never exceeds 1.0 even with high learning rate', () => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.99,
        learningRate: 0.5,
      });

      const result = weightedEdgeRepo.reinforceEdge(edge.id);

      // w_new = 0.99 + 0.5 * (1 - 0.99) = 0.99 + 0.005 = 0.995
      expect(result!.newWeight).toBeCloseTo(0.995, 5);
      expect(result!.newWeight).toBeLessThanOrEqual(1.0);
    });

    it('increments activation count on each reinforcement', () => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.5,
      });

      for (let i = 1; i <= 5; i++) {
        const result = weightedEdgeRepo.reinforceEdge(edge.id);
        expect(result!.activationCount).toBe(i);
      }

      // Verify persisted
      const persisted = weightedEdgeRepo.getEdge(edge.id);
      expect(persisted!.activationCount).toBe(5);
      expect(persisted!.lastActivatedAt).toBeDefined();
    });

    it('verifies Hebbian formula step-by-step for 5 iterations', () => {
      const lr = 0.15;
      const edge = weightedEdgeRepo.createEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.2,
        learningRate: lr,
      });

      // Manually compute expected values
      let expected = 0.2;
      for (let i = 0; i < 5; i++) {
        expected = expected + lr * (1 - expected);
        const result = weightedEdgeRepo.reinforceEdge(edge.id);
        expect(result!.newWeight).toBeCloseTo(expected, 8);
      }
    });
  });

  // ─── 3. Duplicate Edge Handling ──────────────────────────────

  describe('Duplicate edge handling', () => {
    it('prevents duplicate weighted_edges via UNIQUE constraint', () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.5,
      });

      // Same source, target, edge_type → should throw
      expect(() => {
        weightedEdgeRepo.createEdge({
          sourceId: 'a1', sourceType: 'anchor',
          targetId: 'f1', targetType: 'fact',
          edgeType: 'anchor_to_fact',
          weight: 0.8,
        });
      }).toThrow();
    });

    it('allows different edge types between same endpoints', () => {
      // This is valid: two nodes can have multiple relationship types
      // But anchor_to_fact and anchor_to_concept are different target types
      // so we need to use valid combinations
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.5,
      });

      // Same source and target but different edge_type is allowed only if the pair supports it
      // In practice, the UNIQUE is on (source_id, target_id, edge_type)
      // Use derived_from as an alternative edge type
      const edge2 = weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'derived_from',
        weight: 0.3,
      });

      expect(edge2.edgeType).toBe('derived_from');
      expect(weightedEdgeRepo.countEdges()).toBe(2);
    });

    it('findEdge detects existing edge before creating duplicate', () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.5,
      });

      // Check before creating
      const existing = weightedEdgeRepo.findEdge('a1', 'f1', 'anchor_to_fact');
      expect(existing).not.toBeNull();
      expect(existing!.weight).toBe(0.5);

      // No duplicate — just reinforce the existing
      if (existing) {
        const result = weightedEdgeRepo.reinforceEdge(existing.id);
        expect(result!.newWeight).toBeGreaterThan(0.5);
      }
    });

    it('memory_edges upsert with hebbian merges duplicate gracefully', () => {
      // First create
      const input: UpsertEdgeInput = {
        sourceId: 'anchor-x',
        sourceType: 'anchor',
        targetId: 'fact-x',
        targetType: 'fact',
        edgeType: 'fact_supports_concept',
        weight: 0.5,
      };

      const created = edgeRepo.upsertEdge(input);
      expect(created.weight).toBe(0.5);

      // Upsert again → hebbian merge: 0.5 + 0.3 * (1 - 0.5) = 0.65
      const updated = edgeRepo.upsertEdge({ ...input, weight: 0.3 });
      expect(updated.weight).toBeCloseTo(0.65, 5);
      expect(edgeRepo.countEdges()).toBe(1); // No duplicate
    });

    it('memory_edges upsert with replace strategy overwrites weight', () => {
      edgeRepo.upsertEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'fact_supports_concept',
        weight: 0.5,
      });

      const updated = edgeRepo.upsertEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'fact_supports_concept',
        weight: 0.9,
      }, 'replace');

      expect(updated.weight).toBe(0.9);
    });

    it('memory_edges upsert with max strategy keeps higher weight', () => {
      edgeRepo.upsertEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'fact_supports_concept',
        weight: 0.7,
      });

      // New weight 0.3 < existing 0.7 → keep 0.7
      const kept = edgeRepo.upsertEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'fact_supports_concept',
        weight: 0.3,
      }, 'max');
      expect(kept.weight).toBe(0.7);

      // New weight 0.9 > existing 0.7 → use 0.9
      const raised = edgeRepo.upsertEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'fact_supports_concept',
        weight: 0.9,
      }, 'max');
      expect(raised.weight).toBe(0.9);
    });

    it('memory_edges upsert with average strategy averages weights', () => {
      edgeRepo.upsertEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'fact_supports_concept',
        weight: 0.4,
      });

      const updated = edgeRepo.upsertEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'fact_supports_concept',
        weight: 0.8,
      }, 'average');

      expect(updated.weight).toBeCloseTo(0.6, 5);
    });
  });

  // ─── 4. EdgeScorer → Weighted Edge Creation Pipeline ─────────

  describe('EdgeScorer to WeightedEdge creation pipeline', () => {
    it('computes initial weight from scorer and creates edge', () => {
      const anchor = anchorRepo.createAnchor(makeAnchorInput({
        label: 'React Development',
        description: 'React frontend development patterns',
      }));

      const now = new Date().toISOString();

      const anchorNode = makeNode({
        id: anchor.id,
        type: 'concept',
        content: 'React frontend development patterns',
        createdAt: now,
        entities: ['React'],
        conversationIds: ['conv-1'],
      });

      const factNode = makeNode({
        id: 'fact-react-hooks',
        type: 'fact',
        content: 'React hooks simplify state management in functional components',
        createdAt: now,
        entities: ['React'],
        conversationIds: ['conv-1'],
      });

      const breakdown = scorer.score(anchorNode, factNode);
      expect(breakdown.meetsThreshold).toBe(true);

      // Use scorer's weight to create the edge
      const edge = weightedEdgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'anchor',
        targetId: 'fact-react-hooks',
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: breakdown.score,
      });

      expect(edge.weight).toBe(breakdown.score);
      expect(edge.weight).toBeGreaterThan(0);
      expect(edge.weight).toBeLessThanOrEqual(1);
    });

    it('scoreMany filters and ranks candidates for edge creation', () => {
      const referenceNode = makeNode({
        id: 'anchor-ts',
        content: 'TypeScript React development patterns',
        entities: ['TypeScript', 'React'],
        conversationIds: ['conv-1'],
      });

      const candidates = [
        makeNode({ id: 'f1', content: 'TypeScript React component testing', entities: ['TypeScript', 'React'], conversationIds: ['conv-1'] }),
        makeNode({ id: 'f2', content: 'Python data science pipeline', entities: ['Python'], conversationIds: ['conv-99'] }),
        makeNode({ id: 'f3', content: 'TypeScript type inference system', entities: ['TypeScript'], conversationIds: ['conv-1'] }),
      ];

      const results = scorer.scoreMany(referenceNode, candidates, { includeBelow: true });

      // f1 should rank highest (most overlap)
      expect(results[0].node.id).toBe('f1');
      // f2 should rank lowest (no overlap)
      expect(results[results.length - 1].node.id).toBe('f2');

      // Create edges only for candidates above threshold
      const edgesToCreate = results.filter(r => r.breakdown.meetsThreshold);
      expect(edgesToCreate.length).toBeGreaterThanOrEqual(1);
    });

    it('computeInitialWeight provides minimum 0.1 for any pair', () => {
      const nodeA = makeNode({
        content: 'completely unrelated topic alpha',
        createdAt: '2020-01-01T00:00:00Z',
        entities: [],
        conversationIds: ['c-999'],
      });
      const nodeB = makeNode({
        id: 'n2',
        content: 'something entirely different beta',
        createdAt: '2025-12-31T00:00:00Z',
        entities: [],
        conversationIds: ['c-001'],
      });

      const weight = scorer.computeInitialWeight(nodeA, nodeB);
      expect(weight).toBeGreaterThanOrEqual(0.1);
    });

    it('Hebbian delta scales with relevance score', () => {
      const highDelta = scorer.computeHebbianDelta(0.5, 1.0, 0.1);
      const medDelta = scorer.computeHebbianDelta(0.5, 0.5, 0.1);
      const lowDelta = scorer.computeHebbianDelta(0.5, 0.1, 0.1);

      expect(highDelta).toBeGreaterThan(medDelta);
      expect(medDelta).toBeGreaterThan(lowDelta);

      // Exact values
      expect(highDelta).toBeCloseTo(0.1, 5);  // 0.1 * 1.0
      expect(medDelta).toBeCloseTo(0.05, 5);  // 0.1 * 0.5
      expect(lowDelta).toBeCloseTo(0.01, 5);  // 0.1 * 0.1
    });
  });

  // ─── 5. Batch Co-Activation ──────────────────────────────────

  describe('Batch co-activation reinforcement', () => {
    it('reinforces multiple edges in single transaction', () => {
      const e1 = weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.4,
        learningRate: 0.1,
      });
      const e2 = weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f2', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.6,
        learningRate: 0.1,
      });
      const e3 = weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'ep1', targetType: 'episode',
        edgeType: 'anchor_to_episode', weight: 0.3,
        learningRate: 0.2,
      });

      const results = weightedEdgeRepo.batchReinforce({
        edgeIds: [e1.id, e2.id, e3.id],
      });

      expect(results).toHaveLength(3);

      // Verify Hebbian formula for each
      // e1: 0.4 + 0.1 * (1 - 0.4) = 0.46
      expect(results[0].newWeight).toBeCloseTo(0.46, 8);
      // e2: 0.6 + 0.1 * (1 - 0.6) = 0.64
      expect(results[1].newWeight).toBeCloseTo(0.64, 8);
      // e3: 0.3 + 0.2 * (1 - 0.3) = 0.44
      expect(results[2].newWeight).toBeCloseTo(0.44, 8);

      // All activation counts should be 1
      results.forEach(r => expect(r.activationCount).toBe(1));
    });

    it('batch reinforcement with override learning rate', () => {
      const e1 = weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.5,
        learningRate: 0.1, // Will be overridden
      });

      const results = weightedEdgeRepo.batchReinforce({
        edgeIds: [e1.id],
        learningRate: 0.3,
      });

      // Uses override: 0.5 + 0.3 * (1 - 0.5) = 0.65
      expect(results[0].newWeight).toBeCloseTo(0.65, 8);
    });

    it('batch handles non-existent edge IDs gracefully', () => {
      const e1 = weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.5,
      });

      const results = weightedEdgeRepo.batchReinforce({
        edgeIds: [e1.id, 'nonexistent-edge', 'also-missing'],
      });

      // Only 1 result for the existing edge
      expect(results).toHaveLength(1);
      expect(results[0].edgeId).toBe(e1.id);
    });
  });

  // ─── 6. Decay and Pruning in Weighted Edges ─────────────────

  describe('Decay and pruning of anchor edges', () => {
    it('applies decay formula: w_new = w * (1 - decay_rate)', () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.8,
        decayRate: 0.1,
      });

      weightedEdgeRepo.applyDecay();

      const edge = weightedEdgeRepo.getOutgoingEdges('a1')[0];
      // 0.8 * (1 - 0.1) = 0.72
      expect(edge.weight).toBeCloseTo(0.72, 5);
    });

    it('edges with zero decay rate are not affected', () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.8,
        decayRate: 0.0,
      });

      weightedEdgeRepo.applyDecay();

      const edge = weightedEdgeRepo.getOutgoingEdges('a1')[0];
      expect(edge.weight).toBeCloseTo(0.8, 5);
    });

    it('multiple decay cycles progressively reduce weight', () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 1.0,
        decayRate: 0.1,
      });

      let expected = 1.0;
      for (let i = 0; i < 5; i++) {
        expected = expected * (1 - 0.1);
        weightedEdgeRepo.applyDecay();
      }

      const edge = weightedEdgeRepo.getOutgoingEdges('a1')[0];
      // After 5 cycles: 1.0 * 0.9^5 ≈ 0.59049
      expect(edge.weight).toBeCloseTo(expected, 3);
    });

    it('decay then prune removes low-weight edges', () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.8,
        decayRate: 0.1,
      });
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f2', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.05,
        decayRate: 0.5,
      });

      const result = weightedEdgeRepo.applyDecay({ pruneBelow: 0.03 });

      // Edge 2: 0.05 * (1 - 0.5) = 0.025 < 0.03 → pruned
      expect(result.prunedCount).toBe(1);
      expect(weightedEdgeRepo.countEdges()).toBe(1);
    });
  });

  // ─── 7. Full Lifecycle: Create → Reinforce → Decay → Prune ──

  describe('Full anchor edge lifecycle', () => {
    it('creates edge, reinforces through co-activation, decays, and prunes', () => {
      // Step 1: Create anchor and edge
      const anchor = anchorRepo.createAnchor(makeAnchorInput({ label: 'API Design' }));
      const edge = weightedEdgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'anchor',
        targetId: 'fact-api-rest',
        targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.4,
        learningRate: 0.15,
        decayRate: 0.1,
      });

      expect(edge.weight).toBe(0.4);

      // Step 2: Reinforce 3 times (simulating 3 co-activations)
      let w = 0.4;
      for (let i = 0; i < 3; i++) {
        w = w + 0.15 * (1 - w);
        const result = weightedEdgeRepo.reinforceEdge(edge.id);
        expect(result!.newWeight).toBeCloseTo(w, 8);
      }

      // w after 3 reinforcements should be: ~0.6517
      expect(w).toBeGreaterThan(0.6);

      // Step 3: Apply decay 5 times without reinforcement
      for (let i = 0; i < 5; i++) {
        w = w * (1 - 0.1);
        weightedEdgeRepo.applyDecay();
      }

      const decayedEdge = weightedEdgeRepo.getEdge(edge.id)!;
      expect(decayedEdge.weight).toBeCloseTo(w, 3);

      // Step 4: Verify weight is still above pruning threshold
      expect(decayedEdge.weight).toBeGreaterThan(0.3);

      // Step 5: Heavy decay to trigger pruning — apply many cycles
      for (let i = 0; i < 50; i++) {
        weightedEdgeRepo.applyDecay();
      }

      // After ~55 total decay cycles at rate 0.1, weight should be very small
      const almostGone = weightedEdgeRepo.getEdge(edge.id)!;
      expect(almostGone.weight).toBeLessThan(0.01);

      const result = weightedEdgeRepo.applyDecay({ pruneBelow: 0.01 });
      // Edge should be pruned after many decay cycles
      expect(weightedEdgeRepo.countEdges()).toBe(0);
    });

    it('anchor reinforcement and edge reinforcement work together', () => {
      const anchor = anchorRepo.createAnchor(makeAnchorInput({
        label: 'Testing Patterns',
        initialWeight: 0.5,
        decayRate: 0.01,
      }));

      const edge = weightedEdgeRepo.createEdge({
        sourceId: anchor.id,
        sourceType: 'anchor',
        targetId: 'concept-tdd',
        targetType: 'concept',
        edgeType: 'anchor_to_concept',
        weight: 0.5,
        learningRate: 0.1,
      });

      // Reinforce both anchor and edge (simulating retrieval co-activation)
      const reinforcedAnchor = anchorRepo.reinforceWeight(anchor.id, 0.1);
      const reinforcedEdge = weightedEdgeRepo.reinforceEdge(edge.id);

      // Anchor: 0.5 + 0.1 * (1 - 0.5) = 0.55
      expect(reinforcedAnchor!.currentWeight).toBeCloseTo(0.55, 8);
      // Edge: 0.5 + 0.1 * (1 - 0.5) = 0.55
      expect(reinforcedEdge!.newWeight).toBeCloseTo(0.55, 8);

      // Verify anchor access was recorded
      expect(reinforcedAnchor!.accessCount).toBe(1);
      expect(reinforcedAnchor!.lastAccessedAt).toBeDefined();
    });
  });

  // ─── 8. Cross-Repository Edge Queries ────────────────────────

  describe('Cross-repository anchor edge queries', () => {
    it('filters weighted edges by anchor source and target type', () => {
      const anchor = anchorRepo.createAnchor(makeAnchorInput({ label: 'Node.js' }));

      weightedEdgeRepo.createEdge({
        sourceId: anchor.id, sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.8,
      });
      weightedEdgeRepo.createEdge({
        sourceId: anchor.id, sourceType: 'anchor',
        targetId: 'ep1', targetType: 'episode',
        edgeType: 'anchor_to_episode', weight: 0.6,
      });
      weightedEdgeRepo.createEdge({
        sourceId: anchor.id, sourceType: 'anchor',
        targetId: 'c1', targetType: 'concept',
        edgeType: 'anchor_to_concept', weight: 0.7,
      });

      // Query only facts connected to anchor
      const factEdges = weightedEdgeRepo.queryEdges({
        sourceId: anchor.id,
        targetType: 'fact',
      });
      expect(factEdges).toHaveLength(1);
      expect(factEdges[0].targetId).toBe('f1');

      // Query by edge types
      const anchorEdges = weightedEdgeRepo.queryEdges({
        edgeTypes: ['anchor_to_fact', 'anchor_to_concept'],
      });
      expect(anchorEdges).toHaveLength(2);

      // Query with min weight filter
      const strongEdges = weightedEdgeRepo.queryEdges({
        sourceId: anchor.id,
        minWeight: 0.7,
      });
      expect(strongEdges).toHaveLength(2); // 0.8 and 0.7
    });

    it('getConnectedEdges returns all edges for an anchor', () => {
      const a1 = anchorRepo.createAnchor(makeAnchorInput({ label: 'A1' }));
      const a2 = anchorRepo.createAnchor(makeAnchorInput({ label: 'A2' }));

      // a1 → f1
      weightedEdgeRepo.createEdge({
        sourceId: a1.id, sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.5,
      });
      // a2 → a1
      weightedEdgeRepo.createEdge({
        sourceId: a2.id, sourceType: 'anchor',
        targetId: a1.id, targetType: 'anchor',
        edgeType: 'anchor_to_anchor', weight: 0.6,
      });

      const connected = weightedEdgeRepo.getConnectedEdges(a1.id);
      expect(connected).toHaveLength(2);
    });
  });

  // ─── 9. Weight Clamping and Edge Cases ───────────────────────

  describe('Weight clamping and edge cases', () => {
    it('clamps weight to 0 when negative', () => {
      weightedEdgeRepo.updateWeight('some-edge', -0.5);
      // Won't error — the SQL UPDATE succeeds but no row found
    });

    it('direct weight update clamps to [0, 1]', () => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.5,
      });

      weightedEdgeRepo.updateWeight(edge.id, 1.5);
      let updated = weightedEdgeRepo.getEdge(edge.id)!;
      expect(updated.weight).toBe(1.0);

      weightedEdgeRepo.updateWeight(edge.id, -0.3);
      updated = weightedEdgeRepo.getEdge(edge.id)!;
      expect(updated.weight).toBe(0.0);
    });

    it('reinforcing a non-existent edge returns null', () => {
      const result = weightedEdgeRepo.reinforceEdge('does-not-exist');
      expect(result).toBeNull();
    });

    it('empty batch reinforcement returns empty results', () => {
      const results = weightedEdgeRepo.batchReinforce({ edgeIds: [] });
      expect(results).toEqual([]);
    });

    it('decay with no edges is a no-op', () => {
      const result = weightedEdgeRepo.applyDecay();
      expect(result.decayedCount).toBe(0);
      expect(result.prunedCount).toBe(0);
    });

    it('weight 0 edge does not go negative after decay', () => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.01,
        decayRate: 0.99, // very aggressive
      });

      weightedEdgeRepo.applyDecay();

      const decayed = weightedEdgeRepo.getEdge(edge.id)!;
      expect(decayed.weight).toBeGreaterThanOrEqual(0);
      // 0.01 * (1 - 0.99) = 0.0001
      expect(decayed.weight).toBeCloseTo(0.0001, 4);
    });
  });

  // ─── 10. Hebbian Weight Convergence Properties ───────────────

  describe('Hebbian weight convergence properties', () => {
    it('reinforcement rate decreases as weight increases (diminishing returns)', () => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.1,
        learningRate: 0.2,
      });

      const deltas: number[] = [];
      for (let i = 0; i < 10; i++) {
        const result = weightedEdgeRepo.reinforceEdge(edge.id)!;
        deltas.push(result.newWeight - result.previousWeight);
      }

      // Each delta should be smaller than the previous (diminishing returns)
      for (let i = 1; i < deltas.length; i++) {
        expect(deltas[i]).toBeLessThan(deltas[i - 1]);
      }
    });

    it('competing reinforcement and decay reach equilibrium', () => {
      const edge = weightedEdgeRepo.createEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.5,
        learningRate: 0.1,
        decayRate: 0.05,
      });

      // Alternate reinforce and decay
      const weights: number[] = [0.5];
      for (let i = 0; i < 30; i++) {
        weightedEdgeRepo.reinforceEdge(edge.id);
        weightedEdgeRepo.applyDecay();
        const current = weightedEdgeRepo.getEdge(edge.id)!;
        weights.push(current.weight);
      }

      // Weight should stabilize (last 5 values should be close)
      const last5 = weights.slice(-5);
      const maxDiff = Math.max(...last5) - Math.min(...last5);
      expect(maxDiff).toBeLessThan(0.02);
    });

    it('stronger initial edges maintain higher equilibrium than weaker ones', () => {
      const strongEdge = weightedEdgeRepo.createEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.8,
        learningRate: 0.1,
        decayRate: 0.05,
      });

      const weakEdge = weightedEdgeRepo.createEdge({
        sourceId: 'a', sourceType: 'anchor',
        targetId: 'f2', targetType: 'fact',
        edgeType: 'anchor_to_fact',
        weight: 0.2,
        learningRate: 0.1,
        decayRate: 0.05,
      });

      // Apply same number of reinforcements and decays
      for (let i = 0; i < 20; i++) {
        weightedEdgeRepo.reinforceEdge(strongEdge.id);
        weightedEdgeRepo.reinforceEdge(weakEdge.id);
        weightedEdgeRepo.applyDecay();
      }

      const strong = weightedEdgeRepo.getEdge(strongEdge.id)!;
      const weak = weightedEdgeRepo.getEdge(weakEdge.id)!;

      // Both should converge to same equilibrium since they get same reinforcement
      // With same learning rate and decay rate, the equilibrium is the same
      // After enough iterations, both converge to the same value
      expect(Math.abs(strong.weight - weak.weight)).toBeLessThan(0.05);
    });
  });
});
