/**
 * depth-visual-mapper.ts — deepK depth-based visualization data conversion utility.
 *
 * Converts retrieval results into sigma.js-compatible graph node/edge data,
 * with depth-based (k=0~3) visual property mapping:
 *
 *   k=0 (center/query match): largest size, full opacity, vivid saturated color
 *   k=1 (direct neighbors):   large size, high opacity, slightly desaturated
 *   k=2 (2-hop neighbors):    medium size, moderate opacity, muted color
 *   k=3 (3-hop periphery):    small size, low opacity, faded/dimmed color
 *
 * This mapping implements the 4-layer progressive depth (deepK) visualization
 * concept, where retrieval starts at L0 (cheapest) and visually reflects
 * the exploration depth in the sigma.js graph.
 *
 * Design:
 * - Pure functions, no side effects — can be used in both GraphAdapter and React components
 * - Uses centralized color palette from config/node-colors.ts
 * - Scalable to 수십만 nodes (O(1) per node computation)
 * - Supports both global map and local ego-network views
 */

import type { MemoryNodeTypeNullable, MemoryNodeRole } from '../types/memory-node';
import { NODE_TYPE_PALETTES, NODE_ROLE_PALETTES } from '../config/node-colors';

// ─── Constants ─────────────────────────────────────────────

/** Maximum supported depth (k=0 through k=3) */
export const MAX_DEPTH = 3;

/** Valid depth values for progressive depth visualization */
export type DepthLevel = 0 | 1 | 2 | 3;

// ─── Depth Visual Profiles ─────────────────────────────────

/**
 * Visual properties for a given depth level.
 * All numeric values are normalized [0, 1] for flexible scaling.
 */
export interface DepthVisualProfile {
  /** Depth level (0 = center, 3 = periphery) */
  depth: DepthLevel;
  /** Label describing this depth */
  label: string;
  /** Size multiplier [0, 1] — applied to base node size */
  sizeMultiplier: number;
  /** Opacity [0, 1] — controls node/edge transparency */
  opacity: number;
  /** Saturation multiplier [0, 1] — controls color vividness */
  saturation: number;
  /** Whether to show label text at this depth */
  showLabel: boolean;
  /** Border width multiplier */
  borderWidthMultiplier: number;
  /** Edge thickness multiplier for edges at this depth */
  edgeSizeMultiplier: number;
  /** Edge opacity for edges connecting nodes at this depth */
  edgeOpacity: number;
}

/**
 * Depth visual profiles — one for each k=0..3.
 *
 * k=0: Query-matched / center node — maximum visual prominence
 * k=1: Direct neighbors — high prominence, labels visible
 * k=2: 2-hop neighbors — reduced prominence, labels hidden by default
 * k=3: Periphery — minimal prominence, context-only nodes
 */
export const DEPTH_PROFILES: ReadonlyArray<DepthVisualProfile> = [
  {
    depth: 0,
    label: 'Center (k=0)',
    sizeMultiplier: 1.0,
    opacity: 1.0,
    saturation: 1.0,
    showLabel: true,
    borderWidthMultiplier: 1.0,
    edgeSizeMultiplier: 1.0,
    edgeOpacity: 0.9,
  },
  {
    depth: 1,
    label: 'Direct (k=1)',
    sizeMultiplier: 0.75,
    opacity: 0.85,
    saturation: 0.85,
    showLabel: true,
    borderWidthMultiplier: 0.8,
    edgeSizeMultiplier: 0.8,
    edgeOpacity: 0.65,
  },
  {
    depth: 2,
    label: '2-hop (k=2)',
    sizeMultiplier: 0.5,
    opacity: 0.55,
    saturation: 0.6,
    showLabel: false,
    borderWidthMultiplier: 0.5,
    edgeSizeMultiplier: 0.55,
    edgeOpacity: 0.35,
  },
  {
    depth: 3,
    label: 'Periphery (k=3)',
    sizeMultiplier: 0.3,
    opacity: 0.3,
    saturation: 0.35,
    showLabel: false,
    borderWidthMultiplier: 0.3,
    edgeSizeMultiplier: 0.35,
    edgeOpacity: 0.18,
  },
] as const;

/**
 * Get the depth visual profile for a given depth level.
 * Clamps to [0, MAX_DEPTH].
 */
export function getDepthProfile(depth: number): DepthVisualProfile {
  const clamped = Math.max(0, Math.min(MAX_DEPTH, Math.round(depth)));
  return DEPTH_PROFILES[clamped];
}

// ─── Color Manipulation ────────────────────────────────────

/**
 * Parse a hex color string to RGB components.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

/**
 * Convert RGB to HSL for saturation manipulation.
 */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return { h, s, l };
}

/**
 * Convert HSL back to RGB.
 */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }

  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

/**
 * Apply saturation and opacity adjustments to a hex color,
 * returning an rgba() string suitable for sigma.js.
 *
 * @param hexColor - base color in #RRGGBB format
 * @param saturationMultiplier - [0, 1] desaturation factor (1 = full, 0 = grayscale)
 * @param opacity - [0, 1] alpha value
 * @returns rgba() CSS color string
 */
export function applyDepthColor(hexColor: string, saturationMultiplier: number, opacity: number): string {
  const rgb = hexToRgb(hexColor);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

  // Adjust saturation
  hsl.s *= Math.max(0, Math.min(1, saturationMultiplier));

  // Convert back to RGB
  const adjusted = hslToRgb(hsl.h, hsl.s, hsl.l);
  const alpha = Math.max(0, Math.min(1, opacity));

  return `rgba(${adjusted.r},${adjusted.g},${adjusted.b},${alpha.toFixed(2)})`;
}

// ─── Node Visual Properties ────────────────────────────────

/**
 * Resolved visual properties for a single graph node at a specific depth.
 */
export interface DepthNodeVisuals {
  /** Fill color (rgba) — adjusted for depth */
  color: string;
  /** Border color (rgba) — adjusted for depth */
  borderColor: string;
  /** Node size (pixels) — scaled by depth profile */
  size: number;
  /** Whether to show label */
  showLabel: boolean;
  /** Opacity [0, 1] */
  opacity: number;
  /** Depth level */
  depth: DepthLevel;
  /** Z-index hint (higher depth = lower z) */
  zIndex: number;
}

/**
 * Compute node visual properties for a given depth level.
 *
 * Uses the centralized node-colors palette and the depth visual profile
 * to produce sigma.js-ready visual attributes.
 *
 * @param nodeType - MemoryNode type (null for untyped)
 * @param nodeRole - 'hub' or 'leaf'
 * @param depth - graph traversal depth (0 = center/match, 1..3 = hops away)
 * @param baseSize - base node size before depth scaling (from activation/degree sizing)
 */
export function computeDepthNodeVisuals(
  nodeType: MemoryNodeTypeNullable,
  nodeRole: MemoryNodeRole,
  depth: number,
  baseSize: number = 8,
): DepthNodeVisuals {
  const profile = getDepthProfile(depth);

  // Resolve base colors from centralized palette
  const typeKey = nodeType ?? 'null';
  const typePalette = NODE_TYPE_PALETTES[typeKey] ?? NODE_TYPE_PALETTES['null'];
  const rolePalette = NODE_ROLE_PALETTES[nodeRole] ?? NODE_ROLE_PALETTES['leaf'];

  // Use role base color for hub border, type base for fill
  const baseColor = nodeRole === 'hub' && typeKey === 'null'
    ? rolePalette.base
    : typePalette.base;
  const baseBorder = nodeRole === 'hub' ? rolePalette.border : typePalette.dark;

  // Apply depth-based color adjustments
  const color = applyDepthColor(baseColor, profile.saturation, profile.opacity);
  const borderColor = applyDepthColor(baseBorder, profile.saturation, profile.opacity * 0.8);

  // Scale size by depth multiplier
  const size = Math.max(1, baseSize * profile.sizeMultiplier);

  return {
    color,
    borderColor,
    size,
    showLabel: profile.showLabel,
    opacity: profile.opacity,
    depth: profile.depth as DepthLevel,
    zIndex: MAX_DEPTH - profile.depth, // k=0 nodes render on top
  };
}

// ─── Edge Visual Properties ────────────────────────────────

/**
 * Resolved visual properties for a graph edge based on connected node depths.
 */
export interface DepthEdgeVisuals {
  /** Edge color (rgba) */
  color: string;
  /** Edge thickness (pixels) */
  size: number;
  /** Edge opacity [0, 1] */
  opacity: number;
  /** Max depth of the two connected nodes */
  maxDepth: DepthLevel;
}

/** Base edge color (neutral blue-gray) */
const EDGE_BASE_COLOR = '#788cb4';

/**
 * Compute edge visual properties based on the depths of its two endpoints.
 *
 * The edge takes the visual profile of its deeper (farther from center) endpoint,
 * ensuring that periphery edges are appropriately faded.
 *
 * @param sourceDepth - depth of the source node
 * @param targetDepth - depth of the target node
 * @param weight - Hebbian weight [0, 100] for thickness scaling
 * @param baseEdgeSize - base edge size before depth scaling (default 1.5)
 */
export function computeDepthEdgeVisuals(
  sourceDepth: number,
  targetDepth: number,
  weight: number = 50,
  baseEdgeSize: number = 1.5,
): DepthEdgeVisuals {
  // Edge depth = max of its two endpoints (farther node determines fading)
  const maxDepth = Math.max(sourceDepth, targetDepth);
  const profile = getDepthProfile(maxDepth);

  // Weight-based thickness: normalize weight to [0.3, 1] range
  const weightFactor = 0.3 + 0.7 * Math.max(0, Math.min(1, weight / 100));
  const size = Math.max(0.3, baseEdgeSize * profile.edgeSizeMultiplier * weightFactor);

  const color = applyDepthColor(EDGE_BASE_COLOR, profile.saturation, profile.edgeOpacity);

  return {
    color,
    size,
    opacity: profile.edgeOpacity,
    maxDepth: profile.depth as DepthLevel,
  };
}

// ─── Batch Conversion: Retrieval Results → Graph Data ──────

/**
 * A retrieval result node with its depth assignment.
 * Input type for batch conversion.
 */
export interface DepthAnnotatedNode {
  id: string;
  nodeType: MemoryNodeTypeNullable;
  nodeRole: MemoryNodeRole;
  frontmatter: string;
  keywords: string;
  activationCount: number;
  lastActivatedAtEvent: number;
  /** BFS depth from center (0 = center/match, 1+ = hops away) */
  depth: number;
  /** Base size from degree/activation calculations (optional, default computed) */
  baseSize?: number;
}

/**
 * A retrieval result edge with endpoint depths.
 * Input type for batch conversion.
 */
export interface DepthAnnotatedEdge {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType: string;
  weight: number;
  shield: number;
  activationCount: number;
  lastActivatedAtEvent: number;
  /** Source node depth */
  sourceDepth: number;
  /** Target node depth */
  targetDepth: number;
}

/**
 * Sigma.js-ready node attributes with depth-based visual properties.
 */
export interface SigmaNodeAttributes {
  label: string;
  x: number;
  y: number;
  size: number;
  color: string;
  borderColor: string;
  nodeType: MemoryNodeTypeNullable;
  nodeRole: MemoryNodeRole;
  keywords: string;
  activationCount: number;
  lastActivatedAtEvent: number;
  depth: DepthLevel;
  opacity: number;
  showLabel: boolean;
  zIndex: number;
  /** sigma.js node rendering type */
  type: string;
}

/**
 * Sigma.js-ready edge attributes with depth-based visual properties.
 */
export interface SigmaEdgeAttributes {
  label: string;
  color: string;
  size: number;
  edgeType: string;
  weight: number;
  shield: number;
  activationCount: number;
  lastActivatedAtEvent: number;
  opacity: number;
  maxDepth: DepthLevel;
  /** sigma.js edge rendering type */
  type: string;
}

/**
 * Complete sigma.js-ready graph data output.
 */
export interface DepthGraphData {
  nodes: Map<string, SigmaNodeAttributes>;
  edges: Map<string, { source: string; target: string; attributes: SigmaEdgeAttributes }>;
  /** Per-depth statistics */
  depthStats: DepthStats;
}

/**
 * Per-depth node/edge count statistics.
 */
export interface DepthStats {
  nodeCounts: [number, number, number, number]; // [k0, k1, k2, k3]
  edgeCounts: [number, number, number, number]; // max-depth grouped
  totalNodes: number;
  totalEdges: number;
}

/**
 * Convert depth-annotated retrieval results into sigma.js-ready graph data.
 *
 * This is the primary batch conversion function for the deepK visualization pipeline.
 * It processes retrieval nodes/edges in a single pass, applying depth-based visual
 * properties (color, size, opacity) from the centralized palette.
 *
 * @param nodes - retrieval result nodes with depth annotations
 * @param edges - retrieval result edges with endpoint depth annotations
 * @param spreadFactor - position spread for initial random placement (default: auto)
 * @returns sigma.js-ready graph data with depth stats
 */
export function convertToDepthGraph(
  nodes: DepthAnnotatedNode[],
  edges: DepthAnnotatedEdge[],
  spreadFactor?: number,
): DepthGraphData {
  const spread = spreadFactor ?? Math.sqrt(nodes.length) * 15;
  const nodeMap = new Map<string, SigmaNodeAttributes>();
  const edgeMap = new Map<string, { source: string; target: string; attributes: SigmaEdgeAttributes }>();
  const depthStats: DepthStats = {
    nodeCounts: [0, 0, 0, 0],
    edgeCounts: [0, 0, 0, 0],
    totalNodes: 0,
    totalEdges: 0,
  };

  // ── Process nodes ──
  for (const node of nodes) {
    const baseSize = node.baseSize ?? computeDefaultBaseSize(node.activationCount, node.nodeRole);
    const visuals = computeDepthNodeVisuals(node.nodeType, node.nodeRole, node.depth, baseSize);

    // Position: center node at origin, others spread randomly
    const isCenter = node.depth === 0;
    const x = isCenter ? 0 : (Math.random() - 0.5) * spread;
    const y = isCenter ? 0 : (Math.random() - 0.5) * spread;

    const attrs: SigmaNodeAttributes = {
      label: node.frontmatter,
      x,
      y,
      size: visuals.size,
      color: visuals.color,
      borderColor: visuals.borderColor,
      nodeType: node.nodeType,
      nodeRole: node.nodeRole,
      keywords: node.keywords,
      activationCount: node.activationCount,
      lastActivatedAtEvent: node.lastActivatedAtEvent,
      depth: visuals.depth,
      opacity: visuals.opacity,
      showLabel: visuals.showLabel,
      zIndex: visuals.zIndex,
      type: node.nodeRole === 'hub' ? 'hub' : 'leaf',
    };

    nodeMap.set(node.id, attrs);

    // Update stats
    const di = Math.min(MAX_DEPTH, Math.max(0, Math.round(node.depth))) as 0 | 1 | 2 | 3;
    depthStats.nodeCounts[di]++;
    depthStats.totalNodes++;
  }

  // ── Process edges ──
  for (const edge of edges) {
    // Skip edges with missing endpoints
    if (!nodeMap.has(edge.sourceId) || !nodeMap.has(edge.targetId)) continue;

    const visuals = computeDepthEdgeVisuals(edge.sourceDepth, edge.targetDepth, edge.weight);

    const attrs: SigmaEdgeAttributes = {
      label: edge.edgeType,
      color: visuals.color,
      size: visuals.size,
      edgeType: edge.edgeType,
      weight: edge.weight,
      shield: edge.shield,
      activationCount: edge.activationCount,
      lastActivatedAtEvent: edge.lastActivatedAtEvent,
      opacity: visuals.opacity,
      maxDepth: visuals.maxDepth,
      type: 'arrow',
    };

    edgeMap.set(edge.id, { source: edge.sourceId, target: edge.targetId, attributes: attrs });

    // Update stats
    const ei = Math.min(MAX_DEPTH, Math.max(0, visuals.maxDepth)) as 0 | 1 | 2 | 3;
    depthStats.edgeCounts[ei]++;
    depthStats.totalEdges++;
  }

  return { nodes: nodeMap, edges: edgeMap, depthStats };
}

// ─── Depth Assignment Helpers ──────────────────────────────

/**
 * Assign BFS depths to nodes from a set of center/seed node IDs.
 * Returns a Map of nodeId → depth.
 *
 * Used to annotate graph API responses with depth levels before
 * passing them to convertToDepthGraph().
 *
 * @param centerIds - seed node IDs (these get depth=0)
 * @param adjacency - adjacency list (nodeId → Set of neighbor nodeIds)
 * @param maxDepth - maximum BFS depth (default: MAX_DEPTH)
 * @returns Map of nodeId → depth (nodes beyond maxDepth are excluded)
 */
export function assignBfsDepths(
  centerIds: string[],
  adjacency: Map<string, Set<string>>,
  maxDepth: number = MAX_DEPTH,
): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [];

  // Seed with center nodes at depth 0
  for (const id of centerIds) {
    if (!depths.has(id)) {
      depths.set(id, 0);
      queue.push({ id, depth: 0 });
    }
  }

  // BFS
  let qi = 0;
  while (qi < queue.length) {
    const { id, depth } = queue[qi++];
    if (depth >= maxDepth) continue;

    const neighbors = adjacency.get(id);
    if (!neighbors) continue;

    for (const neighborId of neighbors) {
      if (!depths.has(neighborId)) {
        depths.set(neighborId, depth + 1);
        queue.push({ id: neighborId, depth: depth + 1 });
      }
    }
  }

  return depths;
}

/**
 * Build an adjacency map from a list of edges.
 * Treats edges as undirected for BFS depth assignment.
 *
 * @param edges - edges with sourceId and targetId
 * @returns adjacency map (nodeId → Set of neighbor nodeIds)
 */
export function buildAdjacency(
  edges: Array<{ sourceId: string; targetId: string }>,
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();

  for (const edge of edges) {
    if (!adj.has(edge.sourceId)) adj.set(edge.sourceId, new Set());
    if (!adj.has(edge.targetId)) adj.set(edge.targetId, new Set());
    adj.get(edge.sourceId)!.add(edge.targetId);
    adj.get(edge.targetId)!.add(edge.sourceId);
  }

  return adj;
}

// ─── Internal Helpers ──────────────────────────────────────

/**
 * Compute a default base size for a node before depth scaling.
 * Uses log-scaled activation count with role-based bonus.
 */
function computeDefaultBaseSize(activationCount: number, nodeRole: MemoryNodeRole): number {
  const logScale = Math.log2(Math.max(1, activationCount) + 1);
  const normalized = Math.min(1, logScale / 10);
  const base = 4 + normalized * 12; // range [4, 16]
  return nodeRole === 'hub' ? base + 4 : base;
}

// ─── Legend Data ────────────────────────────────────────────

/**
 * Depth legend entry for UI display.
 */
export interface DepthLegendEntry {
  depth: DepthLevel;
  label: string;
  /** Example color (using semantic type palette) */
  exampleColor: string;
  /** Example size (relative) */
  exampleSize: number;
  opacity: number;
}

/**
 * Generate legend entries for depth visualization.
 * Useful for rendering a depth legend in the graph UI.
 */
export function getDepthLegend(): DepthLegendEntry[] {
  const semanticBase = NODE_TYPE_PALETTES.semantic.base;

  return DEPTH_PROFILES.map((profile) => ({
    depth: profile.depth,
    label: profile.label,
    exampleColor: applyDepthColor(semanticBase, profile.saturation, profile.opacity),
    exampleSize: 12 * profile.sizeMultiplier,
    opacity: profile.opacity,
  }));
}
