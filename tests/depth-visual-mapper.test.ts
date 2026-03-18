/**
 * Tests for depth-visual-mapper.ts — deepK depth-based visualization utility.
 *
 * Covers:
 * - Depth profile constants and validation
 * - Color manipulation (saturation, opacity, hex→rgba)
 * - Node visual property computation per depth
 * - Edge visual property computation per depth
 * - Batch conversion (convertToDepthGraph)
 * - BFS depth assignment
 * - Legend generation
 * - Edge cases (out-of-range depths, missing endpoints, null types)
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_DEPTH,
  DEPTH_PROFILES,
  getDepthProfile,
  applyDepthColor,
  computeDepthNodeVisuals,
  computeDepthEdgeVisuals,
  convertToDepthGraph,
  assignBfsDepths,
  buildAdjacency,
  getDepthLegend,
  type DepthAnnotatedNode,
  type DepthAnnotatedEdge,
  type DepthLevel,
} from '../web/src/graph/depth-visual-mapper';

// ─── Depth Profile Constants ────────────────────────────────

describe('DEPTH_PROFILES', () => {
  it('has exactly 4 profiles (k=0..3)', () => {
    expect(DEPTH_PROFILES).toHaveLength(4);
  });

  it('profiles are ordered by depth 0→3', () => {
    for (let i = 0; i < DEPTH_PROFILES.length; i++) {
      expect(DEPTH_PROFILES[i].depth).toBe(i);
    }
  });

  it('sizeMultiplier decreases with depth', () => {
    for (let i = 1; i < DEPTH_PROFILES.length; i++) {
      expect(DEPTH_PROFILES[i].sizeMultiplier).toBeLessThan(DEPTH_PROFILES[i - 1].sizeMultiplier);
    }
  });

  it('opacity decreases with depth', () => {
    for (let i = 1; i < DEPTH_PROFILES.length; i++) {
      expect(DEPTH_PROFILES[i].opacity).toBeLessThan(DEPTH_PROFILES[i - 1].opacity);
    }
  });

  it('saturation decreases with depth', () => {
    for (let i = 1; i < DEPTH_PROFILES.length; i++) {
      expect(DEPTH_PROFILES[i].saturation).toBeLessThan(DEPTH_PROFILES[i - 1].saturation);
    }
  });

  it('k=0 has full opacity and saturation', () => {
    expect(DEPTH_PROFILES[0].opacity).toBe(1.0);
    expect(DEPTH_PROFILES[0].saturation).toBe(1.0);
    expect(DEPTH_PROFILES[0].sizeMultiplier).toBe(1.0);
    expect(DEPTH_PROFILES[0].showLabel).toBe(true);
  });

  it('k=3 has minimal visual prominence', () => {
    expect(DEPTH_PROFILES[3].opacity).toBeLessThanOrEqual(0.35);
    expect(DEPTH_PROFILES[3].sizeMultiplier).toBeLessThanOrEqual(0.35);
    expect(DEPTH_PROFILES[3].showLabel).toBe(false);
  });

  it('k=0,1 show labels; k=2,3 hide labels', () => {
    expect(DEPTH_PROFILES[0].showLabel).toBe(true);
    expect(DEPTH_PROFILES[1].showLabel).toBe(true);
    expect(DEPTH_PROFILES[2].showLabel).toBe(false);
    expect(DEPTH_PROFILES[3].showLabel).toBe(false);
  });

  it('edgeOpacity decreases with depth', () => {
    for (let i = 1; i < DEPTH_PROFILES.length; i++) {
      expect(DEPTH_PROFILES[i].edgeOpacity).toBeLessThan(DEPTH_PROFILES[i - 1].edgeOpacity);
    }
  });
});

describe('getDepthProfile', () => {
  it('returns correct profile for valid depths', () => {
    for (let d = 0; d <= MAX_DEPTH; d++) {
      expect(getDepthProfile(d).depth).toBe(d);
    }
  });

  it('clamps negative depths to 0', () => {
    expect(getDepthProfile(-1).depth).toBe(0);
    expect(getDepthProfile(-999).depth).toBe(0);
  });

  it('clamps depths beyond MAX_DEPTH to MAX_DEPTH', () => {
    expect(getDepthProfile(4).depth).toBe(MAX_DEPTH);
    expect(getDepthProfile(100).depth).toBe(MAX_DEPTH);
  });

  it('rounds fractional depths', () => {
    expect(getDepthProfile(0.4).depth).toBe(0);
    expect(getDepthProfile(0.6).depth).toBe(1);
    expect(getDepthProfile(1.5).depth).toBe(2);
  });
});

// ─── Color Manipulation ────────────────────────────────────

describe('applyDepthColor', () => {
  it('returns rgba() string', () => {
    const result = applyDepthColor('#4a9eff', 1.0, 1.0);
    expect(result).toMatch(/^rgba\(\d+,\d+,\d+,\d+\.\d+\)$/);
  });

  it('full saturation+opacity preserves hue', () => {
    const result = applyDepthColor('#ff0000', 1.0, 1.0);
    // Should be close to rgba(255,0,0,1.00)
    expect(result).toContain('255');
    expect(result).toContain('1.00');
  });

  it('zero saturation produces grayscale', () => {
    const result = applyDepthColor('#4a9eff', 0.0, 1.0);
    // Grayscale: R≈G≈B
    const match = result.match(/rgba\((\d+),(\d+),(\d+)/);
    expect(match).not.toBeNull();
    const [, r, g, b] = match!;
    // In grayscale, all channels should be equal
    expect(Number(r)).toBe(Number(g));
    expect(Number(g)).toBe(Number(b));
  });

  it('reduced opacity appears in alpha channel', () => {
    const result = applyDepthColor('#4a9eff', 1.0, 0.5);
    expect(result).toContain('0.50');
  });

  it('clamps opacity to [0, 1]', () => {
    const overResult = applyDepthColor('#4a9eff', 1.0, 1.5);
    expect(overResult).toContain('1.00');

    const underResult = applyDepthColor('#4a9eff', 1.0, -0.5);
    expect(underResult).toContain('0.00');
  });

  it('clamps saturation to [0, 1]', () => {
    // Should not throw and should produce valid rgba
    const result = applyDepthColor('#4a9eff', 2.0, 1.0);
    expect(result).toMatch(/^rgba\(\d+,\d+,\d+,\d+\.\d+\)$/);
  });
});

// ─── Node Visual Properties ────────────────────────────────

describe('computeDepthNodeVisuals', () => {
  it('returns valid visuals for k=0 semantic leaf', () => {
    const v = computeDepthNodeVisuals('semantic', 'leaf', 0, 10);
    expect(v.depth).toBe(0);
    expect(v.opacity).toBe(1.0);
    expect(v.size).toBe(10); // sizeMultiplier = 1.0
    expect(v.showLabel).toBe(true);
    expect(v.zIndex).toBe(MAX_DEPTH); // highest z for k=0
    expect(v.color).toMatch(/^rgba\(/);
    expect(v.borderColor).toMatch(/^rgba\(/);
  });

  it('k=3 nodes are smaller, more transparent, no label', () => {
    const v = computeDepthNodeVisuals('semantic', 'leaf', 3, 10);
    expect(v.depth).toBe(3);
    expect(v.opacity).toBeLessThan(0.4);
    expect(v.size).toBeLessThan(5); // 10 * 0.3
    expect(v.showLabel).toBe(false);
    expect(v.zIndex).toBe(0); // lowest z for k=3
  });

  it('hub nodes at k=0 get role-based border', () => {
    const v = computeDepthNodeVisuals('semantic', 'hub', 0, 12);
    expect(v.borderColor).toMatch(/^rgba\(/);
    expect(v.size).toBe(12);
  });

  it('null nodeType uses null palette', () => {
    const v = computeDepthNodeVisuals(null, 'leaf', 0, 8);
    expect(v.color).toMatch(/^rgba\(/);
    expect(v.depth).toBe(0);
  });

  it('null nodeType + hub role uses role base color', () => {
    const v = computeDepthNodeVisuals(null, 'hub', 0, 8);
    expect(v.color).toMatch(/^rgba\(/);
  });

  it('size scales correctly across depths for same base', () => {
    const baseSize = 12;
    const sizes = [0, 1, 2, 3].map(d => computeDepthNodeVisuals('episodic', 'leaf', d, baseSize).size);
    // Each depth should have smaller size than previous
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeLessThan(sizes[i - 1]);
    }
  });

  it('all five nodeTypes produce distinct k=0 colors', () => {
    const types = ['semantic', 'episodic', 'procedural', 'prospective', 'emotional'] as const;
    const colors = types.map(t => computeDepthNodeVisuals(t, 'leaf', 0, 8).color);
    const uniqueColors = new Set(colors);
    expect(uniqueColors.size).toBe(5);
  });

  it('uses default base size when none provided', () => {
    const v = computeDepthNodeVisuals('semantic', 'leaf', 0);
    expect(v.size).toBeGreaterThan(0);
  });

  it('minimum size is >= 1 even at k=3 with small base', () => {
    const v = computeDepthNodeVisuals('semantic', 'leaf', 3, 2);
    expect(v.size).toBeGreaterThanOrEqual(1);
  });
});

// ─── Edge Visual Properties ────────────────────────────────

describe('computeDepthEdgeVisuals', () => {
  it('returns valid visuals for k=0 edges', () => {
    const v = computeDepthEdgeVisuals(0, 0, 80);
    expect(v.maxDepth).toBe(0);
    expect(v.opacity).toBeGreaterThan(0.8);
    expect(v.size).toBeGreaterThan(0);
    expect(v.color).toMatch(/^rgba\(/);
  });

  it('uses max depth of endpoints', () => {
    const v = computeDepthEdgeVisuals(0, 2, 50);
    expect(v.maxDepth).toBe(2);

    const v2 = computeDepthEdgeVisuals(3, 1, 50);
    expect(v2.maxDepth).toBe(3);
  });

  it('higher weight produces thicker edges', () => {
    const thin = computeDepthEdgeVisuals(0, 0, 10);
    const thick = computeDepthEdgeVisuals(0, 0, 90);
    expect(thick.size).toBeGreaterThan(thin.size);
  });

  it('k=3 edges are more transparent than k=0', () => {
    const e0 = computeDepthEdgeVisuals(0, 0, 50);
    const e3 = computeDepthEdgeVisuals(3, 3, 50);
    expect(e3.opacity).toBeLessThan(e0.opacity);
  });

  it('edge opacity decreases with depth', () => {
    const opacities = [0, 1, 2, 3].map(d => computeDepthEdgeVisuals(d, d, 50).opacity);
    for (let i = 1; i < opacities.length; i++) {
      expect(opacities[i]).toBeLessThan(opacities[i - 1]);
    }
  });

  it('default weight (50) produces reasonable edge', () => {
    const v = computeDepthEdgeVisuals(1, 1);
    expect(v.size).toBeGreaterThan(0);
  });
});

// ─── Batch Conversion ──────────────────────────────────────

describe('convertToDepthGraph', () => {
  const makeNode = (id: string, depth: number, overrides?: Partial<DepthAnnotatedNode>): DepthAnnotatedNode => ({
    id,
    nodeType: 'semantic',
    nodeRole: 'leaf',
    frontmatter: `Node ${id}`,
    keywords: `keyword_${id}`,
    activationCount: 5,
    lastActivatedAtEvent: 100,
    depth,
    ...overrides,
  });

  const makeEdge = (id: string, src: string, tgt: string, srcD: number, tgtD: number): DepthAnnotatedEdge => ({
    id,
    sourceId: src,
    targetId: tgt,
    edgeType: 'related',
    weight: 50,
    shield: 10,
    activationCount: 3,
    lastActivatedAtEvent: 100,
    sourceDepth: srcD,
    targetDepth: tgtD,
  });

  it('converts nodes and edges into graph data', () => {
    const nodes = [makeNode('a', 0), makeNode('b', 1), makeNode('c', 2)];
    const edges = [makeEdge('e1', 'a', 'b', 0, 1), makeEdge('e2', 'b', 'c', 1, 2)];

    const result = convertToDepthGraph(nodes, edges);

    expect(result.nodes.size).toBe(3);
    expect(result.edges.size).toBe(2);
    expect(result.depthStats.totalNodes).toBe(3);
    expect(result.depthStats.totalEdges).toBe(2);
  });

  it('assigns correct depth stats', () => {
    const nodes = [
      makeNode('a', 0),
      makeNode('b', 1), makeNode('c', 1),
      makeNode('d', 2),
      makeNode('e', 3), makeNode('f', 3),
    ];
    const edges: DepthAnnotatedEdge[] = [];

    const result = convertToDepthGraph(nodes, edges);

    expect(result.depthStats.nodeCounts[0]).toBe(1);
    expect(result.depthStats.nodeCounts[1]).toBe(2);
    expect(result.depthStats.nodeCounts[2]).toBe(1);
    expect(result.depthStats.nodeCounts[3]).toBe(2);
  });

  it('centers k=0 node at origin', () => {
    const nodes = [makeNode('center', 0), makeNode('far', 2)];
    const result = convertToDepthGraph(nodes, []);

    const centerAttrs = result.nodes.get('center')!;
    expect(centerAttrs.x).toBe(0);
    expect(centerAttrs.y).toBe(0);
  });

  it('k=0 nodes are larger than k=2 nodes', () => {
    const baseSize = 10;
    const nodes = [
      makeNode('a', 0, { baseSize }),
      makeNode('b', 2, { baseSize }),
    ];
    const result = convertToDepthGraph(nodes, []);

    expect(result.nodes.get('a')!.size).toBeGreaterThan(result.nodes.get('b')!.size);
  });

  it('skips edges with missing endpoints', () => {
    const nodes = [makeNode('a', 0)];
    const edges = [makeEdge('e1', 'a', 'missing', 0, 1)];

    const result = convertToDepthGraph(nodes, edges);
    expect(result.edges.size).toBe(0);
    expect(result.depthStats.totalEdges).toBe(0);
  });

  it('handles empty input', () => {
    const result = convertToDepthGraph([], []);
    expect(result.nodes.size).toBe(0);
    expect(result.edges.size).toBe(0);
    expect(result.depthStats.totalNodes).toBe(0);
  });

  it('handles hub nodes with null type', () => {
    const nodes = [makeNode('hub', 0, { nodeType: null, nodeRole: 'hub' })];
    const result = convertToDepthGraph(nodes, []);

    const attrs = result.nodes.get('hub')!;
    expect(attrs.nodeType).toBeNull();
    expect(attrs.nodeRole).toBe('hub');
    expect(attrs.type).toBe('hub');
  });

  it('assigns correct sigma.js attributes', () => {
    const nodes = [makeNode('a', 1, { nodeType: 'episodic', nodeRole: 'hub' })];
    const result = convertToDepthGraph(nodes, []);
    const attrs = result.nodes.get('a')!;

    expect(attrs.label).toBe('Node a');
    expect(attrs.nodeType).toBe('episodic');
    expect(attrs.nodeRole).toBe('hub');
    expect(attrs.keywords).toBe('keyword_a');
    expect(attrs.activationCount).toBe(5);
    expect(attrs.depth).toBe(1);
    expect(attrs.type).toBe('hub');
    expect(attrs.showLabel).toBe(true); // k=1 shows labels
  });

  it('preserves edge attributes correctly', () => {
    const nodes = [makeNode('a', 0), makeNode('b', 1)];
    const edges = [makeEdge('e1', 'a', 'b', 0, 1)];

    const result = convertToDepthGraph(nodes, edges);
    const edgeEntry = result.edges.get('e1')!;

    expect(edgeEntry.source).toBe('a');
    expect(edgeEntry.target).toBe('b');
    expect(edgeEntry.attributes.edgeType).toBe('related');
    expect(edgeEntry.attributes.weight).toBe(50);
    expect(edgeEntry.attributes.shield).toBe(10);
    expect(edgeEntry.attributes.maxDepth).toBe(1);
    expect(edgeEntry.attributes.type).toBe('arrow');
  });
});

// ─── BFS Depth Assignment ──────────────────────────────────

describe('buildAdjacency', () => {
  it('builds undirected adjacency from directed edges', () => {
    const edges = [
      { sourceId: 'a', targetId: 'b' },
      { sourceId: 'b', targetId: 'c' },
    ];

    const adj = buildAdjacency(edges);

    expect(adj.get('a')!.has('b')).toBe(true);
    expect(adj.get('b')!.has('a')).toBe(true); // reverse direction
    expect(adj.get('b')!.has('c')).toBe(true);
    expect(adj.get('c')!.has('b')).toBe(true);
  });

  it('handles empty edges', () => {
    const adj = buildAdjacency([]);
    expect(adj.size).toBe(0);
  });
});

describe('assignBfsDepths', () => {
  it('assigns depth 0 to center nodes', () => {
    const adj = buildAdjacency([{ sourceId: 'a', targetId: 'b' }]);
    const depths = assignBfsDepths(['a'], adj);

    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(1);
  });

  it('correctly assigns multi-hop depths', () => {
    const edges = [
      { sourceId: 'a', targetId: 'b' },
      { sourceId: 'b', targetId: 'c' },
      { sourceId: 'c', targetId: 'd' },
    ];
    const adj = buildAdjacency(edges);
    const depths = assignBfsDepths(['a'], adj);

    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(1);
    expect(depths.get('c')).toBe(2);
    expect(depths.get('d')).toBe(3);
  });

  it('respects maxDepth — excludes nodes beyond limit', () => {
    const edges = [
      { sourceId: 'a', targetId: 'b' },
      { sourceId: 'b', targetId: 'c' },
      { sourceId: 'c', targetId: 'd' },
      { sourceId: 'd', targetId: 'e' },
    ];
    const adj = buildAdjacency(edges);
    const depths = assignBfsDepths(['a'], adj, 2);

    expect(depths.has('a')).toBe(true);
    expect(depths.has('b')).toBe(true);
    expect(depths.has('c')).toBe(true);
    expect(depths.has('d')).toBe(false); // beyond maxDepth=2
    expect(depths.has('e')).toBe(false);
  });

  it('handles multiple center nodes', () => {
    const edges = [
      { sourceId: 'a', targetId: 'c' },
      { sourceId: 'b', targetId: 'c' },
      { sourceId: 'c', targetId: 'd' },
    ];
    const adj = buildAdjacency(edges);
    const depths = assignBfsDepths(['a', 'b'], adj);

    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(0);
    expect(depths.get('c')).toBe(1); // 1 hop from either center
    expect(depths.get('d')).toBe(2);
  });

  it('handles disconnected center node', () => {
    const adj = buildAdjacency([]);
    const depths = assignBfsDepths(['isolated'], adj);

    expect(depths.get('isolated')).toBe(0);
    expect(depths.size).toBe(1);
  });

  it('BFS finds shortest path in graph with cycles', () => {
    // a-b-c-d forms a cycle plus a-d shortcut
    const edges = [
      { sourceId: 'a', targetId: 'b' },
      { sourceId: 'b', targetId: 'c' },
      { sourceId: 'c', targetId: 'd' },
      { sourceId: 'a', targetId: 'd' }, // shortcut
    ];
    const adj = buildAdjacency(edges);
    const depths = assignBfsDepths(['a'], adj);

    expect(depths.get('d')).toBe(1); // via shortcut, not 3 via b→c→d
  });
});

// ─── Legend ────────────────────────────────────────────────

describe('getDepthLegend', () => {
  it('returns 4 entries (k=0..3)', () => {
    const legend = getDepthLegend();
    expect(legend).toHaveLength(4);
  });

  it('entries have correct depth values', () => {
    const legend = getDepthLegend();
    for (let i = 0; i < 4; i++) {
      expect(legend[i].depth).toBe(i);
    }
  });

  it('example sizes decrease with depth', () => {
    const legend = getDepthLegend();
    for (let i = 1; i < legend.length; i++) {
      expect(legend[i].exampleSize).toBeLessThan(legend[i - 1].exampleSize);
    }
  });

  it('opacities decrease with depth', () => {
    const legend = getDepthLegend();
    for (let i = 1; i < legend.length; i++) {
      expect(legend[i].opacity).toBeLessThan(legend[i - 1].opacity);
    }
  });

  it('example colors are rgba strings', () => {
    const legend = getDepthLegend();
    for (const entry of legend) {
      expect(entry.exampleColor).toMatch(/^rgba\(/);
    }
  });

  it('each entry has a label', () => {
    const legend = getDepthLegend();
    for (const entry of legend) {
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });
});

// ─── Edge Cases ─────────────────────────────────────────────

describe('edge cases', () => {
  it('MAX_DEPTH is 3', () => {
    expect(MAX_DEPTH).toBe(3);
  });

  it('computeDepthNodeVisuals handles all nodeTypes', () => {
    const types = ['semantic', 'episodic', 'procedural', 'prospective', 'emotional', null] as const;
    for (const t of types) {
      const v = computeDepthNodeVisuals(t, 'leaf', 0, 8);
      expect(v.color).toMatch(/^rgba\(/);
      expect(v.size).toBeGreaterThan(0);
    }
  });

  it('computeDepthNodeVisuals handles both roles at all depths', () => {
    const roles: Array<'hub' | 'leaf'> = ['hub', 'leaf'];
    for (const role of roles) {
      for (let d = 0; d <= MAX_DEPTH; d++) {
        const v = computeDepthNodeVisuals('semantic', role, d, 10);
        expect(v.depth).toBe(d);
        expect(v.size).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('computeDepthEdgeVisuals handles zero weight', () => {
    const v = computeDepthEdgeVisuals(0, 0, 0);
    expect(v.size).toBeGreaterThan(0);
  });

  it('computeDepthEdgeVisuals handles WEIGHT_CAP (100)', () => {
    const v = computeDepthEdgeVisuals(0, 0, 100);
    expect(v.size).toBeGreaterThan(0);
  });

  it('convertToDepthGraph handles large number of nodes efficiently', () => {
    const count = 10000;
    const nodes: DepthAnnotatedNode[] = [];
    for (let i = 0; i < count; i++) {
      nodes.push({
        id: `node_${i}`,
        nodeType: 'semantic',
        nodeRole: i < 100 ? 'hub' : 'leaf',
        frontmatter: `Node ${i}`,
        keywords: `kw${i}`,
        activationCount: Math.floor(Math.random() * 100),
        lastActivatedAtEvent: 100,
        depth: Math.min(3, Math.floor(i / (count / 4))),
      });
    }

    const start = performance.now();
    const result = convertToDepthGraph(nodes, []);
    const elapsed = performance.now() - start;

    expect(result.nodes.size).toBe(count);
    expect(elapsed).toBeLessThan(2000); // Should complete well under 2 seconds
  });
});
