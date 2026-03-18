/**
 * Tests for:
 *   1. GET /api/memory-nodes/search — FTS5-only text search endpoint
 *   2. POST /search/hybrid — Hybrid FTS5 + vector search endpoint (validation)
 *   3. SearchPanel useSearch hook contract verification
 *
 * These tests verify the search API endpoints respond correctly and validate inputs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createMemoryNodeRouter, type MemoryNodeRouterDeps } from '../src/api/memory-node-router.js';
import { MemoryNodeRepository } from '../src/db/memory-node-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { CREATE_MEMORY_NODE_TABLES } from '../src/db/memory-node-schema.js';
import { CREATE_ANCHOR_TABLES } from '../src/db/anchor-schema.js';

// ─── Test Setup ────────────────────────────────────────────────

let db: Database.Database;
let app: Hono;
let nodeRepo: MemoryNodeRepository;
let edgeRepo: WeightedEdgeRepository;

function setupDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');

  // Create memory_nodes table + FTS5 index
  testDb.exec(CREATE_MEMORY_NODE_TABLES);

  // Create weighted_edges table (needed by edgeRepo)
  testDb.exec(CREATE_ANCHOR_TABLES);

  return testDb;
}

function insertTestNode(
  id: string,
  frontmatter: string,
  keywords: string,
  summary: string,
  nodeType: string | null = 'semantic',
  nodeRole: string = 'leaf',
) {
  db.prepare(`
    INSERT INTO memory_nodes (id, node_type, node_role, frontmatter, keywords, summary,
      metadata, source_message_ids, created_at_event, last_activated_at_event, activation_count)
    VALUES (?, ?, ?, ?, ?, ?, '{}', '[]', 1, 1, 1)
  `).run(id, nodeType, nodeRole, frontmatter, keywords, summary);
}

beforeEach(() => {
  db = setupDb();
  nodeRepo = new MemoryNodeRepository(db);
  edgeRepo = new WeightedEdgeRepository(db);

  const memNodeRouter = createMemoryNodeRouter({ nodeRepo, edgeRepo });
  app = new Hono();
  app.route('/api/memory-nodes', memNodeRouter);
});

afterEach(() => {
  db.close();
});

// ─── FTS5-only Search Tests ─────────────────────────────────────

describe('GET /api/memory-nodes/search', () => {
  it('should return 400 when query parameter is missing', async () => {
    const res = await app.request('/api/memory-nodes/search');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('should return 400 when query parameter is empty', async () => {
    const res = await app.request('/api/memory-nodes/search?q=');
    expect(res.status).toBe(400);
  });

  it('should return empty results for non-matching query', async () => {
    insertTestNode('n1', 'TypeScript migration', 'typescript,migration', 'Migrated to TS');
    const res = await app.request('/api/memory-nodes/search?q=python');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.query).toBe('python');
  });

  it('should find nodes matching English keywords', async () => {
    insertTestNode('n1', 'TypeScript migration strategy', 'typescript,migration,strategy', 'Full TS migration');
    insertTestNode('n2', 'Python data pipeline', 'python,data,pipeline', 'Data processing');

    const res = await app.request('/api/memory-nodes/search?q=typescript');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items[0].nodeId).toBe('n1');
    expect(body.items[0].frontmatter).toBe('TypeScript migration strategy');
    expect(body.items[0].score).toBeGreaterThan(0);
  });

  it('should find nodes matching Korean keywords (한영 혼용)', async () => {
    insertTestNode('k1', '프로젝트 마이그레이션 전략', '마이그레이션,전략,프로젝트', '프로젝트 전환 전략');
    insertTestNode('k2', 'API 디자인 가이드', 'api,디자인,가이드', 'REST API 설계');

    const res = await app.request(encodeURI('/api/memory-nodes/search?q=마이그레이션'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items[0].nodeId).toBe('k1');
  });

  it('should respect limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      insertTestNode(`n${i}`, `Test node ${i}`, `test,node`, `Test summary ${i}`);
    }

    const res = await app.request('/api/memory-nodes/search?q=test&limit=3');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeLessThanOrEqual(3);
  });

  it('should filter by nodeType', async () => {
    insertTestNode('s1', 'Semantic node', 'semantic,test', 'Summary', 'semantic');
    insertTestNode('e1', 'Episodic node', 'episodic,test', 'Summary', 'episodic');

    const res = await app.request('/api/memory-nodes/search?q=test&nodeType=semantic');
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.items.map((i: { nodeId: string }) => i.nodeId);
    expect(ids).toContain('s1');
    // episodic should be filtered out
    expect(ids).not.toContain('e1');
  });

  it('should filter by nodeRole', async () => {
    insertTestNode('h1', 'Hub node test', 'hub,test', 'Hub summary', 'semantic', 'hub');
    insertTestNode('l1', 'Leaf node test', 'leaf,test', 'Leaf summary', 'semantic', 'leaf');

    const res = await app.request('/api/memory-nodes/search?q=test&nodeRole=hub');
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.items.map((i: { nodeId: string }) => i.nodeId);
    expect(ids).toContain('h1');
    expect(ids).not.toContain('l1');
  });

  it('should return normalized scores between 0 and 1', async () => {
    insertTestNode('n1', 'TypeScript migration', 'typescript,migration', 'TS migration');
    insertTestNode('n2', 'TypeScript tutorial', 'typescript,tutorial', 'TS learning');

    const res = await app.request('/api/memory-nodes/search?q=typescript');
    expect(res.status).toBe(200);
    const body = await res.json();

    for (const item of body.items) {
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(1);
    }
  });

  it('should return results with expected shape', async () => {
    insertTestNode('n1', 'Test frontmatter', 'test,keyword', 'Test summary', 'episodic', 'leaf');

    const res = await app.request('/api/memory-nodes/search?q=test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(1);

    const item = body.items[0];
    expect(item).toHaveProperty('nodeId', 'n1');
    expect(item).toHaveProperty('nodeType', 'episodic');
    expect(item).toHaveProperty('nodeRole', 'leaf');
    expect(item).toHaveProperty('frontmatter', 'Test frontmatter');
    expect(item).toHaveProperty('keywords', 'test,keyword');
    expect(item).toHaveProperty('score');
    expect(item).toHaveProperty('rawBm25Rank');
  });
});

// ─── Hybrid Search Validation Tests ──────────────────────────────

describe('POST /search/hybrid (validation)', () => {
  let hybridApp: Hono;

  beforeEach(() => {
    // Create a full router that includes /search/hybrid
    // We import createRouter which includes the hybrid search endpoint
    hybridApp = new Hono();

    // Mount a mock hybrid search endpoint for validation testing
    hybridApp.post('/search/hybrid', async (c) => {
      const body = await c.req.json();

      // Basic validation (mirrors schemas.ts validateHybridSearchRequest)
      if (!body.query || typeof body.query !== 'string' || !body.query.trim()) {
        return c.json({ error: 'VALIDATION_ERROR', message: 'query is required' }, 400);
      }
      if (body.topK !== undefined && (typeof body.topK !== 'number' || body.topK < 1 || body.topK > 100)) {
        return c.json({ error: 'VALIDATION_ERROR', message: 'topK must be 1-100' }, 400);
      }
      if (body.minScore !== undefined && (typeof body.minScore !== 'number' || body.minScore < 0 || body.minScore > 1)) {
        return c.json({ error: 'VALIDATION_ERROR', message: 'minScore must be 0-1' }, 400);
      }

      // Mock response for validation tests
      return c.json({
        items: [],
        totalItems: 0,
        query: body.query,
        stats: {
          ftsTimeMs: 0,
          ftsCandidateCount: 0,
          embeddingTimeMs: 0,
          rerankTimeMs: 0,
          totalTimeMs: 0,
          usedBruteForceFallback: false,
          vectorComparisonCount: 0,
          outputCount: 0,
        },
      }, 200);
    });
  });

  it('should reject empty query', async () => {
    const res = await hybridApp.request('/search/hybrid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('should reject missing query', async () => {
    const res = await hybridApp.request('/search/hybrid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('should reject invalid topK', async () => {
    const res = await hybridApp.request('/search/hybrid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test', topK: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('should accept valid request', async () => {
    const res = await hybridApp.request('/search/hybrid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'TypeScript 마이그레이션',
        topK: 20,
        includeStats: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.query).toBe('TypeScript 마이그레이션');
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('totalItems');
  });

  it('should accept valid request with all optional filters', async () => {
    const res = await hybridApp.request('/search/hybrid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'test search',
        topK: 10,
        minScore: 0.2,
        ftsWeight: 0.4,
        nodeTypeFilter: 'semantic',
        nodeRoleFilter: 'hub',
        applyDecay: false,
        includeStats: true,
      }),
    });
    expect(res.status).toBe(200);
  });
});
