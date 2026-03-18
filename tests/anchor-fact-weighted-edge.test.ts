/**
 * AC 8: anchor와 fact 사이에 weighted_edge가 생성된다
 *
 * Focused verification that weighted_edges between anchors and facts are
 * correctly created through the AnchorLinker pipeline with:
 *   1. Correct source/target types ('anchor'/'fact')
 *   2. Correct edge_type ('anchor_to_fact')
 *   3. LLM-specified weight is respected
 *   4. Hebbian parameters (initialWeight, learningRate, decayRate) are set
 *   5. Edges are queryable from both anchor side and fact side
 *   6. Metadata (reason) is stored for traceability
 *   7. Hebbian reinforcement works on anchor_to_fact edges
 *   8. Multiple facts can connect to the same anchor (fan-out)
 *   9. Same fact can connect to multiple anchors (fan-in)
 *  10. UNIQUE constraint prevents duplicate edges
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import { AnchorLinker } from '../src/services/anchor-linker.js';
import type { AnchorCandidate } from '../src/services/anchor-candidate-finder.js';
import type { Fact } from '../src/models/fact.js';

// ─── Test Helpers ────────────────────────────────────────────────

const DIM = 64;
const CONV_ID = 'conv-ac8';

function seedConversation(db: Database.Database): void {
  const convRepo = new ConversationRepository(db);
  convRepo.ingest({
    id: CONV_ID,
    source: 'test',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
  });
}

function createFact(db: Database.Database, content?: string): Fact {
  const factRepo = new FactRepository(db);
  return factRepo.createMany([{
    conversationId: CONV_ID,
    sourceMessageIds: ['msg-1'],
    sourceTurnIndex: 0,
    content: content ?? 'User prefers TypeScript for backend',
    category: 'preference',
    confidence: 0.9,
    entities: ['TypeScript'],
  }])[0];
}

function makeCandidate(anchorId: string, label: string): AnchorCandidate {
  return {
    anchorId,
    label,
    description: `${label} description`,
    anchorType: 'topic',
    similarity: 0.85,
    effectiveWeight: 0.9,
    score: 0.765,
  };
}

// ─── Test Suite ──────────────────────────────────────────────────

describe('AC 8: anchor–fact weighted_edge creation', () => {
  let db: Database.Database;
  let anchorRepo: AnchorRepository;
  let edgeRepo: WeightedEdgeRepository;
  let llm: MockLLMProvider;
  let emb: MockEmbeddingProvider;
  let linker: AnchorLinker;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    seedConversation(db);
    anchorRepo = new AnchorRepository(db);
    edgeRepo = new WeightedEdgeRepository(db);
    llm = new MockLLMProvider();
    emb = new MockEmbeddingProvider(DIM);
    linker = new AnchorLinker(llm, emb, anchorRepo, edgeRepo);
  });

  // ── 1. Correct source/target types ────────────────────────────

  it('creates edge with sourceType=anchor and targetType=fact when connecting to existing anchor', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TypeScript',
      description: 'TS lang',
      anchorType: 'topic',
    });
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.8 }],
      create: [],
    }));

    const result = await linker.linkFact(fact, [makeCandidate(anchor.id, 'TypeScript')]);

    const edge = edgeRepo.getEdge(result.connectedEdges[0].edgeId)!;
    expect(edge.sourceType).toBe('anchor');
    expect(edge.targetType).toBe('fact');
    expect(edge.sourceId).toBe(anchor.id);
    expect(edge.targetId).toBe(fact.id);
  });

  it('creates edge with sourceType=anchor and targetType=fact when creating new anchor', async () => {
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [],
      create: [{ label: 'New Topic', description: 'A new topic', anchorType: 'topic', weight: 0.7 }],
    }));

    const result = await linker.linkFact(fact, []);

    const edgeId = result.createdAnchors[0].edgeId;
    const edge = edgeRepo.getEdge(edgeId)!;
    expect(edge.sourceType).toBe('anchor');
    expect(edge.targetType).toBe('fact');
    expect(edge.targetId).toBe(fact.id);
    expect(edge.sourceId).toBe(result.createdAnchors[0].anchorId);
  });

  // ── 2. Correct edge_type ──────────────────────────────────────

  it('uses anchor_to_fact edge_type for all anchor-fact connections', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.9 }],
      create: [{ label: 'Backend', description: 'Backend dev', anchorType: 'topic' }],
    }));

    const result = await linker.linkFact(fact, [makeCandidate(anchor.id, 'TS')]);

    // Both connect and create produce anchor_to_fact edges
    const connectEdge = edgeRepo.getEdge(result.connectedEdges[0].edgeId)!;
    const createEdge = edgeRepo.getEdge(result.createdAnchors[0].edgeId)!;

    expect(connectEdge.edgeType).toBe('anchor_to_fact');
    expect(createEdge.edgeType).toBe('anchor_to_fact');
  });

  // ── 3. LLM-specified weight is respected ──────────────────────

  it('respects LLM-specified weight for connect edges', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.73 }],
      create: [],
    }));

    const result = await linker.linkFact(fact, [makeCandidate(anchor.id, 'TS')]);

    const edge = edgeRepo.getEdge(result.connectedEdges[0].edgeId)!;
    expect(edge.weight).toBe(0.73);
  });

  it('respects LLM-specified weight for create edges', async () => {
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [],
      create: [{ label: 'New', description: 'New anchor', anchorType: 'entity', weight: 0.62 }],
    }));

    const result = await linker.linkFact(fact, []);

    const edge = edgeRepo.getEdge(result.createdAnchors[0].edgeId)!;
    expect(edge.weight).toBe(0.62);
  });

  it('uses default weight 0.5 when LLM omits weight for create edges', async () => {
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [],
      create: [{ label: 'NoWeight', description: 'No weight specified', anchorType: 'topic' }],
    }));

    const result = await linker.linkFact(fact, []);

    const edge = edgeRepo.getEdge(result.createdAnchors[0].edgeId)!;
    expect(edge.weight).toBe(0.5);
  });

  // ── 4. Hebbian parameters are set ─────────────────────────────

  it('sets Hebbian parameters on newly created edges', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.8 }],
      create: [],
    }));

    const result = await linker.linkFact(fact, [makeCandidate(anchor.id, 'TS')]);

    const edge = edgeRepo.getEdge(result.connectedEdges[0].edgeId)!;
    expect(edge.initialWeight).toBe(0.8);  // matches the assigned weight
    expect(edge.learningRate).toBe(0.1);   // default Hebbian learning rate
    expect(edge.decayRate).toBe(0.01);     // default Hebbian decay rate
    expect(edge.activationCount).toBe(0);  // no activations yet
    expect(edge.lastActivatedAt).toBeUndefined();
  });

  // ── 5. Bidirectional queryability ─────────────────────────────

  it('edge is discoverable from anchor side (outgoing)', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.8 }],
      create: [],
    }));

    await linker.linkFact(fact, [makeCandidate(anchor.id, 'TS')]);

    const outgoing = edgeRepo.getOutgoingEdges(anchor.id);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].targetId).toBe(fact.id);
  });

  it('edge is discoverable from fact side (incoming)', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.8 }],
      create: [],
    }));

    await linker.linkFact(fact, [makeCandidate(anchor.id, 'TS')]);

    const incoming = edgeRepo.getIncomingEdges(fact.id);
    expect(incoming).toHaveLength(1);
    expect(incoming[0].sourceId).toBe(anchor.id);
  });

  it('edge is queryable by anchor_to_fact edge type filter', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.8 }],
      create: [],
    }));

    await linker.linkFact(fact, [makeCandidate(anchor.id, 'TS')]);

    const edges = edgeRepo.queryEdges({
      edgeTypes: ['anchor_to_fact'],
      sourceType: 'anchor',
      targetType: 'fact',
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe(anchor.id);
    expect(edges[0].targetId).toBe(fact.id);
  });

  // ── 6. Metadata (reason) for traceability ─────────────────────

  it('stores LLM reason in edge metadata for connect decisions', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.8, reason: 'direct topic relevance' }],
      create: [],
    }));

    const result = await linker.linkFact(fact, [makeCandidate(anchor.id, 'TS')]);

    const edge = edgeRepo.getEdge(result.connectedEdges[0].edgeId)!;
    expect(edge.metadata).toEqual({ reason: 'direct topic relevance' });
  });

  it('stores LLM reason in edge metadata for create decisions', async () => {
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [],
      create: [{
        label: 'New',
        description: 'New anchor',
        anchorType: 'topic',
        weight: 0.7,
        reason: 'introduces new concept',
      }],
    }));

    const result = await linker.linkFact(fact, []);

    const edge = edgeRepo.getEdge(result.createdAnchors[0].edgeId)!;
    expect(edge.metadata).toEqual({ reason: 'introduces new concept' });
  });

  // ── 7. Hebbian reinforcement on anchor_to_fact edges ──────────

  it('anchor_to_fact edges support Hebbian reinforcement', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.5 }],
      create: [],
    }));

    const result = await linker.linkFact(fact, [makeCandidate(anchor.id, 'TS')]);
    const edgeId = result.connectedEdges[0].edgeId;

    // Reinforce: delta = 0.1 * 100 * ((100 - 0.5) / 100) = 9.95
    // w_new = 0.5 + 9.95 = 10.45
    const reinforced = edgeRepo.reinforceEdge(edgeId)!;
    expect(reinforced.previousWeight).toBe(0.5);
    expect(reinforced.newWeight).toBeCloseTo(10.45, 1);
    expect(reinforced.activationCount).toBe(1);

    // Second reinforcement: delta = 0.1 * 100 * ((100 - 10.45) / 100) = 8.955
    const reinforced2 = edgeRepo.reinforceEdge(edgeId)!;
    expect(reinforced2.newWeight).toBeGreaterThan(10.45);
    expect(reinforced2.activationCount).toBe(2);
  });

  // ── 8. Fan-out: multiple facts → same anchor ─────────────────

  it('multiple facts can connect to the same anchor via separate edges', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TypeScript',
      description: 'TS lang',
      anchorType: 'topic',
    });

    const fact1 = createFact(db, 'Fact 1 about TypeScript');
    const fact2 = createFact(db, 'Fact 2 about TypeScript');

    // Link fact1
    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.8 }],
      create: [],
    }));
    await linker.linkFact(fact1, [makeCandidate(anchor.id, 'TypeScript')]);

    // Link fact2
    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.6 }],
      create: [],
    }));
    await linker.linkFact(fact2, [makeCandidate(anchor.id, 'TypeScript')]);

    // Anchor now has 2 outgoing edges
    const outgoing = edgeRepo.getOutgoingEdges(anchor.id);
    expect(outgoing).toHaveLength(2);

    const targetIds = outgoing.map(e => e.targetId);
    expect(targetIds).toContain(fact1.id);
    expect(targetIds).toContain(fact2.id);

    // Weights are different per LLM decision
    const edge1 = outgoing.find(e => e.targetId === fact1.id)!;
    const edge2 = outgoing.find(e => e.targetId === fact2.id)!;
    expect(edge1.weight).toBe(0.8);
    expect(edge2.weight).toBe(0.6);
  });

  // ── 9. Fan-in: same fact → multiple anchors ───────────────────

  it('same fact can connect to multiple anchors', async () => {
    const anchor1 = anchorRepo.createAnchor({
      label: 'TypeScript',
      description: 'TS lang',
      anchorType: 'topic',
    });
    const anchor2 = anchorRepo.createAnchor({
      label: 'Backend',
      description: 'Backend dev',
      anchorType: 'topic',
    });

    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [
        { anchorId: anchor1.id, weight: 0.9 },
        { anchorId: anchor2.id, weight: 0.7 },
      ],
      create: [],
    }));

    await linker.linkFact(fact, [
      makeCandidate(anchor1.id, 'TypeScript'),
      makeCandidate(anchor2.id, 'Backend'),
    ]);

    // Fact has 2 incoming edges from different anchors
    const incoming = edgeRepo.getIncomingEdges(fact.id);
    expect(incoming).toHaveLength(2);

    const sourceIds = incoming.map(e => e.sourceId);
    expect(sourceIds).toContain(anchor1.id);
    expect(sourceIds).toContain(anchor2.id);
  });

  // ── 10. UNIQUE constraint prevents duplicate edges ────────────

  it('prevents duplicate anchor_to_fact edge for same anchor-fact pair', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });
    const fact = createFact(db);

    // First link succeeds
    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.8 }],
      create: [],
    }));
    const result1 = await linker.linkFact(fact, [makeCandidate(anchor.id, 'TS')]);
    expect(result1.connectedEdges).toHaveLength(1);
    expect(result1.stats.connectSuccesses).toBe(1);

    // Second link to same pair should fail gracefully (UNIQUE constraint)
    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.9 }],
      create: [],
    }));
    const result2 = await linker.linkFact(fact, [makeCandidate(anchor.id, 'TS')]);

    // Should have a warning about the failure
    expect(result2.connectedEdges).toHaveLength(0);
    expect(result2.warnings.length).toBeGreaterThan(0);

    // Only 1 edge in DB (no duplicate)
    const edges = edgeRepo.getOutgoingEdges(anchor.id);
    expect(edges).toHaveLength(1);
  });

  // ── 11. findEdge works for anchor_to_fact ─────────────────────

  it('findEdge locates edge by source-target-type triplet', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });
    const fact = createFact(db);

    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.75 }],
      create: [],
    }));

    await linker.linkFact(fact, [makeCandidate(anchor.id, 'TS')]);

    const found = edgeRepo.findEdge(anchor.id, fact.id, 'anchor_to_fact');
    expect(found).not.toBeNull();
    expect(found!.weight).toBe(0.75);
    expect(found!.sourceType).toBe('anchor');
    expect(found!.targetType).toBe('fact');
  });

  // ── 12. Brain-like associative graph structure ────────────────

  it('creates a traversable anchor hub: fact1 ← anchor → fact2', async () => {
    const fact1 = createFact(db, 'TypeScript is great for type safety');
    const fact2 = createFact(db, 'TypeScript has excellent tooling support');

    // Fact 1 creates a new anchor
    llm.addResponse(JSON.stringify({
      connect: [],
      create: [{ label: 'TypeScript', description: 'TS language', anchorType: 'topic', weight: 0.9 }],
    }));
    const result1 = await linker.linkFact(fact1, []);
    const anchorId = result1.createdAnchors[0].anchorId;

    // Fact 2 connects to the same anchor
    llm.addResponse(JSON.stringify({
      connect: [{ anchorId, weight: 0.85 }],
      create: [],
    }));
    await linker.linkFact(fact2, [makeCandidate(anchorId, 'TypeScript')]);

    // Graph traversal: from anchor, find all connected facts
    const anchorEdges = edgeRepo.getOutgoingEdges(anchorId);
    expect(anchorEdges).toHaveLength(2);
    expect(anchorEdges.every(e => e.edgeType === 'anchor_to_fact')).toBe(true);

    // From fact2, find what anchors it's connected to → traverse to fact1
    const fact2Incoming = edgeRepo.getIncomingEdges(fact2.id);
    expect(fact2Incoming).toHaveLength(1);
    const sharedAnchor = fact2Incoming[0].sourceId;

    const allFactsViaAnchor = edgeRepo.getOutgoingEdges(sharedAnchor);
    const factIds = allFactsViaAnchor.map(e => e.targetId);
    expect(factIds).toContain(fact1.id);
    expect(factIds).toContain(fact2.id);

    // This proves associative recall: starting from fact2, we can discover fact1
    // through the shared anchor, which is the brain-like behavior
  });

  // ── 13. Edge weight filtering for retrieval ───────────────────

  it('edges with higher weight are retrieved first (ordered by weight DESC)', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });

    const factLow = createFact(db, 'Low relevance fact');
    const factHigh = createFact(db, 'High relevance fact');

    // Low weight edge
    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.3 }],
      create: [],
    }));
    await linker.linkFact(factLow, [makeCandidate(anchor.id, 'TS')]);

    // High weight edge
    llm.addResponse(JSON.stringify({
      connect: [{ anchorId: anchor.id, weight: 0.95 }],
      create: [],
    }));
    await linker.linkFact(factHigh, [makeCandidate(anchor.id, 'TS')]);

    // getOutgoingEdges returns by weight DESC
    const edges = edgeRepo.getOutgoingEdges(anchor.id);
    expect(edges[0].weight).toBe(0.95);
    expect(edges[0].targetId).toBe(factHigh.id);
    expect(edges[1].weight).toBe(0.3);
    expect(edges[1].targetId).toBe(factLow.id);
  });
});
