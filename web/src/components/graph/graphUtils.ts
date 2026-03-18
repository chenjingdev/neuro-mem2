/**
 * Graph utility functions — shared by GlobalMapView and LocalExplorerView.
 *
 * Handles:
 * - Graphology graph construction from API data
 * - Node color/size calculations based on type, role, activation
 * - ForceAtlas2 layout with Barnes-Hut optimization for scalability
 */

import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type { GraphData, GraphNode } from '../../hooks/useGraphData';
import {
  NODE_TYPE_COLORS,
  NODE_ROLE_COLORS,
  NODE_ROLE_PALETTES,
  resolveNodeColor,
  resolveHubBorderColor,
  computeEdgeColor as computeEdgeColorFromConfig,
  EDGE_HIGHLIGHT_COLOR,
  EDGE_DIM_COLOR,
  EDGE_HUB_COLOR,
} from '../../config/node-colors';

// Re-export centralized color maps for backward compatibility
export { NODE_TYPE_COLORS, NODE_ROLE_COLORS };

// ─── Size Calculation ───────────────────────────────────

/** Size range constants */
const NODE_SIZE_MIN = 3;
const NODE_SIZE_MAX = 30;
const HUB_SIZE_MIN = 7;
const HUB_SIZE_MAX = 30;
const LEAF_SIZE_MIN = 3;
const LEAF_SIZE_MAX = 12;

/** Compute initial node size based on role + activation count.
 * Hub nodes are larger; activation scales logarithmically.
 * This is the fallback size before degree-based sizing is applied.
 */
export function computeNodeSize(node: GraphNode): number {
  const baseSize = node.nodeRole === 'hub' ? 8 : 4;
  const activationBoost = Math.log2(Math.max(1, node.activationCount)) * 1.5;
  return Math.min(baseSize + activationBoost, 24);
}

/**
 * Compute degree-based node size.
 * Hub nodes scale between HUB_SIZE_MIN..HUB_SIZE_MAX based on their degree.
 * Leaf nodes scale between LEAF_SIZE_MIN..LEAF_SIZE_MAX with less range.
 * Uses log scale to prevent extreme outliers from dominating.
 *
 * @param degree - number of edges connected to this node
 * @param maxDegree - maximum degree in the graph (for normalization)
 * @param nodeRole - 'hub' or 'leaf'
 * @param activationCount - activation count for secondary boost
 */
export function computeDegreeSizedNode(
  degree: number,
  maxDegree: number,
  nodeRole: string,
  activationCount: number,
): number {
  const isHub = nodeRole === 'hub';
  const sizeMin = isHub ? HUB_SIZE_MIN : LEAF_SIZE_MIN;
  const sizeMax = isHub ? HUB_SIZE_MAX : LEAF_SIZE_MAX;

  // Log-scaled degree normalization (avoids extreme outliers)
  const logDegree = Math.log2(Math.max(1, degree) + 1);
  const logMax = Math.log2(Math.max(1, maxDegree) + 1);
  const degreeNorm = logMax > 0 ? logDegree / logMax : 0;

  // Activation gives a small secondary boost (up to 15% of range)
  const activationBoost = Math.min(0.15, Math.log2(Math.max(1, activationCount)) * 0.02);

  // Combined factor clamped to [0, 1]
  const factor = Math.min(1, degreeNorm + activationBoost);

  return sizeMin + factor * (sizeMax - sizeMin);
}

/**
 * Apply degree-based sizing to all nodes in a built graph.
 * Must be called AFTER all nodes and edges are added.
 * This is the key function for hub size differentiation.
 */
export function applyDegreeSizing(graph: Graph): void {
  if (graph.order === 0) return;

  // Step 1: compute degree for each node
  let maxDegree = 0;
  const degrees = new Map<string, number>();

  graph.forEachNode((nodeId) => {
    const deg = graph.degree(nodeId);
    degrees.set(nodeId, deg);
    if (deg > maxDegree) maxDegree = deg;
  });

  // Step 2: assign size based on degree
  graph.forEachNode((nodeId, attrs) => {
    const degree = degrees.get(nodeId) ?? 0;
    const nodeRole = (attrs.nodeRole as string) ?? 'leaf';
    const activationCount = (attrs.activationCount as number) ?? 0;

    const newSize = computeDegreeSizedNode(degree, maxDegree, nodeRole, activationCount);
    graph.setNodeAttribute(nodeId, 'size', newSize);
  });
}

/**
 * Compute node color based on type (primary) or role (fallback for untyped hubs).
 * Uses centralized resolveNodeColor from config/node-colors.
 */
export function computeNodeColor(node: GraphNode): string {
  return resolveNodeColor(node.nodeType, node.nodeRole);
}

/** Compute edge color with opacity based on weight. Delegates to centralized config. */
export function computeEdgeColor(weight: number): string {
  return computeEdgeColorFromConfig(weight);
}

// ─── Graph Construction ─────────────────────────────────

/**
 * Build a graphology Graph from API GraphData.
 * Assigns positions, sizes, colors, labels.
 */
export function buildGraph(data: GraphData, centerNodeId?: string): Graph {
  const graph = new Graph({ multi: false, type: 'undirected' });

  // Add nodes with initial random positions
  const nodeCount = data.nodes.length;
  const spreadFactor = Math.sqrt(nodeCount) * 10;

  for (const node of data.nodes) {
    const isCenter = node.id === centerNodeId;
    const x = isCenter ? 0 : (Math.random() - 0.5) * spreadFactor;
    const y = isCenter ? 0 : (Math.random() - 0.5) * spreadFactor;

    // Resolve colors from centralized palette
    const nodeColor = computeNodeColor(node);
    const hubBorder = resolveHubBorderColor(node.nodeRole);

    graph.addNode(node.id, {
      x,
      y,
      size: computeNodeSize(node),
      color: nodeColor,
      label: node.label,
      // Hub nodes get a visible border ring for visual distinction
      borderColor: hubBorder ?? undefined,
      borderSize: hubBorder ? 2 : 0,
      // Custom attributes for tooltip/interaction
      nodeType: node.nodeType,
      nodeRole: node.nodeRole,
      activationCount: node.activationCount,
      keywords: node.keywords,
      // Visual state
      highlighted: isCenter,
    });
  }

  // Add edges (skip duplicates, handle missing nodes)
  for (const edge of data.edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    // graphology undirected: avoid duplicate edge
    if (graph.hasEdge(edge.source, edge.target)) continue;

    try {
      graph.addEdge(edge.source, edge.target, {
        size: Math.max(0.5, Math.min(4, edge.weight / 25)),
        color: computeEdgeColor(edge.weight),
        weight: edge.weight,
        shield: edge.shield,
        edgeType: edge.edgeType,
      });
    } catch {
      // Skip edge if it already exists
    }
  }

  // Apply degree-based sizing: hub nodes with many connections appear larger
  applyDegreeSizing(graph);

  return graph;
}

// ─── ForceAtlas2 Layout Engine ───────────────────────────

/**
 * ForceAtlas2 layout configuration.
 * Callers can override any subset of these parameters.
 */
export interface FA2LayoutOptions {
  /** Number of synchronous iterations (auto-tuned by graph size if omitted) */
  iterations?: number;
  /** Gravity — pulls nodes toward center. Higher = tighter layout. Default: auto */
  gravity?: number;
  /** Scaling ratio — repulsion multiplier. Higher = more spread. Default: auto */
  scalingRatio?: number;
  /** Use Barnes-Hut approximation for O(n·log n) repulsion. Default: auto (>500 nodes) */
  barnesHutOptimize?: boolean;
  /** Barnes-Hut accuracy: 0=exact, 1=coarse. Default: 0.5 */
  barnesHutTheta?: number;
  /** Strong gravity mode — gravity grows with distance (prevents far-flung outliers). Default: false */
  strongGravityMode?: boolean;
  /** Slow down factor — dampens velocity. Higher = more stable, slower convergence. Default: auto */
  slowDown?: number;
  /** Edge weight influence: 0=ignore weights, 1=linear, >1=amplified. Default: 1 */
  edgeWeightInfluence?: number;
  /** LinLog mode — log-attraction makes tighter, more readable clusters. Default: auto (true for >2000 nodes) */
  linLogMode?: boolean;
  /** View mode for auto-tuning. 'local' applies stronger gravity + strongGravityMode. */
  viewMode?: 'global' | 'local';
  /** Center node id for local view — this node's position is pinned at origin. */
  centerNodeId?: string;
  /** Adjust gravity specifically (multiplier applied on top of auto gravity). Default: 1.0 */
  gravityMultiplier?: number;
}

/**
 * Size-tier presets for ForceAtlas2 parameters.
 * Each tier is tuned for a specific node count range for optimal visual quality
 * and performance at 수십만 노드 scale.
 *
 * Key relationships:
 * - gravity ∝ 1/sqrt(n) — looser for big graphs so clusters don't merge
 * - scalingRatio ∝ sqrt(n) — more repulsion to fill screen space
 * - iterations ∝ 1/n — fewer passes for perf, Barnes-Hut compensates
 * - linLogMode on for large graphs — log attraction creates tighter clusters
 */
const SIZE_TIERS = [
  // Tier 0: tiny (<50 nodes) — high quality, full convergence
  { maxN: 50,    iterations: 200, gravity: 3.0,  scalingRatio: 2,   barnesHut: false, theta: 0.5, slowDown: 1,   linLog: false },
  // Tier 1: small (50–500) — good quality, moderate iterations
  { maxN: 500,   iterations: 100, gravity: 1.5,  scalingRatio: 5,   barnesHut: false, theta: 0.5, slowDown: 1,   linLog: false },
  // Tier 2: medium (500–2000) — Barnes-Hut kicks in
  { maxN: 2000,  iterations: 80,  gravity: 1.0,  scalingRatio: 8,   barnesHut: true,  theta: 0.5, slowDown: 1.5, linLog: false },
  // Tier 3: large (2000–10000) — LinLog for cluster definition
  { maxN: 10000, iterations: 50,  gravity: 0.5,  scalingRatio: 12,  barnesHut: true,  theta: 0.6, slowDown: 2,   linLog: true  },
  // Tier 4: massive (>10000) — minimal iterations, aggressive approximation
  { maxN: Infinity, iterations: 30, gravity: 0.3, scalingRatio: 20, barnesHut: true,  theta: 0.8, slowDown: 3,   linLog: true  },
] as const;

/**
 * Resolve a size tier based on node count.
 */
function resolveTier(nodeCount: number) {
  for (const tier of SIZE_TIERS) {
    if (nodeCount <= tier.maxN) return tier;
  }
  return SIZE_TIERS[SIZE_TIERS.length - 1];
}

/**
 * Apply ForceAtlas2 layout with adaptive parameter tuning.
 *
 * The engine automatically selects optimal parameters based on:
 * 1. Graph size (5-tier system from tiny to 수십만 노드)
 * 2. View mode (global overview vs local ego-network)
 * 3. Center node pinning (local view fixes center at origin)
 *
 * All auto-tuned parameters can be overridden via FA2LayoutOptions.
 *
 * @param graph - graphology Graph instance (modified in-place)
 * @param options - optional overrides for layout parameters
 */
export function applyLayout(graph: Graph, options?: FA2LayoutOptions | number): void {
  const nodeCount = graph.order;
  if (nodeCount <= 1) return;

  // Support legacy call: applyLayout(graph, 80)
  const opts: FA2LayoutOptions = typeof options === 'number'
    ? { iterations: options }
    : (options ?? {});

  const isLocal = opts.viewMode === 'local';
  const tier = resolveTier(nodeCount);
  const gravityMul = opts.gravityMultiplier ?? 1.0;

  // ── Auto-tune parameters with tier defaults ──

  const iterations = opts.iterations ?? tier.iterations;

  // Local view: 2× gravity for tighter ego-network clustering
  const baseGravity = isLocal ? tier.gravity * 2.5 : tier.gravity;
  const gravity = (opts.gravity ?? baseGravity) * gravityMul;

  // Local view: slightly less repulsion to keep neighbors close
  const scalingRatio = opts.scalingRatio ?? (isLocal ? Math.max(2, tier.scalingRatio * 0.6) : tier.scalingRatio);

  const barnesHutOptimize = opts.barnesHutOptimize ?? tier.barnesHut;
  const barnesHutTheta = opts.barnesHutTheta ?? tier.theta;

  // Local view: strongGravityMode prevents outliers from drifting
  const strongGravityMode = opts.strongGravityMode ?? isLocal;

  // Local view: more dampening for stability
  const slowDown = opts.slowDown ?? (isLocal ? Math.max(tier.slowDown, 2) : tier.slowDown);

  const edgeWeightInfluence = opts.edgeWeightInfluence ?? 1;
  const linLogMode = opts.linLogMode ?? tier.linLog;

  // ── Pin center node at origin (local view) ──
  // Save and fix position so ForceAtlas2 treats it as an anchor
  const centerNodeId = opts.centerNodeId;
  let savedCenterPos: { x: number; y: number } | null = null;
  if (centerNodeId && graph.hasNode(centerNodeId)) {
    savedCenterPos = {
      x: graph.getNodeAttribute(centerNodeId, 'x') as number,
      y: graph.getNodeAttribute(centerNodeId, 'y') as number,
    };
    // Set fixed flag recognized by graphology-layout-forceatlas2
    graph.setNodeAttribute(centerNodeId, 'fixed', true);
  }

  // ── Run ForceAtlas2 ──

  forceAtlas2.assign(graph, {
    iterations,
    settings: {
      gravity,
      scalingRatio,
      barnesHutOptimize,
      barnesHutTheta,
      strongGravityMode,
      slowDown,
      edgeWeightInfluence,
      linLogMode,
      adjustSizes: false, // Don't prevent overlap (too expensive for large graphs)
    },
    getEdgeWeight: 'weight',
  });

  // ── Restore center node position after layout ──
  if (centerNodeId && savedCenterPos && graph.hasNode(centerNodeId)) {
    graph.setNodeAttribute(centerNodeId, 'x', savedCenterPos.x);
    graph.setNodeAttribute(centerNodeId, 'y', savedCenterPos.y);
    graph.removeNodeAttribute(centerNodeId, 'fixed');
  }
}

/**
 * Get the current layout parameter description for display in UI controls.
 * Returns the resolved parameters that would be used for a given graph size.
 */
export function getLayoutParams(nodeCount: number, viewMode: 'global' | 'local' = 'global'): {
  tier: string;
  iterations: number;
  gravity: number;
  scalingRatio: number;
  barnesHutOptimize: boolean;
  barnesHutTheta: number;
  strongGravityMode: boolean;
  slowDown: number;
  linLogMode: boolean;
} {
  const tier = resolveTier(nodeCount);
  const isLocal = viewMode === 'local';
  const tierNames = ['tiny', 'small', 'medium', 'large', 'massive'];
  const tierIdx = SIZE_TIERS.indexOf(tier as any);
  return {
    tier: tierNames[tierIdx] ?? 'unknown',
    iterations: tier.iterations,
    gravity: isLocal ? tier.gravity * 2.5 : tier.gravity,
    scalingRatio: isLocal ? Math.max(2, tier.scalingRatio * 0.6) : tier.scalingRatio,
    barnesHutOptimize: tier.barnesHut,
    barnesHutTheta: tier.theta,
    strongGravityMode: isLocal,
    slowDown: isLocal ? Math.max(tier.slowDown, 2) : tier.slowDown,
    linLogMode: tier.linLog,
  };
}

/**
 * Extract GraphNode data from a graphology node's attributes.
 */
export function extractNodeData(graph: Graph, nodeId: string): GraphNode | null {
  if (!graph.hasNode(nodeId)) return null;
  const attrs = graph.getNodeAttributes(nodeId);
  return {
    id: nodeId,
    nodeType: attrs.nodeType ?? null,
    nodeRole: attrs.nodeRole ?? 'leaf',
    label: attrs.label ?? '',
    activationCount: attrs.activationCount ?? 0,
    keywords: attrs.keywords ?? '',
  };
}
