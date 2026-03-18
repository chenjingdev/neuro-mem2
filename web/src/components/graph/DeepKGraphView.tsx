/**
 * DeepKGraphView — sigma.js graph with concentric-circle depth layout.
 *
 * Renders nodes arranged in concentric rings based on BFS hop distance (deepK)
 * from a center node. Each ring represents a depth level:
 *   - Ring 0 (center): the focus node
 *   - Ring 1: direct neighbors (1-hop)
 *   - Ring 2: 2-hop neighbors
 *   - Ring 3+: deeper connections
 *
 * Features:
 *   - Concentric circle layout with depth-based positioning
 *   - Depth ring labels (L0, L1, L2, L3) as HTML overlays
 *   - Node coloring by type (from centralized palette) + depth-based opacity
 *   - Edge connections with weight-based thickness
 *   - Interactive: hover highlights connected nodes, click navigates
 *   - Hub nodes rendered larger with border ring
 *   - Performance: handles up to ~2000 nodes in local deepK view
 */

import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import {
  SigmaContainer,
  useRegisterEvents,
  useSigma,
  useSetSettings,
  useCamera,
} from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import './DeepKGraphView.css';
import Graph from 'graphology';

import { computeNodeColor, computeNodeSize, computeEdgeColor, extractNodeData } from './graphUtils';
import {
  resolveHubBorderColor,
  EDGE_HIGHLIGHT_COLOR,
  EDGE_DIM_COLOR,
  EDGE_HUB_COLOR,
} from '../../config/node-colors';
import type { GraphData, GraphNode, GraphEdge } from '../../hooks/useGraphData';

// ─── Constants ─────────────────────────────────────────────

/** Radius multiplier per depth ring (pixels in graph space) */
const RING_RADIUS_BASE = 150;
/** Additional radius per ring */
const RING_RADIUS_INCREMENT = 180;
/** Maximum depth rings rendered */
const MAX_DEPTH = 6;
/** Depth ring label colors */
const DEPTH_RING_COLORS = [
  '#4a9eff',  // L0 - center (blue)
  '#00b894',  // L1 - direct (green)
  '#fdcb6e',  // L2 - 2-hop (yellow)
  '#ff7675',  // L3 - 3-hop (red)
  '#e84393',  // L4 - 4-hop (pink)
  '#6c5ce7',  // L5 - 5-hop (purple)
  '#8b8b9e',  // L6+ - further (gray)
];

/** Depth ring label descriptions (한영) */
const DEPTH_LABELS: Record<number, string> = {
  0: 'Center (중심)',
  1: 'L1 — Direct (직접 연결)',
  2: 'L2 — 2-hop',
  3: 'L3 — 3-hop',
  4: 'L4 — 4-hop',
  5: 'L5 — 5-hop',
};

// ─── Types ───────────────────────────────────────────────────

export interface DeepKGraphViewProps {
  /** Graph data from API */
  data: GraphData;
  /** Center node ID for BFS depth calculation */
  centerNodeId: string;
  /** Maximum depth to display (default: 3) */
  maxDepth?: number;
  /** Called when a node is clicked */
  onNodeClick?: (nodeId: string) => void;
  /** Called when a node is hovered/unhovered */
  onNodeHover?: (node: GraphNode | null, position?: { x: number; y: number }) => void;
  /** Additional class name */
  className?: string;
}

interface NodeDepthInfo {
  depth: number;
  angleIndex: number;
  totalAtDepth: number;
}

// ─── BFS Depth Computation ─────────────────────────────────

/**
 * Compute BFS depth for all reachable nodes from centerNodeId.
 * Returns a Map of nodeId → depth (0 = center).
 */
function computeBFSDepth(
  data: GraphData,
  centerNodeId: string,
  maxDepth: number,
): Map<string, NodeDepthInfo> {
  const result = new Map<string, NodeDepthInfo>();

  // Build adjacency list
  const adjacency = new Map<string, Set<string>>();
  for (const node of data.nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const edge of data.edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  // BFS
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: centerNodeId, depth: 0 }];
  visited.add(centerNodeId);

  // Group nodes by depth for angle assignment
  const depthGroups = new Map<number, string[]>();

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (!depthGroups.has(depth)) depthGroups.set(depth, []);
    depthGroups.get(depth)!.push(id);

    if (depth >= maxDepth) continue;

    const neighbors = adjacency.get(id);
    if (!neighbors) continue;

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ id: neighbor, depth: depth + 1 });
      }
    }
  }

  // Assign angle indices within each depth ring
  for (const [depth, nodeIds] of depthGroups.entries()) {
    // Sort for deterministic layout (hubs first, then by id)
    const nodeMap = new Map(data.nodes.map(n => [n.id, n]));
    nodeIds.sort((a, b) => {
      const na = nodeMap.get(a);
      const nb = nodeMap.get(b);
      // Hubs first
      if (na?.nodeRole === 'hub' && nb?.nodeRole !== 'hub') return -1;
      if (na?.nodeRole !== 'hub' && nb?.nodeRole === 'hub') return 1;
      return a.localeCompare(b);
    });

    for (let i = 0; i < nodeIds.length; i++) {
      result.set(nodeIds[i], {
        depth,
        angleIndex: i,
        totalAtDepth: nodeIds.length,
      });
    }
  }

  return result;
}

// ─── Concentric Circle Layout ─────────────────────────────

/**
 * Apply concentric circle layout to a graphology graph.
 * Nodes are placed on rings based on their BFS depth from center.
 *
 * Center node: (0, 0)
 * Depth 1 nodes: evenly spaced on first ring
 * Depth 2 nodes: evenly spaced on second ring
 * etc.
 */
function applyConcentricLayout(
  graph: Graph,
  depthMap: Map<string, NodeDepthInfo>,
): void {
  graph.forEachNode((nodeId) => {
    const info = depthMap.get(nodeId);
    if (!info) {
      // Unreachable node — place far away
      graph.setNodeAttribute(nodeId, 'x', (Math.random() - 0.5) * 2000);
      graph.setNodeAttribute(nodeId, 'y', (Math.random() - 0.5) * 2000);
      return;
    }

    if (info.depth === 0) {
      // Center node at origin
      graph.setNodeAttribute(nodeId, 'x', 0);
      graph.setNodeAttribute(nodeId, 'y', 0);
      return;
    }

    // Compute ring radius
    const radius = RING_RADIUS_BASE + (info.depth - 1) * RING_RADIUS_INCREMENT;

    // Compute angle: evenly distribute nodes on the ring
    // Add small random jitter to prevent exact overlaps when many nodes at same depth
    const baseAngle = (2 * Math.PI * info.angleIndex) / info.totalAtDepth;
    const jitter = info.totalAtDepth > 20
      ? (Math.random() - 0.5) * (0.3 / info.totalAtDepth)
      : 0;
    const angle = baseAngle + jitter;

    // Slight radius variation for visual appeal (prevents rigid circles)
    const radiusJitter = info.totalAtDepth > 10
      ? (Math.random() - 0.5) * (radius * 0.08)
      : 0;

    const x = (radius + radiusJitter) * Math.cos(angle);
    const y = (radius + radiusJitter) * Math.sin(angle);

    graph.setNodeAttribute(nodeId, 'x', x);
    graph.setNodeAttribute(nodeId, 'y', y);
  });
}

// ─── Graph Building ─────────────────────────────────────────

/**
 * Build a graphology Graph from data with concentric layout applied.
 */
function buildDeepKGraph(
  data: GraphData,
  centerNodeId: string,
  maxDepth: number,
): { graph: Graph; depthMap: Map<string, NodeDepthInfo>; maxRingDepth: number } {
  // Compute BFS depths
  const depthMap = computeBFSDepth(data, centerNodeId, maxDepth);

  const graph = new Graph({ multi: false, type: 'undirected' });

  // Only add nodes that are reachable (in depthMap)
  const reachableIds = new Set(depthMap.keys());

  for (const node of data.nodes) {
    if (!reachableIds.has(node.id)) continue;

    const depthInfo = depthMap.get(node.id)!;
    const isCenter = node.id === centerNodeId;

    // Color: nodeType color, but dim based on depth
    const baseColor = computeNodeColor(node);

    // Size: center is larger, deeper nodes slightly smaller
    const baseSize = computeNodeSize(node);
    const depthSizeFactor = Math.max(0.5, 1 - depthInfo.depth * 0.1);
    const size = isCenter ? baseSize * 1.8 : baseSize * depthSizeFactor;

    const hubBorder = resolveHubBorderColor(node.nodeRole);

    graph.addNode(node.id, {
      x: 0,
      y: 0,
      size,
      color: baseColor,
      label: node.label.length > 40 ? node.label.slice(0, 37) + '...' : node.label,
      // Hub nodes get a visible border
      borderColor: isCenter ? '#ffffff' : (hubBorder ?? undefined),
      borderSize: isCenter ? 3 : (hubBorder ? 2 : 0),
      // Custom attributes
      nodeType: node.nodeType,
      nodeRole: node.nodeRole,
      activationCount: node.activationCount,
      keywords: node.keywords,
      depth: depthInfo.depth,
      isCenter,
      // Force label on center node and shallow depth hubs
      forceLabel: isCenter || (depthInfo.depth <= 1 && node.nodeRole === 'hub'),
    });
  }

  // Add edges (only between nodes that exist in the graph)
  for (const edge of data.edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    if (edge.source === edge.target) continue;
    if (graph.hasEdge(edge.source, edge.target)) continue;

    try {
      const sourceDepth = depthMap.get(edge.source)?.depth ?? 999;
      const targetDepth = depthMap.get(edge.target)?.depth ?? 999;
      // Edges crossing depth boundaries get slightly different styling
      const isCrossDepth = sourceDepth !== targetDepth;

      graph.addEdge(edge.source, edge.target, {
        size: Math.max(0.5, Math.min(4, edge.weight / 25)),
        color: computeEdgeColor(edge.weight),
        weight: edge.weight,
        shield: edge.shield,
        edgeType: edge.edgeType,
        crossDepth: isCrossDepth,
      });
    } catch {
      // Skip duplicate edges
    }
  }

  // Apply concentric circle layout
  applyConcentricLayout(graph, depthMap);

  // Compute max ring depth present
  let maxRingDepth = 0;
  for (const info of depthMap.values()) {
    if (info.depth > maxRingDepth) maxRingDepth = info.depth;
  }

  return { graph, depthMap, maxRingDepth };
}

// ─── Depth Ring Labels Overlay ──────────────────────────────

interface DepthRingOverlayProps {
  maxRingDepth: number;
  depthCounts: Map<number, number>;
}

/**
 * HTML overlay showing concentric ring labels and node counts per depth.
 * Positioned absolutely over the sigma.js canvas.
 */
function DepthRingOverlay({ maxRingDepth, depthCounts }: DepthRingOverlayProps) {
  const rings = [];
  for (let d = 0; d <= Math.min(maxRingDepth, MAX_DEPTH); d++) {
    const count = depthCounts.get(d) ?? 0;
    const color = DEPTH_RING_COLORS[Math.min(d, DEPTH_RING_COLORS.length - 1)];
    const label = DEPTH_LABELS[d] ?? `L${d}`;

    rings.push(
      <div
        key={d}
        className="deepk-ring-label"
        style={{
          '--ring-color': color,
        } as React.CSSProperties}
      >
        <span className="deepk-ring-dot" style={{ backgroundColor: color }} />
        <span className="deepk-ring-text">{label}</span>
        <span className="deepk-ring-count">{count} node{count !== 1 ? 's' : ''}</span>
      </div>
    );
  }

  return (
    <div className="deepk-ring-legend">
      <div className="deepk-ring-title">Depth Layers (깊이)</div>
      {rings}
    </div>
  );
}

// ─── Depth Ring SVG Overlay ─────────────────────────────────

interface DepthRingCirclesProps {
  maxRingDepth: number;
}

/**
 * SVG overlay rendering concentric guide circles behind the graph.
 * These dashed circles indicate depth ring boundaries.
 *
 * Uses a CSS-only approach rendered inside the sigma container overlay.
 */
function DepthRingCircles({ maxRingDepth }: DepthRingCirclesProps) {
  const sigma = useSigma();
  const [circles, setCircles] = useState<Array<{
    cx: number; cy: number; r: number; depth: number;
  }>>([]);

  const updateCircles = useCallback(() => {
    // Convert graph-space ring radii to viewport coordinates
    const center = sigma.graphToViewport({ x: 0, y: 0 });
    const ringsData: typeof circles = [];

    for (let d = 1; d <= Math.min(maxRingDepth, MAX_DEPTH); d++) {
      const graphRadius = RING_RADIUS_BASE + (d - 1) * RING_RADIUS_INCREMENT;
      const edgePoint = sigma.graphToViewport({ x: graphRadius, y: 0 });
      const viewRadius = Math.abs(edgePoint.x - center.x);

      ringsData.push({
        cx: center.x,
        cy: center.y,
        r: viewRadius,
        depth: d,
      });
    }

    setCircles(ringsData);
  }, [sigma, maxRingDepth]);

  useEffect(() => {
    updateCircles();
    // Update on camera changes (zoom/pan)
    const handler = () => requestAnimationFrame(updateCircles);
    sigma.getCamera().on('updated', handler);
    // Also update on resize
    window.addEventListener('resize', handler);
    return () => {
      sigma.getCamera().removeListener('updated', handler);
      window.removeEventListener('resize', handler);
    };
  }, [sigma, updateCircles]);

  return (
    <svg className="deepk-ring-svg" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }}>
      {circles.map(({ cx, cy, r, depth }) => {
        const color = DEPTH_RING_COLORS[Math.min(depth, DEPTH_RING_COLORS.length - 1)];
        return (
          <g key={depth}>
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={color}
              strokeWidth={1}
              strokeDasharray="6,4"
              opacity={0.3}
            />
            {/* Depth label on the ring (top position) */}
            <text
              x={cx}
              y={cy - r - 6}
              fill={color}
              fontSize={11}
              fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', monospace"
              textAnchor="middle"
              opacity={0.6}
            >
              L{depth}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Graph Events (Interaction) ─────────────────────────────

interface DeepKEventsProps {
  centerNodeId: string;
  maxRingDepth: number;
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (node: GraphNode | null, position?: { x: number; y: number }) => void;
}

function DeepKEvents({ centerNodeId, maxRingDepth, onNodeClick, onNodeHover }: DeepKEventsProps) {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const setSettings = useSetSettings();
  const { gotoNode } = useCamera();
  const hoveredRef = useRef<string | null>(null);

  // Center camera on the center node after mount
  useEffect(() => {
    const graph = sigma.getGraph();
    if (graph.hasNode(centerNodeId)) {
      requestAnimationFrame(() => {
        gotoNode(centerNodeId, { duration: 400 });
      });
    }
  }, [centerNodeId, sigma, gotoNode]);

  // Node/edge styling with depth awareness
  useEffect(() => {
    setSettings({
      nodeReducer: (node, attrs) => {
        const isCenter = node === centerNodeId;
        const depth = attrs.depth as number | undefined;

        // Center node always prominent
        if (isCenter) {
          return {
            ...attrs,
            zIndex: 10,
            forceLabel: true,
          };
        }

        // When hovering a node
        if (hoveredRef.current) {
          const graph = sigma.getGraph();
          const isHovered = node === hoveredRef.current;
          const isNeighbor = graph.hasEdge(node, hoveredRef.current) ||
                            graph.hasEdge(hoveredRef.current, node);

          if (isHovered) {
            return { ...attrs, zIndex: 9, forceLabel: true };
          }
          if (isNeighbor) {
            return { ...attrs, zIndex: 5 };
          }
          // Dim non-connected nodes
          return { ...attrs, color: '#1e1e3a', label: '', zIndex: 0 };
        }

        // Default: deeper nodes slightly dimmer (handled by color already)
        return {
          ...attrs,
          zIndex: Math.max(0, 5 - (depth ?? 0)),
        };
      },
      edgeReducer: (edge, attrs) => {
        if (!hoveredRef.current) {
          // Default: edges connecting to center are highlighted
          const graph = sigma.getGraph();
          const src = graph.source(edge);
          const tgt = graph.target(edge);
          if (src === centerNodeId || tgt === centerNodeId) {
            return {
              ...attrs,
              color: EDGE_HUB_COLOR,
              size: Math.max(attrs.size as number, 1.5),
            };
          }
          return attrs;
        }

        // Hover mode: highlight connected edges
        const graph = sigma.getGraph();
        const src = graph.source(edge);
        const tgt = graph.target(edge);
        if (src === hoveredRef.current || tgt === hoveredRef.current) {
          return {
            ...attrs,
            color: EDGE_HIGHLIGHT_COLOR,
            size: Math.max(attrs.size as number, 2),
            zIndex: 1,
          };
        }
        return { ...attrs, color: EDGE_DIM_COLOR, zIndex: 0 };
      },
    });
  }, [centerNodeId, sigma, setSettings]);

  // Register event handlers
  useEffect(() => {
    registerEvents({
      clickNode: (event) => {
        onNodeClick?.(event.node);
      },
      enterNode: (event) => {
        hoveredRef.current = event.node;

        // Extract node data for tooltip
        const nodeData = extractNodeData(sigma.getGraph(), event.node);
        const displayData = sigma.getNodeDisplayData(event.node);
        if (displayData && nodeData) {
          const viewPos = sigma.graphToViewport({
            x: displayData.x,
            y: displayData.y,
          });
          onNodeHover?.(nodeData, { x: viewPos.x, y: viewPos.y });
        } else {
          onNodeHover?.(nodeData);
        }

        // Trigger reducer re-evaluation
        sigma.refresh();
      },
      leaveNode: () => {
        hoveredRef.current = null;
        onNodeHover?.(null);
        sigma.refresh();
      },
    });
  }, [registerEvents, sigma, onNodeClick, onNodeHover]);

  return <DepthRingCircles maxRingDepth={maxRingDepth} />;
}

// ─── Main Component ─────────────────────────────────────────

export function DeepKGraphView({
  data,
  centerNodeId,
  maxDepth = 3,
  onNodeClick,
  onNodeHover,
  className,
}: DeepKGraphViewProps) {
  // Build graph with concentric layout
  const { graph, depthCounts, maxRingDepth } = useMemo(() => {
    if (!data || data.nodes.length === 0) {
      return { graph: null, depthCounts: new Map<number, number>(), maxRingDepth: 0 };
    }

    const result = buildDeepKGraph(data, centerNodeId, maxDepth);

    // Count nodes per depth for the legend
    const counts = new Map<number, number>();
    for (const info of result.depthMap.values()) {
      counts.set(info.depth, (counts.get(info.depth) ?? 0) + 1);
    }

    return {
      graph: result.graph,
      depthCounts: counts,
      maxRingDepth: result.maxRingDepth,
    };
  }, [data, centerNodeId, maxDepth]);

  // Empty state
  if (!graph || graph.order === 0) {
    return (
      <div className={`deepk-graph-empty ${className ?? ''}`}>
        <div className="deepk-empty-icon">🎯</div>
        <p>No connections found for this node.</p>
        <p className="deepk-empty-hint">Select a different node or increase the depth.</p>
      </div>
    );
  }

  return (
    <div className={`deepk-graph-container ${className ?? ''}`}>
      {/* Sigma.js graph rendering */}
      <SigmaContainer
        graph={graph}
        className="sigma-container sigma-deepk"
        settings={{
          // Show labels at moderate zoom
          labelRenderedSizeThreshold: 5,
          labelDensity: 0.12,
          labelGridCellSize: 45,
          renderEdgeLabels: false,
          enableEdgeEvents: false,
          defaultNodeType: 'circle',
          // Zoom settings
          minCameraRatio: 0.05,
          maxCameraRatio: 8,
          zIndex: true,
          // Appearance
          labelFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
          labelSize: 12,
          labelColor: { color: '#e0e0e0' },
          defaultEdgeType: 'line',
          stagePadding: 80,
        }}
      >
        <DeepKEvents
          centerNodeId={centerNodeId}
          maxRingDepth={maxRingDepth}
          onNodeClick={onNodeClick}
          onNodeHover={onNodeHover}
        />
      </SigmaContainer>

      {/* Depth ring legend overlay */}
      <DepthRingOverlay
        maxRingDepth={maxRingDepth}
        depthCounts={depthCounts}
      />
    </div>
  );
}

// ─── Exports ────────────────────────────────────────────────

export { DEPTH_RING_COLORS, DEPTH_LABELS, MAX_DEPTH };
export type { NodeDepthInfo };
