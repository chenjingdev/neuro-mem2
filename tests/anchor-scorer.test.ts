/**
 * Tests for the AnchorScorer module — anchor-level relevance scoring,
 * edge creation decisions, and Hebbian co-activation reinforcement.
 */

import { describe, it, expect } from 'vitest';
import {
  AnchorScorer,
  inferEdgeType,
  DEFAULT_ANCHOR_SCORER_CONFIG,
  type AnchorScoringResult,
  type MemoryNodeDescriptor,
} from '../src/scoring/index.js';

// ────────────────────────────────────────────────────────
// Helper: create a MemoryNodeDescriptor
// ────────────────────────────────────────────────────────

function makeNode(overrides: Partial<MemoryNodeDescriptor> = {}): MemoryNodeDescriptor {
  return {
    id: overrides.id ?? 'node-1',
    type: overrides.type ?? 'fact',
    content: overrides.content ?? 'some content',
    createdAt: overrides.createdAt ?? '2025-01-15T10:00:00Z',
    entities: overrides.entities ?? [],
    conversationIds: overrides.conversationIds ?? ['conv-1'],
    turnIndices: overrides.turnIndices,
    embedding: overrides.embedding,
  };
}

// ────────────────────────────────────────────────────────
// inferEdgeType
// ────────────────────────────────────────────────────────

describe('inferEdgeType', () => {
  it('returns about for hub → leaf', () => {
    expect(inferEdgeType('hub', 'leaf')).toBe('about');
  });

  it('returns related for hub → hub', () => {
    expect(inferEdgeType('hub', 'hub')).toBe('related');
  });

  it('returns related for leaf → leaf', () => {
    expect(inferEdgeType('leaf', 'leaf')).toBe('related');
  });

  it('returns about for leaf → hub', () => {
    expect(inferEdgeType('leaf', 'hub')).toBe('about');
  });
});

// ────────────────────────────────────────────────────────
// AnchorScorer — construction
// ────────────────────────────────────────────────────────

describe('AnchorScorer', () => {
  it('creates with default config', () => {
    const scorer = new AnchorScorer();
    expect(scorer.config.defaultLearningRate).toBe(0.1);
    expect(scorer.config.defaultDecayRate).toBe(0.01);
    expect(scorer.config.minEdgeCreationThreshold).toBe(0.1);
    expect(scorer.config.maxEdgesPerBatch).toBe(50);
  });

  it('merges partial config', () => {
    const scorer = new AnchorScorer({
      defaultLearningRate: 0.2,
      minEdgeCreationThreshold: 0.3,
    });
    expect(scorer.config.defaultLearningRate).toBe(0.2);
    expect(scorer.config.minEdgeCreationThreshold).toBe(0.3);
    // Defaults preserved
    expect(scorer.config.defaultDecayRate).toBe(0.01);
    expect(scorer.config.maxEdgesPerBatch).toBe(50);
  });

  it('exposes underlying EdgeScorer', () => {
    const scorer = new AnchorScorer();
    expect(scorer.getEdgeScorer()).toBeDefined();
  });

  // ────────────────────────────────────────────────────
  // scorePair()
  // ────────────────────────────────────────────────────

  describe('scorePair()', () => {
    it('returns high score for closely related nodes', () => {
      const scorer = new AnchorScorer();
      const now = new Date().toISOString();

      const nodeA = makeNode({
        id: 'a',
        type: 'hub' as any,
        content: 'TypeScript React frontend development',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['conv-1'],
      });
      const nodeB = makeNode({
        id: 'b',
        type: 'leaf' as any,
        content: 'TypeScript React component architecture patterns',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['conv-1'],
      });

      const result = scorer.scorePair(nodeA, nodeB);
      expect(result.shouldLink).toBe(true);
      expect(result.suggestedWeight).toBeGreaterThan(0.1);
      expect(result.edgeType).toBe('about');
      expect(result.sourceId).toBe('a');
      expect(result.targetId).toBe('b');
      expect(result.sourceType).toBe('hub');
      expect(result.targetType).toBe('leaf');
    });

    it('returns low score for unrelated nodes', () => {
      const scorer = new AnchorScorer();

      const nodeA = makeNode({
        id: 'a',
        type: 'fact',
        content: 'Python machine learning model training',
        createdAt: '2020-01-01T00:00:00Z',
        entities: ['Python', 'TensorFlow'],
        conversationIds: ['conv-1'],
      });
      const nodeB = makeNode({
        id: 'b',
        type: 'concept',
        content: 'Java Spring enterprise microservices deployment',
        createdAt: '2025-06-01T00:00:00Z',
        entities: ['Java', 'Spring'],
        conversationIds: ['conv-99'],
      });

      const result = scorer.scorePair(nodeA, nodeB);
      expect(result.shouldLink).toBe(false);
      expect(result.suggestedWeight).toBe(0);
      expect(result.breakdown.score).toBeLessThan(0.1);
    });

    it('correctly infers edge type from node types', () => {
      const scorer = new AnchorScorer();

      const hub = makeNode({ id: 'a', type: 'hub' as any, content: 'topic' });
      const leaf1 = makeNode({ id: 'b', type: 'leaf' as any, content: 'topic' });
      const leaf2 = makeNode({ id: 'c', type: 'leaf' as any, content: 'topic' });

      expect(scorer.scorePair(hub, leaf1).edgeType).toBe('about');
      expect(scorer.scorePair(hub, leaf2).edgeType).toBe('about');
      expect(scorer.scorePair(leaf1, leaf2).edgeType).toBe('related');
    });

    it('provides complete breakdown', () => {
      const scorer = new AnchorScorer();
      const nodeA = makeNode({ id: 'a', content: 'hello world' });
      const nodeB = makeNode({ id: 'b', content: 'goodbye world' });

      const result = scorer.scorePair(nodeA, nodeB);
      expect(result.breakdown.signals).toHaveProperty('temporal');
      expect(result.breakdown.signals).toHaveProperty('semantic');
      expect(result.breakdown.signals).toHaveProperty('coOccurrence');
      expect(result.breakdown.signals).toHaveProperty('entityOverlap');
      expect(result.breakdown.weights).toBeDefined();
    });

    it('uses embeddings when available for scoring', () => {
      const scorer = new AnchorScorer({
        edgeScorerConfig: {
          weights: { temporal: 0, semantic: 1, coOccurrence: 0, entityOverlap: 0 },
        },
      });

      const nodeA = makeNode({ id: 'a', embedding: [1, 0, 0] });
      const nodeB = makeNode({ id: 'b', embedding: [1, 0, 0] });
      const nodeC = makeNode({ id: 'c', embedding: [0, 1, 0] });

      expect(scorer.scorePair(nodeA, nodeB).breakdown.score).toBeCloseTo(1.0, 2);
      expect(scorer.scorePair(nodeA, nodeC).breakdown.score).toBeCloseTo(0, 2);
    });

    it('suggestedWeight has minimum floor of 0.1 when linked', () => {
      const scorer = new AnchorScorer({ minEdgeCreationThreshold: 0.05 });

      // Create nodes with just barely related content
      const nodeA = makeNode({
        id: 'a',
        content: 'typescript development patterns',
        createdAt: '2025-01-15T10:00:00Z',
        entities: ['TypeScript'],
        conversationIds: ['conv-1'],
      });
      const nodeB = makeNode({
        id: 'b',
        content: 'python machine learning setup',
        createdAt: '2025-01-15T10:00:00Z',
        entities: [],
        conversationIds: ['conv-2'],
      });

      const result = scorer.scorePair(nodeA, nodeB);
      if (result.shouldLink) {
        expect(result.suggestedWeight).toBeGreaterThanOrEqual(0.1);
      }
    });
  });

  // ────────────────────────────────────────────────────
  // scoreBatch()
  // ────────────────────────────────────────────────────

  describe('scoreBatch()', () => {
    it('scores multiple candidates and returns sorted results', () => {
      const scorer = new AnchorScorer();
      const now = new Date().toISOString();

      const reference = makeNode({
        id: 'ref',
        type: 'anchor',
        content: 'TypeScript React development',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['conv-1'],
      });

      const candidates = [
        makeNode({
          id: 'c1',
          type: 'fact',
          content: 'Python Django web framework',
          createdAt: '2020-01-01T00:00:00Z',
          entities: ['Python'],
          conversationIds: ['conv-99'],
        }),
        makeNode({
          id: 'c2',
          type: 'fact',
          content: 'TypeScript React component patterns frontend',
          createdAt: now,
          entities: ['TypeScript', 'React'],
          conversationIds: ['conv-1'],
        }),
        makeNode({
          id: 'c3',
          type: 'concept',
          content: 'JavaScript frontend development',
          createdAt: now,
          entities: ['JavaScript'],
          conversationIds: ['conv-1'],
        }),
      ];

      const result = scorer.scoreBatch(reference, candidates);

      expect(result.totalEvaluated).toBe(3);
      expect(result.scoredPairs.length).toBe(3);
      // Sorted descending
      for (let i = 1; i < result.scoredPairs.length; i++) {
        expect(result.scoredPairs[i - 1].breakdown.score)
          .toBeGreaterThanOrEqual(result.scoredPairs[i].breakdown.score);
      }
      // c2 should be the top scorer (same entities, same time, related content)
      expect(result.topPair?.targetId).toBe('c2');
      expect(result.averageScore).toBeGreaterThan(0);
    });

    it('excludes self from candidates', () => {
      const scorer = new AnchorScorer();
      const node = makeNode({ id: 'self' });

      const result = scorer.scoreBatch(node, [
        makeNode({ id: 'self' }),
        makeNode({ id: 'other' }),
      ]);

      expect(result.totalEvaluated).toBe(1);
      expect(result.scoredPairs[0].targetId).toBe('other');
    });

    it('respects maxEdgesPerBatch limit', () => {
      const scorer = new AnchorScorer({
        maxEdgesPerBatch: 2,
        minEdgeCreationThreshold: 0,
      });
      const now = new Date().toISOString();
      const reference = makeNode({ id: 'ref', createdAt: now });
      const candidates = Array.from({ length: 10 }, (_, i) =>
        makeNode({ id: `c${i}`, createdAt: now }),
      );

      const result = scorer.scoreBatch(reference, candidates);
      expect(result.linkedPairs.length).toBeLessThanOrEqual(2);
    });

    it('returns empty result for no candidates', () => {
      const scorer = new AnchorScorer();
      const result = scorer.scoreBatch(makeNode(), []);
      expect(result.totalEvaluated).toBe(0);
      expect(result.linkedCount).toBe(0);
      expect(result.averageScore).toBe(0);
      expect(result.topPair).toBeNull();
    });

    it('correctly computes averageScore', () => {
      const scorer = new AnchorScorer({
        edgeScorerConfig: {
          weights: { temporal: 1, semantic: 0, coOccurrence: 0, entityOverlap: 0 },
        },
      });

      const now = new Date().toISOString();
      const reference = makeNode({ id: 'ref', createdAt: now });
      // Both created at same time → temporal = 1.0
      const candidates = [
        makeNode({ id: 'c1', createdAt: now }),
        makeNode({ id: 'c2', createdAt: now }),
      ];

      const result = scorer.scoreBatch(reference, candidates);
      expect(result.averageScore).toBeCloseTo(1.0, 2);
    });
  });

  // ────────────────────────────────────────────────────
  // reinforceWeight()
  // ────────────────────────────────────────────────────

  describe('reinforceWeight()', () => {
    it('increases weight based on relevance and learning rate', () => {
      const scorer = new AnchorScorer();
      const now = new Date().toISOString();

      const nodeA = makeNode({
        id: 'a',
        type: 'hub' as any,
        content: 'TypeScript development',
        createdAt: now,
        entities: ['TypeScript'],
        conversationIds: ['conv-1'],
      });
      const nodeB = makeNode({
        id: 'b',
        type: 'leaf' as any,
        content: 'TypeScript development patterns',
        createdAt: now,
        entities: ['TypeScript'],
        conversationIds: ['conv-1'],
      });

      const result = scorer.reinforceWeight(0.5, nodeA, nodeB);

      expect(result.newWeight).toBeGreaterThan(0.5);
      expect(result.delta).toBeGreaterThan(0);
      expect(result.previousWeight).toBe(0.5);
      expect(result.sourceId).toBe('a');
      expect(result.targetId).toBe('b');
      expect(result.edgeType).toBe('about');
    });

    it('approaches 1.0 asymptotically', () => {
      const scorer = new AnchorScorer({ defaultLearningRate: 0.5 });
      const now = new Date().toISOString();
      const nodeA = makeNode({ id: 'a', createdAt: now, entities: ['X'], conversationIds: ['c'] });
      const nodeB = makeNode({ id: 'b', createdAt: now, entities: ['X'], conversationIds: ['c'] });

      // Simulate multiple reinforcements
      let weight = 0.5;
      for (let i = 0; i < 20; i++) {
        const result = scorer.reinforceWeight(weight, nodeA, nodeB, 0.5);
        weight = result.newWeight;
      }

      expect(weight).toBeLessThanOrEqual(1.0);
      expect(weight).toBeGreaterThan(0.95);
    });

    it('weight never exceeds 1.0', () => {
      const scorer = new AnchorScorer({ defaultLearningRate: 1.0 });
      const now = new Date().toISOString();
      const nodeA = makeNode({ id: 'a', createdAt: now });
      const nodeB = makeNode({ id: 'b', createdAt: now });

      const result = scorer.reinforceWeight(0.99, nodeA, nodeB, 1.0);
      expect(result.newWeight).toBeLessThanOrEqual(1.0);
    });

    it('delta is zero when weight is already 1.0', () => {
      const scorer = new AnchorScorer();
      const nodeA = makeNode({ id: 'a' });
      const nodeB = makeNode({ id: 'b' });

      const result = scorer.reinforceWeight(1.0, nodeA, nodeB);
      expect(result.delta).toBe(0);
      expect(result.newWeight).toBe(1.0);
    });

    it('delta scales with relevance score', () => {
      const scorer = new AnchorScorer();
      const now = new Date().toISOString();

      const nodeA = makeNode({ id: 'a', createdAt: now, entities: ['X'], conversationIds: ['c'] });
      // Highly related
      const nodeRelated = makeNode({
        id: 'b1',
        createdAt: now,
        content: nodeA.content,
        entities: ['X'],
        conversationIds: ['c'],
      });
      // Weakly related
      const nodeUnrelated = makeNode({
        id: 'b2',
        createdAt: '2020-01-01T00:00:00Z',
        content: 'completely different topic',
        entities: ['Y'],
        conversationIds: ['other'],
      });

      const resultRelated = scorer.reinforceWeight(0.5, nodeA, nodeRelated);
      const resultUnrelated = scorer.reinforceWeight(0.5, nodeA, nodeUnrelated);

      expect(resultRelated.delta).toBeGreaterThan(resultUnrelated.delta);
    });

    it('uses custom learning rate when provided', () => {
      const scorer = new AnchorScorer({ defaultLearningRate: 0.1 });
      const now = new Date().toISOString();
      const nodeA = makeNode({ id: 'a', createdAt: now });
      const nodeB = makeNode({ id: 'b', createdAt: now });

      const resultDefault = scorer.reinforceWeight(0.5, nodeA, nodeB);
      const resultCustom = scorer.reinforceWeight(0.5, nodeA, nodeB, 0.5);

      // Higher learning rate → larger delta
      expect(resultCustom.delta).toBeGreaterThan(resultDefault.delta);
    });
  });

  // ────────────────────────────────────────────────────
  // computeRelevance()
  // ────────────────────────────────────────────────────

  describe('computeRelevance()', () => {
    it('returns a score in [0, 1]', () => {
      const scorer = new AnchorScorer();
      const nodeA = makeNode({ id: 'a' });
      const nodeB = makeNode({ id: 'b' });
      const score = scorer.computeRelevance(nodeA, nodeB);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('returns 1.0 for identical nodes', () => {
      const scorer = new AnchorScorer();
      const now = new Date().toISOString();
      const nodeA = makeNode({
        id: 'a',
        content: 'TypeScript React',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['c1'],
      });
      const nodeB = makeNode({
        id: 'b',
        content: 'TypeScript React',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['c1'],
      });
      expect(scorer.computeRelevance(nodeA, nodeB)).toBeCloseTo(1.0, 1);
    });
  });

  // ────────────────────────────────────────────────────
  // computeHebbianDelta()
  // ────────────────────────────────────────────────────

  describe('computeHebbianDelta()', () => {
    it('computes delta = lr * relevance * (1 - weight)', () => {
      const scorer = new AnchorScorer({ defaultLearningRate: 0.1 });

      // weight=0.5, relevance=1.0 → delta = 0.1 * 1.0 * 0.5 = 0.05
      expect(scorer.computeHebbianDelta(0.5, 1.0)).toBeCloseTo(0.05, 5);

      // weight=0.0, relevance=1.0 → delta = 0.1 * 1.0 * 1.0 = 0.1
      expect(scorer.computeHebbianDelta(0.0, 1.0)).toBeCloseTo(0.1, 5);

      // weight=1.0, relevance=1.0 → delta = 0 (no headroom)
      expect(scorer.computeHebbianDelta(1.0, 1.0)).toBeCloseTo(0, 5);

      // weight=0.5, relevance=0.5 → delta = 0.1 * 0.5 * 0.5 = 0.025
      expect(scorer.computeHebbianDelta(0.5, 0.5)).toBeCloseTo(0.025, 5);
    });

    it('uses custom learning rate', () => {
      const scorer = new AnchorScorer();
      const delta = scorer.computeHebbianDelta(0.0, 1.0, 0.5);
      expect(delta).toBeCloseTo(0.5, 5);
    });

    it('clamps weight to [0, 1] before computing', () => {
      const scorer = new AnchorScorer();
      // Weight > 1 → clamped to 1 → headroom = 0
      expect(scorer.computeHebbianDelta(1.5, 1.0)).toBeCloseTo(0, 5);
      // Weight < 0 → clamped to 0 → headroom = 1
      expect(scorer.computeHebbianDelta(-0.5, 1.0)).toBeCloseTo(0.1, 5);
    });
  });

  // ────────────────────────────────────────────────────
  // applyHebbianUpdate()
  // ────────────────────────────────────────────────────

  describe('applyHebbianUpdate()', () => {
    it('returns weight + delta, clamped to [0, 1]', () => {
      const scorer = new AnchorScorer({ defaultLearningRate: 0.1 });
      const newWeight = scorer.applyHebbianUpdate(0.5, 1.0);
      expect(newWeight).toBeCloseTo(0.55, 5);
    });

    it('never exceeds 1.0', () => {
      const scorer = new AnchorScorer({ defaultLearningRate: 1.0 });
      const newWeight = scorer.applyHebbianUpdate(0.99, 1.0);
      expect(newWeight).toBeLessThanOrEqual(1.0);
    });

    it('never goes below 0', () => {
      const scorer = new AnchorScorer();
      const newWeight = scorer.applyHebbianUpdate(0, 0);
      expect(newWeight).toBeGreaterThanOrEqual(0);
    });
  });

  // ────────────────────────────────────────────────────
  // batchReinforce()
  // ────────────────────────────────────────────────────

  describe('batchReinforce()', () => {
    it('reinforces all pairwise edges', () => {
      const scorer = new AnchorScorer();
      const now = new Date().toISOString();

      const nodes = [
        makeNode({ id: 'n1', type: 'hub' as any, createdAt: now }),
        makeNode({ id: 'n2', type: 'leaf' as any, createdAt: now }),
        makeNode({ id: 'n3', type: 'leaf' as any, createdAt: now }),
      ];

      const weights = new Map<string, number>();
      weights.set(`n1:n2:about`, 0.5);
      weights.set(`n1:n3:about`, 0.3);
      weights.set(`n2:n3:related`, 0.4);

      const results = scorer.batchReinforce(weights, nodes);

      // 3 nodes → 3 pairwise combinations
      expect(results.length).toBe(3);
      // All should have increased weight
      for (const r of results) {
        expect(r.newWeight).toBeGreaterThanOrEqual(r.previousWeight);
      }
    });

    it('uses default weight of 0 for unknown edges', () => {
      const scorer = new AnchorScorer();
      const now = new Date().toISOString();

      const nodes = [
        makeNode({ id: 'n1', type: 'leaf' as any, createdAt: now }),
        makeNode({ id: 'n2', type: 'leaf' as any, createdAt: now }),
      ];

      const weights = new Map<string, number>(); // empty map
      const results = scorer.batchReinforce(weights, nodes);

      expect(results.length).toBe(1);
      expect(results[0].previousWeight).toBe(0);
      expect(results[0].newWeight).toBeGreaterThan(0);
    });

    it('returns empty array for single node', () => {
      const scorer = new AnchorScorer();
      const results = scorer.batchReinforce(new Map(), [makeNode()]);
      expect(results.length).toBe(0);
    });

    it('returns empty array for empty nodes', () => {
      const scorer = new AnchorScorer();
      const results = scorer.batchReinforce(new Map(), []);
      expect(results.length).toBe(0);
    });

    it('uses override learning rate', () => {
      const scorer = new AnchorScorer({ defaultLearningRate: 0.1 });
      const now = new Date().toISOString();

      const nodes = [
        makeNode({ id: 'n1', createdAt: now }),
        makeNode({ id: 'n2', createdAt: now }),
      ];

      const weights = new Map([['n1:n2:related', 0.5]]);

      const resultsDefault = scorer.batchReinforce(weights, nodes);
      const resultsCustom = scorer.batchReinforce(weights, nodes, 0.5);

      expect(resultsCustom[0].delta).toBeGreaterThan(resultsDefault[0].delta);
    });
  });
});

// ────────────────────────────────────────────────────────
// DEFAULT_ANCHOR_SCORER_CONFIG
// ────────────────────────────────────────────────────────

describe('DEFAULT_ANCHOR_SCORER_CONFIG', () => {
  it('has reasonable defaults', () => {
    expect(DEFAULT_ANCHOR_SCORER_CONFIG.defaultLearningRate).toBe(0.1);
    expect(DEFAULT_ANCHOR_SCORER_CONFIG.defaultDecayRate).toBe(0.01);
    expect(DEFAULT_ANCHOR_SCORER_CONFIG.minEdgeCreationThreshold).toBe(0.1);
    expect(DEFAULT_ANCHOR_SCORER_CONFIG.maxEdgesPerBatch).toBe(50);
  });
});
