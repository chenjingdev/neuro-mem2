/**
 * Tests for Graph API endpoint and view interconnection logic.
 *
 * Validates:
 * - GET /api/memory-nodes/graph returns global map data (sampled hubs + leaves)
 * - GET /api/memory-nodes/graph?centerNodeId=X returns local ego-network (BFS)
 * - Global → Local transition: node click in global produces valid centerNodeId for local
 * - Sampling: maxNodes cap is respected
 * - Edge filtering: minWeight filter works
 * - Hub-only mode: hubsOnly=true only returns hub nodes
 * - BFS hops: hops parameter limits traversal depth
 * - Performance: LOD uses L0 fields only (no embedding, no metadata)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryNodeRepository } from '../src/db/memory-node-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { CREATE_MEMORY_NODE_TABLES } from '../src/db/memory-node-schema.js';
import type { CreateMemoryNodeInput } from '../src/models/memory-node.js';
import { createMemoryNodeRouter } from '../src/api/memory-node-router.js';

describe('Graph API — Global Map & Local Explorer Views', () => {
  let db: Database.Database;
  let nodeRepo: MemoryNodeRepository;
  let edgeRepo: WeightedEdgeRepository;
  let app: ReturnType<typeof createMemoryNodeRouter>;

  function makeInput(overrides: Partial<CreateMemoryNodeInput> = {}): CreateMemoryNodeInput {
    return {
      nodeType: 'semantic',
      nodeRole: 'leaf',
      frontmatter: 'test node',
      keywords: 'test keyword',
      summary: 'A test node',
      metadata: {},
      sourceMessageIds: [],
      currentEventCounter: 1,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec(CREATE_MEMORY_NODE_TABLES);

    // Create weighted_edges table
    db.exec(`
      CREATE TABLE IF NOT EXISTS weighted_edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'memory_node',
        target_id TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT 'memory_node',
        edge_type TEXT NOT NULL DEFAULT 'co_activation',
        weight REAL NOT NULL DEFAULT 50,
        initial_weight REAL NOT NULL DEFAULT 50,
        shield REAL NOT NULL DEFAULT 0,
        learning_rate REAL NOT NULL DEFAULT 0.1,
        decay_rate REAL NOT NULL DEFAULT 0.01,
        activation_count INTEGER NOT NULL DEFAULT 0,
        last_activated_at_event REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT
      )
    `);

    nodeRepo = new MemoryNodeRepository(db);
    edgeRepo = new WeightedEdgeRepository(db);
    app = createMemoryNodeRouter({ nodeRepo, edgeRepo });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Helper: create nodes and edges for testing ───

  function createTestGraph() {
    // Create 2 hubs and 5 leaves
    const hub1 = nodeRepo.create(makeInput({
      nodeRole: 'hub',
      frontmatter: 'Hub: TypeScript',
      keywords: 'typescript programming',
      nodeType: 'semantic',
    }));
    const hub2 = nodeRepo.create(makeInput({
      nodeRole: 'hub',
      frontmatter: 'Hub: React',
      keywords: 'react ui framework',
      nodeType: 'semantic',
    }));

    const leaf1 = nodeRepo.create(makeInput({
      frontmatter: 'Leaf: useState hook',
      keywords: 'usestate hook react',
      nodeType: 'procedural',
    }));
    const leaf2 = nodeRepo.create(makeInput({
      frontmatter: 'Leaf: type inference',
      keywords: 'type inference typescript',
      nodeType: 'semantic',
    }));
    const leaf3 = nodeRepo.create(makeInput({
      frontmatter: 'Leaf: deployment done',
      keywords: 'deploy production',
      nodeType: 'episodic',
    }));
    const leaf4 = nodeRepo.create(makeInput({
      frontmatter: 'Leaf: useEffect cleanup',
      keywords: 'useeffect cleanup react',
      nodeType: 'procedural',
    }));
    const leaf5 = nodeRepo.create(makeInput({
      frontmatter: 'Leaf: team meeting notes',
      keywords: 'meeting notes team',
      nodeType: 'episodic',
    }));

    // Create edges: hub1 → leaf1, leaf2, leaf3; hub2 → leaf1, leaf4; leaf3 → leaf5
    const edge1 = edgeRepo.createEdge({
      sourceId: hub1.id, sourceType: 'memory_node',
      targetId: leaf1.id, targetType: 'memory_node',
      edgeType: 'co_activation', weight: 80,
    });
    const edge2 = edgeRepo.createEdge({
      sourceId: hub1.id, sourceType: 'memory_node',
      targetId: leaf2.id, targetType: 'memory_node',
      edgeType: 'co_activation', weight: 60,
    });
    const edge3 = edgeRepo.createEdge({
      sourceId: hub1.id, sourceType: 'memory_node',
      targetId: leaf3.id, targetType: 'memory_node',
      edgeType: 'co_activation', weight: 30,
    });
    const edge4 = edgeRepo.createEdge({
      sourceId: hub2.id, sourceType: 'memory_node',
      targetId: leaf1.id, targetType: 'memory_node',
      edgeType: 'co_activation', weight: 70,
    });
    const edge5 = edgeRepo.createEdge({
      sourceId: hub2.id, sourceType: 'memory_node',
      targetId: leaf4.id, targetType: 'memory_node',
      edgeType: 'co_activation', weight: 50,
    });
    const edge6 = edgeRepo.createEdge({
      sourceId: leaf3.id, sourceType: 'memory_node',
      targetId: leaf5.id, targetType: 'memory_node',
      edgeType: 'co_activation', weight: 40,
    });

    return { hub1, hub2, leaf1, leaf2, leaf3, leaf4, leaf5, edge1, edge2, edge3, edge4, edge5, edge6 };
  }

  // ─── Tests ──────────────────────────────────────────────

  describe('Global Map View (GET /graph)', () => {
    it('returns all nodes and edges for small graphs', async () => {
      const { hub1, hub2 } = createTestGraph();

      const res = await app.request('/graph');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.nodes).toHaveLength(7);
      expect(data.edges).toHaveLength(6);
      expect(data.totalNodes).toBeGreaterThanOrEqual(7);
      expect(data.totalEdges).toBeGreaterThanOrEqual(6);
    });

    it('returns L0-only fields (no embedding, no metadata)', async () => {
      createTestGraph();

      const res = await app.request('/graph');
      const data = await res.json();

      for (const node of data.nodes) {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('nodeType');
        expect(node).toHaveProperty('nodeRole');
        expect(node).toHaveProperty('label');
        expect(node).toHaveProperty('activationCount');
        expect(node).toHaveProperty('keywords');
        // Should NOT have full data fields
        expect(node).not.toHaveProperty('embedding');
        expect(node).not.toHaveProperty('metadata');
        expect(node).not.toHaveProperty('summary');
      }
    });

    it('edge fields are lightweight', async () => {
      createTestGraph();

      const res = await app.request('/graph');
      const data = await res.json();

      for (const edge of data.edges) {
        expect(edge).toHaveProperty('id');
        expect(edge).toHaveProperty('source');
        expect(edge).toHaveProperty('target');
        expect(edge).toHaveProperty('weight');
        expect(edge).toHaveProperty('shield');
        expect(edge).toHaveProperty('edgeType');
      }
    });

    it('respects maxNodes sampling cap', async () => {
      createTestGraph();

      const res = await app.request('/graph?maxNodes=3');
      const data = await res.json();

      // Should have at most 3 nodes (hubs prioritized)
      expect(data.nodes.length).toBeLessThanOrEqual(3);
      // At least one hub should be present
      const hubNodes = data.nodes.filter((n: { nodeRole: string }) => n.nodeRole === 'hub');
      expect(hubNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('hubsOnly returns only hub nodes', async () => {
      createTestGraph();

      const res = await app.request('/graph?hubsOnly=true');
      const data = await res.json();

      expect(data.nodes.length).toBe(2);
      for (const node of data.nodes) {
        expect(node.nodeRole).toBe('hub');
      }
    });

    it('minWeight filters edges', async () => {
      createTestGraph();

      const res = await app.request('/graph?minWeight=50');
      const data = await res.json();

      for (const edge of data.edges) {
        expect(edge.weight).toBeGreaterThanOrEqual(50);
      }
    });

    it('returns sampled flag when graph is capped', async () => {
      createTestGraph();

      // With maxNodes=3, should be sampled
      const res = await app.request('/graph?maxNodes=3');
      const data = await res.json();
      expect(data.sampled).toBe(true);
    });

    it('returns sampled=false when all nodes fit', async () => {
      createTestGraph();

      const res = await app.request('/graph?maxNodes=100');
      const data = await res.json();
      expect(data.sampled).toBe(false);
    });
  });

  describe('Local Explorer View (GET /graph?centerNodeId=X)', () => {
    it('returns ego-network centered on a node', async () => {
      const { hub1 } = createTestGraph();

      const res = await app.request(`/graph?centerNodeId=${hub1.id}&hops=1`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.centerNodeId).toBe(hub1.id);
      expect(data.hops).toBe(1);
      // hub1 has edges to leaf1, leaf2, leaf3 → 4 nodes at 1 hop
      expect(data.nodes.length).toBe(4);
      expect(data.sampled).toBe(false);
    });

    it('respects hops parameter for BFS depth', async () => {
      const { hub1 } = createTestGraph();

      // 1 hop: hub1 + leaf1,2,3
      const res1 = await app.request(`/graph?centerNodeId=${hub1.id}&hops=1`);
      const data1 = await res1.json();

      // 2 hops: should also include leaf5 (via leaf3), hub2 (via leaf1), leaf4 (via hub2)
      const res2 = await app.request(`/graph?centerNodeId=${hub1.id}&hops=2`);
      const data2 = await res2.json();

      expect(data2.nodes.length).toBeGreaterThan(data1.nodes.length);
    });

    it('minWeight filters during BFS', async () => {
      const { hub1, leaf1, leaf2 } = createTestGraph();

      // With minWeight=50, only edges with weight >= 50 should be traversed
      const res = await app.request(`/graph?centerNodeId=${hub1.id}&hops=1&minWeight=50`);
      const data = await res.json();

      // hub1→leaf1(80), hub1→leaf2(60) pass; hub1→leaf3(30) filtered
      const nodeIds = data.nodes.map((n: { id: string }) => n.id);
      expect(nodeIds).toContain(hub1.id);
      expect(nodeIds).toContain(leaf1.id);
      expect(nodeIds).toContain(leaf2.id);
      // leaf3 (weight=30) should be filtered
      expect(data.nodes.length).toBe(3);
    });

    it('maxNodes caps the ego-network size', async () => {
      const { hub1 } = createTestGraph();

      const res = await app.request(`/graph?centerNodeId=${hub1.id}&hops=3&maxNodes=3`);
      const data = await res.json();

      expect(data.nodes.length).toBeLessThanOrEqual(3);
      // Center node should always be present
      expect(data.nodes.some((n: { id: string }) => n.id === hub1.id)).toBe(true);
    });
  });

  describe('View Interconnection', () => {
    it('global map node IDs can be used as centerNodeId for local view', async () => {
      createTestGraph();

      // Step 1: Get global map
      const globalRes = await app.request('/graph');
      const globalData = await globalRes.json();
      expect(globalData.nodes.length).toBeGreaterThan(0);

      // Step 2: Pick first node and use as center for local view
      const pickedNodeId = globalData.nodes[0].id;
      const localRes = await app.request(`/graph?centerNodeId=${pickedNodeId}&hops=2`);
      expect(localRes.status).toBe(200);

      const localData = await localRes.json();
      expect(localData.centerNodeId).toBe(pickedNodeId);
      expect(localData.nodes.length).toBeGreaterThanOrEqual(1);

      // Center node should be in the local view
      expect(localData.nodes.some((n: { id: string }) => n.id === pickedNodeId)).toBe(true);
    });

    it('local view neighbor node can be used to re-center local view', async () => {
      const { hub1 } = createTestGraph();

      // Step 1: Get local view centered on hub1
      const res1 = await app.request(`/graph?centerNodeId=${hub1.id}&hops=1`);
      const data1 = await res1.json();

      // Step 2: Pick a neighbor and re-center
      const neighborId = data1.nodes.find((n: { id: string }) => n.id !== hub1.id)?.id;
      expect(neighborId).toBeTruthy();

      const res2 = await app.request(`/graph?centerNodeId=${neighborId}&hops=1`);
      expect(res2.status).toBe(200);

      const data2 = await res2.json();
      expect(data2.centerNodeId).toBe(neighborId);
    });

    it('handles non-existent center node gracefully', async () => {
      createTestGraph();

      const res = await app.request('/graph?centerNodeId=non-existent-id&hops=1');
      // Should return empty or minimal response (center node alone with no edges)
      expect(res.status).toBe(200);
      const data = await res.json();
      // No nodes found via BFS since center doesn't exist in graph
      expect(data.nodes.length).toBe(0);
    });
  });

  describe('Performance / LOD', () => {
    it('labels are truncated to 60 chars', async () => {
      const longLabel = 'A'.repeat(100);
      nodeRepo.create(makeInput({
        frontmatter: longLabel,
        nodeRole: 'hub',
      }));

      const res = await app.request('/graph');
      const data = await res.json();

      for (const node of data.nodes) {
        expect(node.label.length).toBeLessThanOrEqual(60);
      }
    });

    it('handles empty graph gracefully', async () => {
      const res = await app.request('/graph');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.nodes).toHaveLength(0);
      expect(data.edges).toHaveLength(0);
    });
  });
});
