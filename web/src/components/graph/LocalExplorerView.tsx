/**
 * LocalExplorerView — ego-network visualization centered on a selected node.
 *
 * Shows the BFS neighborhood of a center node:
 * - Center node highlighted and positioned centrally
 * - Neighbors arranged by ForceAtlas2 with gravity toward center
 * - Click neighbor → re-centers on that node (parent handles)
 * - Different visual treatment for center vs. neighbors
 *
 * Performance: typically <500 nodes in local view,
 * so rendering is fast even with full labels.
 */

import { useEffect, useRef, useMemo } from 'react';
import {
  SigmaContainer,
  useRegisterEvents,
  useSigma,
  useSetSettings,
  useCamera,
} from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';

import { buildGraph, applyLayout, extractNodeData } from './graphUtils';
import { LayoutControls } from './LayoutControls';
import { EDGE_HIGHLIGHT_COLOR, EDGE_DIM_COLOR, EDGE_HUB_COLOR } from '../../config/node-colors';
import type { GraphData, GraphNode } from '../../hooks/useGraphData';

// ─── Props ──────────────────────────────────────────────

interface LocalExplorerViewProps {
  data: GraphData;
  centerNodeId: string;
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (node: GraphNode | null, position?: { x: number; y: number }) => void;
}

// ─── Inner Component ────────────────────────────────────

function LocalGraphEvents({ data, centerNodeId, onNodeClick, onNodeHover }: LocalExplorerViewProps) {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const setSettings = useSetSettings();
  const { gotoNode } = useCamera();

  const hoveredRef = useRef<string | null>(null);

  // Center camera on the center node after layout
  useEffect(() => {
    const graph = sigma.getGraph();
    if (graph.hasNode(centerNodeId)) {
      // Slight delay to let sigma render
      requestAnimationFrame(() => {
        gotoNode(centerNodeId, { duration: 300 });
      });
    }
  }, [centerNodeId, sigma, gotoNode]);

  // Apply persistent styling: center node gets a ring effect via size boost
  useEffect(() => {
    setSettings({
      nodeReducer: (node, attrs) => {
        if (node === centerNodeId) {
          return {
            ...attrs,
            size: (attrs.size as number) * 1.5,
            borderColor: '#ffffff',
            borderSize: 3,
            zIndex: 2,
            forceLabel: true,
          };
        }
        if (hoveredRef.current) {
          const graph = sigma.getGraph();
          if (node === hoveredRef.current ||
              graph.hasEdge(node, hoveredRef.current) ||
              graph.hasEdge(hoveredRef.current, node)) {
            return { ...attrs, zIndex: 1 };
          }
          return { ...attrs, color: '#2a2a4a', label: '', zIndex: 0 };
        }
        return attrs;
      },
      edgeReducer: (edge, attrs) => {
        if (!hoveredRef.current) {
          // Default: highlight edges to center
          const graph = sigma.getGraph();
          const src = graph.source(edge);
          const tgt = graph.target(edge);
          if (src === centerNodeId || tgt === centerNodeId) {
            return { ...attrs, color: EDGE_HUB_COLOR, size: Math.max(attrs.size as number, 1.5) };
          }
          return attrs;
        }

        const graph = sigma.getGraph();
        const src = graph.source(edge);
        const tgt = graph.target(edge);
        if (src === hoveredRef.current || tgt === hoveredRef.current) {
          return { ...attrs, color: EDGE_HIGHLIGHT_COLOR, size: Math.max(attrs.size as number, 2), zIndex: 1 };
        }
        return { ...attrs, color: EDGE_DIM_COLOR, zIndex: 0 };
      },
    });
  }, [centerNodeId, sigma, setSettings]);

  useEffect(() => {
    registerEvents({
      clickNode: (event) => {
        onNodeClick?.(event.node);
      },
      enterNode: (event) => {
        hoveredRef.current = event.node;
        const nodeData = extractNodeData(sigma.getGraph(), event.node);
        const displayData = sigma.getNodeDisplayData(event.node);
        if (displayData) {
          const viewPos = sigma.graphToViewport({ x: displayData.x, y: displayData.y });
          onNodeHover?.(nodeData, { x: viewPos.x, y: viewPos.y });
        } else {
          onNodeHover?.(nodeData);
        }
        // Trigger re-render of reducers
        sigma.refresh();
      },
      leaveNode: () => {
        hoveredRef.current = null;
        onNodeHover?.(null);
        sigma.refresh();
      },
    });
  }, [registerEvents, sigma, onNodeClick, onNodeHover]);

  return null;
}

// ─── Main Component ─────────────────────────────────────

export function LocalExplorerView({ data, centerNodeId, onNodeClick, onNodeHover }: LocalExplorerViewProps) {
  const graph = useMemo(() => {
    if (!data || data.nodes.length === 0) return null;
    const g = buildGraph(data, centerNodeId);
    // Local view: stronger gravity, center node pinned at origin, strongGravityMode on
    applyLayout(g, {
      viewMode: 'local',
      centerNodeId,
      // Override iterations for local (typically <500 nodes, can afford more)
      iterations: data.nodes.length > 200 ? 80 : 120,
    });
    return g;
  }, [data, centerNodeId]);

  if (!graph || graph.order === 0) {
    return (
      <div className="graph-empty-state">
        <div className="graph-empty-icon">🔍</div>
        <p>No connections found for this node.</p>
      </div>
    );
  }

  return (
    <SigmaContainer
      graph={graph}
      className="sigma-container sigma-local"
      settings={{
        // Show all labels in local view (fewer nodes)
        labelRenderedSizeThreshold: 4,
        labelDensity: 0.15,
        labelGridCellSize: 40,
        renderEdgeLabels: false,
        enableEdgeEvents: false,
        defaultNodeType: 'circle',
        minCameraRatio: 0.1,
        maxCameraRatio: 5,
        zIndex: true,
        labelFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
        labelSize: 13,
        labelColor: { color: '#e0e0e0' },
        defaultEdgeType: 'line',
        stagePadding: 60,
      }}
    >
      <LocalGraphEvents
        data={data}
        centerNodeId={centerNodeId}
        onNodeClick={onNodeClick}
        onNodeHover={onNodeHover}
      />
      <LayoutControls viewMode="local" centerNodeId={centerNodeId} />
    </SigmaContainer>
  );
}
