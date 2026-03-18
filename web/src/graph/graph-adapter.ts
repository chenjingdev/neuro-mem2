/**
 * GraphAdapter — converts MemoryNode + WeightedEdge API data into a
 * graphology Graph instance for sigma.js visualization.
 *
 * Design goals:
 * - Efficient incremental updates (add/remove/update nodes & edges)
 * - Scalable to 수십만 nodes via batch operations
 * - Attribute mapping optimized for sigma.js rendering (color, size, label)
 * - Supports both full graph and local neighborhood views
 */

import Graph from 'graphology';
import type { MemoryNodeData, MemoryNodeRole, MemoryNodeTypeNullable, WeightedEdgeData } from '../types/memory-node';
import {
  resolveNodeColor,
  resolveHubBorderColor,
  NODE_ROLE_PALETTES,
  computeEdgeColor as computeEdgeColorFromConfig,
} from '../config/node-colors';
import {
  MAX_DEPTH,
  computeDepthNodeVisuals,
  computeDepthEdgeVisuals,
  assignBfsDepths,
  buildAdjacency,
} from './depth-visual-mapper';

// ─── Graph Node/Edge Attribute Types ─────────────────────

/** Attributes stored on each graph node (for sigma.js rendering) */
export interface GraphNodeAttributes {
  /** Display label (frontmatter text) */
  label: string;
  /** X position (set by layout algorithm) */
  x: number;
  /** Y position (set by layout algorithm) */
  y: number;
  /** Node size (derived from activationCount) */
  size: number;
  /** Node fill color (derived from nodeType + nodeRole) */
  color: string;
  /** Node border color (derived from nodeRole) */
  borderColor: string;
  /** Node type classification */
  nodeType: MemoryNodeTypeNullable;
  /** Node role (hub/leaf) */
  nodeRole: MemoryNodeRole;
  /** Keywords for search matching */
  keywords: string;
  /** Activation count for decay/importance display */
  activationCount: number;
  /** Last activated event counter */
  lastActivatedAtEvent: number;
  /** Whether this node has been fully loaded (L1+) */
  loaded: boolean;
  /** Node type indicator (for rendering shape differentiation) */
  type: string;
  /** DeepK depth level (0 = center, 1..3 = hops away). -1 or undefined = unassigned. */
  depth: number;
  /** Opacity [0, 1] — depth-based transparency (1.0 for center, fading for periphery) */
  opacity: number;
  /** Whether label should be shown based on depth (k=0,1 show labels) */
  showLabel: boolean;
  /** Z-index hint for rendering order (deeper = lower z) */
  zIndex: number;
}

/** Attributes stored on each graph edge (for sigma.js rendering) */
export interface GraphEdgeAttributes {
  /** Edge label (edgeType) */
  label: string;
  /** Edge color (derived from weight) */
  color: string;
  /** Edge thickness (derived from weight) */
  size: number;
  /** Relationship type */
  edgeType: string;
  /** Hebbian weight [0-100] */
  weight: number;
  /** Shield value */
  shield: number;
  /** Activation count */
  activationCount: number;
  /** Last activated event counter */
  lastActivatedAtEvent: number;
  /** Effective weight after decay (if computed) */
  effectiveWeight?: number;
  /** Edge rendering type */
  type: string;
  /** Source node depth (for depth-based edge styling) */
  sourceDepth: number;
  /** Target node depth (for depth-based edge styling) */
  targetDepth: number;
  /** Max depth of the two endpoints (determines edge visual fading) */
  maxDepth: number;
  /** Edge opacity [0, 1] — depth-based transparency */
  opacity: number;
}

// ─── Color Constants ─────────────────────────────────────
// All node type/role colors are resolved from the centralized palette
// in config/node-colors.ts via resolveNodeColor() and resolveHubBorderColor().

// ─── Sizing Constants ────────────────────────────────────

/** Min/max node sizes for sigma.js (initial/fallback) */
const NODE_SIZE_MIN = 3;
const NODE_SIZE_MAX = 20;
const NODE_SIZE_HUB_BONUS = 4;

/** Degree-based sizing ranges */
const HUB_SIZE_MIN = 7;
const HUB_SIZE_MAX = 30;
const LEAF_SIZE_MIN = 3;
const LEAF_SIZE_MAX = 12;

/** Min/max edge sizes */
const EDGE_SIZE_MIN = 0.5;
const EDGE_SIZE_MAX = 5;

/** Weight cap for normalization (matches WeightedEdge WEIGHT_CAP) */
const WEIGHT_CAP = 100;

// ─── Helper Functions ────────────────────────────────────

/**
 * Compute node color from nodeType and nodeRole.
 * Delegates to centralized resolveNodeColor from config/node-colors.ts.
 */
function getNodeColor(nodeType: MemoryNodeTypeNullable, nodeRole?: MemoryNodeRole): string {
  return resolveNodeColor(nodeType, nodeRole);
}

/**
 * Compute node border color from nodeRole.
 * Delegates to centralized palette from config/node-colors.ts.
 */
function getBorderColor(nodeRole: MemoryNodeRole): string {
  return resolveHubBorderColor(nodeRole) ?? NODE_ROLE_PALETTES.leaf.border;
}

/**
 * Compute node size from activation count and role.
 * Hub nodes get a size bonus for visual prominence.
 */
function computeNodeSize(activationCount: number, nodeRole: MemoryNodeRole): number {
  // Log scale for activation count (handles wide range gracefully)
  const logScale = Math.log2(Math.max(1, activationCount) + 1);
  // Normalize: assume activationCount rarely exceeds ~1000
  const normalized = Math.min(1, logScale / 10);
  const base = NODE_SIZE_MIN + normalized * (NODE_SIZE_MAX - NODE_SIZE_MIN);
  return nodeRole === 'hub' ? base + NODE_SIZE_HUB_BONUS : base;
}

/**
 * Compute edge color based on weight.
 * Delegates to centralized computeEdgeColor from config/node-colors.ts.
 */
function computeEdgeColor(weight: number): string {
  return computeEdgeColorFromConfig(weight);
}

/**
 * Compute edge thickness from weight.
 */
function computeEdgeSize(weight: number): number {
  const t = Math.max(0, Math.min(1, weight / WEIGHT_CAP));
  return EDGE_SIZE_MIN + t * (EDGE_SIZE_MAX - EDGE_SIZE_MIN);
}

/**
 * Generate a random position for initial placement before layout runs.
 * Spread within [-100, 100] range.
 */
function randomPosition(): { x: number; y: number } {
  return {
    x: (Math.random() - 0.5) * 200,
    y: (Math.random() - 0.5) * 200,
  };
}

// ─── GraphAdapter Class ──────────────────────────────────

export class GraphAdapter {
  /** The underlying graphology Graph instance */
  readonly graph: Graph<GraphNodeAttributes, GraphEdgeAttributes>;

  constructor() {
    this.graph = new Graph<GraphNodeAttributes, GraphEdgeAttributes>({
      multi: false,       // Single edge between any node pair per direction
      allowSelfLoops: false,
      type: 'directed',
    });
  }

  // ═══════════════════════════════════════════════════════
  // NODE OPERATIONS
  // ═══════════════════════════════════════════════════════

  /**
   * Add a single MemoryNode to the graph.
   * If the node already exists, updates its attributes instead.
   */
  addNode(node: MemoryNodeData): void {
    const pos = this.graph.hasNode(node.id)
      ? { x: this.graph.getNodeAttribute(node.id, 'x'), y: this.graph.getNodeAttribute(node.id, 'y') }
      : randomPosition();

    const attrs: GraphNodeAttributes = {
      label: node.frontmatter,
      x: pos.x,
      y: pos.y,
      size: computeNodeSize(node.activationCount, node.nodeRole),
      color: getNodeColor(node.nodeType, node.nodeRole),
      borderColor: getBorderColor(node.nodeRole),
      nodeType: node.nodeType,
      nodeRole: node.nodeRole,
      keywords: node.keywords,
      activationCount: node.activationCount,
      lastActivatedAtEvent: node.lastActivatedAtEvent,
      loaded: true,
      type: node.nodeRole === 'hub' ? 'hub' : 'leaf',
      depth: -1,         // Unassigned — will be set by applyDepthVisuals()
      opacity: 1.0,
      showLabel: true,
      zIndex: 0,
    };

    if (this.graph.hasNode(node.id)) {
      this.graph.replaceNodeAttributes(node.id, attrs);
    } else {
      this.graph.addNode(node.id, attrs);
    }
  }

  /**
   * Add multiple MemoryNodes in batch (optimized for large datasets).
   */
  addNodes(nodes: MemoryNodeData[]): void {
    for (const node of nodes) {
      this.addNode(node);
    }
  }

  /**
   * Add a placeholder node (L0 ref only — minimal data).
   * Used for lazy loading: shows the node exists before full data is fetched.
   */
  addPlaceholderNode(id: string, frontmatter: string, nodeType: MemoryNodeTypeNullable, nodeRole: MemoryNodeRole): void {
    if (this.graph.hasNode(id)) return;

    const pos = randomPosition();
    this.graph.addNode(id, {
      label: frontmatter,
      x: pos.x,
      y: pos.y,
      size: computeNodeSize(0, nodeRole),
      color: getNodeColor(nodeType, nodeRole),
      borderColor: getBorderColor(nodeRole),
      nodeType: nodeType,
      nodeRole: nodeRole,
      keywords: '',
      activationCount: 0,
      lastActivatedAtEvent: 0,
      loaded: false,
      type: nodeRole === 'hub' ? 'hub' : 'leaf',
      depth: -1,
      opacity: 1.0,
      showLabel: true,
      zIndex: 0,
    });
  }

  /**
   * Remove a node (and all its connected edges) from the graph.
   */
  removeNode(nodeId: string): void {
    if (this.graph.hasNode(nodeId)) {
      this.graph.dropNode(nodeId);
    }
  }

  /**
   * Check if a node exists in the graph.
   */
  hasNode(nodeId: string): boolean {
    return this.graph.hasNode(nodeId);
  }

  // ═══════════════════════════════════════════════════════
  // EDGE OPERATIONS
  // ═══════════════════════════════════════════════════════

  /**
   * Add a single WeightedEdge to the graph.
   * Both source and target nodes must already exist in the graph.
   * If the edge already exists, updates its attributes.
   */
  addEdge(edge: WeightedEdgeData): void {
    // Skip edges whose endpoints are not in the graph
    if (!this.graph.hasNode(edge.sourceId) || !this.graph.hasNode(edge.targetId)) {
      return;
    }

    const displayWeight = edge.effectiveWeight ?? edge.weight;

    const attrs: GraphEdgeAttributes = {
      label: edge.edgeType,
      color: computeEdgeColor(displayWeight),
      size: computeEdgeSize(displayWeight),
      edgeType: edge.edgeType,
      weight: edge.weight,
      shield: edge.shield,
      activationCount: edge.activationCount,
      lastActivatedAtEvent: edge.lastActivatedAtEvent,
      effectiveWeight: edge.effectiveWeight,
      type: 'arrow',
      sourceDepth: -1,   // Unassigned — will be set by applyDepthVisuals()
      targetDepth: -1,
      maxDepth: -1,
      opacity: 1.0,
    };

    // Use edge.id as key for deduplication
    if (this.graph.hasEdge(edge.id)) {
      this.graph.replaceEdgeAttributes(edge.id, attrs);
    } else {
      try {
        this.graph.addEdgeWithKey(edge.id, edge.sourceId, edge.targetId, attrs);
      } catch {
        // Edge might already exist between these nodes (parallel edge in non-multi graph)
        // Silently skip — first edge wins
      }
    }
  }

  /**
   * Add multiple WeightedEdges in batch.
   */
  addEdges(edges: WeightedEdgeData[]): void {
    for (const edge of edges) {
      this.addEdge(edge);
    }
  }

  /**
   * Remove an edge from the graph.
   */
  removeEdge(edgeId: string): void {
    if (this.graph.hasEdge(edgeId)) {
      this.graph.dropEdge(edgeId);
    }
  }

  /**
   * Check if an edge exists in the graph.
   */
  hasEdge(edgeId: string): boolean {
    return this.graph.hasEdge(edgeId);
  }

  // ═══════════════════════════════════════════════════════
  // BULK OPERATIONS
  // ═══════════════════════════════════════════════════════

  /**
   * Load a complete graph from API data (nodes + edges).
   * Clears existing data and rebuilds from scratch.
   * Applies degree-based sizing after loading.
   */
  loadFullGraph(nodes: MemoryNodeData[], edges: WeightedEdgeData[]): void {
    this.graph.clear();
    this.addNodes(nodes);
    this.addEdges(edges);
    this.applyDegreeSizing();
  }

  /**
   * Load a local neighborhood: a center node + its connected nodes and edges.
   * Merges into existing graph (does not clear).
   * Applies degree-based sizing after loading.
   */
  loadNeighborhood(
    centerNode: MemoryNodeData,
    neighbors: Array<{ node: MemoryNodeData; edge: WeightedEdgeData }>,
  ): void {
    this.addNode(centerNode);
    for (const { node, edge } of neighbors) {
      this.addNode(node);
      this.addEdge(edge);
    }
    this.applyDegreeSizing();
  }

  /**
   * Clear the entire graph.
   */
  clear(): void {
    this.graph.clear();
  }

  // ═══════════════════════════════════════════════════════
  // DEGREE-BASED SIZING
  // ═══════════════════════════════════════════════════════

  /**
   * Recalculate node sizes based on their degree (number of connections).
   * Hub nodes with many connections appear significantly larger than leaf nodes.
   * Uses log scale to prevent extreme outliers from dominating.
   *
   * Must be called AFTER all nodes and edges are loaded.
   */
  applyDegreeSizing(): void {
    if (this.graph.order === 0) return;

    // Step 1: compute degree for every node + find max
    let maxDegree = 0;
    const degrees = new Map<string, number>();

    this.graph.forEachNode((nodeId) => {
      const deg = this.graph.degree(nodeId);
      degrees.set(nodeId, deg);
      if (deg > maxDegree) maxDegree = deg;
    });

    // Step 2: assign size based on degree, role, and activation
    this.graph.forEachNode((nodeId, attrs) => {
      const degree = degrees.get(nodeId) ?? 0;
      const isHub = attrs.nodeRole === 'hub';
      const sizeMin = isHub ? HUB_SIZE_MIN : LEAF_SIZE_MIN;
      const sizeMax = isHub ? HUB_SIZE_MAX : LEAF_SIZE_MAX;

      // Log-scaled degree normalization
      const logDegree = Math.log2(Math.max(1, degree) + 1);
      const logMax = Math.log2(Math.max(1, maxDegree) + 1);
      const degreeNorm = logMax > 0 ? logDegree / logMax : 0;

      // Activation provides secondary boost (up to 15% of range)
      const activationBoost = Math.min(
        0.15,
        Math.log2(Math.max(1, attrs.activationCount) + 1) * 0.02,
      );

      const factor = Math.min(1, degreeNorm + activationBoost);
      const newSize = sizeMin + factor * (sizeMax - sizeMin);

      this.graph.setNodeAttribute(nodeId, 'size', newSize);
    });
  }

  // ═══════════════════════════════════════════════════════
  // DEEPK DEPTH OPERATIONS
  // ═══════════════════════════════════════════════════════

  /**
   * Load a local neighborhood graph with deepK depth-based visual mapping.
   *
   * This is the primary entry point for deepK visualization. It:
   * 1. Loads nodes and edges into the graph
   * 2. Computes BFS depths from the center node(s)
   * 3. Applies depth-based visual properties (color, size, opacity) from depth-visual-mapper
   * 4. Applies degree-based sizing as a secondary pass
   *
   * @param nodes - MemoryNode data from API
   * @param edges - WeightedEdge data from API
   * @param centerNodeIds - seed node IDs for BFS depth=0 (usually one center node)
   * @param maxDepth - maximum BFS depth to visualize (default: MAX_DEPTH = 3)
   */
  loadWithDepth(
    nodes: MemoryNodeData[],
    edges: WeightedEdgeData[],
    centerNodeIds: string[],
    maxDepth: number = MAX_DEPTH,
  ): void {
    this.graph.clear();
    this.addNodes(nodes);
    this.addEdges(edges);
    this.applyDepthVisuals(centerNodeIds, maxDepth);
    this.applyDegreeSizing();
  }

  /**
   * Compute BFS depths from center node(s) and apply depth-based visual properties
   * to all nodes and edges in the graph.
   *
   * Uses assignBfsDepths() + buildAdjacency() from depth-visual-mapper for BFS,
   * then applies computeDepthNodeVisuals() for each node and computeDepthEdgeVisuals()
   * for each edge.
   *
   * Must be called AFTER nodes and edges are loaded into the graph.
   *
   * @param centerNodeIds - seed node IDs (depth=0)
   * @param maxDepth - maximum BFS depth (default: MAX_DEPTH = 3)
   * @returns Map of nodeId → depth (for use in layout algorithms)
   */
  applyDepthVisuals(
    centerNodeIds: string[],
    maxDepth: number = MAX_DEPTH,
  ): Map<string, number> {
    if (this.graph.order === 0) return new Map();

    // Step 1: Build adjacency from current graph edges
    const edgeList: Array<{ sourceId: string; targetId: string }> = [];
    this.graph.forEachEdge((_edgeId, _attrs, source, target) => {
      edgeList.push({ sourceId: source, targetId: target });
    });
    const adjacency = buildAdjacency(edgeList);

    // Step 2: BFS depth assignment from center nodes
    const depthMap = assignBfsDepths(centerNodeIds, adjacency, maxDepth);

    // Step 3: Apply depth-based visual properties to nodes
    this.graph.forEachNode((nodeId, attrs) => {
      const depth = depthMap.get(nodeId) ?? maxDepth; // Unreachable nodes get max depth
      const visuals = computeDepthNodeVisuals(
        attrs.nodeType,
        attrs.nodeRole,
        depth,
        attrs.size, // Use current size as base size
      );

      this.graph.mergeNodeAttributes(nodeId, {
        depth: visuals.depth,
        color: visuals.color,
        borderColor: visuals.borderColor,
        size: visuals.size,
        opacity: visuals.opacity,
        showLabel: visuals.showLabel,
        zIndex: visuals.zIndex,
      });
    });

    // Step 4: Apply depth-based visual properties to edges
    this.graph.forEachEdge((edgeId, _attrs, source, target) => {
      const sourceDepth = depthMap.get(source) ?? maxDepth;
      const targetDepth = depthMap.get(target) ?? maxDepth;
      const edgeWeight = this.graph.getEdgeAttribute(edgeId, 'weight') as number;
      const edgeVisuals = computeDepthEdgeVisuals(sourceDepth, targetDepth, edgeWeight);

      this.graph.mergeEdgeAttributes(edgeId, {
        sourceDepth,
        targetDepth,
        maxDepth: edgeVisuals.maxDepth,
        color: edgeVisuals.color,
        size: edgeVisuals.size,
        opacity: edgeVisuals.opacity,
      });
    });

    return depthMap;
  }

  /**
   * Set the depth of a specific node and update its visual properties.
   * Useful for incremental depth updates when expanding the graph interactively.
   *
   * @param nodeId - target node ID
   * @param depth - depth level to assign
   */
  setNodeDepth(nodeId: string, depth: number): void {
    if (!this.graph.hasNode(nodeId)) return;

    const attrs = this.graph.getNodeAttributes(nodeId);
    const visuals = computeDepthNodeVisuals(
      attrs.nodeType,
      attrs.nodeRole,
      depth,
      attrs.size,
    );

    this.graph.mergeNodeAttributes(nodeId, {
      depth: visuals.depth,
      color: visuals.color,
      borderColor: visuals.borderColor,
      size: visuals.size,
      opacity: visuals.opacity,
      showLabel: visuals.showLabel,
      zIndex: visuals.zIndex,
    });
  }

  /**
   * Get the current depth map from the graph (node ID → depth).
   * Returns only nodes with assigned depths (depth >= 0).
   */
  getDepthMap(): Map<string, number> {
    const depthMap = new Map<string, number>();
    this.graph.forEachNode((nodeId, attrs) => {
      if (attrs.depth >= 0) {
        depthMap.set(nodeId, attrs.depth);
      }
    });
    return depthMap;
  }

  /**
   * Get per-depth node/edge count statistics.
   * Useful for rendering depth legend overlays.
   */
  getDepthStats(): { nodeCounts: number[]; edgeCounts: number[]; maxDepthPresent: number } {
    const nodeCounts = new Array(MAX_DEPTH + 1).fill(0);
    const edgeCounts = new Array(MAX_DEPTH + 1).fill(0);
    let maxDepthPresent = 0;

    this.graph.forEachNode((_nodeId, attrs) => {
      const d = attrs.depth;
      if (d >= 0 && d <= MAX_DEPTH) {
        nodeCounts[d]++;
        if (d > maxDepthPresent) maxDepthPresent = d;
      }
    });

    this.graph.forEachEdge((_edgeId, attrs) => {
      const d = attrs.maxDepth;
      if (d >= 0 && d <= MAX_DEPTH) {
        edgeCounts[d]++;
      }
    });

    return { nodeCounts, edgeCounts, maxDepthPresent };
  }

  // ═══════════════════════════════════════════════════════
  // QUERY / STATS
  // ═══════════════════════════════════════════════════════

  /** Number of nodes in the graph */
  get nodeCount(): number {
    return this.graph.order;
  }

  /** Number of edges in the graph */
  get edgeCount(): number {
    return this.graph.size;
  }

  /**
   * Get neighbor node IDs for a given node.
   */
  getNeighborIds(nodeId: string): string[] {
    if (!this.graph.hasNode(nodeId)) return [];
    return this.graph.neighbors(nodeId);
  }

  /**
   * Get all node IDs of a specific role.
   */
  getNodeIdsByRole(role: MemoryNodeRole): string[] {
    const ids: string[] = [];
    this.graph.forEachNode((id, attrs) => {
      if (attrs.nodeRole === role) ids.push(id);
    });
    return ids;
  }

  /**
   * Get all node IDs of a specific type.
   */
  getNodeIdsByType(nodeType: MemoryNodeTypeNullable): string[] {
    const ids: string[] = [];
    this.graph.forEachNode((id, attrs) => {
      if (attrs.nodeType === nodeType) ids.push(id);
    });
    return ids;
  }

  /**
   * Filter visible nodes by predicate (returns IDs to hide).
   * Useful for type/role filtering in the UI.
   */
  getFilteredNodeIds(predicate: (attrs: GraphNodeAttributes) => boolean): string[] {
    const ids: string[] = [];
    this.graph.forEachNode((id, attrs) => {
      if (predicate(attrs)) ids.push(id);
    });
    return ids;
  }

  /**
   * Compute graph statistics for display.
   */
  getStats(): GraphStats {
    const byRole: Record<string, number> = { hub: 0, leaf: 0 };
    const byType: Record<string, number> = {};

    this.graph.forEachNode((_id, attrs) => {
      byRole[attrs.nodeRole] = (byRole[attrs.nodeRole] ?? 0) + 1;
      const typeKey = attrs.nodeType ?? 'null';
      byType[typeKey] = (byType[typeKey] ?? 0) + 1;
    });

    return {
      nodeCount: this.graph.order,
      edgeCount: this.graph.size,
      byRole,
      byType,
    };
  }
}

/** Graph statistics for UI display */
export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  byRole: Record<string, number>;
  byType: Record<string, number>;
}

// ─── Singleton-like Factory ──────────────────────────────

/**
 * Create a new GraphAdapter instance.
 * Each graph view (full map vs. local explorer) should have its own adapter.
 */
export function createGraphAdapter(): GraphAdapter {
  return new GraphAdapter();
}

// ─── Re-export Graph type for convenience ────────────────
export type { Graph };
