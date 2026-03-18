/**
 * Tests for GraphAdapter — graphology graph data model construction
 * from MemoryNode + WeightedEdge API data.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// We test the adapter logic directly by importing from web/src
// Since vitest can handle TS imports, we resolve the path relative to project root
import { GraphAdapter, createGraphAdapter } from '../web/src/graph/graph-adapter';
import type { MemoryNodeData, WeightedEdgeData } from '../web/src/types/memory-node';

// ─── Test Fixtures ───────────────────────────────────────

function makeNode(overrides: Partial<MemoryNodeData> = {}): MemoryNodeData {
  return {
    id: 'node-1',
    nodeType: 'semantic',
    nodeRole: 'leaf',
    frontmatter: 'Test node',
    keywords: 'test keyword',
    hasEmbedding: true,
    embeddingDim: 384,
    metadata: {},
    summary: 'A test memory node',
    sourceMessageIds: [],
    createdAtEvent: 1,
    lastActivatedAtEvent: 5,
    activationCount: 3,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function makeEdge(overrides: Partial<WeightedEdgeData> = {}): WeightedEdgeData {
  return {
    id: 'edge-1',
    sourceId: 'node-1',
    targetId: 'node-2',
    edgeType: 'related',
    weight: 50,
    initialWeight: 10,
    shield: 5,
    learningRate: 0.1,
    decayRate: 0.01,
    activationCount: 2,
    lastActivatedAtEvent: 4,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────

describe('GraphAdapter', () => {
  let adapter: GraphAdapter;

  beforeEach(() => {
    adapter = createGraphAdapter();
  });

  describe('construction', () => {
    it('creates an empty directed graph', () => {
      expect(adapter.nodeCount).toBe(0);
      expect(adapter.edgeCount).toBe(0);
      expect(adapter.graph.type).toBe('directed');
    });
  });

  describe('addNode', () => {
    it('adds a leaf node with correct attributes', () => {
      const node = makeNode({ id: 'n1', nodeType: 'semantic', nodeRole: 'leaf', activationCount: 10 });
      adapter.addNode(node);

      expect(adapter.hasNode('n1')).toBe(true);
      expect(adapter.nodeCount).toBe(1);

      const attrs = adapter.graph.getNodeAttributes('n1');
      expect(attrs.label).toBe('Test node');
      expect(attrs.nodeType).toBe('semantic');
      expect(attrs.nodeRole).toBe('leaf');
      expect(attrs.color).toBe('#4a9eff'); // semantic color
      expect(attrs.activationCount).toBe(10);
      expect(attrs.loaded).toBe(true);
      expect(attrs.type).toBe('leaf');
      expect(typeof attrs.x).toBe('number');
      expect(typeof attrs.y).toBe('number');
      expect(typeof attrs.size).toBe('number');
      expect(attrs.size).toBeGreaterThan(0);
    });

    it('adds a hub node with correct attributes and size bonus', () => {
      const hubNode = makeNode({ id: 'h1', nodeRole: 'hub', nodeType: null, activationCount: 5 });
      const leafNode = makeNode({ id: 'l1', nodeRole: 'leaf', nodeType: null, activationCount: 5 });

      adapter.addNode(hubNode);
      adapter.addNode(leafNode);

      const hubSize = adapter.graph.getNodeAttribute('h1', 'size');
      const leafSize = adapter.graph.getNodeAttribute('l1', 'size');
      expect(hubSize).toBeGreaterThan(leafSize); // Hub gets size bonus
      expect(adapter.graph.getNodeAttribute('h1', 'type')).toBe('hub');
    });

    it('assigns correct colors for all node types', () => {
      const types: Array<{ type: MemoryNodeData['nodeType']; color: string }> = [
        { type: 'semantic', color: '#4a9eff' },
        { type: 'episodic', color: '#ff7675' },
        { type: 'procedural', color: '#00b894' },
        { type: 'prospective', color: '#fdcb6e' },
        { type: 'emotional', color: '#e84393' },
        { type: null, color: '#95a5a6' }, // null type
      ];

      for (const { type, color } of types) {
        const id = `t-${type ?? 'null'}`;
        adapter.addNode(makeNode({ id, nodeType: type }));
        expect(adapter.graph.getNodeAttribute(id, 'color')).toBe(color);
      }
    });

    it('updates existing node in-place (preserving position)', () => {
      adapter.addNode(makeNode({ id: 'n1', frontmatter: 'Original' }));
      const origX = adapter.graph.getNodeAttribute('n1', 'x');
      const origY = adapter.graph.getNodeAttribute('n1', 'y');

      // Update with new data
      adapter.addNode(makeNode({ id: 'n1', frontmatter: 'Updated', activationCount: 99 }));

      expect(adapter.nodeCount).toBe(1); // Still one node
      expect(adapter.graph.getNodeAttribute('n1', 'label')).toBe('Updated');
      expect(adapter.graph.getNodeAttribute('n1', 'activationCount')).toBe(99);
      // Position should be preserved
      expect(adapter.graph.getNodeAttribute('n1', 'x')).toBe(origX);
      expect(adapter.graph.getNodeAttribute('n1', 'y')).toBe(origY);
    });
  });

  describe('addPlaceholderNode', () => {
    it('adds a placeholder with loaded=false', () => {
      adapter.addPlaceholderNode('p1', 'Placeholder', 'episodic', 'leaf');

      expect(adapter.hasNode('p1')).toBe(true);
      const attrs = adapter.graph.getNodeAttributes('p1');
      expect(attrs.label).toBe('Placeholder');
      expect(attrs.loaded).toBe(false);
      expect(attrs.nodeType).toBe('episodic');
      expect(attrs.activationCount).toBe(0);
    });

    it('does not overwrite existing node', () => {
      adapter.addNode(makeNode({ id: 'n1', frontmatter: 'Real node' }));
      adapter.addPlaceholderNode('n1', 'Placeholder', 'semantic', 'leaf');

      expect(adapter.graph.getNodeAttribute('n1', 'label')).toBe('Real node');
      expect(adapter.graph.getNodeAttribute('n1', 'loaded')).toBe(true);
    });
  });

  describe('addEdge', () => {
    it('adds an edge between existing nodes with correct attributes', () => {
      adapter.addNode(makeNode({ id: 'n1' }));
      adapter.addNode(makeNode({ id: 'n2' }));

      const edge = makeEdge({ id: 'e1', sourceId: 'n1', targetId: 'n2', weight: 75, edgeType: 'about' });
      adapter.addEdge(edge);

      expect(adapter.hasEdge('e1')).toBe(true);
      expect(adapter.edgeCount).toBe(1);

      const attrs = adapter.graph.getEdgeAttributes('e1');
      expect(attrs.edgeType).toBe('about');
      expect(attrs.weight).toBe(75);
      expect(attrs.shield).toBe(5);
      expect(attrs.activationCount).toBe(2);
      expect(attrs.type).toBe('arrow');
      expect(attrs.size).toBeGreaterThan(0);
    });

    it('skips edges when endpoints are missing', () => {
      adapter.addNode(makeNode({ id: 'n1' }));
      // n2 does not exist
      adapter.addEdge(makeEdge({ sourceId: 'n1', targetId: 'n2' }));

      expect(adapter.edgeCount).toBe(0);
    });

    it('uses effectiveWeight for display when available', () => {
      adapter.addNode(makeNode({ id: 'n1' }));
      adapter.addNode(makeNode({ id: 'n2' }));

      const edge = makeEdge({
        id: 'e1', sourceId: 'n1', targetId: 'n2',
        weight: 80, effectiveWeight: 40,
      });
      adapter.addEdge(edge);

      const attrs = adapter.graph.getEdgeAttributes('e1');
      expect(attrs.weight).toBe(80);         // Raw weight preserved
      expect(attrs.effectiveWeight).toBe(40); // Effective weight stored
      // Color/size should be based on effectiveWeight (40), not raw weight (80)
    });

    it('updates existing edge in-place', () => {
      adapter.addNode(makeNode({ id: 'n1' }));
      adapter.addNode(makeNode({ id: 'n2' }));

      adapter.addEdge(makeEdge({ id: 'e1', sourceId: 'n1', targetId: 'n2', weight: 30 }));
      adapter.addEdge(makeEdge({ id: 'e1', sourceId: 'n1', targetId: 'n2', weight: 90 }));

      expect(adapter.edgeCount).toBe(1);
      expect(adapter.graph.getEdgeAttribute('e1', 'weight')).toBe(90);
    });
  });

  describe('addNodes / addEdges batch', () => {
    it('adds multiple nodes and edges in batch', () => {
      const nodes = Array.from({ length: 100 }, (_, i) =>
        makeNode({ id: `n${i}`, frontmatter: `Node ${i}` })
      );
      adapter.addNodes(nodes);
      expect(adapter.nodeCount).toBe(100);

      const edges = Array.from({ length: 50 }, (_, i) =>
        makeEdge({ id: `e${i}`, sourceId: `n${i * 2}`, targetId: `n${i * 2 + 1}` })
      );
      adapter.addEdges(edges);
      expect(adapter.edgeCount).toBe(50);
    });
  });

  describe('loadFullGraph', () => {
    it('clears existing data and rebuilds', () => {
      adapter.addNode(makeNode({ id: 'old' }));
      expect(adapter.nodeCount).toBe(1);

      const nodes = [makeNode({ id: 'a' }), makeNode({ id: 'b' })];
      const edges = [makeEdge({ id: 'e1', sourceId: 'a', targetId: 'b' })];

      adapter.loadFullGraph(nodes, edges);

      expect(adapter.nodeCount).toBe(2);
      expect(adapter.edgeCount).toBe(1);
      expect(adapter.hasNode('old')).toBe(false);
      expect(adapter.hasNode('a')).toBe(true);
    });
  });

  describe('loadNeighborhood', () => {
    it('merges neighborhood into existing graph', () => {
      // Pre-existing node
      adapter.addNode(makeNode({ id: 'existing' }));

      const center = makeNode({ id: 'center' });
      const neighbors = [
        {
          node: makeNode({ id: 'nb1' }),
          edge: makeEdge({ id: 'e1', sourceId: 'center', targetId: 'nb1' }),
        },
        {
          node: makeNode({ id: 'nb2' }),
          edge: makeEdge({ id: 'e2', sourceId: 'center', targetId: 'nb2' }),
        },
      ];

      adapter.loadNeighborhood(center, neighbors);

      expect(adapter.nodeCount).toBe(4); // existing + center + nb1 + nb2
      expect(adapter.edgeCount).toBe(2);
    });
  });

  describe('removeNode / removeEdge', () => {
    it('removes a node and its connected edges', () => {
      adapter.addNode(makeNode({ id: 'n1' }));
      adapter.addNode(makeNode({ id: 'n2' }));
      adapter.addEdge(makeEdge({ id: 'e1', sourceId: 'n1', targetId: 'n2' }));

      adapter.removeNode('n1');
      expect(adapter.hasNode('n1')).toBe(false);
      expect(adapter.edgeCount).toBe(0); // Edge removed with node
    });

    it('removes an edge without affecting nodes', () => {
      adapter.addNode(makeNode({ id: 'n1' }));
      adapter.addNode(makeNode({ id: 'n2' }));
      adapter.addEdge(makeEdge({ id: 'e1', sourceId: 'n1', targetId: 'n2' }));

      adapter.removeEdge('e1');
      expect(adapter.hasEdge('e1')).toBe(false);
      expect(adapter.nodeCount).toBe(2); // Nodes still there
    });

    it('silently handles removing non-existent node/edge', () => {
      adapter.removeNode('nonexistent');
      adapter.removeEdge('nonexistent');
      // No errors thrown
    });
  });

  describe('query operations', () => {
    beforeEach(() => {
      adapter.addNode(makeNode({ id: 'h1', nodeRole: 'hub', nodeType: 'semantic' }));
      adapter.addNode(makeNode({ id: 'h2', nodeRole: 'hub', nodeType: null }));
      adapter.addNode(makeNode({ id: 'l1', nodeRole: 'leaf', nodeType: 'episodic' }));
      adapter.addNode(makeNode({ id: 'l2', nodeRole: 'leaf', nodeType: 'semantic' }));
      adapter.addEdge(makeEdge({ id: 'e1', sourceId: 'h1', targetId: 'l1' }));
      adapter.addEdge(makeEdge({ id: 'e2', sourceId: 'h1', targetId: 'l2' }));
    });

    it('getNeighborIds returns connected nodes', () => {
      const neighbors = adapter.getNeighborIds('h1');
      expect(neighbors.sort()).toEqual(['l1', 'l2']);
    });

    it('getNodeIdsByRole filters correctly', () => {
      const hubs = adapter.getNodeIdsByRole('hub');
      expect(hubs.sort()).toEqual(['h1', 'h2']);

      const leaves = adapter.getNodeIdsByRole('leaf');
      expect(leaves.sort()).toEqual(['l1', 'l2']);
    });

    it('getNodeIdsByType filters correctly', () => {
      const semantic = adapter.getNodeIdsByType('semantic');
      expect(semantic.sort()).toEqual(['h1', 'l2']);

      const nullType = adapter.getNodeIdsByType(null);
      expect(nullType).toEqual(['h2']);
    });

    it('getFilteredNodeIds applies custom predicate', () => {
      const hubsOnly = adapter.getFilteredNodeIds(attrs => attrs.nodeRole === 'hub');
      expect(hubsOnly.sort()).toEqual(['h1', 'h2']);
    });

    it('getStats computes correct statistics', () => {
      const stats = adapter.getStats();
      expect(stats.nodeCount).toBe(4);
      expect(stats.edgeCount).toBe(2);
      expect(stats.byRole).toEqual({ hub: 2, leaf: 2 });
      expect(stats.byType.semantic).toBe(2);
      expect(stats.byType.episodic).toBe(1);
      expect(stats.byType.null).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all nodes and edges', () => {
      adapter.addNode(makeNode({ id: 'n1' }));
      adapter.addNode(makeNode({ id: 'n2' }));
      adapter.addEdge(makeEdge({ id: 'e1', sourceId: 'n1', targetId: 'n2' }));

      adapter.clear();
      expect(adapter.nodeCount).toBe(0);
      expect(adapter.edgeCount).toBe(0);
    });
  });

  describe('scalability', () => {
    it('handles 1000 nodes + 2000 edges without error', () => {
      const nodes = Array.from({ length: 1000 }, (_, i) =>
        makeNode({ id: `n${i}`, frontmatter: `Node ${i}` })
      );
      adapter.addNodes(nodes);
      expect(adapter.nodeCount).toBe(1000);

      const edges: WeightedEdgeData[] = [];
      for (let i = 0; i < 2000; i++) {
        const src = `n${i % 1000}`;
        const tgt = `n${(i + 1) % 1000}`;
        if (src !== tgt) {
          edges.push(makeEdge({ id: `e${i}`, sourceId: src, targetId: tgt }));
        }
      }
      adapter.addEdges(edges);
      // Some edges may be skipped (duplicate source→target in non-multi graph)
      expect(adapter.edgeCount).toBeGreaterThan(0);
      expect(adapter.edgeCount).toBeLessThanOrEqual(edges.length);
    });
  });
});
