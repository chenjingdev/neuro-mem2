/**
 * Integration test: Cross-session fact recall via anchor-based associative memory.
 *
 * Sub-AC 3 of AC 12: Verifies that facts stored in one "session" (conversation)
 * can be recalled in a new session via related queries — the core brain-like
 * behavior where anchor associations enable cross-session memory retrieval.
 *
 * End-to-end flow:
 *   1. Session A: Store facts and create anchors with embeddings + weighted edges
 *   2. Session B: Query with a related (but different) text
 *   3. Verify: Previous facts appear in retrieval results via anchor activation
 *
 * This tests the full pipeline:
 *   Fact → Anchor → Embedding → WeightedEdge → Query → CosineSim → Expansion → Recall
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import { UnifiedRetriever } from '../src/retrieval/unified-retriever.js';
import type Database from 'better-sqlite3';

// ─── Test Helpers ────────────────────────────────────────────────

const DIM = 8;

function unitVector(dim: number, index: number): number[] {
  const v = new Array(dim).fill(0);
  v[index] = 1.0;
  return v;
}

/** Create a vector with a dominant component and minor noise for realistic similarity */
function biasedVector(dim: number, primary: number, secondary?: number, blend = 0.3): number[] {
  const v = new Array(dim).fill(0);
  v[primary] = 1.0;
  if (secondary !== undefined) {
    v[secondary] = blend;
  }
  // L2 normalize
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return v.map(x => x / norm);
}

function toFloat32(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

// ─── Test Suite ──────────────────────────────────────────────────

describe('Cross-session fact recall (integration)', () => {
  let db: Database.Database;
  let anchorRepo: AnchorRepository;
  let edgeRepo: WeightedEdgeRepository;
  let factRepo: FactRepository;
  let convRepo: ConversationRepository;
  let embeddingProvider: MockEmbeddingProvider;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    anchorRepo = new AnchorRepository(db);
    edgeRepo = new WeightedEdgeRepository(db);
    factRepo = new FactRepository(db);
    convRepo = new ConversationRepository(db);
    embeddingProvider = new MockEmbeddingProvider(DIM);
  });

  /**
   * Helper: Simulate ingestion — create a fact, an anchor, an embedding, and a weighted edge.
   * This mirrors what FactIngestionPipeline + AnchorLinker would do in production.
   */
  function ingestFactWithAnchor(opts: {
    conversationId: string;
    factContent: string;
    anchorLabel: string;
    anchorDescription: string;
    anchorEmbedding: number[];
    edgeWeight?: number;
    summary?: string;
    frontmatter?: string;
  }) {
    const fact = factRepo.create({
      content: opts.factContent,
      conversationId: opts.conversationId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: [],
    });

    // Update summary/frontmatter if provided (simulates Level 0/1 enrichment)
    if (opts.summary || opts.frontmatter) {
      factRepo.update(fact.id, {
        summary: opts.summary,
        frontmatter: opts.frontmatter,
      });
    }

    // Check if anchor already exists (by label) — reuse if so
    let anchor = anchorRepo.findByLabel(opts.anchorLabel);
    if (!anchor) {
      anchor = anchorRepo.createAnchor({
        label: opts.anchorLabel,
        description: opts.anchorDescription,
        anchorType: 'topic',
        embedding: toFloat32(opts.anchorEmbedding),
        initialWeight: 1.0,
        decayRate: 0,
      });
    }

    edgeRepo.createEdge({
      sourceId: anchor.id,
      sourceType: 'hub',
      targetId: fact.id,
      targetType: 'leaf',
      edgeType: 'about',
      weight: opts.edgeWeight ?? 0.8,
    });

    return { fact, anchor };
  }

  // ── Test 1: Basic cross-session recall ──

  it('recalls facts from a previous conversation when querying in a new session', async () => {
    // === Session A: Store facts about TypeScript ===
    const sessionA = convRepo.ingest({ source: 'test', messages: [] });

    const tsVec = unitVector(DIM, 0);

    ingestFactWithAnchor({
      conversationId: sessionA.id,
      factContent: 'User prefers TypeScript over JavaScript for all new projects',
      anchorLabel: 'TypeScript',
      anchorDescription: 'TypeScript programming language preferences',
      anchorEmbedding: tsVec,
      edgeWeight: 0.9,
      summary: 'User prefers TypeScript for new projects',
      frontmatter: 'TypeScript preference',
    });

    ingestFactWithAnchor({
      conversationId: sessionA.id,
      factContent: 'The project uses strict TypeScript with noImplicitAny enabled',
      anchorLabel: 'TypeScript',
      anchorDescription: 'TypeScript programming language preferences',
      anchorEmbedding: tsVec,
      edgeWeight: 0.85,
    });

    // === Session B: New conversation, related query ===
    const _sessionB = convRepo.ingest({ source: 'test', messages: [] });

    // Query embedding is similar to TypeScript anchor
    embeddingProvider.setEmbedding('What language should I use for the new module?', tsVec);

    const retriever = new UnifiedRetriever(db, embeddingProvider, {
      vector: { expandToMemoryNodes: true, similarityThreshold: 0.1 },
      reinforceOnRetrieval: false,
      enableBFSExpansion: false,
    }, { usageDecayRate: 0 });

    const result = await retriever.recall({
      text: 'What language should I use for the new module?',
    });

    // Both facts from Session A should be recalled
    const factItems = result.items.filter(i => i.nodeType === 'fact');
    expect(factItems.length).toBe(2);

    // Facts should contain the original content
    const contents = factItems.map(f => f.content);
    expect(contents.some(c => c.includes('prefers TypeScript'))).toBe(true);
    expect(contents.some(c => c.includes('strict TypeScript'))).toBe(true);

    // Anchor should be activated
    expect(result.activatedAnchors.length).toBe(1);
    expect(result.activatedAnchors[0].label).toBe('TypeScript');
  });

  // ── Test 2: Multi-topic cross-session recall ──

  it('recalls facts across multiple topics from different sessions', async () => {
    const session1 = convRepo.ingest({ source: 'test', messages: [] });
    const session2 = convRepo.ingest({ source: 'test', messages: [] });

    const tsVec = unitVector(DIM, 0);
    const dbVec = unitVector(DIM, 1);

    // Session 1: TypeScript facts
    ingestFactWithAnchor({
      conversationId: session1.id,
      factContent: 'Use ESM modules exclusively, no CommonJS',
      anchorLabel: 'TypeScript',
      anchorDescription: 'TypeScript config and conventions',
      anchorEmbedding: tsVec,
      edgeWeight: 0.9,
    });

    // Session 2: Database facts
    ingestFactWithAnchor({
      conversationId: session2.id,
      factContent: 'SQLite with WAL mode for the persistence layer',
      anchorLabel: 'Database',
      anchorDescription: 'Database technology choices',
      anchorEmbedding: dbVec,
      edgeWeight: 0.85,
    });

    // Query about TypeScript → should recall TS facts, not DB facts
    embeddingProvider.setEmbedding('How should I configure TypeScript?', tsVec);

    const retriever = new UnifiedRetriever(db, embeddingProvider, {
      vector: { expandToMemoryNodes: true, similarityThreshold: 0.3 },
      reinforceOnRetrieval: false,
      enableBFSExpansion: false,
    }, { usageDecayRate: 0 });

    const tsResult = await retriever.recall({
      text: 'How should I configure TypeScript?',
    });

    const tsFactItems = tsResult.items.filter(i => i.nodeType === 'fact');
    expect(tsFactItems.length).toBe(1);
    expect(tsFactItems[0].content).toContain('ESM modules');

    // Query about database → should recall DB facts, not TS facts
    embeddingProvider.setEmbedding('What database should I use?', dbVec);

    const dbResult = await retriever.recall({
      text: 'What database should I use?',
    });

    const dbFactItems = dbResult.items.filter(i => i.nodeType === 'fact');
    expect(dbFactItems.length).toBe(1);
    expect(dbFactItems[0].content).toContain('SQLite');
  });

  // ── Test 3: Associative recall (not direct text match) ──

  it('recalls facts through anchor association even when query wording is different', async () => {
    const session = convRepo.ingest({ source: 'test', messages: [] });

    // Anchor for "deployment" with a specific embedding
    const deployVec = unitVector(DIM, 2);

    ingestFactWithAnchor({
      conversationId: session.id,
      factContent: 'Production deployments use Docker containers on AWS ECS',
      anchorLabel: 'Deployment',
      anchorDescription: 'Deployment infrastructure and processes',
      anchorEmbedding: deployVec,
      edgeWeight: 0.9,
    });

    ingestFactWithAnchor({
      conversationId: session.id,
      factContent: 'CI/CD pipeline runs on GitHub Actions with auto-deploy to staging',
      anchorLabel: 'Deployment',
      anchorDescription: 'Deployment infrastructure and processes',
      anchorEmbedding: deployVec,
      edgeWeight: 0.75,
    });

    // New session: different wording but same semantic space
    // "How do we ship code?" maps to deployment anchor
    embeddingProvider.setEmbedding('How do we ship code to production?', deployVec);

    const retriever = new UnifiedRetriever(db, embeddingProvider, {
      vector: { expandToMemoryNodes: true, similarityThreshold: 0.1 },
      reinforceOnRetrieval: false,
      enableBFSExpansion: false,
    }, { usageDecayRate: 0 });

    const result = await retriever.recall({
      text: 'How do we ship code to production?',
    });

    const factItems = result.items.filter(i => i.nodeType === 'fact');
    expect(factItems.length).toBe(2);

    // Higher-weighted edge should rank first
    expect(factItems[0].content).toContain('Docker containers');
    expect(factItems[1].content).toContain('GitHub Actions');
  });

  // ── Test 4: Cross-topic anchor activation with partial similarity ──

  it('activates multiple anchors and merges facts when query spans topics', async () => {
    const session = convRepo.ingest({ source: 'test', messages: [] });

    // Two anchors with different embedding directions
    const frontendVec = biasedVector(DIM, 0, 1, 0.2);
    const backendVec = biasedVector(DIM, 1, 0, 0.2);

    ingestFactWithAnchor({
      conversationId: session.id,
      factContent: 'React 18 with Next.js for the frontend',
      anchorLabel: 'Frontend',
      anchorDescription: 'Frontend stack',
      anchorEmbedding: frontendVec,
      edgeWeight: 0.9,
    });

    ingestFactWithAnchor({
      conversationId: session.id,
      factContent: 'Express.js with PostgreSQL for the backend API',
      anchorLabel: 'Backend',
      anchorDescription: 'Backend stack',
      anchorEmbedding: backendVec,
      edgeWeight: 0.85,
    });

    // Query that spans both topics (similar to both vectors)
    const crossVec = biasedVector(DIM, 0, 1, 1.0); // equal weight on both
    embeddingProvider.setEmbedding('What is the full stack architecture?', crossVec);

    const retriever = new UnifiedRetriever(db, embeddingProvider, {
      vector: { expandToMemoryNodes: true, similarityThreshold: 0.3 },
      reinforceOnRetrieval: false,
      enableBFSExpansion: false,
    }, { usageDecayRate: 0 });

    const result = await retriever.recall({
      text: 'What is the full stack architecture?',
    });

    // Both anchors should be activated
    expect(result.activatedAnchors.length).toBe(2);

    // Both facts should be recalled
    const factItems = result.items.filter(i => i.nodeType === 'fact');
    expect(factItems.length).toBe(2);

    const contents = factItems.map(f => f.content);
    expect(contents.some(c => c.includes('React 18'))).toBe(true);
    expect(contents.some(c => c.includes('Express.js'))).toBe(true);
  });

  // ── Test 5: Hebbian reinforcement strengthens recall over repeated access ──

  it('strengthens recall paths through Hebbian reinforcement on repeated queries', async () => {
    const session = convRepo.ingest({ source: 'test', messages: [] });
    const vec = unitVector(DIM, 3);

    ingestFactWithAnchor({
      conversationId: session.id,
      factContent: 'Use Vitest for all unit tests',
      anchorLabel: 'Testing',
      anchorDescription: 'Testing practices',
      anchorEmbedding: vec,
      edgeWeight: 0.5,
    });

    embeddingProvider.setEmbedding('How do we test?', vec);

    const retriever = new UnifiedRetriever(db, embeddingProvider, {
      vector: { expandToMemoryNodes: true, similarityThreshold: 0.1 },
      reinforceOnRetrieval: true,
      reinforcementRate: 0.1,
      enableBFSExpansion: false,
    }, { usageDecayRate: 0 });

    // First recall — edge weight starts at 0.5
    const result1 = await retriever.recall({ text: 'How do we test?' });
    expect(result1.diagnostics.edgesReinforced).toBeGreaterThanOrEqual(1);

    // Second recall — edge weight should be higher now
    const result2 = await retriever.recall({ text: 'How do we test?' });
    expect(result2.diagnostics.edgesReinforced).toBeGreaterThanOrEqual(1);

    // Verify edge weight increased: 0.5 → 0.55 → 0.595
    const edge = db.prepare(
      `SELECT weight, activation_count FROM weighted_edges
       WHERE source_type = 'hub' AND target_type = 'leaf'`,
    ).get() as { weight: number; activation_count: number };

    expect(edge.weight).toBeGreaterThan(0.5);
    expect(edge.activation_count).toBeGreaterThanOrEqual(2);
  });

  // ── Test 6: No cross-contamination — unrelated queries don't recall unrelated facts ──

  it('does not recall unrelated facts from other sessions', async () => {
    const session1 = convRepo.ingest({ source: 'test', messages: [] });
    const session2 = convRepo.ingest({ source: 'test', messages: [] });

    ingestFactWithAnchor({
      conversationId: session1.id,
      factContent: 'User likes dark mode',
      anchorLabel: 'UI Preferences',
      anchorDescription: 'User interface preferences',
      anchorEmbedding: unitVector(DIM, 4),
      edgeWeight: 0.9,
    });

    ingestFactWithAnchor({
      conversationId: session2.id,
      factContent: 'API rate limit is 100 requests per minute',
      anchorLabel: 'API Config',
      anchorDescription: 'API configuration settings',
      anchorEmbedding: unitVector(DIM, 5),
      edgeWeight: 0.9,
    });

    // Query about API — orthogonal vector to UI Preferences
    embeddingProvider.setEmbedding('What are the API limits?', unitVector(DIM, 5));

    const retriever = new UnifiedRetriever(db, embeddingProvider, {
      vector: { expandToMemoryNodes: true, similarityThreshold: 0.3 },
      reinforceOnRetrieval: false,
      enableBFSExpansion: false,
    }, { usageDecayRate: 0 });

    const result = await retriever.recall({
      text: 'What are the API limits?',
    });

    const factItems = result.items.filter(i => i.nodeType === 'fact');
    expect(factItems.length).toBe(1);
    expect(factItems[0].content).toContain('rate limit');
    expect(factItems[0].content).not.toContain('dark mode');
  });

  // ── Test 7: BFS expansion discovers associated facts across anchors ──

  it('discovers related facts through BFS expansion across anchor connections', async () => {
    const session = convRepo.ingest({ source: 'test', messages: [] });

    const tsVec = unitVector(DIM, 0);
    const testVec = unitVector(DIM, 1);

    // Fact 1 → TypeScript anchor
    const { fact: fact1, anchor: tsAnchor } = ingestFactWithAnchor({
      conversationId: session.id,
      factContent: 'All code must be written in TypeScript',
      anchorLabel: 'TypeScript',
      anchorDescription: 'TypeScript language',
      anchorEmbedding: tsVec,
      edgeWeight: 0.9,
    });

    // Fact 2 → Testing anchor (not directly reachable from TS query)
    const testAnchor = anchorRepo.createAnchor({
      label: 'Testing',
      description: 'Testing practices',
      anchorType: 'topic',
      embedding: toFloat32(testVec),
      initialWeight: 1.0,
      decayRate: 0,
    });

    const fact2 = factRepo.create({
      content: 'Use Vitest with TypeScript for type-safe tests',
      conversationId: session.id,
      sourceMessageIds: ['msg-2'],
      sourceTurnIndex: 1,
      confidence: 0.9,
      category: 'technical',
      entities: [],
    });

    edgeRepo.createEdge({
      sourceId: testAnchor.id,
      sourceType: 'hub',
      targetId: fact2.id,
      targetType: 'leaf',
      edgeType: 'about',
      weight: 0.8,
    });

    // Cross-link: Testing anchor also connects to the TypeScript fact
    // (This creates an association path: query → TS anchor → fact1, and TS anchor → fact1 ← Testing anchor → fact2)
    edgeRepo.createEdge({
      sourceId: testAnchor.id,
      sourceType: 'hub',
      targetId: fact1.id,
      targetType: 'leaf',
      edgeType: 'about',
      weight: 0.6,
    });

    // Also link TS anchor to fact2 for BFS discovery
    edgeRepo.createEdge({
      sourceId: tsAnchor.id,
      sourceType: 'hub',
      targetId: fact2.id,
      targetType: 'leaf',
      edgeType: 'about',
      weight: 0.5,
    });

    // Query about TypeScript
    embeddingProvider.setEmbedding('Tell me about TypeScript', tsVec);

    const retriever = new UnifiedRetriever(db, embeddingProvider, {
      vector: { expandToMemoryNodes: true, similarityThreshold: 0.1 },
      reinforceOnRetrieval: false,
      enableBFSExpansion: true,
      bfsExpander: { maxDepth: 2, minEdgeWeight: 0.1 },
    }, { usageDecayRate: 0 });

    const result = await retriever.recall({
      text: 'Tell me about TypeScript',
    });

    // Both facts should be found — fact1 directly, fact2 via expansion/BFS
    const factItems = result.items.filter(i => i.nodeType === 'fact');
    expect(factItems.length).toBeGreaterThanOrEqual(2);

    const contents = factItems.map(f => f.content);
    expect(contents.some(c => c.includes('written in TypeScript'))).toBe(true);
    expect(contents.some(c => c.includes('Vitest'))).toBe(true);
  });

  // ── Test 8: Pipeline traceability across sessions ──

  it('provides full pipeline traceability for cross-session recall', async () => {
    const session = convRepo.ingest({ source: 'test', messages: [] });

    ingestFactWithAnchor({
      conversationId: session.id,
      factContent: 'Use pnpm as the package manager',
      anchorLabel: 'Tooling',
      anchorDescription: 'Development tooling choices',
      anchorEmbedding: unitVector(DIM, 6),
      edgeWeight: 0.8,
    });

    embeddingProvider.setEmbedding('What package manager?', unitVector(DIM, 6));

    const retriever = new UnifiedRetriever(db, embeddingProvider, {
      vector: { expandToMemoryNodes: true, similarityThreshold: 0.1 },
      reinforceOnRetrieval: true,
      enableBFSExpansion: true,
    }, { usageDecayRate: 0 });

    const result = await retriever.recall({ text: 'What package manager?' });

    // Verify pipeline stages are tracked
    const d = result.diagnostics;
    expect(d.stages.length).toBeGreaterThanOrEqual(4);

    const stageNames = d.stages.map(s => s.name);
    expect(stageNames).toContain('embed_query');
    expect(stageNames).toContain('anchor_search');
    expect(stageNames).toContain('expansion');
    expect(stageNames).toContain('reinforce');
    expect(stageNames).toContain('bfs_expansion');

    // All timing should be non-negative
    expect(d.embeddingTimeMs).toBeGreaterThanOrEqual(0);
    expect(d.anchorSearchTimeMs).toBeGreaterThanOrEqual(0);
    expect(d.totalTimeMs).toBeGreaterThan(0);
    expect(d.anchorsMatched).toBe(1);

    // The fact should be retrieved
    const factItems = result.items.filter(i => i.nodeType === 'fact');
    expect(factItems.length).toBe(1);
    expect(factItems[0].content).toContain('pnpm');
  });

  // ── Test 9: Empty DB returns gracefully ──

  it('returns empty results gracefully when no facts have been stored', async () => {
    embeddingProvider.setEmbedding('any query', unitVector(DIM, 0));

    const retriever = new UnifiedRetriever(db, embeddingProvider, {
      reinforceOnRetrieval: false,
    });

    const result = await retriever.recall({ text: 'any query' });

    expect(result.items).toHaveLength(0);
    expect(result.activatedAnchors).toHaveLength(0);
    expect(result.diagnostics.stages.length).toBeGreaterThan(0);
  });

  // ── Test 10: Score ordering reflects edge weight (stronger connections first) ──

  it('orders recalled facts by score (anchor similarity × edge weight)', async () => {
    const session = convRepo.ingest({ source: 'test', messages: [] });
    const vec = unitVector(DIM, 7);

    ingestFactWithAnchor({
      conversationId: session.id,
      factContent: 'Low priority: use tabs for indentation',
      anchorLabel: 'Coding Style',
      anchorDescription: 'Code style preferences',
      anchorEmbedding: vec,
      edgeWeight: 0.3,
    });

    ingestFactWithAnchor({
      conversationId: session.id,
      factContent: 'High priority: always use Prettier for formatting',
      anchorLabel: 'Coding Style',
      anchorDescription: 'Code style preferences',
      anchorEmbedding: vec,
      edgeWeight: 0.95,
    });

    ingestFactWithAnchor({
      conversationId: session.id,
      factContent: 'Medium priority: max line length is 100 chars',
      anchorLabel: 'Coding Style',
      anchorDescription: 'Code style preferences',
      anchorEmbedding: vec,
      edgeWeight: 0.6,
    });

    embeddingProvider.setEmbedding('What are the coding style rules?', vec);

    const retriever = new UnifiedRetriever(db, embeddingProvider, {
      vector: { expandToMemoryNodes: true, similarityThreshold: 0.1 },
      reinforceOnRetrieval: false,
      enableBFSExpansion: false,
    }, { usageDecayRate: 0 });

    const result = await retriever.recall({
      text: 'What are the coding style rules?',
    });

    const factItems = result.items.filter(i => i.nodeType === 'fact');
    expect(factItems.length).toBe(3);

    // Should be ordered by score (descending) — highest edge weight first
    expect(factItems[0].content).toContain('Prettier');
    expect(factItems[1].content).toContain('line length');
    expect(factItems[2].content).toContain('tabs');

    // Verify scores are in descending order
    for (let i = 1; i < factItems.length; i++) {
      expect(factItems[i - 1].score).toBeGreaterThanOrEqual(factItems[i].score);
    }
  });
});
