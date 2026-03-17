/**
 * AC 7: 새 anchor 생성 시 로컬 임베딩 벡터가 anchors 테이블에 저장된다
 *
 * Validates the full round-trip:
 *   1. AnchorLinker creates a new anchor via LLM decision
 *   2. EmbeddingProvider generates a local embedding for the anchor
 *   3. Float32Array is serialized → BLOB and stored in anchors table
 *   4. BLOB can be deserialized back to Float32Array with correct values
 *   5. Stored embedding is usable for cosine similarity (future retrieval)
 *   6. Anchor appears in getAnchorsWithEmbeddings() for candidate search
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import { AnchorLinker } from '../src/services/anchor-linker.js';
import {
  cosineSimilarityVec,
  bufferToFloat32Array,
} from '../src/retrieval/vector-searcher.js';
import type { Fact } from '../src/models/fact.js';
import type Database from 'better-sqlite3';

// ─── Test Helpers ────────────────────────────────────────────────

const DIM = 64;
const TEST_CONV_ID = 'conv-1';

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

function makeFact(db: Database.Database): Fact {
  const factRepo = new FactRepository(db);
  const facts = factRepo.createMany([
    {
      conversationId: TEST_CONV_ID,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      content: 'User prefers TypeScript for backend development',
      category: 'preference',
      confidence: 0.9,
      entities: ['TypeScript'],
    },
  ]);
  return facts[0];
}

// ─── Tests ───────────────────────────────────────────────────────

describe('AC 7: Anchor embedding storage on creation', () => {
  let db: Database.Database;
  let anchorRepo: AnchorRepository;
  let edgeRepo: WeightedEdgeRepository;
  let llmProvider: MockLLMProvider;
  let embeddingProvider: MockEmbeddingProvider;
  let linker: AnchorLinker;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    seedConversation(db);
    anchorRepo = new AnchorRepository(db);
    edgeRepo = new WeightedEdgeRepository(db);
    llmProvider = new MockLLMProvider();
    embeddingProvider = new MockEmbeddingProvider(DIM);
    linker = new AnchorLinker(llmProvider, embeddingProvider, anchorRepo, edgeRepo);
  });

  it('stores embedding BLOB in anchors table when new anchor is created', async () => {
    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          {
            label: 'Backend Development',
            description: 'Server-side development preferences',
            anchorType: 'topic',
            weight: 0.7,
          },
        ],
      }),
    );

    const result = await linker.linkFact(fact, []);
    expect(result.createdAnchors).toHaveLength(1);

    // Verify embedding is stored in DB
    const anchor = anchorRepo.getAnchor(result.createdAnchors[0].anchorId);
    expect(anchor).not.toBeNull();
    expect(anchor!.embedding).toBeDefined();
    expect(anchor!.embedding).toBeInstanceOf(Float32Array);
    expect(anchor!.embeddingDim).toBe(DIM);
    expect(anchor!.embedding!.length).toBe(DIM);
  });

  it('stored embedding values match what the EmbeddingProvider produced', async () => {
    // Register a known embedding for the anchor text
    const knownEmbedding = new Array(DIM).fill(0).map((_, i) => (i + 1) / DIM);
    // Normalize it
    const norm = Math.sqrt(knownEmbedding.reduce((s, v) => s + v * v, 0));
    const normalized = knownEmbedding.map((v) => v / norm);

    embeddingProvider.setEmbedding(
      'Backend Development: Server-side development preferences',
      normalized,
    );

    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          {
            label: 'Backend Development',
            description: 'Server-side development preferences',
            anchorType: 'topic',
          },
        ],
      }),
    );

    const result = await linker.linkFact(fact, []);
    const anchor = anchorRepo.getAnchor(result.createdAnchors[0].anchorId);

    // Values should match (within Float32 precision)
    for (let i = 0; i < DIM; i++) {
      expect(anchor!.embedding![i]).toBeCloseTo(normalized[i], 5);
    }
  });

  it('embedding BLOB round-trips through SQLite (serialize → store → deserialize)', async () => {
    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          {
            label: 'Round Trip Test',
            description: 'Testing BLOB round-trip',
            anchorType: 'topic',
          },
        ],
      }),
    );

    await linker.linkFact(fact, []);

    // Read directly from SQLite to verify BLOB is stored
    const row = db
      .prepare('SELECT embedding, embedding_dim FROM anchors WHERE label = ?')
      .get('Round Trip Test') as { embedding: Buffer; embedding_dim: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.embedding).toBeInstanceOf(Buffer);
    expect(row!.embedding_dim).toBe(DIM);

    // Deserialize using VectorSearcher helper
    const deserialized = bufferToFloat32Array(row!.embedding, row!.embedding_dim);
    expect(deserialized).not.toBeNull();
    expect(deserialized!.length).toBe(DIM);

    // All values should be finite numbers
    for (let i = 0; i < DIM; i++) {
      expect(Number.isFinite(deserialized![i])).toBe(true);
    }
  });

  it('stored embedding is usable for cosine similarity computation', async () => {
    // Create a known embedding so we can verify similarity
    const anchorEmbedding = new Array(DIM).fill(0).map((_, i) => (i % 2 === 0 ? 0.5 : -0.5));
    const normA = Math.sqrt(anchorEmbedding.reduce((s, v) => s + v * v, 0));
    const normalizedAnchor = anchorEmbedding.map((v) => v / normA);

    embeddingProvider.setEmbedding(
      'Cosine Test: Anchor for similarity testing',
      normalizedAnchor,
    );

    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          {
            label: 'Cosine Test',
            description: 'Anchor for similarity testing',
            anchorType: 'topic',
          },
        ],
      }),
    );

    await linker.linkFact(fact, []);

    // Retrieve the stored anchor embedding
    const anchor = anchorRepo.findByLabel('Cosine Test');
    expect(anchor!.embedding).toBeDefined();

    // Compute self-similarity (should be ≈ 1.0 for normalized vectors)
    const selfSim = cosineSimilarityVec(normalizedAnchor, anchor!.embedding!);
    expect(selfSim).toBeCloseTo(1.0, 4);

    // Compute similarity with a different vector (should be < 1.0)
    const differentVec = new Array(DIM).fill(1 / Math.sqrt(DIM));
    const diffSim = cosineSimilarityVec(differentVec, anchor!.embedding!);
    expect(diffSim).toBeGreaterThanOrEqual(0);
    expect(diffSim).toBeLessThan(1.0);
  });

  it('newly created anchor appears in getAnchorsWithEmbeddings()', async () => {
    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          {
            label: 'Discoverable Anchor',
            description: 'Should appear in embedding search',
            anchorType: 'entity',
          },
        ],
      }),
    );

    await linker.linkFact(fact, []);

    // getAnchorsWithEmbeddings is used by AnchorCandidateFinder to load candidates
    const anchorsWithEmb = anchorRepo.getAnchorsWithEmbeddings();
    expect(anchorsWithEmb.length).toBeGreaterThanOrEqual(1);

    const found = anchorsWithEmb.find((a) => a.label === 'Discoverable Anchor');
    expect(found).toBeDefined();
    expect(found!.embedding).toBeDefined();
    expect(found!.embeddingDim).toBe(DIM);
  });

  it('embedding text combines label + description for semantic richness', async () => {
    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          {
            label: 'Machine Learning',
            description: 'AI and deep learning techniques',
            anchorType: 'topic',
          },
        ],
      }),
    );

    await linker.linkFact(fact, []);

    // Verify the embedding was requested with "label: description" format
    const embedCall = embeddingProvider.calls.find(
      (c) => c.text === 'Machine Learning: AI and deep learning techniques',
    );
    expect(embedCall).toBeDefined();
  });

  it('multiple new anchors each get their own embedding', async () => {
    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          {
            label: 'Anchor A',
            description: 'First anchor',
            anchorType: 'topic',
          },
          {
            label: 'Anchor B',
            description: 'Second anchor',
            anchorType: 'entity',
          },
        ],
      }),
    );

    const result = await linker.linkFact(fact, []);
    expect(result.createdAnchors).toHaveLength(2);

    // Both anchors should have embeddings
    for (const created of result.createdAnchors) {
      const anchor = anchorRepo.getAnchor(created.anchorId);
      expect(anchor!.embedding).toBeDefined();
      expect(anchor!.embeddingDim).toBe(DIM);
    }

    // Embeddings should be different (different label+description)
    const a = anchorRepo.findByLabel('Anchor A');
    const b = anchorRepo.findByLabel('Anchor B');
    const sim = cosineSimilarityVec(
      Array.from(a!.embedding!),
      b!.embedding!,
    );
    // Different texts produce different embeddings (similarity < 1)
    expect(sim).toBeLessThan(1.0);
  });

  it('anchor without embedding (embedNewAnchors=false) does NOT appear in getAnchorsWithEmbeddings', async () => {
    const noEmbedLinker = new AnchorLinker(
      llmProvider,
      embeddingProvider,
      anchorRepo,
      edgeRepo,
      { embedNewAnchors: false },
    );

    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          {
            label: 'No Embed Anchor',
            description: 'Should not have embedding',
            anchorType: 'topic',
          },
        ],
      }),
    );

    await noEmbedLinker.linkFact(fact, []);

    const anchorsWithEmb = anchorRepo.getAnchorsWithEmbeddings();
    const found = anchorsWithEmb.find((a) => a.label === 'No Embed Anchor');
    expect(found).toBeUndefined();
  });

  it('embedding survives anchor update (embedding is preserved)', async () => {
    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          {
            label: 'Persistent Embedding',
            description: 'Embedding should survive updates',
            anchorType: 'topic',
          },
        ],
      }),
    );

    const result = await linker.linkFact(fact, []);
    const anchorId = result.createdAnchors[0].anchorId;

    // Get original embedding
    const original = anchorRepo.getAnchor(anchorId);
    const originalEmbedding = Array.from(original!.embedding!);

    // Update anchor (record activation)
    anchorRepo.recordActivation(anchorId);

    // Verify embedding is preserved after update
    const updated = anchorRepo.getAnchor(anchorId);
    expect(updated!.embedding).toBeDefined();
    expect(updated!.embeddingDim).toBe(DIM);

    for (let i = 0; i < DIM; i++) {
      expect(updated!.embedding![i]).toBeCloseTo(originalEmbedding[i], 5);
    }
  });
});
