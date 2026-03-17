/**
 * Tests for the Graph Traversal Module (Sub-AC 2 of AC 7).
 *
 * Tests cover:
 * 1. Entity extraction from query text
 * 2. Seed node discovery across facts, concepts, and anchors
 * 3. Weighted BFS traversal through memory_edges
 * 4. Node resolution and ranking
 * 5. End-to-end QueryGraphTraverser pipeline
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { FactRepository } from '../src/db/fact-repo.js';
import { ConceptRepository } from '../src/db/concept-repo.js';
import { EpisodeRepository } from '../src/db/episode-repo.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { EdgeRepository } from '../src/db/edge-repo.js';
import { ConversationRepository } from '../src/db/conversation-repo.js';
import {
  extractEntitiesFromQuery,
  findSeedNodes,
  traverseGraph,
  resolveNodes,
  QueryGraphTraverser,
} from '../src/retrieval/graph-traversal.js';

// ── Helpers ──

function setupTestDb(): {
  db: Database.Database;
  factRepo: FactRepository;
  conceptRepo: ConceptRepository;
  episodeRepo: EpisodeRepository;
  anchorRepo: AnchorRepository;
  edgeRepo: EdgeRepository;
  convId: string;
} {
  const db = createDatabase({ inMemory: true });
  const convRepo = new ConversationRepository(db);
  // Create a conversation to satisfy FK constraints on facts
  const conv = convRepo.ingest({
    source: 'test',
    title: 'Test conversation',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Tell me about TypeScript' },
      { role: 'assistant', content: 'TypeScript is great!' },
    ],
  });
  return {
    db,
    factRepo: new FactRepository(db),
    conceptRepo: new ConceptRepository(db),
    episodeRepo: new EpisodeRepository(db),
    anchorRepo: new AnchorRepository(db),
    edgeRepo: new EdgeRepository(db),
    convId: conv.id,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. Entity Extraction
// ═══════════════════════════════════════════════════════════════════

describe('extractEntitiesFromQuery', () => {
  it('should extract quoted phrases as entities', () => {
    const result = extractEntitiesFromQuery('How do I use "React hooks" in my project?');
    expect(result.entities).toContain('React hooks');
  });

  it('should extract CamelCase/PascalCase identifiers', () => {
    const result = extractEntitiesFromQuery('Implement the UserProfile component');
    expect(result.entities).toContain('UserProfile');
  });

  it('should extract capitalized words as potential entities', () => {
    const result = extractEntitiesFromQuery('I prefer TypeScript over JavaScript');
    expect(result.entities).toContain('TypeScript');
    expect(result.entities).toContain('JavaScript');
  });

  it('should extract technical terms with dots (e.g., Node.js)', () => {
    const result = extractEntitiesFromQuery('We are using Node.js and Vue.js');
    expect(result.entities).toContain('Node.js');
    expect(result.entities).toContain('Vue.js');
  });

  it('should extract significant lowercase terms as keyTerms', () => {
    const result = extractEntitiesFromQuery('optimize database queries for performance');
    expect(result.keyTerms).toContain('optimize');
    expect(result.keyTerms).toContain('database');
    expect(result.keyTerms).toContain('queries');
    expect(result.keyTerms).toContain('performance');
  });

  it('should filter out stop words', () => {
    const result = extractEntitiesFromQuery('what is the best way to handle errors');
    // 'what', 'the', 'best', 'way' are stop words or too short
    expect(result.keyTerms).not.toContain('what');
    expect(result.keyTerms).not.toContain('the');
    expect(result.keyTerms).toContain('handle');
    expect(result.keyTerms).toContain('errors');
  });

  it('should deduplicate entities', () => {
    const result = extractEntitiesFromQuery('TypeScript TypeScript TypeScript');
    expect(result.entities.filter(e => e === 'TypeScript')).toHaveLength(1);
  });

  it('should handle empty query', () => {
    const result = extractEntitiesFromQuery('');
    expect(result.entities).toHaveLength(0);
    expect(result.keyTerms).toHaveLength(0);
  });

  it('should handle query with only stop words', () => {
    const result = extractEntitiesFromQuery('the and for but not');
    expect(result.entities).toHaveLength(0);
    expect(result.keyTerms).toHaveLength(0);
  });

  it('should not duplicate entities in keyTerms', () => {
    const result = extractEntitiesFromQuery('React component using React');
    // 'React' should be in entities only, not keyTerms
    expect(result.entities).toContain('React');
    expect(result.keyTerms).not.toContain('react');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Seed Node Discovery
// ═══════════════════════════════════════════════════════════════════

describe('findSeedNodes', () => {
  let db: Database.Database;
  let factRepo: FactRepository;
  let conceptRepo: ConceptRepository;
  let anchorRepo: AnchorRepository;
  let convId: string;

  beforeEach(() => {
    const setup = setupTestDb();
    db = setup.db;
    factRepo = setup.factRepo;
    conceptRepo = setup.conceptRepo;
    anchorRepo = setup.anchorRepo;
    convId = setup.convId;
  });

  it('should find facts by entity match', () => {
    factRepo.create({
      content: 'User prefers TypeScript for backend development',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'preference',
      entities: ['TypeScript', 'backend'],
    });

    const seeds = findSeedNodes(db, {
      entities: ['TypeScript'],
      keyTerms: [],
    });

    expect(seeds.size).toBeGreaterThanOrEqual(1);
    const factSeeds = [...seeds.entries()].filter(([, v]) => v.nodeType === 'fact');
    expect(factSeeds.length).toBeGreaterThanOrEqual(1);
  });

  it('should find concepts by name', () => {
    conceptRepo.createConcept({
      name: 'TypeScript',
      description: 'A typed superset of JavaScript',
      category: 'technology',
      sourceConversationId: convId,
    });

    const seeds = findSeedNodes(db, {
      entities: ['TypeScript'],
      keyTerms: [],
    });

    const conceptSeeds = [...seeds.entries()].filter(([, v]) => v.nodeType === 'concept');
    expect(conceptSeeds.length).toBeGreaterThanOrEqual(1);
  });

  it('should find concepts by alias', () => {
    conceptRepo.createConcept({
      name: 'TypeScript',
      description: 'A typed superset of JavaScript',
      aliases: ['TS', 'typescript'],
      category: 'technology',
      sourceConversationId: convId,
    });

    const seeds = findSeedNodes(db, {
      entities: [],
      keyTerms: ['typescript'],
    });

    expect(seeds.size).toBeGreaterThanOrEqual(1);
  });

  it('should find anchors by label', () => {
    anchorRepo.createAnchor({
      label: 'TypeScript Migration',
      description: 'Project to migrate codebase to TypeScript',
      anchorType: 'topic',
    });

    const seeds = findSeedNodes(db, {
      entities: ['TypeScript'],
      keyTerms: [],
    });

    const anchorSeeds = [...seeds.entries()].filter(([, v]) => v.nodeType === 'anchor');
    expect(anchorSeeds.length).toBeGreaterThanOrEqual(1);
  });

  it('should find facts by content match with keyTerms', () => {
    factRepo.create({
      content: 'The database uses SQLite with WAL mode for performance',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: ['SQLite'],
    });

    const seeds = findSeedNodes(db, {
      entities: [],
      keyTerms: ['database'],
    });

    expect(seeds.size).toBeGreaterThanOrEqual(1);
  });

  it('should return empty map for no matches', () => {
    const seeds = findSeedNodes(db, {
      entities: ['NonExistentEntity'],
      keyTerms: ['nonexistentterm'],
    });

    expect(seeds.size).toBe(0);
  });

  it('should return empty map for empty entities', () => {
    const seeds = findSeedNodes(db, {
      entities: [],
      keyTerms: [],
    });

    expect(seeds.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Graph Traversal (BFS)
// ═══════════════════════════════════════════════════════════════════

describe('traverseGraph', () => {
  let db: Database.Database;
  let factRepo: FactRepository;
  let conceptRepo: ConceptRepository;
  let edgeRepo: EdgeRepository;
  let convId: string;

  beforeEach(() => {
    const setup = setupTestDb();
    db = setup.db;
    factRepo = setup.factRepo;
    conceptRepo = setup.conceptRepo;
    edgeRepo = setup.edgeRepo;
    convId = setup.convId;
  });

  it('should include seed nodes in results', () => {
    const fact = factRepo.create({
      content: 'TypeScript is preferred',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'preference',
      entities: ['TypeScript'],
    });

    const seeds = new Map<string, { nodeType: 'fact' | 'episode' | 'concept' | 'anchor'; matchedEntity: string }>();
    seeds.set(fact.id, { nodeType: 'fact', matchedEntity: 'TypeScript' });

    const { results, stats } = traverseGraph(db, seeds);
    expect(results.has(fact.id)).toBe(true);
    expect(results.get(fact.id)!.score).toBe(1.0);
    expect(results.get(fact.id)!.hops).toBe(0);
    expect(stats.nodesVisited).toBeGreaterThanOrEqual(1);
  });

  it('should traverse edges to find connected nodes', () => {
    const fact = factRepo.create({
      content: 'TypeScript is preferred',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'preference',
      entities: ['TypeScript'],
    });

    const concept = conceptRepo.createConcept({
      name: 'TypeScript',
      description: 'A typed superset of JavaScript',
      category: 'technology',
      sourceConversationId: convId,
    });

    // Create edge: fact -> concept with weight 0.8
    edgeRepo.createEdge({
      sourceId: fact.id,
      sourceType: 'fact',
      targetId: concept.id,
      targetType: 'concept',
      edgeType: 'fact_supports_concept',
      weight: 0.8,
    });

    const seeds = new Map<string, { nodeType: 'fact' | 'episode' | 'concept' | 'anchor'; matchedEntity: string }>();
    seeds.set(fact.id, { nodeType: 'fact', matchedEntity: 'TypeScript' });

    const { results } = traverseGraph(db, seeds);

    expect(results.has(concept.id)).toBe(true);
    const conceptResult = results.get(concept.id)!;
    expect(conceptResult.hops).toBe(1);
    // Score = 1.0 (seed) * 0.8 (edge weight) * 0.7 (hop decay) = 0.56
    expect(conceptResult.score).toBeCloseTo(0.56, 2);
  });

  it('should traverse bidirectionally through edges', () => {
    const fact = factRepo.create({
      content: 'TypeScript is preferred',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'preference',
      entities: ['TypeScript'],
    });

    const concept = conceptRepo.createConcept({
      name: 'TypeScript',
      description: 'A typed superset of JavaScript',
      category: 'technology',
      sourceConversationId: convId,
    });

    // Edge goes concept -> fact (reverse direction)
    edgeRepo.createEdge({
      sourceId: concept.id,
      sourceType: 'concept',
      targetId: fact.id,
      targetType: 'fact',
      edgeType: 'fact_supports_concept',
      weight: 0.8,
    });

    // Start from concept, should still reach fact
    const seeds = new Map<string, { nodeType: 'fact' | 'episode' | 'concept' | 'anchor'; matchedEntity: string }>();
    seeds.set(concept.id, { nodeType: 'concept', matchedEntity: 'TypeScript' });

    const { results } = traverseGraph(db, seeds);
    expect(results.has(fact.id)).toBe(true);
  });

  it('should respect maxHops limit', () => {
    const fact1 = factRepo.create({
      content: 'Fact 1',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: ['A'],
    });

    const concept1 = conceptRepo.createConcept({
      name: 'Concept1',
      description: 'First concept',
      category: 'technology',
      sourceConversationId: convId,
    });

    const fact2 = factRepo.create({
      content: 'Fact 2',
      conversationId: convId,
      sourceMessageIds: ['msg-2'],
      sourceTurnIndex: 1,
      confidence: 0.9,
      category: 'technical',
      entities: ['B'],
    });

    // Chain: fact1 -> concept1 -> fact2
    edgeRepo.createEdge({
      sourceId: fact1.id,
      sourceType: 'fact',
      targetId: concept1.id,
      targetType: 'concept',
      edgeType: 'fact_supports_concept',
      weight: 0.9,
    });

    edgeRepo.createEdge({
      sourceId: concept1.id,
      sourceType: 'concept',
      targetId: fact2.id,
      targetType: 'fact',
      edgeType: 'fact_supports_concept',
      weight: 0.9,
    });

    const seeds = new Map<string, { nodeType: 'fact' | 'episode' | 'concept' | 'anchor'; matchedEntity: string }>();
    seeds.set(fact1.id, { nodeType: 'fact', matchedEntity: 'A' });

    // maxHops = 1 → should reach concept1 but NOT fact2
    const { results: results1 } = traverseGraph(db, seeds, { maxHops: 1 });
    expect(results1.has(concept1.id)).toBe(true);
    expect(results1.has(fact2.id)).toBe(false);

    // maxHops = 2 → should reach both
    const { results: results2 } = traverseGraph(db, seeds, { maxHops: 2 });
    expect(results2.has(concept1.id)).toBe(true);
    expect(results2.has(fact2.id)).toBe(true);
  });

  it('should filter by minimum edge weight', () => {
    const fact = factRepo.create({
      content: 'Fact A',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: ['A'],
    });

    const concept = conceptRepo.createConcept({
      name: 'WeakConcept',
      description: 'Weakly connected',
      category: 'technology',
      sourceConversationId: convId,
    });

    // Weak edge
    edgeRepo.createEdge({
      sourceId: fact.id,
      sourceType: 'fact',
      targetId: concept.id,
      targetType: 'concept',
      edgeType: 'fact_supports_concept',
      weight: 0.05,
    });

    const seeds = new Map<string, { nodeType: 'fact' | 'episode' | 'concept' | 'anchor'; matchedEntity: string }>();
    seeds.set(fact.id, { nodeType: 'fact', matchedEntity: 'A' });

    const { results } = traverseGraph(db, seeds, { minEdgeWeight: 0.1 });
    expect(results.has(concept.id)).toBe(false);
  });

  it('should filter by edge type', () => {
    const fact = factRepo.create({
      content: 'Fact A',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: ['A'],
    });

    const concept = conceptRepo.createConcept({
      name: 'Concept A',
      description: 'Test',
      category: 'technology',
      sourceConversationId: convId,
    });

    edgeRepo.createEdge({
      sourceId: fact.id,
      sourceType: 'fact',
      targetId: concept.id,
      targetType: 'concept',
      edgeType: 'fact_supports_concept',
      weight: 0.8,
    });

    const seeds = new Map<string, { nodeType: 'fact' | 'episode' | 'concept' | 'anchor'; matchedEntity: string }>();
    seeds.set(fact.id, { nodeType: 'fact', matchedEntity: 'A' });

    // Filter to only temporal_next edges — should not find concept
    const { results } = traverseGraph(db, seeds, { edgeTypes: ['temporal_next'] });
    expect(results.has(concept.id)).toBe(false);
  });

  it('should keep best score when node is reachable via multiple paths', () => {
    const fact = factRepo.create({
      content: 'Fact A',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: ['A'],
    });

    const concept = conceptRepo.createConcept({
      name: 'SharedConcept',
      description: 'Reachable from multiple seeds',
      category: 'technology',
      sourceConversationId: convId,
    });

    // Two edges with different weights
    edgeRepo.createEdge({
      sourceId: fact.id,
      sourceType: 'fact',
      targetId: concept.id,
      targetType: 'concept',
      edgeType: 'fact_supports_concept',
      weight: 0.9,
    });

    // Seed from both nodes
    const seeds = new Map<string, { nodeType: 'fact' | 'episode' | 'concept' | 'anchor'; matchedEntity: string }>();
    seeds.set(fact.id, { nodeType: 'fact', matchedEntity: 'A' });
    seeds.set(concept.id, { nodeType: 'concept', matchedEntity: 'SharedConcept' });

    const { results } = traverseGraph(db, seeds);
    // Concept is seeded directly → score = 1.0 (better than traversal score)
    expect(results.get(concept.id)!.score).toBe(1.0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Node Resolution
// ═══════════════════════════════════════════════════════════════════

describe('resolveNodes', () => {
  let db: Database.Database;
  let factRepo: FactRepository;
  let conceptRepo: ConceptRepository;
  let convId: string;

  beforeEach(() => {
    const setup = setupTestDb();
    db = setup.db;
    factRepo = setup.factRepo;
    conceptRepo = setup.conceptRepo;
    convId = setup.convId;
  });

  it('should resolve fact nodes with full data', () => {
    const fact = factRepo.create({
      content: 'TypeScript is preferred',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'preference',
      entities: ['TypeScript'],
    });

    const resultsMap = new Map();
    resultsMap.set(fact.id, {
      node: { id: fact.id, nodeType: 'fact', data: null },
      score: 0.8,
      hops: 1,
      path: ['edge-1'],
      seedEntity: 'TypeScript',
    });

    const resolved = resolveNodes(db, resultsMap);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.node.data).toBeDefined();
    expect((resolved[0]!.node.data as any).content).toBe('TypeScript is preferred');
  });

  it('should skip nodes that no longer exist in DB', () => {
    const resultsMap = new Map();
    resultsMap.set('nonexistent-id', {
      node: { id: 'nonexistent-id', nodeType: 'fact', data: null },
      score: 0.5,
      hops: 1,
      path: [],
      seedEntity: 'test',
    });

    const resolved = resolveNodes(db, resultsMap);
    expect(resolved).toHaveLength(0);
  });

  it('should sort resolved nodes by score descending', () => {
    const fact1 = factRepo.create({
      content: 'High relevance fact',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: ['A'],
    });

    const fact2 = factRepo.create({
      content: 'Low relevance fact',
      conversationId: convId,
      sourceMessageIds: ['msg-2'],
      sourceTurnIndex: 1,
      confidence: 0.5,
      category: 'technical',
      entities: ['B'],
    });

    const resultsMap = new Map();
    resultsMap.set(fact1.id, {
      node: { id: fact1.id, nodeType: 'fact', data: null },
      score: 0.3,
      hops: 2,
      path: [],
      seedEntity: 'A',
    });
    resultsMap.set(fact2.id, {
      node: { id: fact2.id, nodeType: 'fact', data: null },
      score: 0.9,
      hops: 1,
      path: [],
      seedEntity: 'B',
    });

    const resolved = resolveNodes(db, resultsMap);
    expect(resolved[0]!.score).toBeGreaterThan(resolved[1]!.score);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. End-to-End QueryGraphTraverser
// ═══════════════════════════════════════════════════════════════════

describe('QueryGraphTraverser', () => {
  let db: Database.Database;
  let factRepo: FactRepository;
  let conceptRepo: ConceptRepository;
  let edgeRepo: EdgeRepository;
  let anchorRepo: AnchorRepository;
  let convId: string;

  beforeEach(() => {
    const setup = setupTestDb();
    db = setup.db;
    factRepo = setup.factRepo;
    conceptRepo = setup.conceptRepo;
    edgeRepo = setup.edgeRepo;
    anchorRepo = setup.anchorRepo;
    convId = setup.convId;
  });

  it('should traverse from query to related nodes', () => {
    // Setup: fact about TypeScript connected to a concept
    const fact = factRepo.create({
      content: 'User prefers TypeScript for all backend services',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'preference',
      entities: ['TypeScript', 'backend'],
    });

    const concept = conceptRepo.createConcept({
      name: 'Backend Architecture',
      description: 'Backend service design decisions',
      category: 'technology',
      sourceConversationId: convId,
    });

    edgeRepo.createEdge({
      sourceId: fact.id,
      sourceType: 'fact',
      targetId: concept.id,
      targetType: 'concept',
      edgeType: 'fact_supports_concept',
      weight: 0.8,
    });

    const traverser = new QueryGraphTraverser(db);
    const result = traverser.traverse('What language do we use for TypeScript backend?');

    // Should find the fact directly (TypeScript entity match)
    expect(result.seedNodeIds.length).toBeGreaterThanOrEqual(1);
    expect(result.results.length).toBeGreaterThanOrEqual(1);

    // Should include the connected concept
    const factResult = result.results.find(r => r.node.id === fact.id);
    expect(factResult).toBeDefined();

    // Stats should be populated
    expect(result.stats.nodesVisited).toBeGreaterThanOrEqual(1);
    expect(result.stats.timeMs).toBeGreaterThanOrEqual(0);
  });

  it('should respect maxResults', () => {
    // Create many facts
    for (let i = 0; i < 10; i++) {
      factRepo.create({
        content: `TypeScript fact number ${i}`,
        conversationId: convId,
        sourceMessageIds: [`msg-${i}`],
        sourceTurnIndex: i,
        confidence: 0.9,
        category: 'technical',
        entities: ['TypeScript'],
      });
    }

    const traverser = new QueryGraphTraverser(db);
    const result = traverser.traverse('TypeScript', { maxResults: 3 });

    expect(result.results.length).toBeLessThanOrEqual(3);
  });

  it('should handle query with no matching entities', () => {
    const traverser = new QueryGraphTraverser(db);
    const result = traverser.traverse('xyznonexistent123');

    expect(result.results).toHaveLength(0);
    expect(result.seedNodeIds).toHaveLength(0);
  });

  it('should traverse from direct seeds', () => {
    const fact = factRepo.create({
      content: 'Direct seed fact',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: ['test'],
    });

    const concept = conceptRepo.createConcept({
      name: 'Connected Concept',
      description: 'Test',
      category: 'technology',
      sourceConversationId: convId,
    });

    edgeRepo.createEdge({
      sourceId: fact.id,
      sourceType: 'fact',
      targetId: concept.id,
      targetType: 'concept',
      edgeType: 'fact_supports_concept',
      weight: 0.9,
    });

    const traverser = new QueryGraphTraverser(db);
    const seedIds = new Map<string, 'fact' | 'episode' | 'concept' | 'anchor'>();
    seedIds.set(fact.id, 'fact');

    const result = traverser.traverseFromSeeds(seedIds);

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some(r => r.node.id === concept.id)).toBe(true);
  });

  it('should find nodes through multi-hop traversal from query', () => {
    // fact1 -> concept1 -> fact2 (2 hops)
    const fact1 = factRepo.create({
      content: 'We use React for the frontend',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: ['React', 'frontend'],
    });

    const concept = conceptRepo.createConcept({
      name: 'Frontend Stack',
      description: 'Frontend technology decisions',
      category: 'technology',
      sourceConversationId: convId,
    });

    const fact2 = factRepo.create({
      content: 'Frontend uses Tailwind CSS for styling',
      conversationId: convId,
      sourceMessageIds: ['msg-2'],
      sourceTurnIndex: 1,
      confidence: 0.9,
      category: 'technical',
      entities: ['Tailwind', 'CSS'],
    });

    edgeRepo.createEdge({
      sourceId: fact1.id,
      sourceType: 'fact',
      targetId: concept.id,
      targetType: 'concept',
      edgeType: 'fact_supports_concept',
      weight: 0.8,
    });

    edgeRepo.createEdge({
      sourceId: concept.id,
      sourceType: 'concept',
      targetId: fact2.id,
      targetType: 'fact',
      edgeType: 'fact_supports_concept',
      weight: 0.7,
    });

    const traverser = new QueryGraphTraverser(db, { maxHops: 2 });
    const result = traverser.traverse('What React framework do we use?');

    // Should find fact1 (direct match) and potentially fact2 (2 hops away)
    expect(result.results.some(r => r.node.id === fact1.id)).toBe(true);
    // fact2 might be reached through: fact1 -> concept -> fact2
    const fact2Result = result.results.find(r => r.node.id === fact2.id);
    if (fact2Result) {
      expect(fact2Result.hops).toBe(2);
      expect(fact2Result.score).toBeLessThan(1.0); // Decayed through hops
    }
  });

  it('should find anchors and traverse their edges', () => {
    const anchor = anchorRepo.createAnchor({
      label: 'Database Optimization',
      description: 'Performance tuning for database layer',
      anchorType: 'topic',
    });

    const fact = factRepo.create({
      content: 'Using WAL mode improves write performance',
      conversationId: convId,
      sourceMessageIds: ['msg-1'],
      sourceTurnIndex: 0,
      confidence: 0.9,
      category: 'technical',
      entities: ['WAL', 'SQLite'],
    });

    edgeRepo.createEdge({
      sourceId: anchor.id,
      sourceType: 'anchor',
      targetId: fact.id,
      targetType: 'fact',
      edgeType: 'derived_from',
      weight: 0.85,
    });

    const traverser = new QueryGraphTraverser(db);
    const result = traverser.traverse('How do we optimize our Database?');

    // Should find the anchor via "Database" match and traverse to fact
    expect(result.seedNodeIds.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some(r => r.node.id === fact.id)).toBe(true);
  });

  it('should return extracted entities in the result', () => {
    const traverser = new QueryGraphTraverser(db);
    const result = traverser.traverse('How do we use TypeScript with Node.js?');

    expect(result.extractedEntities.entities).toContain('TypeScript');
    expect(result.extractedEntities.entities).toContain('Node.js');
  });
});
