/**
 * End-to-end tests for HubCreationPipeline — validates the full flow:
 *
 * 1. Extractor output → relatedEntities → hub matching
 * 2. HubMatcher (FTS5 + cosine ≥ 0.85) finds existing hubs
 * 3. Auto-creates new hub nodes for unmatched entities
 * 4. Creates WeightedEdges (hub→leaf, 'about') with correct weight
 * 5. Deduplication: same entity across multiple leaves → one hub
 * 6. EventBus integration: listens for 'memory-nodes.extracted'
 * 7. No-embedding fallback: label-based matching when no provider
 * 8. Korean/English (한영 혼용) entity support
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { HubCreationPipeline } from '../../src/pipeline/hub-creation-pipeline.js';
import { MemoryNodeRepository } from '../../src/db/memory-node-repo.js';
import { WeightedEdgeRepository } from '../../src/db/weighted-edge-repo.js';
import { MockEmbeddingProvider } from '../../src/retrieval/embedding-provider.js';
import { EventBus } from '../../src/events/event-bus.js';
import { CREATE_MEMORY_NODE_TABLES } from '../../src/db/memory-node-schema.js';
import { CREATE_ANCHOR_TABLES } from '../../src/db/anchor-schema.js';
import type { MemoryNode, MemoryNodeMetadata } from '../../src/models/memory-node.js';
import type { MemoryNodesExtractedEvent } from '../../src/events/event-bus.js';

// ─── Test Helpers ─────────────────────────────────────────────────

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_MEMORY_NODE_TABLES);
  db.exec(CREATE_ANCHOR_TABLES);
  return db;
}

/**
 * Create a deterministic embedding from a seed.
 * Same seed → identical vector → cosine similarity = 1.0
 */
function makeEmbedding(seed: number, dim: number = 64): Float32Array {
  const arr = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    arr[i] = Math.sin(seed * (i + 1) * 0.01) * Math.cos(seed * 0.1 + i * 0.001);
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += arr[i]! * arr[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) arr[i] /= norm;
  return arr;
}

/**
 * Create a leaf node in the DB simulating extractor output.
 */
function createLeafNode(
  repo: MemoryNodeRepository,
  frontmatter: string,
  entities: string[],
  embedding?: Float32Array,
): MemoryNode {
  return repo.create({
    nodeType: 'semantic',
    nodeRole: 'leaf',
    frontmatter,
    keywords: frontmatter.toLowerCase(),
    summary: `Leaf: ${frontmatter}`,
    metadata: { entities, confidence: 0.9 },
    embedding,
    embeddingDim: embedding?.length,
    currentEventCounter: 10,
  });
}

/**
 * Create a hub node in the DB (pre-existing).
 */
function createHubNode(
  repo: MemoryNodeRepository,
  label: string,
  keywords: string,
  embedding?: Float32Array,
): MemoryNode {
  return repo.create({
    nodeType: null,
    nodeRole: 'hub',
    frontmatter: label,
    keywords,
    summary: `Hub: ${label}`,
    metadata: { hubType: 'entity' },
    embedding,
    embeddingDim: embedding?.length,
  });
}

// ─── Tests ────────────────────────────────────────────────────────

describe('HubCreationPipeline', () => {
  let db: Database.Database;
  let nodeRepo: MemoryNodeRepository;
  let edgeRepo: WeightedEdgeRepository;
  let embeddingProvider: MockEmbeddingProvider;
  let pipeline: HubCreationPipeline;

  beforeEach(() => {
    db = setupDb();
    nodeRepo = new MemoryNodeRepository(db);
    edgeRepo = new WeightedEdgeRepository(db);
    embeddingProvider = new MockEmbeddingProvider(64);
    pipeline = new HubCreationPipeline(db, embeddingProvider);
  });

  afterEach(() => {
    db.close();
  });

  // ════════════════════════════════════════════════════════════════
  // 1. Auto-creation of new hub nodes from unmatched entities
  // ════════════════════════════════════════════════════════════════

  describe('auto-create hubs for unmatched entities', () => {
    it('creates hub nodes from relatedEntities when no matching hub exists', async () => {
      const leaf = createLeafNode(nodeRepo, 'User prefers TypeScript', ['TypeScript', 'JavaScript']);

      const result = await pipeline.processNodes([leaf], 10);

      expect(result.ok).toBe(true);
      expect(result.hubsCreated).toHaveLength(2);
      expect(result.hubsCreated.map(h => h.sourceEntity).sort()).toEqual(['javascript', 'typescript']);

      // Verify hub nodes in DB
      const hubs = nodeRepo.getHubs();
      expect(hubs).toHaveLength(2);
      expect(hubs.every(h => h.nodeRole === 'hub')).toBe(true);
    });

    it('creates hub nodes with proper metadata (hubType=entity, aliases)', async () => {
      const leaf = createLeafNode(nodeRepo, 'Docker is useful', ['Docker']);

      await pipeline.processNodes([leaf], 5);

      const hubs = nodeRepo.getHubs();
      expect(hubs).toHaveLength(1);
      const hub = hubs[0]!;
      expect(hub.nodeRole).toBe('hub');
      expect(hub.nodeType).toBeNull(); // Hub nodes don't have specific type
      const meta = hub.metadata as MemoryNodeMetadata;
      expect(meta.hubType).toBe('entity');
      expect(meta.aliases).toContain('docker');
    });

    it('generates embedding for new hub node via EmbeddingProvider', async () => {
      const leaf = createLeafNode(nodeRepo, 'React is great', ['React']);

      await pipeline.processNodes([leaf], 5);

      // EmbeddingProvider should have been called for the entity
      expect(embeddingProvider.calls.length).toBeGreaterThanOrEqual(1);

      const hubs = nodeRepo.getHubs();
      expect(hubs).toHaveLength(1);
      expect(hubs[0]!.embedding).toBeDefined();
      expect(hubs[0]!.embeddingDim).toBe(64);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 2. Matching existing hubs
  // ════════════════════════════════════════════════════════════════

  describe('match existing hubs', () => {
    it('matches an existing hub by label (case-insensitive) without creating duplicate', async () => {
      // Pre-create a hub
      const hubEmb = makeEmbedding(42);
      createHubNode(nodeRepo, 'TypeScript', 'typescript 타입스크립트', hubEmb);

      // Set up mock embedding provider to return the same embedding
      embeddingProvider.setEmbedding('typescript', Array.from(hubEmb));

      const leaf = createLeafNode(nodeRepo, 'TS is great', ['TypeScript']);

      const result = await pipeline.processNodes([leaf], 10);

      expect(result.ok).toBe(true);
      expect(result.hubsMatched).toHaveLength(1);
      expect(result.hubsCreated).toHaveLength(0);
      expect(result.hubsMatched[0]!.label).toBe('TypeScript');

      // Only 1 hub should exist (the pre-existing one)
      const hubs = nodeRepo.getHubs();
      expect(hubs).toHaveLength(1);
    });

    it('falls back to label match when cosine similarity is below threshold', async () => {
      // Create hub
      createHubNode(nodeRepo, 'Python', 'python 파이썬', makeEmbedding(1));

      // Set very different embedding for the entity query (cosine will be low)
      embeddingProvider.setEmbedding('python', Array.from(makeEmbedding(999)));

      const leaf = createLeafNode(nodeRepo, 'Use Python for ML', ['Python']);

      const result = await pipeline.processNodes([leaf], 10);

      // Should still match via label fallback
      expect(result.ok).toBe(true);
      expect(result.hubsCreated).toHaveLength(0);
      expect(result.hubsMatched).toHaveLength(1);
      expect(result.hubsMatched[0]!.label).toBe('Python');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 3. Edge creation (hub→leaf, 'about')
  // ════════════════════════════════════════════════════════════════

  describe('edge creation', () => {
    it('creates hub→leaf edges with correct type and weight', async () => {
      const leaf = createLeafNode(nodeRepo, 'Prefer TS', ['TypeScript']);

      const result = await pipeline.processNodes([leaf], 10);

      expect(result.edgesCreated).toHaveLength(1);
      const edge = result.edgesCreated[0]!;
      expect(edge.edgeType).toBe('about');
      expect(edge.weight).toBe(0.5);
      expect(edge.leafId).toBe(leaf.id);

      // Verify in DB
      const dbEdge = edgeRepo.getEdge(edge.edgeId);
      expect(dbEdge).not.toBeNull();
      expect(dbEdge!.sourceType).toBe('hub');
      expect(dbEdge!.targetType).toBe('leaf');
      expect(dbEdge!.edgeType).toBe('about');
    });

    it('creates multiple edges when leaf has multiple entities', async () => {
      const leaf = createLeafNode(nodeRepo, 'TS and Docker', ['TypeScript', 'Docker', 'Kubernetes']);

      const result = await pipeline.processNodes([leaf], 10);

      expect(result.edgesCreated).toHaveLength(3);
      expect(result.hubsCreated).toHaveLength(3);

      // All edges point to the same leaf
      expect(result.edgesCreated.every(e => e.leafId === leaf.id)).toBe(true);
    });

    it('does not create duplicate edges for same hub→leaf pair', async () => {
      const hub = createHubNode(nodeRepo, 'TypeScript', 'typescript', makeEmbedding(42));
      embeddingProvider.setEmbedding('typescript', Array.from(makeEmbedding(42)));

      const leaf = createLeafNode(nodeRepo, 'TS fact', ['TypeScript']);

      // Process twice
      await pipeline.processNodes([leaf], 10);
      const result2 = await pipeline.processNodes([leaf], 11);

      // Second run should not create duplicate edge
      expect(result2.edgesCreated).toHaveLength(0);

      // Only 1 edge total in DB
      const edges = edgeRepo.getOutgoingEdges(hub.id);
      expect(edges).toHaveLength(1);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 4. Deduplication: same entity across multiple leaves
  // ════════════════════════════════════════════════════════════════

  describe('entity deduplication', () => {
    it('creates one hub for same entity appearing in multiple leaves', async () => {
      const leaf1 = createLeafNode(nodeRepo, 'TS is typed', ['TypeScript']);
      const leaf2 = createLeafNode(nodeRepo, 'TS has generics', ['TypeScript']);

      const result = await pipeline.processNodes([leaf1, leaf2], 10);

      // One hub for TypeScript
      expect(result.hubsCreated).toHaveLength(1);
      expect(result.hubsCreated[0]!.sourceEntity).toBe('typescript');

      // Two edges (hub→leaf1, hub→leaf2)
      expect(result.edgesCreated).toHaveLength(2);
      const leafIds = result.edgesCreated.map(e => e.leafId).sort();
      expect(leafIds).toEqual([leaf1.id, leaf2.id].sort());

      // Only 1 hub node in DB
      const hubs = nodeRepo.getHubs();
      expect(hubs).toHaveLength(1);
    });

    it('normalizes entity casing for deduplication', async () => {
      const leaf1 = createLeafNode(nodeRepo, 'Type1', ['TypeScript']);
      const leaf2 = createLeafNode(nodeRepo, 'Type2', ['typescript']);
      const leaf3 = createLeafNode(nodeRepo, 'Type3', ['TYPESCRIPT']);

      const result = await pipeline.processNodes([leaf1, leaf2, leaf3], 10);

      // All three refer to the same entity (case-normalized)
      expect(result.hubsCreated).toHaveLength(1);
      expect(result.edgesCreated).toHaveLength(3);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 5. Korean entity support (한영 혼용)
  // ════════════════════════════════════════════════════════════════

  describe('Korean entity support', () => {
    it('handles Korean entities correctly', async () => {
      const leaf = createLeafNode(nodeRepo, '리액트 학습', ['리액트', 'React']);

      const result = await pipeline.processNodes([leaf], 10);

      expect(result.ok).toBe(true);
      expect(result.hubsCreated).toHaveLength(2);
      const labels = result.hubsCreated.map(h => h.sourceEntity).sort();
      expect(labels).toContain('리액트');
      expect(labels).toContain('react');
    });

    it('matches existing Korean hub node', async () => {
      const hubEmb = makeEmbedding(77);
      createHubNode(nodeRepo, '데이터베이스', '데이터베이스 database', hubEmb);
      embeddingProvider.setEmbedding('데이터베이스', Array.from(hubEmb));

      const leaf = createLeafNode(nodeRepo, 'DB 최적화', ['데이터베이스']);

      const result = await pipeline.processNodes([leaf], 10);

      expect(result.hubsMatched).toHaveLength(1);
      expect(result.hubsCreated).toHaveLength(0);
      expect(result.hubsMatched[0]!.label).toBe('데이터베이스');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 6. EventBus integration
  // ════════════════════════════════════════════════════════════════

  describe('EventBus integration', () => {
    it('processes nodes when memory-nodes.extracted event is emitted', async () => {
      const eventBus = new EventBus();
      const pipelineWithEvents = new HubCreationPipeline(db, embeddingProvider, eventBus);
      pipelineWithEvents.start();

      // Create a leaf node with entities
      const leaf = createLeafNode(nodeRepo, 'Event test', ['EventBus']);

      const event: MemoryNodesExtractedEvent = {
        type: 'memory-nodes.extracted',
        conversationId: 'conv-1',
        sourceTurnIndex: 1,
        nodeCount: 1,
        nodeIds: [leaf.id],
        nodeTypes: ['semantic'],
        timestamp: new Date().toISOString(),
      };

      await eventBus.emit(event);

      // Wait for async processing
      await new Promise(r => setTimeout(r, 100));

      // Hub should have been created
      const hubs = nodeRepo.getHubs();
      expect(hubs).toHaveLength(1);
      expect(hubs[0]!.frontmatter).toBe('Eventbus');

      pipelineWithEvents.stop();
    });

    it('stop() prevents further processing', async () => {
      const eventBus = new EventBus();
      const pipelineWithEvents = new HubCreationPipeline(db, embeddingProvider, eventBus);
      pipelineWithEvents.start();
      pipelineWithEvents.stop();

      const leaf = createLeafNode(nodeRepo, 'Stopped test', ['StopEntity']);

      await eventBus.emit({
        type: 'memory-nodes.extracted',
        conversationId: 'conv-1',
        sourceTurnIndex: 1,
        nodeCount: 1,
        nodeIds: [leaf.id],
        nodeTypes: ['semantic'],
        timestamp: new Date().toISOString(),
      } as MemoryNodesExtractedEvent);

      await new Promise(r => setTimeout(r, 50));

      const hubs = nodeRepo.getHubs();
      expect(hubs).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 7. No-embedding fallback
  // ════════════════════════════════════════════════════════════════

  describe('no embedding provider', () => {
    it('uses label-based matching when no embedding provider is available', async () => {
      const noEmbPipeline = new HubCreationPipeline(db, null);

      // Pre-create a hub with the same label
      createHubNode(nodeRepo, 'TypeScript', 'typescript');

      const leaf = createLeafNode(nodeRepo, 'TS fact', ['TypeScript']);

      const result = await noEmbPipeline.processNodes([leaf], 10);

      expect(result.ok).toBe(true);
      expect(result.hubsMatched).toHaveLength(1);
      expect(result.hubsCreated).toHaveLength(0);
    });

    it('creates hubs without embeddings when no provider', async () => {
      const noEmbPipeline = new HubCreationPipeline(db, null);

      const leaf = createLeafNode(nodeRepo, 'No emb test', ['NewEntity']);

      const result = await noEmbPipeline.processNodes([leaf], 10);

      expect(result.ok).toBe(true);
      expect(result.hubsCreated).toHaveLength(1);

      const hubs = nodeRepo.getHubs();
      expect(hubs).toHaveLength(1);
      expect(hubs[0]!.embedding).toBeUndefined(); // No embedding
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 8. Configuration
  // ════════════════════════════════════════════════════════════════

  describe('configuration', () => {
    it('disables auto-creation when autoCreateHubs=false', async () => {
      const noCreatePipeline = new HubCreationPipeline(db, embeddingProvider, undefined, {
        autoCreateHubs: false,
      });

      const leaf = createLeafNode(nodeRepo, 'No auto-create', ['UnknownEntity']);

      const result = await noCreatePipeline.processNodes([leaf], 10);

      expect(result.ok).toBe(true);
      expect(result.hubsCreated).toHaveLength(0);
      expect(result.edgesCreated).toHaveLength(0);
    });

    it('uses custom edge weight', async () => {
      const customPipeline = new HubCreationPipeline(db, embeddingProvider, undefined, {
        defaultEdgeWeight: 0.8,
      });

      const leaf = createLeafNode(nodeRepo, 'Custom weight', ['TestEntity']);

      const result = await customPipeline.processNodes([leaf], 10);

      expect(result.edgesCreated).toHaveLength(1);
      expect(result.edgesCreated[0]!.weight).toBe(0.8);
    });

    it('uses custom edge type', async () => {
      const customPipeline = new HubCreationPipeline(db, embeddingProvider, undefined, {
        defaultEdgeType: 'related',
      });

      const leaf = createLeafNode(nodeRepo, 'Custom type', ['SomeEntity']);

      const result = await customPipeline.processNodes([leaf], 10);

      expect(result.edgesCreated).toHaveLength(1);
      expect(result.edgesCreated[0]!.edgeType).toBe('related');
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 9. Edge cases
  // ════════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('handles leaf nodes with no entities gracefully', async () => {
      const leaf = createLeafNode(nodeRepo, 'No entities', []);

      const result = await pipeline.processNodes([leaf], 10);

      expect(result.ok).toBe(true);
      expect(result.hubsCreated).toHaveLength(0);
      expect(result.edgesCreated).toHaveLength(0);
    });

    it('handles empty node list', async () => {
      const result = await pipeline.processNodes([], 10);

      expect(result.ok).toBe(true);
      expect(result.hubsCreated).toHaveLength(0);
    });

    it('skips hub-role nodes (only processes leaves)', async () => {
      const hub = createHubNode(nodeRepo, 'ExistingHub', 'hub keywords');
      // Manually set entities on the hub's metadata
      nodeRepo.update(hub.id, { metadata: { entities: ['ShouldBeIgnored'] } });
      const updatedHub = nodeRepo.getById(hub.id)!;

      const result = await pipeline.processNodes([updatedHub], 10);

      expect(result.ok).toBe(true);
      expect(result.hubsCreated).toHaveLength(0);
      expect(result.edgesCreated).toHaveLength(0);
    });

    it('handles empty string entities (trims and skips)', async () => {
      const leaf = createLeafNode(nodeRepo, 'Empty entities', ['', '  ', 'Valid']);

      const result = await pipeline.processNodes([leaf], 10);

      // Only 'Valid' should produce a hub
      expect(result.hubsCreated).toHaveLength(1);
      expect(result.hubsCreated[0]!.sourceEntity).toBe('valid');
    });

    it('handles nodes from handleNodesExtracted with nonexistent IDs', async () => {
      const event: MemoryNodesExtractedEvent = {
        type: 'memory-nodes.extracted',
        conversationId: 'conv-1',
        sourceTurnIndex: 1,
        nodeCount: 1,
        nodeIds: ['nonexistent-id'],
        nodeTypes: ['semantic'],
        timestamp: new Date().toISOString(),
      };

      const result = await pipeline.handleNodesExtracted(event, 10);

      expect(result.ok).toBe(true);
      expect(result.hubsCreated).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // 10. End-to-end: full pipeline integration
  // ════════════════════════════════════════════════════════════════

  describe('end-to-end integration', () => {
    it('processes multiple leaves with shared and unique entities', async () => {
      // Simulate extractor output: 3 leaves with overlapping entities
      const leaf1 = createLeafNode(nodeRepo, 'TS backend dev', ['TypeScript', 'Node.js', 'Backend']);
      const leaf2 = createLeafNode(nodeRepo, 'TS frontend dev', ['TypeScript', 'React', 'Frontend']);
      const leaf3 = createLeafNode(nodeRepo, 'Database setup', ['PostgreSQL', 'Docker']);

      const result = await pipeline.processNodes([leaf1, leaf2, leaf3], 42);

      expect(result.ok).toBe(true);

      // 6 unique entities: TypeScript, Node.js, Backend, React, Frontend, PostgreSQL, Docker
      expect(result.hubsCreated).toHaveLength(7);

      // TypeScript appears in 2 leaves → 1 hub, 2 edges
      const tsHub = result.hubsCreated.find(h => h.sourceEntity === 'typescript');
      expect(tsHub).toBeDefined();
      expect(tsHub!.connectedLeafIds).toHaveLength(2);
      expect(tsHub!.connectedLeafIds).toContain(leaf1.id);
      expect(tsHub!.connectedLeafIds).toContain(leaf2.id);

      // PostgreSQL appears in 1 leaf → 1 hub, 1 edge
      const pgHub = result.hubsCreated.find(h => h.sourceEntity === 'postgresql');
      expect(pgHub).toBeDefined();
      expect(pgHub!.connectedLeafIds).toHaveLength(1);
      expect(pgHub!.connectedLeafIds).toContain(leaf3.id);

      // Total edges: leaf1(3) + leaf2(3-1shared=2new+1shared_already_cached) + leaf3(2) = 9
      // But since TypeScript is shared, leaf1 creates 3, leaf2 creates 3 (TS reuses hub),
      // leaf3 creates 2 = 8 edges... Let's verify
      // Actually: leaf1 contributes [typescript, node.js, backend], leaf2 contributes [typescript, react, frontend],
      // leaf3 contributes [postgresql, docker]
      // typescript entity maps to leafIds [leaf1.id, leaf2.id] → 2 edges to same hub
      // So total edges = 2 + 1 + 1 + 1 + 1 + 1 + 1 = 8
      expect(result.edgesCreated.length).toBe(8);

      // Verify DB state
      const hubs = nodeRepo.getHubs();
      expect(hubs).toHaveLength(7);
    });

    it('mixes matched and created hubs in one pass', async () => {
      // Pre-create some hubs
      const tsEmb = makeEmbedding(42);
      createHubNode(nodeRepo, 'TypeScript', 'typescript 타입스크립트', tsEmb);
      embeddingProvider.setEmbedding('typescript', Array.from(tsEmb));

      // Leaf with 1 matching entity + 1 new entity
      const leaf = createLeafNode(nodeRepo, 'TS and Docker', ['TypeScript', 'Docker']);

      const result = await pipeline.processNodes([leaf], 10);

      expect(result.ok).toBe(true);
      expect(result.hubsMatched).toHaveLength(1);
      expect(result.hubsMatched[0]!.sourceEntity).toBe('typescript');
      expect(result.hubsCreated).toHaveLength(1);
      expect(result.hubsCreated[0]!.sourceEntity).toBe('docker');
      expect(result.edgesCreated).toHaveLength(2);

      // DB should have 2 hubs total (1 pre-existing + 1 new)
      const hubs = nodeRepo.getHubs();
      expect(hubs).toHaveLength(2);
    });

    it('provides correct performance timing', async () => {
      const leaf = createLeafNode(nodeRepo, 'Timing test', ['SomeEntity']);

      const result = await pipeline.processNodes([leaf], 10);

      expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.totalTimeMs).toBe('number');
    });
  });
});
