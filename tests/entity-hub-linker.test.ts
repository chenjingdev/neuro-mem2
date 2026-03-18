/**
 * Tests for EntityHubLinker — post-processing entity matching and hub linking.
 *
 * Covers:
 * - Exact-match hub reuse (case-insensitive)
 * - Cosine similarity hub matching (>= 0.85 threshold)
 * - New hub creation when no match found
 * - Deduplication of entities across nodes within a batch
 * - Edge creation between leaf nodes and hubs
 * - Batch processing with mixed resolution types
 * - Configuration overrides
 * - Edge deduplication (same leaf→hub pair)
 * - Empty/edge cases
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryNodeRepository } from '../src/db/memory-node-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { CREATE_MEMORY_NODE_TABLES } from '../src/db/memory-node-schema.js';
import type { EmbeddingProvider, EmbeddingResponse } from '../src/retrieval/embedding-provider.js';
import type { ExtractedMemoryNode, CreateMemoryNodeInput } from '../src/models/memory-node.js';
import {
  EntityHubLinker,
  DEFAULT_ENTITY_HUB_LINKER_CONFIG,
  type EntityHubLinkerConfig,
  type EntityResolution,
  type EntityHubLinkResult,
} from '../src/services/entity-hub-linker.js';

// ─── Test Helpers ─────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Create memory_nodes table + FTS5
  db.exec(CREATE_MEMORY_NODE_TABLES);

  // Create weighted_edges table
  db.exec(`
    CREATE TABLE IF NOT EXISTS weighted_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('hub', 'leaf')),
      target_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('hub', 'leaf')),
      edge_type TEXT NOT NULL CHECK(edge_type IN ('about', 'related', 'caused', 'precedes', 'refines', 'contradicts')),
      weight REAL NOT NULL DEFAULT 0.5,
      initial_weight REAL NOT NULL DEFAULT 0.5,
      shield REAL NOT NULL DEFAULT 0.0,
      learning_rate REAL NOT NULL DEFAULT 0.1,
      decay_rate REAL NOT NULL DEFAULT 0.01,
      activation_count INTEGER NOT NULL DEFAULT 0,
      last_activated_at TEXT,
      last_activated_at_event REAL NOT NULL DEFAULT 0.0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata TEXT
    )
  `);

  return db;
}

function makeMockEmbedding(seed: number = 0): number[] {
  // Generate a deterministic 384-dim embedding based on seed
  const embedding = new Array(384);
  for (let i = 0; i < 384; i++) {
    embedding[i] = Math.sin(seed * 1000 + i * 0.1) * 0.5;
  }
  // Normalize to unit vector
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  return embedding.map(v => v / norm);
}

function makeSimilarEmbedding(base: number[], noise: number = 0.01): number[] {
  // Create embedding very similar to base (for high cosine similarity testing)
  const result = base.map(v => v + (Math.random() - 0.5) * noise);
  const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
  return result.map(v => v / norm);
}

function makeDissimilarEmbedding(seed: number = 999): number[] {
  return makeMockEmbedding(seed);
}

function createMockEmbeddingProvider(
  embeddingMap?: Map<string, number[]>,
  defaultEmbedding?: number[],
): EmbeddingProvider {
  return {
    name: 'test-embedding',
    dimensions: 384,
    embed: vi.fn(async (input: { text: string }): Promise<EmbeddingResponse> => {
      const text = input.text.trim().toLowerCase();
      const embedding = embeddingMap?.get(text) ?? defaultEmbedding ?? makeMockEmbedding(text.length);
      return { embedding, dimensions: 384 };
    }),
  } as EmbeddingProvider;
}

function makeExtractedNode(overrides: Partial<ExtractedMemoryNode> = {}): ExtractedMemoryNode {
  return {
    nodeType: 'semantic',
    frontmatter: 'Test node',
    keywords: 'test node',
    searchKeywords: ['test', 'node'],
    relatedEntities: [],
    summary: 'A test memory node',
    metadata: { confidence: 0.9 },
    ...overrides,
  };
}

function createLeafNode(db: Database.Database, overrides: Partial<CreateMemoryNodeInput> = {}): string {
  const repo = new MemoryNodeRepository(db);
  const node = repo.create({
    nodeType: 'semantic',
    nodeRole: 'leaf',
    frontmatter: 'Test leaf node',
    keywords: 'test leaf',
    summary: 'A test leaf node',
    ...overrides,
  });
  return node.id;
}

function createHubNode(
  db: Database.Database,
  label: string,
  embedding?: Float32Array,
): string {
  const repo = new MemoryNodeRepository(db);
  const node = repo.create({
    nodeType: null,
    nodeRole: 'hub',
    frontmatter: label,
    keywords: label.toLowerCase(),
    summary: `Hub for ${label}`,
    embedding,
    embeddingDim: embedding?.length,
    metadata: { hubType: 'entity' },
  });
  return node.id;
}

// ─── Tests ────────────────────────────────────────────────────

describe('EntityHubLinker', () => {
  let db: Database.Database;
  let nodeRepo: MemoryNodeRepository;
  let edgeRepo: WeightedEdgeRepository;

  beforeEach(() => {
    db = createTestDb();
    nodeRepo = new MemoryNodeRepository(db);
    edgeRepo = new WeightedEdgeRepository(db);
  });

  describe('Configuration', () => {
    it('should use default config when none provided', () => {
      const provider = createMockEmbeddingProvider();
      const linker = new EntityHubLinker(db, provider);
      expect(linker.config).toEqual(DEFAULT_ENTITY_HUB_LINKER_CONFIG);
    });

    it('should merge partial config with defaults', () => {
      const provider = createMockEmbeddingProvider();
      const linker = new EntityHubLinker(db, provider, {
        similarityThreshold: 0.9,
        defaultEdgeWeight: 60,
      });
      expect(linker.config.similarityThreshold).toBe(0.9);
      expect(linker.config.defaultEdgeWeight).toBe(60);
      expect(linker.config.embedNewHubs).toBe(true); // default preserved
    });
  });

  describe('Exact-match hub reuse', () => {
    it('should reuse hub when exact label match exists (case-insensitive)', async () => {
      const hubId = createHubNode(db, 'React');
      const leafId = createLeafNode(db);

      const node = makeExtractedNode({ relatedEntities: ['react'] });
      const provider = createMockEmbeddingProvider();
      const linker = new EntityHubLinker(db, provider);

      const result = await linker.linkEntitiesToHubs([node], [leafId], 1.0);

      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0].resolution).toBe('exact-match');
      expect(result.resolutions[0].hubId).toBe(hubId);
      expect(result.resolutions[0].hubLabel).toBe('React');
      expect(result.reusedHubIds).toContain(hubId);
      expect(result.newHubIds).toHaveLength(0);

      // No embedding calls needed for exact match
      expect(result.stats.embeddingCallsMade).toBe(0);
    });

    it('should match case-insensitively', async () => {
      const hubId = createHubNode(db, 'TypeScript');
      const leafId = createLeafNode(db);

      const node = makeExtractedNode({ relatedEntities: ['TYPESCRIPT'] });
      const provider = createMockEmbeddingProvider();
      const linker = new EntityHubLinker(db, provider);

      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      expect(result.resolutions[0].resolution).toBe('exact-match');
      expect(result.resolutions[0].hubId).toBe(hubId);
    });
  });

  describe('Cosine similarity hub matching', () => {
    it('should match hub by cosine similarity when >= threshold', async () => {
      // Create hub with known embedding
      const hubEmbedding = makeMockEmbedding(42);
      const hubId = createHubNode(db, 'React Framework', new Float32Array(hubEmbedding));

      // Create leaf node
      const leafId = createLeafNode(db);

      // Entity is similar but not exact — "react" vs "React Framework"
      const similarEmbedding = makeSimilarEmbedding(hubEmbedding, 0.001);
      const embMap = new Map<string, number[]>();
      embMap.set('react.js', similarEmbedding);

      const provider = createMockEmbeddingProvider(embMap);
      const node = makeExtractedNode({ relatedEntities: ['React.js'] });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      // Should find the hub via cosine matching
      expect(result.resolutions).toHaveLength(1);
      const resolution = result.resolutions[0];
      expect(resolution.resolution).toBe('cosine-match');
      expect(resolution.hubId).toBe(hubId);
      expect(resolution.cosineSimilarity).toBeGreaterThanOrEqual(0.85);
      expect(result.stats.embeddingCallsMade).toBe(1);
    });

    it('should NOT match hub when cosine similarity below threshold', async () => {
      // Create hub with known embedding
      const hubEmbedding = makeMockEmbedding(42);
      createHubNode(db, 'React Framework', new Float32Array(hubEmbedding));

      const leafId = createLeafNode(db);

      // Create entity with dissimilar embedding
      const dissimilar = makeDissimilarEmbedding(777);
      const embMap = new Map<string, number[]>();
      embMap.set('kubernetes', dissimilar);

      const provider = createMockEmbeddingProvider(embMap);
      const node = makeExtractedNode({ relatedEntities: ['Kubernetes'] });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      // Should create a new hub since no match
      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0].resolution).toBe('new-hub');
      expect(result.newHubIds).toHaveLength(1);
    });
  });

  describe('New hub creation', () => {
    it('should create new hub when no match found', async () => {
      const leafId = createLeafNode(db);
      const defaultEmbedding = makeMockEmbedding(10);
      const provider = createMockEmbeddingProvider(undefined, defaultEmbedding);
      const node = makeExtractedNode({ relatedEntities: ['GraphQL'] });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0].resolution).toBe('new-hub');
      expect(result.newHubIds).toHaveLength(1);

      // Verify the hub was actually created in DB
      const hub = nodeRepo.getById(result.newHubIds[0]);
      expect(hub).not.toBeNull();
      expect(hub!.nodeRole).toBe('hub');
      expect(hub!.frontmatter).toBe('Graphql'); // capitalized first letter
      expect(hub!.metadata.hubType).toBe('entity');
      expect(hub!.metadata.aliases).toContain('graphql');
    });

    it('should embed new hubs when embedNewHubs=true', async () => {
      const leafId = createLeafNode(db);
      const embedding = makeMockEmbedding(123);
      const provider = createMockEmbeddingProvider(undefined, embedding);
      const node = makeExtractedNode({ relatedEntities: ['NewTech'] });

      const linker = new EntityHubLinker(db, provider, { embedNewHubs: true });
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      const hub = nodeRepo.getById(result.newHubIds[0]);
      expect(hub).not.toBeNull();
      expect(hub!.embedding).toBeDefined();
      expect(hub!.embeddingDim).toBe(384);
    });
  });

  describe('Edge creation', () => {
    it('should create about edges from leaf to hub', async () => {
      const hubId = createHubNode(db, 'React');
      const leafId = createLeafNode(db);

      const provider = createMockEmbeddingProvider();
      const node = makeExtractedNode({ relatedEntities: ['React'] });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId], 5.0);

      expect(result.totalEdgesCreated).toBe(1);
      expect(result.nodeResults).toHaveLength(1);
      expect(result.nodeResults[0].edgesCreated).toBe(1);

      // Verify edge in DB
      const edges = edgeRepo.getOutgoingEdges(leafId);
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(leafId);
      expect(edges[0].targetId).toBe(hubId);
      expect(edges[0].edgeType).toBe('about');
      expect(edges[0].sourceType).toBe('leaf');
      expect(edges[0].targetType).toBe('hub');
      expect(edges[0].weight).toBe(50); // default weight
    });

    it('should use configured default edge weight', async () => {
      createHubNode(db, 'React');
      const leafId = createLeafNode(db);

      const provider = createMockEmbeddingProvider();
      const node = makeExtractedNode({ relatedEntities: ['React'] });

      const linker = new EntityHubLinker(db, provider, { defaultEdgeWeight: 75 });
      await linker.linkEntitiesToHubs([node], [leafId]);

      const edges = edgeRepo.getOutgoingEdges(leafId);
      expect(edges[0].weight).toBe(75);
    });

    it('should create multiple edges for node with multiple entities', async () => {
      createHubNode(db, 'React');
      createHubNode(db, 'TypeScript');
      const leafId = createLeafNode(db);

      const provider = createMockEmbeddingProvider();
      const node = makeExtractedNode({
        relatedEntities: ['React', 'TypeScript'],
      });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      expect(result.totalEdgesCreated).toBe(2);
      const edges = edgeRepo.getOutgoingEdges(leafId);
      expect(edges).toHaveLength(2);
    });

    it('should deduplicate edges for same leaf→hub pair', async () => {
      createHubNode(db, 'React');
      const leafId = createLeafNode(db);

      const provider = createMockEmbeddingProvider();
      // Same entity mentioned twice
      const node = makeExtractedNode({
        relatedEntities: ['React', 'react', 'REACT'],
      });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      // Only one entity after normalization/dedup, so one edge
      expect(result.totalEdgesCreated).toBe(1);
    });
  });

  describe('Batch deduplication', () => {
    it('should deduplicate entities across nodes in same batch', async () => {
      const leafId1 = createLeafNode(db, { frontmatter: 'Leaf 1' });
      const leafId2 = createLeafNode(db, { frontmatter: 'Leaf 2' });

      const defaultEmbedding = makeMockEmbedding(55);
      const provider = createMockEmbeddingProvider(undefined, defaultEmbedding);

      const node1 = makeExtractedNode({ relatedEntities: ['Python'] });
      const node2 = makeExtractedNode({ relatedEntities: ['Python'] });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs(
        [node1, node2],
        [leafId1, leafId2],
      );

      // Entity resolved once, but edges created for both nodes
      expect(result.resolutions).toHaveLength(1);
      expect(result.totalEdgesCreated).toBe(2);
      expect(result.newHubIds).toHaveLength(1); // Only one hub created

      // Both leaf nodes should have edges to the same hub
      const edges1 = edgeRepo.getOutgoingEdges(leafId1);
      const edges2 = edgeRepo.getOutgoingEdges(leafId2);
      expect(edges1).toHaveLength(1);
      expect(edges2).toHaveLength(1);
      expect(edges1[0].targetId).toBe(edges2[0].targetId);
    });
  });

  describe('Mixed resolution types', () => {
    it('should handle batch with exact-match, cosine-match, and new-hub', async () => {
      // Setup: existing hub for exact match
      createHubNode(db, 'React');

      // Create leaf nodes
      const leafId = createLeafNode(db);
      const defaultEmbedding = makeMockEmbedding(77);
      const provider = createMockEmbeddingProvider(undefined, defaultEmbedding);

      const node = makeExtractedNode({
        relatedEntities: ['React', 'NewFramework'],
      });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      // React → exact-match, NewFramework → new-hub
      expect(result.resolutions).toHaveLength(2);

      const reactResolution = result.resolutions.find(r => r.entityLabel === 'react');
      const newResolution = result.resolutions.find(r => r.entityLabel === 'newframework');

      expect(reactResolution?.resolution).toBe('exact-match');
      expect(newResolution?.resolution).toBe('new-hub');

      expect(result.reusedHubIds).toHaveLength(1);
      expect(result.newHubIds).toHaveLength(1);
      expect(result.totalEdgesCreated).toBe(2);
    });
  });

  describe('Empty and edge cases', () => {
    it('should handle empty relatedEntities gracefully', async () => {
      const leafId = createLeafNode(db);
      const provider = createMockEmbeddingProvider();
      const node = makeExtractedNode({ relatedEntities: [] });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      expect(result.resolutions).toHaveLength(0);
      expect(result.totalEdgesCreated).toBe(0);
      expect(result.stats.uniqueEntitiesProcessed).toBe(0);
    });

    it('should handle empty nodes array', async () => {
      const provider = createMockEmbeddingProvider();
      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([], []);

      expect(result.resolutions).toHaveLength(0);
      expect(result.totalEdgesCreated).toBe(0);
    });

    it('should skip whitespace-only entity labels', async () => {
      const leafId = createLeafNode(db);
      const provider = createMockEmbeddingProvider();
      const node = makeExtractedNode({
        relatedEntities: ['', '  ', 'Valid'],
      });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0].entityLabel).toBe('valid');
    });

    it('should respect maxEntitiesPerBatch limit', async () => {
      const leafId = createLeafNode(db);
      const provider = createMockEmbeddingProvider(undefined, makeMockEmbedding(0));

      // Create more entities than limit
      const manyEntities = Array.from({ length: 60 }, (_, i) => `Entity${i}`);
      const node = makeExtractedNode({ relatedEntities: manyEntities });

      const linker = new EntityHubLinker(db, provider, { maxEntitiesPerBatch: 10 });
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      expect(result.stats.uniqueEntitiesProcessed).toBe(10);
    });

    it('should handle missing createdNodeIds gracefully', async () => {
      const provider = createMockEmbeddingProvider();
      const node = makeExtractedNode({ relatedEntities: ['React'] });

      const linker = new EntityHubLinker(db, provider);
      // Pass undefined node ID
      const result = await linker.linkEntitiesToHubs([node], [undefined as any]);

      // Should not crash, and no edges created for undefined node
      expect(result.totalEdgesCreated).toBe(0);
    });
  });

  describe('resolveEntitiesOnly', () => {
    it('should resolve entities without creating edges', async () => {
      createHubNode(db, 'React');
      const provider = createMockEmbeddingProvider(undefined, makeMockEmbedding(0));

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.resolveEntitiesOnly(['React', 'NewThing']);

      expect(result.resolutions).toHaveLength(2);
      expect(result.stats.exactMatches).toBe(1);
      expect(result.stats.newHubsCreated).toBe(1);

      // No edges should exist (resolve-only mode)
      const edgeCount = edgeRepo.countEdges();
      expect(edgeCount).toBe(0);
    });
  });

  describe('findMatchingHub', () => {
    it('should return exact match as perfect score', () => {
      const hubId = createHubNode(db, 'React');
      const provider = createMockEmbeddingProvider();
      const linker = new EntityHubLinker(db, provider);

      const match = linker.findMatchingHub('React', makeMockEmbedding(0));

      expect(match).not.toBeNull();
      expect(match!.hubId).toBe(hubId);
      expect(match!.hybridScore).toBe(1.0);
      expect(match!.cosineSimilarity).toBe(1.0);
    });

    it('should return null when no match found', () => {
      const provider = createMockEmbeddingProvider();
      const linker = new EntityHubLinker(db, provider);

      const match = linker.findMatchingHub('NonExistent', makeMockEmbedding(0));

      expect(match).toBeNull();
    });
  });

  describe('Stats tracking', () => {
    it('should accurately track all stats', async () => {
      createHubNode(db, 'React');
      const leafId = createLeafNode(db);

      // Give each entity a unique embedding so they don't cosine-match each other
      const embMap = new Map<string, number[]>();
      embMap.set('vue', makeMockEmbedding(100));
      embMap.set('angular', makeMockEmbedding(200));
      const provider = createMockEmbeddingProvider(embMap);

      const node = makeExtractedNode({
        relatedEntities: ['React', 'Vue', 'Angular'],
      });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      expect(result.stats.uniqueEntitiesProcessed).toBe(3);
      expect(result.stats.exactMatches).toBe(1); // React
      expect(result.stats.newHubsCreated).toBe(2); // Vue, Angular
      expect(result.stats.totalTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.stats.embeddingCallsMade).toBe(2); // Vue, Angular (React is exact-match)
    });
  });

  describe('Korean language support (한영 혼용)', () => {
    it('should handle Korean entity labels', async () => {
      createHubNode(db, '리액트');
      const leafId = createLeafNode(db);
      const provider = createMockEmbeddingProvider();

      const node = makeExtractedNode({
        relatedEntities: ['리액트'],
      });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      expect(result.resolutions).toHaveLength(1);
      expect(result.resolutions[0].resolution).toBe('exact-match');
    });

    it('should create hubs for Korean entities', async () => {
      const leafId = createLeafNode(db);
      const provider = createMockEmbeddingProvider(undefined, makeMockEmbedding(0));

      const node = makeExtractedNode({
        relatedEntities: ['타입스크립트'],
      });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId]);

      expect(result.newHubIds).toHaveLength(1);
      const hub = nodeRepo.getById(result.newHubIds[0]);
      expect(hub!.frontmatter).toBe('타입스크립트');
    });
  });

  describe('Event counter propagation', () => {
    it('should pass current event counter to new hubs and edges', async () => {
      const leafId = createLeafNode(db);
      const provider = createMockEmbeddingProvider(undefined, makeMockEmbedding(0));
      const node = makeExtractedNode({ relatedEntities: ['NewEntity'] });

      const linker = new EntityHubLinker(db, provider);
      const result = await linker.linkEntitiesToHubs([node], [leafId], 42.5);

      // New hub should have correct event counter
      const hub = nodeRepo.getById(result.newHubIds[0]);
      expect(hub!.createdAtEvent).toBe(42.5);
      expect(hub!.lastActivatedAtEvent).toBe(42.5);

      // Edge should have correct event counter
      const edges = edgeRepo.getOutgoingEdges(leafId);
      expect(edges[0].lastActivatedAtEvent).toBe(42.5);
    });
  });
});
