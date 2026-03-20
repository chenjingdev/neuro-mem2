/**
 * Tests for Memory Node Router — L0→L1→L2→L3 progressive depth layer loading API.
 *
 * Validates:
 * - GET /api/memory-nodes (list with pagination + depth)
 * - GET /api/memory-nodes/:id (single node at depth)
 * - GET /api/memory-nodes/:id/children (lazy-load children via edges)
 * - GET /api/memory-nodes/hubs (hub listing)
 * - GET /api/memory-nodes/stats (statistics)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { MemoryNodeRepository } from '../../src/db/memory-node-repo.js';
import { WeightedEdgeRepository } from '../../src/db/weighted-edge-repo.js';
import { CREATE_MEMORY_NODE_TABLES } from '../../src/db/memory-node-schema.js';
import { CREATE_ANCHOR_TABLES } from '../../src/db/anchor-schema.js';
import { createMemoryNodeRouter } from '../../src/api/memory-node-router.js';
import type { CreateMemoryNodeInput } from '../../src/models/memory-node.js';

// ─── Test Setup ──────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CREATE_MEMORY_NODE_TABLES);
  db.exec(CREATE_ANCHOR_TABLES);
  return db;
}

function createApp(db: Database.Database) {
  const nodeRepo = new MemoryNodeRepository(db);
  const edgeRepo = new WeightedEdgeRepository(db);
  const router = createMemoryNodeRouter({ nodeRepo, edgeRepo });

  const app = new Hono();
  app.route('/api/memory-nodes', router);
  return { app, nodeRepo, edgeRepo };
}

function makeSemantic(overrides?: Partial<CreateMemoryNodeInput>): CreateMemoryNodeInput {
  return {
    nodeType: 'semantic',
    nodeRole: 'leaf',
    frontmatter: 'User prefers TypeScript',
    keywords: 'typescript preference programming',
    summary: 'The user mentioned that they prefer TypeScript over JavaScript.',
    metadata: {
      entities: ['TypeScript', 'JavaScript'],
      category: 'preference',
      confidence: 0.9,
    },
    sourceMessageIds: ['conv1:0', 'conv1:1'],
    conversationId: 'conv1',
    sourceTurnIndex: 1,
    currentEventCounter: 5.0,
    ...overrides,
  };
}

function makeHub(overrides?: Partial<CreateMemoryNodeInput>): CreateMemoryNodeInput {
  return {
    nodeType: 'semantic',
    nodeRole: 'hub',
    frontmatter: 'TypeScript',
    keywords: 'typescript ts 타입스크립트 language',
    summary: 'TypeScript is a typed superset of JavaScript.',
    metadata: {
      hubType: 'topic',
      aliases: ['TS', '타입스크립트'],
      relevance: 0.95,
    },
    currentEventCounter: 10.0,
    ...overrides,
  };
}

async function fetchJson(app: Hono, path: string) {
  const resp = await app.request(path);
  return { status: resp.status, body: await resp.json() };
}

// ─── Tests ───────────────────────────────────────────────

describe('Memory Node Router — Layer Loading API', () => {
  let db: Database.Database;
  let app: Hono;
  let nodeRepo: MemoryNodeRepository;
  let edgeRepo: WeightedEdgeRepository;

  beforeEach(() => {
    db = createTestDb();
    const setup = createApp(db);
    app = setup.app;
    nodeRepo = setup.nodeRepo;
    edgeRepo = setup.edgeRepo;
  });

  // ── Stats Endpoint ──

  describe('GET /api/memory-nodes/stats', () => {
    it('returns zero counts on empty db', async () => {
      const { status, body } = await fetchJson(app, '/api/memory-nodes/stats');
      expect(status).toBe(200);
      expect(body.totalNodes).toBe(0);
      expect(body.totalEdges).toBe(0);
      expect(body.byRole.hub).toBe(0);
      expect(body.byRole.leaf).toBe(0);
    });

    it('returns correct counts after inserts', async () => {
      nodeRepo.create(makeSemantic());
      nodeRepo.create(makeSemantic({ frontmatter: 'User likes React', keywords: 'react frontend' }));
      nodeRepo.create(makeHub());

      const { status, body } = await fetchJson(app, '/api/memory-nodes/stats');
      expect(status).toBe(200);
      expect(body.totalNodes).toBe(3);
      expect(body.byRole.hub).toBe(1);
      expect(body.byRole.leaf).toBe(2);
      expect(body.byType.semantic).toBe(3);
    });
  });

  // ── List Endpoint ──

  describe('GET /api/memory-nodes', () => {
    it('returns empty list on empty db', async () => {
      const { status, body } = await fetchJson(app, '/api/memory-nodes');
      expect(status).toBe(200);
      expect(body.items).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('returns L0 refs by default (depth=0)', async () => {
      nodeRepo.create(makeSemantic());

      const { body } = await fetchJson(app, '/api/memory-nodes');
      expect(body.items).toHaveLength(1);
      const item = body.items[0];
      // L0 fields present
      expect(item.id).toBeDefined();
      expect(item.frontmatter).toBe('User prefers TypeScript');
      expect(item.keywords).toBeDefined();
      expect(item.nodeType).toBe('semantic');
      expect(item.nodeRole).toBe('leaf');
      // L1+ fields should NOT be present
      expect(item.metadata).toBeUndefined();
      expect(item.summary).toBeUndefined();
      expect(item.sourceMessageIds).toBeUndefined();
    });

    it('returns L1 data when depth=1', async () => {
      nodeRepo.create(makeSemantic());

      const { body } = await fetchJson(app, '/api/memory-nodes?depth=1');
      const item = body.items[0];
      expect(item.metadata).toBeDefined();
      expect(item.metadata.entities).toContain('TypeScript');
      expect(item.summary).toBeUndefined();
    });

    it('returns L2 data when depth=2', async () => {
      nodeRepo.create(makeSemantic());

      const { body } = await fetchJson(app, '/api/memory-nodes?depth=2');
      const item = body.items[0];
      expect(item.metadata).toBeDefined();
      expect(item.summary).toBe('The user mentioned that they prefer TypeScript over JavaScript.');
      expect(item.sourceMessageIds).toBeUndefined();
    });

    it('returns L3 (full) data when depth=3', async () => {
      nodeRepo.create(makeSemantic());

      const { body } = await fetchJson(app, '/api/memory-nodes?depth=3');
      const item = body.items[0];
      expect(item.metadata).toBeDefined();
      expect(item.summary).toBeDefined();
      expect(item.sourceMessageIds).toEqual(['conv1:0', 'conv1:1']);
      expect(item.conversationId).toBe('conv1');
      expect(item.hasEmbedding).toBe(false);
      // Embedding blob should not be serialized
      expect(item.embedding).toBeUndefined();
    });

    it('supports pagination (limit/offset)', async () => {
      // Create 5 nodes
      for (let i = 0; i < 5; i++) {
        nodeRepo.create(makeSemantic({ frontmatter: `Node ${i}`, keywords: `node${i}` }));
      }

      const page1 = await fetchJson(app, '/api/memory-nodes?limit=2&offset=0');
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.total).toBe(5);
      expect(page1.body.limit).toBe(2);
      expect(page1.body.offset).toBe(0);

      const page2 = await fetchJson(app, '/api/memory-nodes?limit=2&offset=2');
      expect(page2.body.items).toHaveLength(2);

      const page3 = await fetchJson(app, '/api/memory-nodes?limit=2&offset=4');
      expect(page3.body.items).toHaveLength(1);
    });

    it('filters by nodeType', async () => {
      nodeRepo.create(makeSemantic());
      nodeRepo.create(makeSemantic({
        nodeType: 'episodic',
        frontmatter: 'Debugging session',
        keywords: 'debug session',
      }));

      const { body } = await fetchJson(app, '/api/memory-nodes?nodeType=episodic');
      expect(body.items).toHaveLength(1);
      expect(body.items[0].nodeType).toBe('episodic');
    });

    it('filters by nodeRole', async () => {
      nodeRepo.create(makeSemantic());
      nodeRepo.create(makeHub());

      const { body } = await fetchJson(app, '/api/memory-nodes?nodeRole=hub');
      expect(body.items).toHaveLength(1);
      expect(body.items[0].nodeRole).toBe('hub');
    });
  });

  // ── Single Node Endpoint ──

  describe('GET /api/memory-nodes/:id', () => {
    it('returns 404 for non-existent node', async () => {
      const { status, body } = await fetchJson(app, '/api/memory-nodes/nonexistent');
      expect(status).toBe(404);
      expect(body.error).toBe('NOT_FOUND');
    });

    it('returns L0 ref by default', async () => {
      const node = nodeRepo.create(makeSemantic());
      const { status, body } = await fetchJson(app, `/api/memory-nodes/${node.id}`);
      expect(status).toBe(200);
      expect(body.id).toBe(node.id);
      expect(body.frontmatter).toBe('User prefers TypeScript');
      expect(body.metadata).toBeUndefined();
    });

    it('returns L1 data with depth=1', async () => {
      const node = nodeRepo.create(makeSemantic());
      const { body } = await fetchJson(app, `/api/memory-nodes/${node.id}?depth=1`);
      expect(body.metadata.category).toBe('preference');
      expect(body.summary).toBeUndefined();
    });

    it('returns L2 data with depth=2', async () => {
      const node = nodeRepo.create(makeSemantic());
      const { body } = await fetchJson(app, `/api/memory-nodes/${node.id}?depth=2`);
      expect(body.metadata).toBeDefined();
      expect(body.summary).toBeDefined();
    });

    it('returns L3 full data with depth=3', async () => {
      const node = nodeRepo.create(makeSemantic());
      const { body } = await fetchJson(app, `/api/memory-nodes/${node.id}?depth=3`);
      expect(body.sourceMessageIds).toEqual(['conv1:0', 'conv1:1']);
      expect(body.hasEmbedding).toBe(false);
    });
  });

  // ── Hubs Endpoint ──

  describe('GET /api/memory-nodes/hubs', () => {
    it('returns only hub nodes', async () => {
      nodeRepo.create(makeSemantic());
      nodeRepo.create(makeHub());
      nodeRepo.create(makeHub({ frontmatter: 'React', keywords: 'react 리액트' }));

      const { body } = await fetchJson(app, '/api/memory-nodes/hubs');
      expect(body.items).toHaveLength(2);
      for (const item of body.items) {
        expect(item.nodeRole).toBe('hub');
      }
    });

    it('supports depth parameter', async () => {
      nodeRepo.create(makeHub());

      const { body } = await fetchJson(app, '/api/memory-nodes/hubs?depth=1');
      expect(body.items[0].metadata).toBeDefined();
      expect(body.items[0].metadata.hubType).toBe('topic');
    });
  });

  // ── Children Endpoint ──

  describe('GET /api/memory-nodes/:id/children', () => {
    it('returns 404 for non-existent parent', async () => {
      const { status, body } = await fetchJson(app, '/api/memory-nodes/nonexistent/children');
      expect(status).toBe(404);
      expect(body.error).toBe('NOT_FOUND');
    });

    it('returns empty children when no edges exist', async () => {
      const hub = nodeRepo.create(makeHub());
      const { status, body } = await fetchJson(app, `/api/memory-nodes/${hub.id}/children`);
      expect(status).toBe(200);
      expect(body.parentId).toBe(hub.id);
      expect(body.children).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it('returns children connected via edges at L0 depth', async () => {
      const hub = nodeRepo.create(makeHub());
      const leaf1 = nodeRepo.create(makeSemantic({ frontmatter: 'Leaf 1' }));
      const leaf2 = nodeRepo.create(makeSemantic({ frontmatter: 'Leaf 2' }));

      // Create edges
      edgeRepo.createEdge({
        sourceId: hub.id,
        sourceType: 'hub',
        targetId: leaf1.id,
        targetType: 'leaf',
        edgeType: 'about',
        weight: 5.0,
      });
      edgeRepo.createEdge({
        sourceId: hub.id,
        sourceType: 'hub',
        targetId: leaf2.id,
        targetType: 'leaf',
        edgeType: 'about',
        weight: 3.0,
      });

      const { status, body } = await fetchJson(app, `/api/memory-nodes/${hub.id}/children`);
      expect(status).toBe(200);
      expect(body.parentId).toBe(hub.id);
      expect(body.children).toHaveLength(2);

      // Check edge info is included
      const child = body.children[0];
      expect(child.node.id).toBeDefined();
      expect(child.node.frontmatter).toBeDefined();
      expect(child.edge.edgeType).toBe('about');
      expect(child.edge.direction).toBe('outgoing');
      expect(typeof child.edge.weight).toBe('number');
    });

    it('returns children at L1 depth', async () => {
      const hub = nodeRepo.create(makeHub());
      const leaf = nodeRepo.create(makeSemantic());

      edgeRepo.createEdge({
        sourceId: hub.id,
        sourceType: 'hub',
        targetId: leaf.id,
        targetType: 'leaf',
        edgeType: 'about',
        weight: 5.0,
      });

      const { body } = await fetchJson(app, `/api/memory-nodes/${hub.id}/children?depth=1`);
      expect(body.children).toHaveLength(1);
      expect(body.children[0].node.metadata).toBeDefined();
      expect(body.children[0].node.metadata.category).toBe('preference');
    });

    it('returns children at L2 depth', async () => {
      const hub = nodeRepo.create(makeHub());
      const leaf = nodeRepo.create(makeSemantic());

      edgeRepo.createEdge({
        sourceId: hub.id,
        sourceType: 'hub',
        targetId: leaf.id,
        targetType: 'leaf',
        edgeType: 'about',
        weight: 5.0,
      });

      const { body } = await fetchJson(app, `/api/memory-nodes/${hub.id}/children?depth=2`);
      expect(body.children[0].node.summary).toBeDefined();
    });

    it('includes incoming edges as children', async () => {
      const hub = nodeRepo.create(makeHub());
      const leaf = nodeRepo.create(makeSemantic());

      // Leaf -> Hub (incoming to hub)
      edgeRepo.createEdge({
        sourceId: leaf.id,
        sourceType: 'leaf',
        targetId: hub.id,
        targetType: 'hub',
        edgeType: 'about',
        weight: 2.0,
      });

      const { body } = await fetchJson(app, `/api/memory-nodes/${hub.id}/children`);
      expect(body.children).toHaveLength(1);
      expect(body.children[0].edge.direction).toBe('incoming');
    });

    it('supports minWeight filter', async () => {
      const hub = nodeRepo.create(makeHub());
      const leaf1 = nodeRepo.create(makeSemantic({ frontmatter: 'Strong' }));
      const leaf2 = nodeRepo.create(makeSemantic({ frontmatter: 'Weak' }));

      edgeRepo.createEdge({
        sourceId: hub.id,
        sourceType: 'hub',
        targetId: leaf1.id,
        targetType: 'leaf',
        edgeType: 'about',
        weight: 10.0,
      });
      edgeRepo.createEdge({
        sourceId: hub.id,
        sourceType: 'hub',
        targetId: leaf2.id,
        targetType: 'leaf',
        edgeType: 'about',
        weight: 1.0,
      });

      const { body } = await fetchJson(app, `/api/memory-nodes/${hub.id}/children?minWeight=5`);
      expect(body.children).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it('supports pagination on children', async () => {
      const hub = nodeRepo.create(makeHub());
      const leaves: ReturnType<typeof nodeRepo.create>[] = [];
      for (let i = 0; i < 5; i++) {
        leaves.push(nodeRepo.create(makeSemantic({ frontmatter: `Leaf ${i}` })));
      }

      for (const leaf of leaves) {
        edgeRepo.createEdge({
          sourceId: hub.id,
          sourceType: 'hub',
          targetId: leaf.id,
          targetType: 'leaf',
          edgeType: 'about',
          weight: 5.0,
        });
      }

      const page1 = await fetchJson(app, `/api/memory-nodes/${hub.id}/children?limit=2&offset=0`);
      expect(page1.body.children).toHaveLength(2);
      expect(page1.body.total).toBe(5);

      const page2 = await fetchJson(app, `/api/memory-nodes/${hub.id}/children?limit=2&offset=4`);
      expect(page2.body.children).toHaveLength(1);
    });
  });

  // ── Korean Content Support ──

  describe('한영 혼용 support', () => {
    it('handles Korean frontmatter and keywords', async () => {
      nodeRepo.create(makeSemantic({
        frontmatter: '사용자는 TypeScript를 선호함',
        keywords: '타입스크립트 선호 프로그래밍 typescript',
      }));

      const { body } = await fetchJson(app, '/api/memory-nodes?depth=0');
      expect(body.items).toHaveLength(1);
      expect(body.items[0].frontmatter).toBe('사용자는 TypeScript를 선호함');
    });
  });
});
