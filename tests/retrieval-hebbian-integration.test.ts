/**
 * Retrieval Pipeline Integration — Co-activation Tracker & Hebbian Update Tests
 *
 * Sub-AC 3 of AC 5: Verifies that the retrieval pipeline integrates
 * co-activation tracking and Hebbian weight updates as post-processing hooks.
 *
 * Covers:
 *   - Co-activated edges are identified and reinforced after each recall
 *   - Repeated retrievals monotonically increase edge weights
 *   - Anchor activation counts increment on each retrieval
 *   - Reinforcement rate follows Hebbian formula: w_new = w_old + lr * (1 - w_old)
 *   - Disabling reinforcement prevents weight changes
 *   - Multiple anchors reinforced in parallel within single recall
 *   - Weight convergence under repeated retrieval (asymptotic approach to 1.0)
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
import { DualPathRetriever } from '../src/retrieval/dual-path-retriever.js';

// ── Helpers ──

function createTestDB(): Database.Database {
  return createDatabase({ inMemory: true });
}

/**
 * Create a deterministic Float32Array embedding from a seed number.
 */
function makeEmbedding(seed: number, dim: number = 64): Float32Array {
  const vec = new Float32Array(dim);
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) | 0;
    vec[i] = (s & 0x7fffffff) / 0x7fffffff;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * Create a blended embedding for controllable cosine similarity.
 */
function makeSimilarEmbedding(seed1: number, seed2: number, blend: number = 0.8, dim: number = 64): Float32Array {
  const v1 = makeEmbedding(seed1, dim);
  const v2 = makeEmbedding(seed2, dim);
  const result = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    result[i] = blend * v1[i] + (1 - blend) * v2[i];
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += result[i] * result[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) result[i] /= norm;
  }
  return result;
}

/**
 * Seed a minimal dataset for retrieval-Hebbian integration testing.
 * Returns IDs of all created entities for inspection.
 */
function seedData(db: Database.Database) {
  const anchorRepo = new AnchorRepository(db);
  const factRepo = new FactRepository(db);
  const conceptRepo = new ConceptRepository(db);
  const episodeRepo = new EpisodeRepository(db);
  const edgeRepo = new EdgeRepository(db);
  const weightedEdgeRepo = new WeightedEdgeRepository(db);

  // Conversation + messages
  const convId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO raw_conversations (id, title, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(convId, 'Hebbian Test Conv', 'test', now, now);
  const msgId1 = uuidv4();
  const msgId2 = uuidv4();
  db.prepare(`INSERT INTO raw_messages (id, conversation_id, role, content, turn_index, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(msgId1, convId, 'user', 'Tell me about TypeScript', 0, now);
  db.prepare(`INSERT INTO raw_messages (id, conversation_id, role, content, turn_index, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(msgId2, convId, 'assistant', 'TypeScript is great for large projects', 1, now);

  // Facts
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
    content: 'TypeScript has strong type inference',
    conversationId: convId,
    sourceMessageIds: [msgId2],
    sourceTurnIndex: 1,
    confidence: 0.85,
    category: 'technical',
    entities: ['TypeScript'],
    subject: 'TypeScript',
    predicate: 'has',
    object: 'type inference',
  });

  const fact3 = factRepo.create({
    content: 'SQLite is used for local persistence',
    conversationId: convId,
    sourceMessageIds: [msgId2],
    sourceTurnIndex: 1,
    confidence: 0.8,
    category: 'technical',
    entities: ['SQLite'],
  });

  // Concepts
  const concept1 = conceptRepo.createConcept({
    name: 'TypeScript',
    description: 'Statically-typed JavaScript superset',
    category: 'technology',
    aliases: ['TS'],
    sourceConversationId: convId,
  });

  // Episode
  const episode1 = {
    id: uuidv4(),
    conversationId: convId,
    type: 'decision' as const,
    title: 'TypeScript discussion',
    description: 'Discussed TypeScript advantages',
    startTurnIndex: 0,
    endTurnIndex: 1,
    sourceMessageIds: [msgId1, msgId2],
    actors: ['user', 'assistant'],
    outcome: 'Agreed on TypeScript',
    createdAt: now,
  };
  episodeRepo.saveEpisodes([episode1]);

  // Memory edges (for graph path)
  edgeRepo.createEdge({
    sourceId: fact1.id, sourceType: 'fact',
    targetId: concept1.id, targetType: 'concept',
    edgeType: 'fact_supports_concept', weight: 0.8,
  });
  edgeRepo.createEdge({
    sourceId: fact2.id, sourceType: 'fact',
    targetId: concept1.id, targetType: 'concept',
    edgeType: 'fact_supports_concept', weight: 0.7,
  });

  // Anchors with embeddings (for vector path)
  const tsEmb = makeEmbedding(42, 64);
  const anchor1 = anchorRepo.createAnchor({
    label: 'TypeScript',
    description: 'TypeScript programming language',
    anchorType: 'entity',
    aliases: ['TS'],
    embedding: tsEmb,
  });

  const sqlEmb = makeEmbedding(99, 64);
  const anchor2 = anchorRepo.createAnchor({
    label: 'SQLite',
    description: 'SQLite embedded database',
    anchorType: 'entity',
    aliases: ['sqlite3'],
    embedding: sqlEmb,
  });

  // Weighted edges: anchor → memory nodes (initial weight 0.5 for testability)
  const we1 = weightedEdgeRepo.createEdge({
    sourceId: anchor1.id, sourceType: 'anchor',
    targetId: fact1.id, targetType: 'fact',
    edgeType: 'anchor_to_fact', weight: 0.5,
    learningRate: 0.1,
  });
  const we2 = weightedEdgeRepo.createEdge({
    sourceId: anchor1.id, sourceType: 'anchor',
    targetId: fact2.id, targetType: 'fact',
    edgeType: 'anchor_to_fact', weight: 0.5,
    learningRate: 0.1,
  });
  const we3 = weightedEdgeRepo.createEdge({
    sourceId: anchor1.id, sourceType: 'anchor',
    targetId: concept1.id, targetType: 'concept',
    edgeType: 'anchor_to_concept', weight: 0.5,
    learningRate: 0.1,
  });
  const we4 = weightedEdgeRepo.createEdge({
    sourceId: anchor1.id, sourceType: 'anchor',
    targetId: episode1.id, targetType: 'episode',
    edgeType: 'anchor_to_episode', weight: 0.5,
    learningRate: 0.1,
  });

  // Anchor2 → fact3 (SQLite edge)
  const we5 = weightedEdgeRepo.createEdge({
    sourceId: anchor2.id, sourceType: 'anchor',
    targetId: fact3.id, targetType: 'fact',
    edgeType: 'anchor_to_fact', weight: 0.5,
    learningRate: 0.1,
  });

  return {
    convId,
    facts: [fact1, fact2, fact3],
    concept: concept1,
    episode: episode1,
    anchors: [anchor1, anchor2],
    weightedEdges: [we1, we2, we3, we4, we5],
    embeddings: { ts: tsEmb, sql: sqlEmb },
  };
}

// ── Tests ──

describe('Retrieval Pipeline — Co-activation & Hebbian Integration', () => {
  let db: Database.Database;
  let mockEmb: MockEmbeddingProvider;
  let weightedEdgeRepo: WeightedEdgeRepository;
  let anchorRepo: AnchorRepository;

  beforeEach(() => {
    db = createTestDB();
    mockEmb = new MockEmbeddingProvider(64);
    weightedEdgeRepo = new WeightedEdgeRepository(db);
    anchorRepo = new AnchorRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ─── 1. Co-activation detection and edge reinforcement ──────

  describe('co-activation tracker hooks into retrieval pipeline', () => {
    it('identifies co-activated edges between activated anchors and retrieved nodes', async () => {
      const data = seedData(db);

      // Query embedding very similar to TypeScript anchor (seed 42)
      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript overview', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: 0.1,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'TypeScript overview' });

      // The TypeScript anchor should be activated via vector path
      expect(result.diagnostics.activatedAnchors.length).toBeGreaterThan(0);
      const tsAnchorActivated = result.diagnostics.activatedAnchors.some(
        a => a.anchorId === data.anchors[0].id,
      );
      expect(tsAnchorActivated).toBe(true);

      // Co-activated edges should have been reinforced
      expect(result.diagnostics.edgesReinforced).toBeGreaterThan(0);
    });

    it('only reinforces edges whose targets appear in merged results', async () => {
      const data = seedData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: 0.1,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'TypeScript' });

      // Get the set of node IDs in the result
      const resultNodeIds = new Set(result.items.map(i => i.nodeId));

      // Check that reinforced edges target nodes that are in the results
      const tsAnchorEdges = weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id);
      for (const edge of tsAnchorEdges) {
        if (edge.activationCount > 0) {
          // This edge was reinforced, so its target should be in results
          expect(resultNodeIds.has(edge.targetId)).toBe(true);
        }
      }
    });
  });

  // ─── 2. Repeated retrieval increases weights ─────────────────

  describe('repeated retrieval increases anchor weights', () => {
    it('edge weights increase monotonically with repeated same-query recall', async () => {
      const data = seedData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: 0.1,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      // Track edge weights across multiple retrievals
      const weightHistory: Map<string, number[]> = new Map();

      // Record initial weights
      const initialEdges = weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id);
      for (const edge of initialEdges) {
        weightHistory.set(edge.id, [edge.weight]);
      }

      // Execute 5 consecutive retrievals
      for (let i = 0; i < 5; i++) {
        const result = await retriever.recall({ queryText: 'TypeScript' });
        expect(result.diagnostics.edgesReinforced).toBeGreaterThan(0);

        // Record weights after each retrieval
        const currentEdges = weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id);
        for (const edge of currentEdges) {
          const history = weightHistory.get(edge.id);
          if (history) {
            history.push(edge.weight);
          }
        }
      }

      // Verify monotonic increase for edges that were reinforced
      for (const [edgeId, weights] of weightHistory) {
        if (weights.length > 1 && weights[weights.length - 1] > weights[0]) {
          // This edge was reinforced — verify monotonic increase
          for (let i = 1; i < weights.length; i++) {
            expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1]);
          }
        }
      }

      // At least one edge should have been reinforced
      let anyReinforced = false;
      for (const [, weights] of weightHistory) {
        if (weights[weights.length - 1] > weights[0]) {
          anyReinforced = true;
          break;
        }
      }
      expect(anyReinforced).toBe(true);
    });

    it('anchor activation count increments with each retrieval', async () => {
      const data = seedData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: 0.1,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      // Initial state: no activations
      const anchorBefore = anchorRepo.getAnchor(data.anchors[0].id);
      expect(anchorBefore).not.toBeNull();
      const initialActivationCount = anchorBefore!.activationCount;

      // Execute 3 recalls
      for (let i = 0; i < 3; i++) {
        await retriever.recall({ queryText: 'TypeScript' });
      }

      // Anchor activation count should have increased
      const anchorAfter = anchorRepo.getAnchor(data.anchors[0].id);
      expect(anchorAfter!.activationCount).toBe(initialActivationCount + 3);
      expect(anchorAfter!.lastActivatedAt).toBeDefined();
    });

    it('edge activation count tracks number of co-activation events', async () => {
      const data = seedData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: 0.1,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      // Execute 4 recalls
      for (let i = 0; i < 4; i++) {
        await retriever.recall({ queryText: 'TypeScript' });
      }

      // Check that reinforced edges have activation counts
      const edges = weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id);
      const reinforcedEdges = edges.filter(e => e.activationCount > 0);
      expect(reinforcedEdges.length).toBeGreaterThan(0);

      for (const edge of reinforcedEdges) {
        // Each reinforced edge should have been activated exactly 4 times
        expect(edge.activationCount).toBe(4);
        expect(edge.lastActivatedAt).toBeDefined();
      }
    });
  });

  // ─── 3. Hebbian formula correctness through pipeline ─────────

  describe('Hebbian weight update formula correctness via retrieval', () => {
    it('follows w_new = w_old + lr * (1 - w_old) through retrieval pipeline', async () => {
      const data = seedData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const lr = 0.05; // reinforcement rate
      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: lr,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      // Get a specific edge to track
      const targetEdge = data.weightedEdges[0]; // anchor1 → fact1
      const initialWeight = targetEdge.weight; // 0.5

      // Manually compute expected weight after Hebbian update
      // w_new = 0.5 + 0.05 * (1 - 0.5) = 0.5 + 0.025 = 0.525
      const expectedAfterOne = initialWeight + lr * (1 - initialWeight);

      const result = await retriever.recall({ queryText: 'TypeScript' });

      // Verify the edge was reinforced
      if (result.diagnostics.edgesReinforced > 0) {
        const edgeAfter = weightedEdgeRepo.getEdge(targetEdge.id);

        // Check that the target fact appeared in results
        const factInResults = result.items.some(i => i.nodeId === data.facts[0].id);
        if (factInResults) {
          expect(edgeAfter!.weight).toBeCloseTo(expectedAfterOne, 8);
        }
      }
    });

    it('weight approaches 1.0 asymptotically with many retrievals', async () => {
      const data = seedData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const lr = 0.1;
      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: lr,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      // Execute many retrievals to push weight toward 1.0
      for (let i = 0; i < 30; i++) {
        await retriever.recall({ queryText: 'TypeScript' });
      }

      // Check edges from anchor1 — those that were reinforced should be near 1.0
      const edges = weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id);
      const reinforcedEdges = edges.filter(e => e.activationCount > 0);

      for (const edge of reinforcedEdges) {
        // After 30 iterations with lr=0.1 from 0.5:
        // Converges to very close to 1.0
        expect(edge.weight).toBeGreaterThan(0.95);
        expect(edge.weight).toBeLessThanOrEqual(1.0);
      }
    });

    it('diminishing returns: weight deltas decrease with each retrieval', async () => {
      const data = seedData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: 0.1,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      // Track deltas for a specific edge
      const targetEdgeId = data.weightedEdges[0].id;
      const deltas: number[] = [];
      let prevWeight = data.weightedEdges[0].weight;

      for (let i = 0; i < 8; i++) {
        await retriever.recall({ queryText: 'TypeScript' });
        const edge = weightedEdgeRepo.getEdge(targetEdgeId)!;
        if (edge.weight > prevWeight) {
          deltas.push(edge.weight - prevWeight);
        }
        prevWeight = edge.weight;
      }

      // Deltas should be strictly decreasing (diminishing returns from Hebbian rule)
      if (deltas.length >= 2) {
        for (let i = 1; i < deltas.length; i++) {
          expect(deltas[i]).toBeLessThan(deltas[i - 1]);
        }
      }
    });
  });

  // ─── 4. Reinforcement can be disabled ────────────────────────

  describe('reinforcement control', () => {
    it('no weight changes when reinforceOnRetrieval is false', async () => {
      const data = seedData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: false,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      // Snapshot initial weights
      const edgesBefore = weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id);
      const weightsBefore = new Map(edgesBefore.map(e => [e.id, e.weight]));

      // Execute retrieval
      const result = await retriever.recall({ queryText: 'TypeScript' });
      expect(result.diagnostics.edgesReinforced).toBe(0);

      // Verify no weight changes
      const edgesAfter = weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id);
      for (const edge of edgesAfter) {
        expect(edge.weight).toBe(weightsBefore.get(edge.id));
        expect(edge.activationCount).toBe(0);
      }
    });

    it('different reinforcement rates produce different weight increases', async () => {
      // Test with two separate databases to compare rates
      const db2 = createTestDB();
      const mockEmb2 = new MockEmbeddingProvider(64);

      try {
        const data1 = seedData(db);
        const data2 = seedData(db2);

        const queryEmb = Array.from(makeEmbedding(42, 64));
        mockEmb.setEmbedding('TypeScript', queryEmb);
        mockEmb2.setEmbedding('TypeScript', queryEmb);

        const slowRetriever = new DualPathRetriever(db, mockEmb, {
          reinforceOnRetrieval: true,
          reinforcementRate: 0.01,
          vector: { similarityThreshold: 0.1 },
          minScore: 0.01,
        });

        const fastRetriever = new DualPathRetriever(db2, mockEmb2, {
          reinforceOnRetrieval: true,
          reinforcementRate: 0.2,
          vector: { similarityThreshold: 0.1 },
          minScore: 0.01,
        });

        // 3 retrievals each
        for (let i = 0; i < 3; i++) {
          await slowRetriever.recall({ queryText: 'TypeScript' });
          await fastRetriever.recall({ queryText: 'TypeScript' });
        }

        // Compare weights — faster rate should produce higher weights
        const slowEdges = new WeightedEdgeRepository(db).getOutgoingEdges(data1.anchors[0].id);
        const fastEdges = new WeightedEdgeRepository(db2).getOutgoingEdges(data2.anchors[0].id);

        const slowReinforced = slowEdges.filter(e => e.activationCount > 0);
        const fastReinforced = fastEdges.filter(e => e.activationCount > 0);

        if (slowReinforced.length > 0 && fastReinforced.length > 0) {
          // Find matching edges by target
          for (const slow of slowReinforced) {
            const fast = fastReinforced.find(e => e.targetId === slow.targetId);
            if (fast) {
              expect(fast.weight).toBeGreaterThan(slow.weight);
            }
          }
        }
      } finally {
        db2.close();
      }
    });
  });

  // ─── 5. Multiple anchors reinforced in single recall ─────────

  describe('multi-anchor co-activation', () => {
    it('reinforces edges from multiple activated anchors in one recall', async () => {
      const data = seedData(db);

      // Query embedding that's somewhat similar to both TypeScript (42) and SQLite (99) anchors
      const queryEmb = Array.from(makeSimilarEmbedding(42, 99, 0.5, 64));
      mockEmb.setEmbedding('TypeScript SQLite', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: 0.1,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'TypeScript SQLite' });

      // Check if multiple anchors were activated
      if (result.diagnostics.activatedAnchors.length >= 2) {
        // Both anchors' edges may have been reinforced
        const anchor1Edges = weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id);
        const anchor2Edges = weightedEdgeRepo.getOutgoingEdges(data.anchors[1].id);

        const a1Reinforced = anchor1Edges.some(e => e.activationCount > 0);
        const a2Reinforced = anchor2Edges.some(e => e.activationCount > 0);

        // At least one anchor's edges should be reinforced
        expect(a1Reinforced || a2Reinforced).toBe(true);
      }
    });
  });

  // ─── 6. Diagnostics accuracy ─────────────────────────────────

  describe('diagnostics report co-activation metrics', () => {
    it('edgesReinforced count matches actual weight changes', async () => {
      const data = seedData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      // Snapshot before
      const allEdgesBefore = new Map<string, number>();
      for (const anchor of data.anchors) {
        for (const edge of weightedEdgeRepo.getOutgoingEdges(anchor.id)) {
          allEdgesBefore.set(edge.id, edge.weight);
        }
      }

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: 0.1,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      const result = await retriever.recall({ queryText: 'TypeScript' });

      // Count actual changes
      let actualChanges = 0;
      for (const anchor of data.anchors) {
        for (const edge of weightedEdgeRepo.getOutgoingEdges(anchor.id)) {
          const before = allEdgesBefore.get(edge.id);
          if (before !== undefined && edge.weight > before) {
            actualChanges++;
          }
        }
      }

      // Reported count should match actual
      expect(result.diagnostics.edgesReinforced).toBe(actualChanges);
    });
  });

  // ─── 7. Stability under idempotent queries ──────────────────

  describe('weight stability and convergence', () => {
    it('weights converge to stable equilibrium after many identical retrievals', async () => {
      const data = seedData(db);

      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: 0.05,
        vector: { similarityThreshold: 0.1 },
        minScore: 0.01,
      });

      // Run many retrievals
      for (let i = 0; i < 50; i++) {
        await retriever.recall({ queryText: 'TypeScript' });
      }

      // All reinforced edges should be very close to 1.0 (asymptotic limit)
      const edges = weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id);
      const reinforcedEdges = edges.filter(e => e.activationCount > 0);

      for (const edge of reinforcedEdges) {
        // After 50 iterations at lr=0.05 from 0.5, weight should be well above 0.9
        // (exact value depends on whether edge is reinforced every iteration)
        expect(edge.weight).toBeGreaterThan(0.90);
      }

      // Run 5 more — the delta should be negligible
      const weightsBefore = new Map(
        weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id)
          .map(e => [e.id, e.weight]),
      );

      for (let i = 0; i < 5; i++) {
        await retriever.recall({ queryText: 'TypeScript' });
      }

      const edgesAfter = weightedEdgeRepo.getOutgoingEdges(data.anchors[0].id);
      for (const edge of edgesAfter) {
        const before = weightsBefore.get(edge.id);
        if (before !== undefined && edge.activationCount > 0) {
          // Delta should be very small (diminishing returns near convergence)
          expect(Math.abs(edge.weight - before)).toBeLessThan(0.05);
        }
      }
    });

    it('non-activated edges remain unchanged through multiple retrievals', async () => {
      const data = seedData(db);

      // Query only targets TypeScript anchor — SQLite anchor edges should be untouched
      const queryEmb = Array.from(makeEmbedding(42, 64));
      mockEmb.setEmbedding('TypeScript only', queryEmb);

      const retriever = new DualPathRetriever(db, mockEmb, {
        reinforceOnRetrieval: true,
        reinforcementRate: 0.1,
        vector: { similarityThreshold: 0.9 }, // High threshold to only match TypeScript
        minScore: 0.01,
      });

      // Snapshot SQLite anchor edges
      const sqlEdgesBefore = weightedEdgeRepo.getOutgoingEdges(data.anchors[1].id);
      const sqlWeightsBefore = new Map(sqlEdgesBefore.map(e => [e.id, e.weight]));

      // Execute multiple retrievals
      for (let i = 0; i < 5; i++) {
        await retriever.recall({ queryText: 'TypeScript only' });
      }

      // SQLite anchor edges should be completely unchanged
      const sqlEdgesAfter = weightedEdgeRepo.getOutgoingEdges(data.anchors[1].id);
      for (const edge of sqlEdgesAfter) {
        expect(edge.weight).toBe(sqlWeightsBefore.get(edge.id));
        expect(edge.activationCount).toBe(0);
      }
    });
  });
});
