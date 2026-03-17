/**
 * Tests for FactIngestionPipeline with integrated anchor linking.
 *
 * This tests the full storeFact → anchor judgment flow:
 *   1. Fact enrichment (frontmatter + summary)
 *   2. DB persistence
 *   3. AnchorCandidateFinder (coarse filter by embedding similarity)
 *   4. AnchorLinker (LLM decides connect-to-existing / create-new)
 *
 * Two primary paths tested:
 *   A. Connect fact to EXISTING anchors — LLM sees candidates, decides to connect
 *   B. Create NEW anchors — LLM sees no relevant candidates, creates new ones
 *
 * Also covers:
 *   - Mixed path (connect + create in single ingestion)
 *   - Graceful degradation (anchor linking fails, fact still saved)
 *   - Pipeline traceability (stats available in result)
 *   - Anchor linking disabled via options
 *   - Pipeline without anchor deps (backward-compatible)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import { FactIngestionPipeline } from '../src/services/fact-ingestion-pipeline.js';
import { AnchorCandidateFinder } from '../src/services/anchor-candidate-finder.js';
import { AnchorLinker } from '../src/services/anchor-linker.js';
import type { CreateFactInput } from '../src/models/fact.js';

// ─── Test Constants & Helpers ───────────────────────────────────

const DIM = 64;
const TEST_CONV_ID = 'conv-anchor-test';

function makeFactInput(overrides: Partial<CreateFactInput> = {}): CreateFactInput {
  return {
    content: 'User prefers TypeScript for backend development',
    conversationId: TEST_CONV_ID,
    sourceMessageIds: ['msg-u1', 'msg-a1'],
    sourceTurnIndex: 1,
    confidence: 0.95,
    category: 'preference',
    entities: ['TypeScript'],
    ...overrides,
  };
}

function seedConversation(db: Database.Database): void {
  const convRepo = new ConversationRepository(db);
  convRepo.ingest({
    id: TEST_CONV_ID,
    source: 'test',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
  });
}

/**
 * Create a normalized embedding vector with high values at specific indices.
 * Vectors with overlapping high-value indices will have high cosine similarity.
 */
function makeSimilarEmbedding(hotIndices: number[], dim: number = DIM): number[] {
  const vec = new Array<number>(dim).fill(0.01);
  for (const idx of hotIndices) {
    vec[idx % dim] = 1.0;
  }
  // L2 normalize
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  return vec.map((v) => v / norm);
}

// ─── Test Suite ─────────────────────────────────────────────────

describe('FactIngestionPipeline with anchor linking', () => {
  let db: Database.Database;
  let factRepo: FactRepository;
  let anchorRepo: AnchorRepository;
  let edgeRepo: WeightedEdgeRepository;
  let mockLLM: MockLLMProvider;
  let mockEmbedding: MockEmbeddingProvider;
  let candidateFinder: AnchorCandidateFinder;
  let anchorLinker: AnchorLinker;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    factRepo = new FactRepository(db);
    anchorRepo = new AnchorRepository(db);
    edgeRepo = new WeightedEdgeRepository(db);
    mockLLM = new MockLLMProvider();
    mockEmbedding = new MockEmbeddingProvider(DIM);

    seedConversation(db);

    candidateFinder = new AnchorCandidateFinder(db, mockEmbedding, {
      similarityThreshold: 0.3,
      maxCandidates: 10,
      useDecayWeighting: false, // simpler for testing
    });

    anchorLinker = new AnchorLinker(
      mockLLM,
      mockEmbedding,
      anchorRepo,
      edgeRepo,
    );
  });

  afterEach(() => {
    db.close();
  });

  // ─── Helper: create pipeline with anchor deps ────────────────

  function createPipelineWithAnchors(
    options: Parameters<typeof FactIngestionPipeline.prototype.ingestOne>[0] extends CreateFactInput
      ? Record<string, unknown>
      : Record<string, unknown> = {},
  ) {
    return new FactIngestionPipeline(
      mockLLM,
      factRepo,
      {
        generateFrontmatter: false,
        generateSummary: false,
        ...options,
      },
      {
        anchorCandidateFinder: candidateFinder,
        anchorLinker: anchorLinker,
      },
    );
  }

  // ─── Path A: Connect to existing anchors ─────────────────────

  describe('Path A: connect fact to existing anchor', () => {
    it('connects fact to existing anchor via LLM judgment', async () => {
      // Set up: create an anchor with embedding similar to fact
      const anchorEmb = makeSimilarEmbedding([0, 1, 2, 3]);
      const anchor = anchorRepo.createAnchor({
        label: 'TypeScript',
        description: 'TypeScript programming language',
        anchorType: 'topic',
        embedding: new Float32Array(anchorEmb),
      });

      // Make fact embedding similar to anchor
      mockEmbedding.setEmbedding(
        'User prefers TypeScript for backend development',
        makeSimilarEmbedding([0, 1, 2, 3]),
      );

      // LLM calls: only anchor-linking (frontmatter/summary disabled)
      mockLLM.addResponse(
        JSON.stringify({
          connect: [{ anchorId: anchor.id, weight: 0.85, reason: 'TypeScript topic match' }],
          create: [],
        }),
      );

      const pipeline = createPipelineWithAnchors();
      const result = await pipeline.ingestOne(makeFactInput());

      // Fact should be persisted
      expect(result.facts).toHaveLength(1);
      const fact = result.facts[0];

      // Anchor link results should be present
      expect(result.anchorLinkResults).toBeDefined();
      expect(result.anchorLinkResults).toHaveLength(1);

      const linkResult = result.anchorLinkResults![0];
      expect(linkResult.connectedEdges).toHaveLength(1);
      expect(linkResult.connectedEdges[0].anchorId).toBe(anchor.id);
      expect(linkResult.connectedEdges[0].anchorLabel).toBe('TypeScript');
      expect(linkResult.connectedEdges[0].weight).toBe(0.85);
      expect(linkResult.createdAnchors).toHaveLength(0);

      // Verify weighted edge in DB
      const edges = edgeRepo.getOutgoingEdges(anchor.id);
      expect(edges).toHaveLength(1);
      expect(edges[0].targetId).toBe(fact.id);
      expect(edges[0].edgeType).toBe('anchor_to_fact');
      expect(edges[0].weight).toBe(0.85);

      // Verify anchor activation was recorded (Hebbian signal)
      const updatedAnchor = anchorRepo.getAnchor(anchor.id);
      expect(updatedAnchor!.activationCount).toBe(1);
    });

    it('connects fact to multiple existing anchors', async () => {
      const emb1 = makeSimilarEmbedding([0, 1, 2]);
      const emb2 = makeSimilarEmbedding([0, 1, 3]);

      const anchor1 = anchorRepo.createAnchor({
        label: 'TypeScript',
        description: 'TypeScript lang',
        anchorType: 'topic',
        embedding: new Float32Array(emb1),
      });
      const anchor2 = anchorRepo.createAnchor({
        label: 'Backend Dev',
        description: 'Backend development',
        anchorType: 'topic',
        embedding: new Float32Array(emb2),
      });

      mockEmbedding.setEmbedding(
        'User prefers TypeScript for backend development',
        makeSimilarEmbedding([0, 1, 2, 3]),
      );

      mockLLM.addResponse(
        JSON.stringify({
          connect: [
            { anchorId: anchor1.id, weight: 0.9 },
            { anchorId: anchor2.id, weight: 0.7 },
          ],
          create: [],
        }),
      );

      const pipeline = createPipelineWithAnchors();
      const result = await pipeline.ingestOne(makeFactInput());

      const linkResult = result.anchorLinkResults![0];
      expect(linkResult.connectedEdges).toHaveLength(2);
      expect(linkResult.stats.connectSuccesses).toBe(2);

      // Both edges in DB
      const edges1 = edgeRepo.getOutgoingEdges(anchor1.id);
      const edges2 = edgeRepo.getOutgoingEdges(anchor2.id);
      expect(edges1).toHaveLength(1);
      expect(edges2).toHaveLength(1);
    });
  });

  // ─── Path B: Create new anchors ──────────────────────────────

  describe('Path B: create new anchor for fact', () => {
    it('creates new anchor when no existing anchors match', async () => {
      // No existing anchors in DB → candidateFinder returns empty list
      mockLLM.addResponse(
        JSON.stringify({
          connect: [],
          create: [
            {
              label: 'TypeScript Preference',
              description: 'User preference for TypeScript in backend',
              anchorType: 'topic',
              weight: 0.8,
              reason: 'new topic introduced',
            },
          ],
        }),
      );

      const pipeline = createPipelineWithAnchors();
      const result = await pipeline.ingestOne(makeFactInput());

      expect(result.facts).toHaveLength(1);
      expect(result.anchorLinkResults).toBeDefined();

      const linkResult = result.anchorLinkResults![0];
      expect(linkResult.connectedEdges).toHaveLength(0);
      expect(linkResult.createdAnchors).toHaveLength(1);
      expect(linkResult.createdAnchors[0].label).toBe('TypeScript Preference');
      expect(linkResult.createdAnchors[0].weight).toBe(0.8);

      // Verify anchor persisted in DB
      const newAnchor = anchorRepo.findByLabel('TypeScript Preference');
      expect(newAnchor).not.toBeNull();
      expect(newAnchor!.anchorType).toBe('topic');
      expect(newAnchor!.description).toBe('User preference for TypeScript in backend');

      // Verify anchor has embedding (embedded immediately for future searches)
      expect(newAnchor!.embedding).toBeDefined();

      // Verify edge: new anchor → fact
      const edges = edgeRepo.getOutgoingEdges(newAnchor!.id);
      expect(edges).toHaveLength(1);
      expect(edges[0].targetId).toBe(result.facts[0].id);
      expect(edges[0].edgeType).toBe('anchor_to_fact');
    });

    it('creates multiple new anchors from a single fact', async () => {
      mockLLM.addResponse(
        JSON.stringify({
          connect: [],
          create: [
            { label: 'TypeScript', description: 'TS language', anchorType: 'entity' },
            { label: 'Backend Dev', description: 'Server-side development', anchorType: 'topic' },
          ],
        }),
      );

      const pipeline = createPipelineWithAnchors();
      const result = await pipeline.ingestOne(makeFactInput());

      const linkResult = result.anchorLinkResults![0];
      expect(linkResult.createdAnchors).toHaveLength(2);
      expect(linkResult.stats.createSuccesses).toBe(2);

      // Both anchors exist in DB
      expect(anchorRepo.findByLabel('TypeScript')).not.toBeNull();
      expect(anchorRepo.findByLabel('Backend Dev')).not.toBeNull();
    });
  });

  // ─── Mixed path: connect + create ────────────────────────────

  describe('Mixed path: connect to existing + create new', () => {
    it('handles both connect and create in single ingestion', async () => {
      const existingAnchor = anchorRepo.createAnchor({
        label: 'TypeScript',
        description: 'TypeScript language',
        anchorType: 'topic',
        embedding: new Float32Array(makeSimilarEmbedding([0, 1, 2])),
      });

      mockEmbedding.setEmbedding(
        'User prefers TypeScript for backend development',
        makeSimilarEmbedding([0, 1, 2]),
      );

      mockLLM.addResponse(
        JSON.stringify({
          connect: [{ anchorId: existingAnchor.id, weight: 0.9 }],
          create: [
            {
              label: 'Backend Preferences',
              description: 'User backend development preferences',
              anchorType: 'topic',
              weight: 0.7,
            },
          ],
        }),
      );

      const pipeline = createPipelineWithAnchors();
      const result = await pipeline.ingestOne(makeFactInput());

      const linkResult = result.anchorLinkResults![0];
      expect(linkResult.connectedEdges).toHaveLength(1);
      expect(linkResult.createdAnchors).toHaveLength(1);
      expect(linkResult.connectedEdges[0].anchorId).toBe(existingAnchor.id);
      expect(linkResult.createdAnchors[0].label).toBe('Backend Preferences');

      // Total 2 edges in DB (one per anchor→fact)
      const allEdges = edgeRepo.queryEdges({ edgeTypes: ['anchor_to_fact'] });
      expect(allEdges).toHaveLength(2);
    });
  });

  // ─── Graceful degradation ────────────────────────────────────

  describe('graceful degradation', () => {
    it('saves fact even when anchor linking LLM fails', async () => {
      // LLM will fail on anchor-linking call
      const failLLM = new MockLLMProvider();
      failLLM.complete = async () => {
        throw new Error('LLM service unavailable');
      };

      const failLinker = new AnchorLinker(
        failLLM,
        mockEmbedding,
        anchorRepo,
        edgeRepo,
      );

      const pipeline = new FactIngestionPipeline(
        failLLM,
        factRepo,
        { generateFrontmatter: false, generateSummary: false },
        { anchorCandidateFinder: candidateFinder, anchorLinker: failLinker },
      );

      const result = await pipeline.ingestOne(makeFactInput());

      // Fact is still saved
      expect(result.facts).toHaveLength(1);
      const dbFact = factRepo.getById(result.facts[0].id);
      expect(dbFact).not.toBeNull();

      // Anchor link result shows degraded but didn't crash
      expect(result.anchorLinkResults).toBeDefined();
      expect(result.anchorLinkResults![0].connectedEdges).toHaveLength(0);
      expect(result.anchorLinkResults![0].createdAnchors).toHaveLength(0);
    });

    it('saves fact even when embedding provider fails', async () => {
      const failEmbedding = new MockEmbeddingProvider(DIM);
      failEmbedding.embed = async () => {
        throw new Error('Embedding model failed');
      };

      const failFinder = new AnchorCandidateFinder(db, failEmbedding);

      const pipeline = new FactIngestionPipeline(
        mockLLM,
        factRepo,
        { generateFrontmatter: false, generateSummary: false },
        { anchorCandidateFinder: failFinder, anchorLinker: anchorLinker },
      );

      const result = await pipeline.ingestOne(makeFactInput());

      // Fact saved despite embedding failure
      expect(result.facts).toHaveLength(1);
      // Warnings should capture the embedding failure
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Anchor linking failed');
    });
  });

  // ─── Pipeline traceability ───────────────────────────────────

  describe('pipeline traceability', () => {
    it('provides anchor link stats in result', async () => {
      const anchor = anchorRepo.createAnchor({
        label: 'TypeScript',
        description: 'TS lang',
        anchorType: 'topic',
        embedding: new Float32Array(makeSimilarEmbedding([0, 1])),
      });

      mockEmbedding.setEmbedding(
        'User prefers TypeScript for backend development',
        makeSimilarEmbedding([0, 1]),
      );

      mockLLM.addResponse(
        JSON.stringify({
          connect: [{ anchorId: anchor.id, weight: 0.8 }],
          create: [],
        }),
      );

      const pipeline = createPipelineWithAnchors();
      const result = await pipeline.ingestOne(makeFactInput());

      const linkResult = result.anchorLinkResults![0];
      expect(linkResult.stats.llmTimeMs).toBeGreaterThanOrEqual(0);
      expect(linkResult.stats.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(linkResult.stats.connectAttempts).toBe(1);
      expect(linkResult.stats.connectSuccesses).toBe(1);
      expect(linkResult.factId).toBe(result.facts[0].id);
    });

    it('includes full pipeline: frontmatter + summary + anchor linking', async () => {
      // Frontmatter LLM response
      mockLLM.addResponse('TS backend pref');
      // Summary LLM response
      mockLLM.addResponse('User prefers TypeScript for backend.');
      // Anchor linker LLM response (no candidates → create new)
      mockLLM.addResponse(
        JSON.stringify({
          connect: [],
          create: [
            {
              label: 'TypeScript Usage',
              description: 'TypeScript language preferences',
              anchorType: 'topic',
            },
          ],
        }),
      );

      const pipeline = new FactIngestionPipeline(
        mockLLM,
        factRepo,
        { generateFrontmatter: true, generateSummary: true },
        { anchorCandidateFinder: candidateFinder, anchorLinker: anchorLinker },
      );

      const result = await pipeline.ingestOne(makeFactInput());

      // All three steps completed
      expect(result.facts[0].frontmatter).toBe('TS backend pref');
      expect(result.facts[0].summary).toBe('User prefers TypeScript for backend.');
      expect(result.anchorLinkResults).toHaveLength(1);
      expect(result.anchorLinkResults![0].createdAnchors).toHaveLength(1);

      // 3 LLM calls total: frontmatter + summary + anchor linking
      expect(mockLLM.calls).toHaveLength(3);
    });
  });

  // ─── Anchor linking disabled / no deps ───────────────────────

  describe('anchor linking control', () => {
    it('skips anchor linking when enableAnchorLinking is false', async () => {
      mockLLM.addResponse('label');
      mockLLM.addResponse('summary');

      const pipeline = new FactIngestionPipeline(
        mockLLM,
        factRepo,
        { enableAnchorLinking: false },
        { anchorCandidateFinder: candidateFinder, anchorLinker: anchorLinker },
      );

      const result = await pipeline.ingestOne(makeFactInput());

      expect(result.facts).toHaveLength(1);
      expect(result.anchorLinkResults).toBeUndefined();
      // Only frontmatter + summary calls, no anchor linking
      expect(mockLLM.calls).toHaveLength(2);
    });

    it('skips anchor linking when deps are not provided (backward-compatible)', async () => {
      mockLLM.addResponse('label');
      mockLLM.addResponse('summary');

      // No deps — original FactIngestionPipeline behavior
      const pipeline = new FactIngestionPipeline(mockLLM, factRepo);

      const result = await pipeline.ingestOne(makeFactInput());

      expect(result.facts).toHaveLength(1);
      expect(result.anchorLinkResults).toBeUndefined();
      expect(mockLLM.calls).toHaveLength(2);
    });

    it('skips anchor linking when only candidateFinder is provided (no linker)', async () => {
      const pipeline = new FactIngestionPipeline(
        mockLLM,
        factRepo,
        { generateFrontmatter: false, generateSummary: false },
        { anchorCandidateFinder: candidateFinder },
      );

      const result = await pipeline.ingestOne(makeFactInput());

      expect(result.facts).toHaveLength(1);
      expect(result.anchorLinkResults).toBeUndefined();
    });
  });

  // ─── Batch ingestion with anchor linking ─────────────────────

  describe('batch ingestion with anchor linking', () => {
    it('links anchors for each fact in a batch', async () => {
      // Fact 1: link LLM response — create new anchor
      mockLLM.addResponse(
        JSON.stringify({
          connect: [],
          create: [{ label: 'TypeScript', description: 'TS lang', anchorType: 'topic' }],
        }),
      );
      // Fact 2: link LLM response — create new anchor
      mockLLM.addResponse(
        JSON.stringify({
          connect: [],
          create: [{ label: 'React', description: 'React framework', anchorType: 'entity' }],
        }),
      );

      const pipeline = createPipelineWithAnchors();
      const result = await pipeline.ingestMany([
        makeFactInput({ content: 'User likes TypeScript' }),
        makeFactInput({ content: 'User uses React for frontend' }),
      ]);

      expect(result.facts).toHaveLength(2);
      expect(result.anchorLinkResults).toHaveLength(2);
      expect(result.anchorLinkResults![0].createdAnchors[0].label).toBe('TypeScript');
      expect(result.anchorLinkResults![1].createdAnchors[0].label).toBe('React');

      // Both anchors in DB
      expect(anchorRepo.countAnchors()).toBe(2);
    });
  });

  // ─── Brain-like behavior: associative recall via anchors ─────

  describe('brain-like associative behavior', () => {
    it('second fact connects to anchor created by first fact', async () => {
      // Fact 1: creates "TypeScript" anchor
      mockLLM.addResponse(
        JSON.stringify({
          connect: [],
          create: [
            {
              label: 'TypeScript',
              description: 'TypeScript programming language',
              anchorType: 'topic',
            },
          ],
        }),
      );

      const pipeline = createPipelineWithAnchors();
      const result1 = await pipeline.ingestOne(
        makeFactInput({ content: 'User prefers TypeScript for backend' }),
      );

      const createdAnchorId = result1.anchorLinkResults![0].createdAnchors[0].anchorId;

      // Now the new anchor has an embedding and is in the DB.
      // For fact 2, make the embeddings similar so candidateFinder will find it.
      const anchorFromDb = anchorRepo.getAnchor(createdAnchorId)!;
      expect(anchorFromDb.embedding).toBeDefined();

      // Set up fact 2 embedding to be similar to the anchor's embedding
      // The anchor was embedded with text "TypeScript: TypeScript programming language"
      // We need the fact content to produce a similar embedding
      const sharedEmb = makeSimilarEmbedding([5, 6, 7, 8]);

      // Override the anchor's embedding in DB to match our controlled vector
      anchorRepo.updateAnchor(createdAnchorId, {
        embedding: new Float32Array(sharedEmb),
      });

      // Fact 2's embedding will be similar
      mockEmbedding.setEmbedding(
        'TypeScript is great for type safety in APIs',
        makeSimilarEmbedding([5, 6, 7, 8]),
      );

      // LLM: connect to the TypeScript anchor that was created in step 1
      mockLLM.addResponse(
        JSON.stringify({
          connect: [{ anchorId: createdAnchorId, weight: 0.9, reason: 'same TypeScript topic' }],
          create: [],
        }),
      );

      const result2 = await pipeline.ingestOne(
        makeFactInput({ content: 'TypeScript is great for type safety in APIs' }),
      );

      // Fact 2 connected to the anchor created by Fact 1
      expect(result2.anchorLinkResults![0].connectedEdges).toHaveLength(1);
      expect(result2.anchorLinkResults![0].connectedEdges[0].anchorId).toBe(createdAnchorId);

      // Now both facts are connected via the "TypeScript" anchor
      // This is the brain-like associative link: fact1 ←→ anchor ←→ fact2
      const anchorEdges = edgeRepo.getOutgoingEdges(createdAnchorId);
      expect(anchorEdges).toHaveLength(2); // one edge to each fact
      const targetIds = anchorEdges.map((e) => e.targetId);
      expect(targetIds).toContain(result1.facts[0].id);
      expect(targetIds).toContain(result2.facts[0].id);
    });
  });
});
