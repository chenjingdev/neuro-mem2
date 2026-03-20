/**
 * Tests for AnchorLinker — parses LLM anchor-linking decisions and
 * executes anchor connections / creations for ingested facts.
 *
 * Tests cover:
 *   1. LLM response parsing (valid JSON, invalid JSON, edge cases)
 *   2. Connect-to-existing-anchor execution
 *   3. Create-new-anchor execution
 *   4. Duplicate label detection (connect instead of create)
 *   5. Embedding of new anchors
 *   6. Error handling / graceful degradation
 *   7. Prompt building
 *   8. Batch linking
 *   9. Pipeline traceability (stats, reasons in metadata)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import { MockLLMProvider } from '../src/extraction/llm-provider.js';
import { MockEmbeddingProvider } from '../src/retrieval/embedding-provider.js';
import {
  AnchorLinker,
  parseAnchorDecision,
  buildAnchorLinkPrompt,
} from '../src/services/anchor-linker.js';
import type { AnchorCandidate } from '../src/services/anchor-candidate-finder.js';
import type { Fact } from '../src/models/fact.js';
import type Database from 'better-sqlite3';

// ─── Test Helpers ────────────────────────────────────────────────

const DIM = 64;
const TEST_CONV_ID = 'conv-1';

/** Seed a conversation so FK constraints pass for fact creation */
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

function makeFact(db: Database.Database, overrides?: Partial<Fact>): Fact {
  const factRepo = new FactRepository(db);
  const facts = factRepo.createMany([
    {
      conversationId: TEST_CONV_ID,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      content: overrides?.content ?? 'User prefers TypeScript for backend development',
      category: 'preference',
      confidence: 0.9,
      entities: ['TypeScript'],
    },
  ]);
  return facts[0];
}

function makeCandidate(overrides?: Partial<AnchorCandidate>): AnchorCandidate {
  return {
    anchorId: overrides?.anchorId ?? 'anchor-1',
    label: overrides?.label ?? 'TypeScript',
    description: overrides?.description ?? 'TypeScript programming language',
    anchorType: overrides?.anchorType ?? 'topic',
    similarity: overrides?.similarity ?? 0.85,
    effectiveWeight: overrides?.effectiveWeight ?? 0.9,
    score: overrides?.score ?? 0.765,
  };
}

// ─── parseAnchorDecision Tests ───────────────────────────────────

describe('parseAnchorDecision', () => {
  it('parses valid connect + create JSON', () => {
    const json = JSON.stringify({
      connect: [
        { anchorId: 'a1', weight: 0.8, reason: 'relevant topic' },
      ],
      create: [
        {
          label: 'Backend Dev',
          description: 'Backend development preferences',
          anchorType: 'topic',
          weight: 0.7,
          reason: 'new theme',
        },
      ],
    });

    const validIds = new Set(['a1', 'a2']);
    const { decision, warnings } = parseAnchorDecision(json, validIds);

    expect(warnings).toHaveLength(0);
    expect(decision.connect).toHaveLength(1);
    expect(decision.connect[0].anchorId).toBe('a1');
    expect(decision.connect[0].weight).toBe(0.8);
    expect(decision.connect[0].reason).toBe('relevant topic');
    expect(decision.create).toHaveLength(1);
    expect(decision.create[0].label).toBe('Backend Dev');
    expect(decision.create[0].anchorType).toBe('topic');
  });

  it('parses JSON wrapped in markdown code block', () => {
    const raw = '```json\n{"connect": [], "create": []}\n```';
    const { decision, warnings } = parseAnchorDecision(raw, new Set());

    expect(warnings).toHaveLength(0);
    expect(decision.connect).toEqual([]);
    expect(decision.create).toEqual([]);
  });

  it('returns empty decision + warning for invalid JSON', () => {
    const { decision, warnings } = parseAnchorDecision('not json at all', new Set());

    expect(decision.connect).toEqual([]);
    expect(decision.create).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Failed to parse');
  });

  it('warns on unknown anchor ID in connect', () => {
    const json = JSON.stringify({
      connect: [{ anchorId: 'unknown-id', weight: 0.5 }],
      create: [],
    });

    const { decision, warnings } = parseAnchorDecision(json, new Set(['valid-id']));

    expect(decision.connect).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unknown anchor');
  });

  it('clamps weight to [0, 1]', () => {
    const json = JSON.stringify({
      connect: [{ anchorId: 'a1', weight: 1.5 }],
      create: [
        { label: 'Test', description: 'Test desc', anchorType: 'topic', weight: -0.5 },
      ],
    });

    const { decision } = parseAnchorDecision(json, new Set(['a1']));

    expect(decision.connect[0].weight).toBe(1);
    expect(decision.create[0].weight).toBe(0);
  });

  it('defaults to weight 0.5 when missing in connect', () => {
    const json = JSON.stringify({
      connect: [{ anchorId: 'a1' }],
      create: [],
    });

    const { decision } = parseAnchorDecision(json, new Set(['a1']));
    expect(decision.connect[0].weight).toBe(0.5);
  });

  it('defaults anchorType to topic when invalid', () => {
    const json = JSON.stringify({
      connect: [],
      create: [
        { label: 'Test', description: 'Desc', anchorType: 'invalid_type' },
      ],
    });

    const { decision, warnings } = parseAnchorDecision(json, new Set());

    expect(decision.create[0].anchorType).toBe('topic');
    expect(warnings.some((w) => w.includes('Invalid anchorType'))).toBe(true);
  });

  it('skips create entries missing label or description', () => {
    const json = JSON.stringify({
      connect: [],
      create: [
        { description: 'No label' },
        { label: 'No desc' },
        { label: 'Valid', description: 'Valid desc', anchorType: 'entity' },
      ],
    });

    const { decision, warnings } = parseAnchorDecision(json, new Set());

    expect(decision.create).toHaveLength(1);
    expect(decision.create[0].label).toBe('Valid');
    expect(warnings.length).toBe(2);
  });

  it('handles empty arrays gracefully', () => {
    const json = JSON.stringify({ connect: [], create: [] });
    const { decision, warnings } = parseAnchorDecision(json, new Set());

    expect(decision.connect).toEqual([]);
    expect(decision.create).toEqual([]);
    expect(warnings).toHaveLength(0);
  });

  it('handles missing arrays gracefully', () => {
    const json = JSON.stringify({});
    const { decision, warnings } = parseAnchorDecision(json, new Set());

    expect(decision.connect).toEqual([]);
    expect(decision.create).toEqual([]);
    expect(warnings).toHaveLength(0);
  });

  it('parses aliases in create entries', () => {
    const json = JSON.stringify({
      connect: [],
      create: [
        {
          label: 'TypeScript',
          description: 'TS language',
          anchorType: 'topic',
          aliases: ['TS', 'typescript'],
        },
      ],
    });

    const { decision } = parseAnchorDecision(json, new Set());
    expect(decision.create[0].aliases).toEqual(['TS', 'typescript']);
  });
});

// ─── buildAnchorLinkPrompt Tests ─────────────────────────────────

describe('buildAnchorLinkPrompt', () => {
  it('includes fact content in prompt', () => {
    const { prompt } = buildAnchorLinkPrompt('User likes TypeScript', []);
    expect(prompt).toContain('User likes TypeScript');
  });

  it('includes candidate anchors in prompt', () => {
    const candidates = [
      makeCandidate({ anchorId: 'a1', label: 'TypeScript', similarity: 0.85 }),
      makeCandidate({ anchorId: 'a2', label: 'Programming', similarity: 0.6 }),
    ];

    const { prompt } = buildAnchorLinkPrompt('fact', candidates);

    expect(prompt).toContain('a1');
    expect(prompt).toContain('TypeScript');
    expect(prompt).toContain('a2');
    expect(prompt).toContain('Programming');
    expect(prompt).toContain('0.85');
  });

  it('shows "(none)" when no candidates', () => {
    const { prompt } = buildAnchorLinkPrompt('fact', []);
    expect(prompt).toContain('(none)');
  });

  it('includes JSON format instructions in system prompt', () => {
    const { system } = buildAnchorLinkPrompt('fact', []);
    expect(system).toContain('connect');
    expect(system).toContain('create');
    expect(system).toContain('anchorId');
    expect(system).toContain('JSON');
  });
});

// ─── AnchorLinker Integration Tests ──────────────────────────────

describe('AnchorLinker', () => {
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

  // ── Connect to existing anchors ─────────────────────────────

  it('connects fact to existing anchor based on LLM decision', async () => {
    // Create an anchor in DB
    const anchor = anchorRepo.createAnchor({
      label: 'TypeScript',
      description: 'TypeScript programming language',
      anchorType: 'topic',
    });

    // Create a fact
    const fact = makeFact(db);

    // LLM says: connect to existing anchor
    llmProvider.addResponse(
      JSON.stringify({
        connect: [{ anchorId: anchor.id, weight: 0.85, reason: 'direct topic match' }],
        create: [],
      }),
    );

    const candidates = [makeCandidate({ anchorId: anchor.id })];
    const result = await linker.linkFact(fact, candidates);

    expect(result.connectedEdges).toHaveLength(1);
    expect(result.connectedEdges[0].anchorId).toBe(anchor.id);
    expect(result.connectedEdges[0].anchorLabel).toBe('TypeScript');
    expect(result.connectedEdges[0].weight).toBe(0.85);
    expect(result.createdAnchors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);

    // Verify edge was persisted
    const edges = edgeRepo.getOutgoingEdges(anchor.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe(fact.id);
    expect(edges[0].edgeType).toBe('about');
    expect(edges[0].weight).toBe(0.85);

    // Verify anchor activation was recorded
    const updatedAnchor = anchorRepo.getAnchor(anchor.id);
    expect(updatedAnchor!.activationCount).toBe(1);
  });

  // ── Create new anchors ──────────────────────────────────────

  it('creates new anchor and connects fact to it', async () => {
    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          {
            label: 'Backend Development',
            description: 'Server-side development preferences and practices',
            anchorType: 'topic',
            weight: 0.7,
            reason: 'new theme introduced',
          },
        ],
      }),
    );

    const result = await linker.linkFact(fact, []);

    expect(result.createdAnchors).toHaveLength(1);
    expect(result.createdAnchors[0].label).toBe('Backend Development');
    expect(result.createdAnchors[0].weight).toBe(0.7);
    expect(result.connectedEdges).toHaveLength(0);

    // Verify anchor was persisted
    const anchor = anchorRepo.findByLabel('Backend Development');
    expect(anchor).not.toBeNull();
    expect(anchor!.anchorType).toBe('topic');
    expect(anchor!.description).toBe('Server-side development preferences and practices');

    // Verify edge was persisted
    const edges = edgeRepo.getOutgoingEdges(anchor!.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe(fact.id);
    expect(edges[0].edgeType).toBe('about');

    // Verify embedding was created for new anchor
    expect(anchor!.embedding).toBeDefined();
    expect(embeddingProvider.calls.length).toBeGreaterThan(0);
  });

  // ── Mixed connect + create ──────────────────────────────────

  it('handles both connect and create in single decision', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TypeScript',
      description: 'TypeScript lang',
      anchorType: 'topic',
    });

    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [{ anchorId: anchor.id, weight: 0.8 }],
        create: [
          {
            label: 'Node.js',
            description: 'Node.js runtime',
            anchorType: 'entity',
            weight: 0.6,
          },
        ],
      }),
    );

    const candidates = [makeCandidate({ anchorId: anchor.id })];
    const result = await linker.linkFact(fact, candidates);

    expect(result.connectedEdges).toHaveLength(1);
    expect(result.createdAnchors).toHaveLength(1);
    expect(result.stats.connectSuccesses).toBe(1);
    expect(result.stats.createSuccesses).toBe(1);
  });

  // ── Duplicate label detection ───────────────────────────────

  it('connects to existing anchor instead of creating duplicate', async () => {
    const existing = anchorRepo.createAnchor({
      label: 'TypeScript',
      description: 'TS language',
      anchorType: 'topic',
    });

    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          {
            label: 'TypeScript',
            description: 'TypeScript programming',
            anchorType: 'topic',
            weight: 0.9,
          },
        ],
      }),
    );

    const result = await linker.linkFact(fact, []);

    // Should connect to existing, not create new
    expect(result.createdAnchors).toHaveLength(0);
    expect(result.connectedEdges).toHaveLength(1);
    expect(result.connectedEdges[0].anchorId).toBe(existing.id);
    expect(result.warnings.some((w) => w.includes('already exists'))).toBe(true);

    // Should still count as a connection success
    expect(result.stats.connectSuccesses).toBe(1);
  });

  // ── Embedding of new anchors ────────────────────────────────

  it('embeds new anchors when embedNewAnchors is true', async () => {
    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          {
            label: 'New Topic',
            description: 'A brand new topic',
            anchorType: 'topic',
          },
        ],
      }),
    );

    const result = await linker.linkFact(fact, []);

    expect(result.createdAnchors).toHaveLength(1);
    const anchor = anchorRepo.getAnchor(result.createdAnchors[0].anchorId);
    expect(anchor!.embedding).toBeDefined();
    expect(anchor!.embeddingDim).toBe(DIM);
  });

  it('skips embedding when embedNewAnchors is false', async () => {
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
          { label: 'NoEmbed', description: 'No embedding', anchorType: 'topic' },
        ],
      }),
    );

    await noEmbedLinker.linkFact(fact, []);

    const anchor = anchorRepo.findByLabel('NoEmbed');
    expect(anchor!.embedding).toBeUndefined();
    expect(embeddingProvider.calls).toHaveLength(0);
  });

  // ── Error handling ──────────────────────────────────────────

  it('degrades gracefully when LLM returns invalid JSON', async () => {
    const fact = makeFact(db);

    llmProvider.addResponse('This is not valid JSON at all');

    const result = await linker.linkFact(fact, []);

    expect(result.connectedEdges).toHaveLength(0);
    expect(result.createdAnchors).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('Failed to parse'))).toBe(true);
  });

  it('handles LLM completion failure gracefully', async () => {
    const fact = makeFact(db);

    // MockLLMProvider with no responses will return '{"facts": []}'
    // which is valid JSON but not our format — should produce empty decision
    const result = await linker.linkFact(fact, []);

    expect(result.connectedEdges).toHaveLength(0);
    expect(result.createdAnchors).toHaveLength(0);
  });

  it('warns when connecting to non-existent anchor', async () => {
    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [{ anchorId: 'non-existent-id', weight: 0.5 }],
        create: [],
      }),
    );

    const candidates = [makeCandidate({ anchorId: 'non-existent-id' })];
    const result = await linker.linkFact(fact, candidates);

    expect(result.connectedEdges).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('not found'))).toBe(true);
    expect(result.stats.connectSuccesses).toBe(0);
  });

  // ── Stats / traceability ────────────────────────────────────

  it('provides detailed execution stats', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });
    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [{ anchorId: anchor.id, weight: 0.8 }],
        create: [
          { label: 'New', description: 'New anchor', anchorType: 'entity' },
        ],
      }),
    );

    const result = await linker.linkFact(fact, [makeCandidate({ anchorId: anchor.id })]);

    expect(result.stats.llmTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.stats.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.stats.connectAttempts).toBe(1);
    expect(result.stats.connectSuccesses).toBe(1);
    expect(result.stats.createAttempts).toBe(1);
    expect(result.stats.createSuccesses).toBe(1);
    expect(result.factId).toBe(fact.id);
  });

  it('stores reason in edge metadata for traceability', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TS',
      description: 'TypeScript',
      anchorType: 'topic',
    });
    const fact = makeFact(db);

    llmProvider.addResponse(
      JSON.stringify({
        connect: [{ anchorId: anchor.id, weight: 0.8, reason: 'direct topic match' }],
        create: [],
      }),
    );

    const result = await linker.linkFact(fact, [makeCandidate({ anchorId: anchor.id })]);

    const edge = edgeRepo.getEdge(result.connectedEdges[0].edgeId);
    expect(edge!.metadata).toEqual({ reason: 'direct topic match' });
  });

  // ── Batch linking ───────────────────────────────────────────

  it('links multiple facts in batch', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TypeScript',
      description: 'TS lang',
      anchorType: 'topic',
    });

    const fact1 = makeFact(db, { content: 'Fact one about TypeScript' });
    const fact2 = makeFact(db, { content: 'Fact two about JavaScript' });

    llmProvider.addResponse(
      JSON.stringify({
        connect: [{ anchorId: anchor.id, weight: 0.9 }],
        create: [],
      }),
    );
    llmProvider.addResponse(
      JSON.stringify({
        connect: [],
        create: [
          { label: 'JavaScript', description: 'JS runtime', anchorType: 'topic', weight: 0.7 },
        ],
      }),
    );

    const results = await linker.linkFacts([
      { fact: fact1, candidates: [makeCandidate({ anchorId: anchor.id })] },
      { fact: fact2, candidates: [] },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].connectedEdges).toHaveLength(1);
    expect(results[1].createdAnchors).toHaveLength(1);
  });

  // ── Empty decision ──────────────────────────────────────────

  it('handles empty decision (no connect, no create)', async () => {
    const fact = makeFact(db);

    llmProvider.addResponse(JSON.stringify({ connect: [], create: [] }));

    const result = await linker.linkFact(fact, []);

    expect(result.connectedEdges).toHaveLength(0);
    expect(result.createdAnchors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.stats.connectAttempts).toBe(0);
    expect(result.stats.createAttempts).toBe(0);
  });

  // ── LLM receives correct prompt ────────────────────────────

  it('sends candidates to LLM in the prompt', async () => {
    const anchor = anchorRepo.createAnchor({
      label: 'TypeScript',
      description: 'TS lang',
      anchorType: 'topic',
    });
    const fact = makeFact(db);

    llmProvider.addResponse(JSON.stringify({ connect: [], create: [] }));

    const candidates = [
      makeCandidate({
        anchorId: anchor.id,
        label: 'TypeScript',
        similarity: 0.9,
      }),
    ];

    await linker.linkFact(fact, candidates);

    // Verify the LLM received the fact and candidates
    expect(llmProvider.calls).toHaveLength(1);
    const call = llmProvider.calls[0];
    expect(call.prompt).toContain(fact.content);
    expect(call.prompt).toContain('TypeScript');
    expect(call.prompt).toContain(anchor.id);
    expect(call.responseFormat).toBe('json');
  });
});
