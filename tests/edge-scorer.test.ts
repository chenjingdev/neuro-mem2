/**
 * Tests for the EdgeScorer module — scoring/weighting logic
 * for computing relevance weights between memory nodes.
 */

import { describe, it, expect } from 'vitest';
import {
  EdgeScorer,
  computeTemporalProximity,
  computeSemanticSimilarity,
  computeCoOccurrence,
  computeCoOccurrenceFromNodes,
  computeEntityOverlap,
  cosineSimilarity,
  jaccardSimilarity,
  DEFAULT_SCORING_WEIGHTS,
  DEFAULT_SCORER_CONFIG,
  type MemoryNodeDescriptor,
  type CoOccurrenceData,
} from '../src/scoring/index.js';

// ────────────────────────────────────────────────────────
// Helper: create a MemoryNodeDescriptor with defaults
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
// Temporal Proximity
// ────────────────────────────────────────────────────────

describe('computeTemporalProximity', () => {
  it('returns 1.0 for identical timestamps', () => {
    const ts = '2025-01-15T10:00:00Z';
    expect(computeTemporalProximity(ts, ts)).toBe(1.0);
  });

  it('returns ~0.5 when separated by exactly one half-life', () => {
    const halfLifeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    const t1 = '2025-01-01T00:00:00Z';
    const t2 = '2025-01-08T00:00:00Z'; // 7 days later
    const score = computeTemporalProximity(t1, t2, halfLifeMs);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('returns ~0.25 when separated by two half-lives', () => {
    const halfLifeMs = 7 * 24 * 60 * 60 * 1000;
    const t1 = '2025-01-01T00:00:00Z';
    const t2 = '2025-01-15T00:00:00Z'; // 14 days later
    const score = computeTemporalProximity(t1, t2, halfLifeMs);
    expect(score).toBeCloseTo(0.25, 5);
  });

  it('is symmetric (order does not matter)', () => {
    const t1 = '2025-01-01T00:00:00Z';
    const t2 = '2025-01-05T00:00:00Z';
    expect(computeTemporalProximity(t1, t2)).toBe(computeTemporalProximity(t2, t1));
  });

  it('approaches 0 for very distant timestamps', () => {
    const t1 = '2020-01-01T00:00:00Z';
    const t2 = '2025-01-01T00:00:00Z';
    const score = computeTemporalProximity(t1, t2);
    expect(score).toBeLessThan(0.001);
  });

  it('returns 0 for invalid timestamps', () => {
    expect(computeTemporalProximity('invalid', '2025-01-01T00:00:00Z')).toBe(0);
    expect(computeTemporalProximity('2025-01-01T00:00:00Z', 'invalid')).toBe(0);
  });

  it('returns 0 for zero or negative half-life', () => {
    const ts1 = '2025-01-01T00:00:00Z';
    const ts2 = '2025-01-02T00:00:00Z';
    expect(computeTemporalProximity(ts1, ts2, 0)).toBe(0);
    expect(computeTemporalProximity(ts1, ts2, -1000)).toBe(0);
  });

  it('works with shorter half-life (1 hour)', () => {
    const oneHourMs = 60 * 60 * 1000;
    const t1 = '2025-01-15T10:00:00Z';
    const t2 = '2025-01-15T11:00:00Z'; // 1 hour later
    const score = computeTemporalProximity(t1, t2, oneHourMs);
    expect(score).toBeCloseTo(0.5, 5);
  });
});

// ────────────────────────────────────────────────────────
// Cosine Similarity
// ────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const vec = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('returns 0 for opposite vectors (clamped from negative)', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2], [])).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('handles vectors of different lengths (uses min length)', () => {
    const v1 = [1, 0, 0];
    const v2 = [1, 0];
    // Only compares first 2 elements: [1,0] vs [1,0] → 1.0
    expect(cosineSimilarity(v1, v2)).toBeCloseTo(1.0, 5);
  });

  it('computes correctly for known values', () => {
    // cos([1,1], [1,0]) = 1/sqrt(2) ≈ 0.7071
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(1 / Math.sqrt(2), 5);
  });
});

// ────────────────────────────────────────────────────────
// Jaccard Similarity
// ────────────────────────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical text', () => {
    expect(jaccardSimilarity('typescript react node', 'typescript react node')).toBe(1.0);
  });

  it('returns 0 for completely different text', () => {
    expect(jaccardSimilarity('python flask django', 'java spring maven')).toBe(0);
  });

  it('returns partial overlap', () => {
    // "typescript react" → tokens: {typescript, react}
    // "typescript node" → tokens: {typescript, node}
    // intersection: {typescript}, union: {typescript, react, node}
    // 1/3 ≈ 0.333
    const score = jaccardSimilarity('typescript react', 'typescript node');
    expect(score).toBeCloseTo(1 / 3, 5);
  });

  it('returns 0 for empty strings', () => {
    expect(jaccardSimilarity('', '')).toBe(0);
    expect(jaccardSimilarity('', 'hello world')).toBe(0);
    expect(jaccardSimilarity('hello world', '')).toBe(0);
  });

  it('filters out stop words', () => {
    // "the" and "and" are stop words, "cat" and "dog" are too short
    // Only meaningful tokens are compared
    expect(jaccardSimilarity('the cat', 'the dog')).toBe(0);
  });

  it('is case insensitive', () => {
    expect(jaccardSimilarity('TypeScript React', 'typescript react')).toBe(1.0);
  });

  it('handles punctuation', () => {
    // Punctuation is stripped, so "TypeScript." → "typescript"
    const score = jaccardSimilarity('TypeScript.', 'TypeScript');
    expect(score).toBe(1.0);
  });
});

// ────────────────────────────────────────────────────────
// Semantic Similarity (combined)
// ────────────────────────────────────────────────────────

describe('computeSemanticSimilarity', () => {
  it('uses cosine similarity when embeddings are available', () => {
    const nodeA = { content: 'irrelevant', embedding: [1, 0, 0] };
    const nodeB = { content: 'also irrelevant', embedding: [0, 1, 0] };
    // orthogonal → 0
    expect(computeSemanticSimilarity(nodeA, nodeB)).toBeCloseTo(0, 5);
  });

  it('uses cosine similarity for identical embeddings', () => {
    const embedding = [0.5, 0.3, 0.8, 0.1];
    const nodeA = { content: 'text', embedding };
    const nodeB = { content: 'different text', embedding };
    expect(computeSemanticSimilarity(nodeA, nodeB)).toBeCloseTo(1.0, 5);
  });

  it('falls back to Jaccard when no embeddings', () => {
    const nodeA = { content: 'typescript react development' };
    const nodeB = { content: 'typescript node development' };
    // Same as jaccardSimilarity
    const expected = jaccardSimilarity(nodeA.content, nodeB.content);
    expect(computeSemanticSimilarity(nodeA, nodeB)).toBe(expected);
  });

  it('falls back to Jaccard when embeddings are empty', () => {
    const nodeA = { content: 'typescript react', embedding: [] };
    const nodeB = { content: 'typescript react', embedding: [] };
    expect(computeSemanticSimilarity(nodeA, nodeB)).toBe(1.0);
  });
});

// ────────────────────────────────────────────────────────
// Co-occurrence
// ────────────────────────────────────────────────────────

describe('computeCoOccurrence', () => {
  it('returns 1.0 when all conversations are shared', () => {
    const data: CoOccurrenceData = {
      sharedConversations: 3,
      totalConversationsA: 3,
      totalConversationsB: 3,
    };
    expect(computeCoOccurrence(data)).toBe(1.0);
  });

  it('returns 0 when no conversations are shared', () => {
    const data: CoOccurrenceData = {
      sharedConversations: 0,
      totalConversationsA: 5,
      totalConversationsB: 3,
    };
    expect(computeCoOccurrence(data)).toBe(0);
  });

  it('returns correct Jaccard coefficient', () => {
    // A has 5, B has 4, shared 2 → union = 5+4-2 = 7, score = 2/7
    const data: CoOccurrenceData = {
      sharedConversations: 2,
      totalConversationsA: 5,
      totalConversationsB: 4,
    };
    expect(computeCoOccurrence(data)).toBeCloseTo(2 / 7, 5);
  });

  it('returns 0 for zero total conversations', () => {
    const data: CoOccurrenceData = {
      sharedConversations: 0,
      totalConversationsA: 0,
      totalConversationsB: 0,
    };
    expect(computeCoOccurrence(data)).toBe(0);
  });

  it('handles negative shared count gracefully', () => {
    const data: CoOccurrenceData = {
      sharedConversations: -1,
      totalConversationsA: 5,
      totalConversationsB: 3,
    };
    expect(computeCoOccurrence(data)).toBe(0);
  });
});

describe('computeCoOccurrenceFromNodes', () => {
  it('computes shared conversation count from node descriptors', () => {
    const nodeA = { conversationIds: ['c1', 'c2', 'c3'] };
    const nodeB = { conversationIds: ['c2', 'c3', 'c4'] };
    const data = computeCoOccurrenceFromNodes(nodeA, nodeB);
    expect(data.sharedConversations).toBe(2);
    expect(data.totalConversationsA).toBe(3);
    expect(data.totalConversationsB).toBe(3);
  });

  it('handles empty conversation lists', () => {
    const data = computeCoOccurrenceFromNodes(
      { conversationIds: [] },
      { conversationIds: ['c1'] },
    );
    expect(data.sharedConversations).toBe(0);
    expect(data.totalConversationsA).toBe(0);
    expect(data.totalConversationsB).toBe(1);
  });

  it('deduplicates conversation IDs', () => {
    const nodeA = { conversationIds: ['c1', 'c1', 'c2'] };
    const nodeB = { conversationIds: ['c2', 'c2'] };
    const data = computeCoOccurrenceFromNodes(nodeA, nodeB);
    expect(data.sharedConversations).toBe(1);
    expect(data.totalConversationsA).toBe(2); // Set deduplicates
    expect(data.totalConversationsB).toBe(1);
  });
});

// ────────────────────────────────────────────────────────
// Entity Overlap
// ────────────────────────────────────────────────────────

describe('computeEntityOverlap', () => {
  it('returns 1.0 for identical entity sets', () => {
    expect(computeEntityOverlap(['React', 'Node'], ['React', 'Node'])).toBe(1.0);
  });

  it('returns 0 for disjoint entity sets', () => {
    expect(computeEntityOverlap(['React'], ['Vue'])).toBe(0);
  });

  it('returns correct Jaccard for partial overlap', () => {
    // {react, node} ∩ {react, vue} = {react}, union = {react, node, vue}
    expect(computeEntityOverlap(['React', 'Node'], ['React', 'Vue'])).toBeCloseTo(1 / 3, 5);
  });

  it('is case insensitive', () => {
    expect(computeEntityOverlap(['REACT'], ['react'])).toBe(1.0);
  });

  it('returns 0 for empty arrays', () => {
    expect(computeEntityOverlap([], [])).toBe(0);
    expect(computeEntityOverlap(['React'], [])).toBe(0);
    expect(computeEntityOverlap([], ['React'])).toBe(0);
  });
});

// ────────────────────────────────────────────────────────
// EdgeScorer class — combined scoring
// ────────────────────────────────────────────────────────

describe('EdgeScorer', () => {
  it('creates with default config', () => {
    const scorer = new EdgeScorer();
    expect(scorer.config.weights).toEqual(DEFAULT_SCORING_WEIGHTS);
    expect(scorer.config.temporalHalfLifeMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(scorer.config.minScoreThreshold).toBe(0.1);
  });

  it('merges partial config', () => {
    const scorer = new EdgeScorer({ minScoreThreshold: 0.3 });
    expect(scorer.config.minScoreThreshold).toBe(0.3);
    expect(scorer.config.weights).toEqual(DEFAULT_SCORING_WEIGHTS);
  });

  it('merges partial weights', () => {
    const scorer = new EdgeScorer({ weights: { temporal: 0.5, semantic: 0.5, coOccurrence: 0, entityOverlap: 0 } });
    expect(scorer.config.weights.temporal).toBe(0.5);
    expect(scorer.config.weights.semantic).toBe(0.5);
  });

  describe('score()', () => {
    it('returns high score for identical nodes', () => {
      const scorer = new EdgeScorer();
      const now = new Date().toISOString();
      const node = makeNode({
        content: 'TypeScript React development project setup',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['conv-1'],
      });
      const nodeCopy = makeNode({
        id: 'node-2',
        content: 'TypeScript React development project setup',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['conv-1'],
      });

      const result = scorer.score(node, nodeCopy);
      expect(result.score).toBeGreaterThan(0.8);
      expect(result.meetsThreshold).toBe(true);
      expect(result.signals.temporal).toBe(1.0);
      expect(result.signals.semantic).toBe(1.0);
      expect(result.signals.coOccurrence).toBe(1.0);
      expect(result.signals.entityOverlap).toBe(1.0);
    });

    it('returns low score for unrelated nodes', () => {
      const scorer = new EdgeScorer();
      const nodeA = makeNode({
        content: 'TypeScript React frontend development patterns',
        createdAt: '2020-01-01T00:00:00Z',
        entities: ['TypeScript', 'React'],
        conversationIds: ['conv-1'],
      });
      const nodeB = makeNode({
        id: 'node-2',
        content: 'Python machine learning model training pipeline',
        createdAt: '2025-06-01T00:00:00Z',
        entities: ['Python', 'TensorFlow'],
        conversationIds: ['conv-99'],
      });

      const result = scorer.score(nodeA, nodeB);
      expect(result.score).toBeLessThan(0.15);
    });

    it('provides detailed signal breakdown', () => {
      const scorer = new EdgeScorer();
      const nodeA = makeNode({ content: 'hello world', entities: ['A'] });
      const nodeB = makeNode({ id: 'node-2', content: 'goodbye world', entities: ['B'] });

      const result = scorer.score(nodeA, nodeB);
      expect(result.signals).toHaveProperty('temporal');
      expect(result.signals).toHaveProperty('semantic');
      expect(result.signals).toHaveProperty('coOccurrence');
      expect(result.signals).toHaveProperty('entityOverlap');
      expect(result.weights).toEqual(DEFAULT_SCORING_WEIGHTS);
    });

    it('score is clamped to [0, 1]', () => {
      const scorer = new EdgeScorer();
      const node = makeNode();
      const result = scorer.score(node, makeNode({ id: 'n2' }));
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });

    it('meetsThreshold reflects the minScoreThreshold', () => {
      const scorer = new EdgeScorer({ minScoreThreshold: 0.99 });
      const nodeA = makeNode({ content: 'something', entities: [] });
      const nodeB = makeNode({ id: 'n2', content: 'different', entities: [] });
      const result = scorer.score(nodeA, nodeB);
      // Unless identical, hard to get 0.99
      expect(result.meetsThreshold).toBe(false);
    });

    it('uses embeddings when available', () => {
      const scorer = new EdgeScorer({
        weights: { temporal: 0, semantic: 1, coOccurrence: 0, entityOverlap: 0 },
      });

      const nodeA = makeNode({ embedding: [1, 0, 0] });
      const nodeB = makeNode({ id: 'n2', embedding: [1, 0, 0] });
      expect(scorer.score(nodeA, nodeB).score).toBeCloseTo(1.0, 2);

      const nodeC = makeNode({ id: 'n3', embedding: [0, 1, 0] });
      expect(scorer.score(nodeA, nodeC).score).toBeCloseTo(0, 2);
    });
  });

  describe('scoreMany()', () => {
    it('scores multiple candidates and returns sorted results', () => {
      const scorer = new EdgeScorer({
        weights: { temporal: 0, semantic: 1, coOccurrence: 0, entityOverlap: 0 },
      });

      const reference = makeNode({ content: 'typescript react development' });
      const candidates = [
        makeNode({ id: 'c1', content: 'python flask web development' }),
        makeNode({ id: 'c2', content: 'typescript react frontend code' }),
        makeNode({ id: 'c3', content: 'java spring enterprise application' }),
      ];

      const results = scorer.scoreMany(reference, candidates, { includeBelow: true });
      expect(results.length).toBe(3);
      // Should be sorted by score descending
      expect(results[0].breakdown.score).toBeGreaterThanOrEqual(results[1].breakdown.score);
      expect(results[1].breakdown.score).toBeGreaterThanOrEqual(results[2].breakdown.score);
      // c2 should be most similar (shares typescript, react)
      expect(results[0].node.id).toBe('c2');
    });

    it('excludes self from results', () => {
      const scorer = new EdgeScorer();
      const reference = makeNode({ id: 'self' });
      const candidates = [
        makeNode({ id: 'self' }), // Same ID
        makeNode({ id: 'other' }),
      ];

      const results = scorer.scoreMany(reference, candidates, { includeBelow: true });
      expect(results.length).toBe(1);
      expect(results[0].node.id).toBe('other');
    });

    it('filters below threshold by default', () => {
      const scorer = new EdgeScorer({ minScoreThreshold: 0.99 });
      const reference = makeNode({ content: 'typescript' });
      const candidates = [
        makeNode({ id: 'c1', content: 'python' }),
      ];

      const results = scorer.scoreMany(reference, candidates);
      expect(results.length).toBe(0);
    });

    it('includes below threshold when option is set', () => {
      const scorer = new EdgeScorer({ minScoreThreshold: 0.99 });
      const reference = makeNode({ content: 'typescript' });
      const candidates = [
        makeNode({ id: 'c1', content: 'python' }),
      ];

      const results = scorer.scoreMany(reference, candidates, { includeBelow: true });
      expect(results.length).toBe(1);
    });
  });

  describe('computeHebbianDelta()', () => {
    it('returns delta proportional to relevance', () => {
      const scorer = new EdgeScorer();
      const deltaHigh = scorer.computeHebbianDelta(0.5, 1.0);
      const deltaLow = scorer.computeHebbianDelta(0.5, 0.2);
      expect(deltaHigh).toBeGreaterThan(deltaLow);
    });

    it('uses base rate', () => {
      const scorer = new EdgeScorer();
      const delta = scorer.computeHebbianDelta(0.5, 1.0, 0.1);
      expect(delta).toBeCloseTo(0.1, 5); // baseRate * relevance = 0.1 * 1.0
    });

    it('scales with custom base rate', () => {
      const scorer = new EdgeScorer();
      const delta = scorer.computeHebbianDelta(0.5, 0.8, 0.2);
      expect(delta).toBeCloseTo(0.16, 5); // 0.2 * 0.8
    });
  });

  describe('computeInitialWeight()', () => {
    it('returns at least 0.1 for any pair', () => {
      const scorer = new EdgeScorer();
      const nodeA = makeNode({
        content: 'abc',
        createdAt: '2020-01-01T00:00:00Z',
        entities: [],
        conversationIds: ['c1'],
      });
      const nodeB = makeNode({
        id: 'n2',
        content: 'xyz',
        createdAt: '2025-12-31T00:00:00Z',
        entities: [],
        conversationIds: ['c99'],
      });
      const weight = scorer.computeInitialWeight(nodeA, nodeB);
      expect(weight).toBeGreaterThanOrEqual(0.1);
    });

    it('returns higher weight for related nodes', () => {
      const scorer = new EdgeScorer();
      const now = new Date().toISOString();

      const nodeA = makeNode({
        content: 'TypeScript React development',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['c1'],
      });
      const relatedB = makeNode({
        id: 'n2',
        content: 'TypeScript React component patterns',
        createdAt: now,
        entities: ['TypeScript', 'React'],
        conversationIds: ['c1'],
      });
      const unrelatedC = makeNode({
        id: 'n3',
        content: 'Python data science models',
        createdAt: '2020-01-01T00:00:00Z',
        entities: ['Python'],
        conversationIds: ['c99'],
      });

      const weightRelated = scorer.computeInitialWeight(nodeA, relatedB);
      const weightUnrelated = scorer.computeInitialWeight(nodeA, unrelatedC);
      expect(weightRelated).toBeGreaterThan(weightUnrelated);
    });
  });
});

// ────────────────────────────────────────────────────────
// Default config validation
// ────────────────────────────────────────────────────────

describe('DEFAULT_SCORING_WEIGHTS', () => {
  it('weights sum to 1.0', () => {
    const sum =
      DEFAULT_SCORING_WEIGHTS.temporal +
      DEFAULT_SCORING_WEIGHTS.semantic +
      DEFAULT_SCORING_WEIGHTS.coOccurrence +
      DEFAULT_SCORING_WEIGHTS.entityOverlap;
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it('all weights are non-negative', () => {
    expect(DEFAULT_SCORING_WEIGHTS.temporal).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_SCORING_WEIGHTS.semantic).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_SCORING_WEIGHTS.coOccurrence).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_SCORING_WEIGHTS.entityOverlap).toBeGreaterThanOrEqual(0);
  });
});

describe('DEFAULT_SCORER_CONFIG', () => {
  it('has reasonable defaults', () => {
    expect(DEFAULT_SCORER_CONFIG.temporalHalfLifeMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_SCORER_CONFIG.minScoreThreshold).toBe(0.1);
  });
});
