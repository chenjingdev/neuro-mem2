/**
 * GlobalMapView — sigma.js WebGL-based full graph visualization.
 *
 * Renders a sampled overview of the memory graph:
 * - Hubs are larger and positioned centrally by ForceAtlas2
 * - Leaves cluster around their connected hubs
 * - Click → triggers onNodeClick for local explorer transition
 * - Hover → shows tooltip via onNodeHover
 *
 * Performance optimizations:
 * - sigma.js uses WebGL for rendering (handles 10k+ nodes)
 * - LOD: labels shown only on zoom (labelRenderedSizeThreshold)
 * - Edge rendering reduced at low zoom levels
 * - Barnes-Hut ForceAtlas2 for fast layout
 */

import { useEffect, useRef, useMemo, useCallback } from 'react';
import {
  SigmaContainer,
  useRegisterEvents,
  useSigma,
  useSetSettings,
} from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';

import { buildGraph, applyLayout, extractNodeData } from './graphUtils';
import { LayoutControls } from './LayoutControls';
import { EDGE_HIGHLIGHT_COLOR, EDGE_DIM_COLOR } from '../../config/node-colors';
import type { GraphData, GraphNode } from '../../hooks/useGraphData';

// ─── Props ──────────────────────────────────────────────

interface GlobalMapViewProps {
  data: GraphData;
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (node: GraphNode | null, position?: { x: number; y: number }) => void;
}

// ─── Inner Component (has access to sigma context) ──────

function GraphEvents({ data, onNodeClick, onNodeHover }: GlobalMapViewProps) {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const setSettings = useSetSettings();

  // Track hovered node for highlighting
  const hoveredNodeRef = useRef<string | null>(null);

  useEffect(() => {
    registerEvents({
      clickNode: (event) => {
        onNodeClick?.(event.node);
      },
      enterNode: (event) => {
        hoveredNodeRef.current = event.node;
        const nodeData = extractNodeData(sigma.getGraph(), event.node);
        // Get screen position from sigma's node display data
        const nodeDisplayData = sigma.getNodeDisplayData(event.node);
        if (nodeDisplayData) {
          const viewPos = sigma.graphToViewport({ x: nodeDisplayData.x, y: nodeDisplayData.y });
          onNodeHover?.(nodeData, { x: viewPos.x, y: viewPos.y });
        } else {
          onNodeHover?.(nodeData);
        }

        // Highlight: dim other nodes
        setSettings({
          nodeReducer: (node, attrs) => {
            const graph = sigma.getGraph();
            if (node === event.node || graph.areNeighbors(node, event.node)) {
              return { ...attrs, zIndex: 1 };
            }
            return { ...attrs, color: '#2a2a4a', label: '', zIndex: 0 };
          },
          edgeReducer: (edge, attrs) => {
            const graph = sigma.getGraph();
            const src = graph.source(edge);
            const tgt = graph.target(edge);
            if (src === event.node || tgt === event.node) {
              return { ...attrs, color: EDGE_HIGHLIGHT_COLOR, size: Math.max(attrs.size as number, 2), zIndex: 1 };
            }
            return { ...attrs, color: EDGE_DIM_COLOR, zIndex: 0 };
          },
        });
      },
      leaveNode: () => {
        hoveredNodeRef.current = null;
        onNodeHover?.(null);
        // Reset highlighting
        setSettings({
          nodeReducer: undefined,
          edgeReducer: undefined,
        });
      },
    });
  }, [registerEvents, sigma, setSettings, onNodeClick, onNodeHover]);

  return null;
}

// ─── Main Component ─────────────────────────────────────

export function GlobalMapView({ data, onNodeClick, onNodeHover }: GlobalMapViewProps) {
  // Build and layout graph from data
  const graph = useMemo(() => {
    if (!data || data.nodes.length === 0) return null;
    const g = buildGraph(data);
    applyLayout(g, { viewMode: 'global' });
    return g;
  }, [data]);

  if (!graph || graph.order === 0) {
    return (
      <div className="graph-empty-state">
        <div className="graph-empty-icon">🕸️</div>
        <p>No memory nodes yet. Start a conversation to build the memory graph.</p>
      </div>
    );
  }

  return (
    <SigmaContainer
      graph={graph}
      className="sigma-container"
      settings={{
        // Performance: only render labels for nodes above this threshold
        labelRenderedSizeThreshold: 8,
        // LOD: reduce label density
        labelDensity: 0.07,
        labelGridCellSize: 60,
        // Edge rendering
        renderEdgeLabels: false,
        enableEdgeEvents: false,
        // Node rendering
        defaultNodeType: 'circle',
        // Zoom settings
        minCameraRatio: 0.02,
        maxCameraRatio: 10,
        // Performance for large graphs
        zIndex: true,
        // Appearance
        labelFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
        labelSize: 12,
        labelColor: { color: '#e0e0e0' },
        defaultEdgeType: 'line',
        stagePadding: 40,
      }}
    >
      <GraphEvents
        data={data}
        onNodeClick={onNodeClick}
        onNodeHover={onNodeHover}
      />
      <LayoutControls viewMode="global" />
    </SigmaContainer>
  );
}
