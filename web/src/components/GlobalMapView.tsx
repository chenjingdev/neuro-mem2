/**
 * GlobalMapView — sigma.js WebGL-based global memory graph visualization.
 *
 * Now uses @react-sigma/core SigmaContainer for proper React lifecycle management.
 * Renders MemoryNodes as an interactive graph:
 *   - WebGL renderer via sigma.js for high-performance rendering
 *   - Node size = degree-based (hub nodes are larger) + activation boost
 *   - Node color = nodeType color mapping (semantic=blue, episodic=red, etc.)
 *   - Edge thickness/opacity = weight-based
 *   - ForceAtlas2 layout for organic clustering
 *   - Zoom, pan, hover tooltips, click-to-select
 *   - Controls: zoom in/out, reset, toggle labels
 */

import { useEffect, useMemo, useCallback, useState } from 'react';
import {
  SigmaContainer,
  useRegisterEvents,
  useSigma,
  useSetSettings,
} from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';

import type { GraphData, GraphNode } from '../hooks/useGraphData';
import { buildGraph, applyLayout, extractNodeData } from './graph/graphUtils';
import {
  NODE_TYPE_PALETTES,
  NODE_ROLE_PALETTES,
  EDGE_HIGHLIGHT_COLOR,
  EDGE_DIM_COLOR,
} from '../config/node-colors';

// ─── Props ──────────────────────────────────────────────────

export interface GlobalMapViewProps {
  /** Graph data from API */
  graphData: GraphData | null;
  /** Whether data is loading */
  isLoading?: boolean;
  /** Error message */
  error?: string | null;
  /** Callback when a node is clicked */
  onNodeClick?: (nodeId: string) => void;
  /** Callback when a node is hovered */
  onNodeHover?: (nodeId: string | null) => void;
  /** Currently highlighted node ID (from external selection) */
  highlightedNodeId?: string | null;
  /** Container CSS class */
  className?: string;
}

// ─── Inner Events Component ─────────────────────────────────

interface InnerEventsProps {
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onTooltipChange: (data: { x: number; y: number; node: GraphNode } | null) => void;
}

function InnerEvents({ onNodeClick, onNodeHover, onTooltipChange }: InnerEventsProps) {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const setSettings = useSetSettings();

  useEffect(() => {
    registerEvents({
      clickNode: (event) => {
        onNodeClick?.(event.node);
      },
      clickStage: () => {
        onNodeClick?.('');
      },
      enterNode: (event) => {
        onNodeHover?.(event.node);

        const nodeData = extractNodeData(sigma.getGraph(), event.node);
        const displayData = sigma.getNodeDisplayData(event.node);
        if (displayData && nodeData) {
          const viewPos = sigma.graphToViewport({ x: displayData.x, y: displayData.y });
          onTooltipChange({ x: viewPos.x, y: viewPos.y, node: nodeData });
        }

        // Highlight: dim non-neighbors
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
        onNodeHover?.(null);
        onTooltipChange(null);
        setSettings({
          nodeReducer: undefined,
          edgeReducer: undefined,
        });
      },
    });
  }, [registerEvents, sigma, setSettings, onNodeClick, onNodeHover, onTooltipChange]);

  return null;
}

// ─── Zoom Controls (inside SigmaContainer) ──────────────────

function ZoomControls({ showLabels, onToggleLabels }: {
  showLabels: boolean;
  onToggleLabels: () => void;
}) {
  const sigma = useSigma();
  const setSettings = useSetSettings();

  useEffect(() => {
    setSettings({ renderLabels: showLabels });
  }, [showLabels, setSettings]);

  const handleZoomIn = useCallback(() => {
    sigma.getCamera().animatedZoom({ duration: 300 });
  }, [sigma]);

  const handleZoomOut = useCallback(() => {
    sigma.getCamera().animatedUnzoom({ duration: 300 });
  }, [sigma]);

  const handleReset = useCallback(() => {
    sigma.getCamera().animatedReset({ duration: 300 });
  }, [sigma]);

  return (
    <div className="gmv-controls">
      <button className="gmv-ctrl-btn" onClick={handleZoomIn} title="Zoom In">+</button>
      <button className="gmv-ctrl-btn" onClick={handleZoomOut} title="Zoom Out">−</button>
      <button className="gmv-ctrl-btn" onClick={handleReset} title="Reset View">⟲</button>
      <div className="gmv-ctrl-divider" />
      <button
        className={`gmv-ctrl-btn ${showLabels ? 'gmv-ctrl-active' : ''}`}
        onClick={onToggleLabels}
        title={showLabels ? 'Hide Labels' : 'Show Labels'}
      >
        Aa
      </button>
    </div>
  );
}

// ─── Highlighted Node Focuser (inside SigmaContainer) ───────

function HighlightFocuser({ nodeId }: { nodeId: string | null | undefined }) {
  const sigma = useSigma();
  const setSettings = useSetSettings();

  useEffect(() => {
    if (!nodeId) {
      setSettings({ nodeReducer: undefined, edgeReducer: undefined });
      return;
    }

    const graph = sigma.getGraph();
    if (!graph.hasNode(nodeId)) return;

    // Focus camera on highlighted node
    const attrs = graph.getNodeAttributes(nodeId);
    sigma.getCamera().animate({ x: attrs.x, y: attrs.y, ratio: 0.2 }, { duration: 500 });
  }, [nodeId, sigma, setSettings]);

  return null;
}

// ─── Component ──────────────────────────────────────────────

export function GlobalMapView({
  graphData,
  isLoading,
  error,
  onNodeClick,
  onNodeHover,
  highlightedNodeId,
  className,
}: GlobalMapViewProps) {
  const [showLabels, setShowLabels] = useState(true);
  const [tooltipData, setTooltipData] = useState<{
    x: number;
    y: number;
    node: GraphNode;
  } | null>(null);

  // Build graphology graph from data
  const graph = useMemo(() => {
    if (!graphData || graphData.nodes.length === 0) return null;
    const g = buildGraph(graphData);
    applyLayout(g, { viewMode: 'global' });
    return g;
  }, [graphData]);

  const handleToggleLabels = useCallback(() => {
    setShowLabels(prev => !prev);
  }, []);

  const sigmaSettings = useMemo(() => ({
    renderLabels: showLabels,
    renderEdgeLabels: false,
    enableEdgeEvents: false,
    labelFont: 'monospace',
    labelSize: 12,
    labelColor: { color: '#e0e0e0' },
    labelRenderedSizeThreshold: 8,
    labelDensity: 0.07,
    labelGridCellSize: 60,
    defaultNodeType: 'circle' as const,
    defaultEdgeType: 'line' as const,
    minCameraRatio: 0.01,
    maxCameraRatio: 10,
    zIndex: true,
    allowInvalidContainer: true,
    stagePadding: 40,
  }), [showLabels]);

  const nodeCount = graphData?.nodes.length ?? 0;
  const edgeCount = graphData?.edges.length ?? 0;
  const totalNodes = graphData?.totalNodes ?? 0;
  const isSampled = graphData?.sampled ?? false;

  const getNodeColor = useCallback((node: GraphNode): string => {
    if (node.nodeType && NODE_TYPE_PALETTES[node.nodeType]) {
      return NODE_TYPE_PALETTES[node.nodeType].base;
    }
    if (node.nodeRole === 'hub') return NODE_ROLE_PALETTES.hub.base;
    return NODE_TYPE_PALETTES.null.base;
  }, []);

  return (
    <div className={`gmv-container ${className || ''}`}>
      {/* Loading overlay */}
      {isLoading && (
        <div className="gmv-overlay">
          <div className="gmv-loading">
            <span className="gmv-spinner" />
            Loading graph data...
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && !isLoading && (
        <div className="gmv-overlay">
          <div className="gmv-error">
            <span>⚠️</span> {error}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && nodeCount === 0 && (
        <div className="gmv-overlay">
          <div className="gmv-empty">
            <span className="gmv-empty-icon">🕸️</span>
            <p>No memory nodes yet</p>
            <p className="gmv-empty-hint">Start a conversation to build the knowledge graph</p>
          </div>
        </div>
      )}

      {/* Sigma graph */}
      {graph && graph.order > 0 && (
        <SigmaContainer
          graph={graph}
          settings={sigmaSettings}
          style={{ width: '100%', height: '100%', background: '#0d0d1a' }}
          className="sigma-container"
        >
          <InnerEvents
            onNodeClick={onNodeClick}
            onNodeHover={onNodeHover}
            onTooltipChange={setTooltipData}
          />
          <ZoomControls
            showLabels={showLabels}
            onToggleLabels={handleToggleLabels}
          />
          <HighlightFocuser nodeId={highlightedNodeId} />
        </SigmaContainer>
      )}

      {/* Stats bar */}
      <div className="gmv-stats">
        <span className="gmv-stats-item">
          <strong>{nodeCount.toLocaleString()}</strong> nodes
          {isSampled && (
            <span className="gmv-stats-sampled"> / {totalNodes.toLocaleString()} total</span>
          )}
        </span>
        <span className="gmv-stats-sep">·</span>
        <span className="gmv-stats-item">
          <strong>{edgeCount.toLocaleString()}</strong> edges
        </span>
      </div>

      {/* Legend */}
      <div className="gmv-legend">
        <div className="gmv-legend-title">Node Types</div>
        <div className="gmv-legend-items">
          {Object.entries(NODE_TYPE_PALETTES)
            .filter(([key]) => key !== 'null')
            .map(([type, palette]) => (
              <div key={type} className="gmv-legend-item">
                <span className="gmv-legend-dot" style={{ background: palette.base }} />
                <span>{type}</span>
              </div>
            ))}
        </div>
        <div className="gmv-legend-title" style={{ marginTop: 6 }}>Roles</div>
        <div className="gmv-legend-items">
          <div className="gmv-legend-item">
            <span className="gmv-legend-dot gmv-legend-dot-hub" style={{ background: NODE_ROLE_PALETTES.hub.base }} />
            <span>hub (larger)</span>
          </div>
          <div className="gmv-legend-item">
            <span className="gmv-legend-dot" style={{ background: NODE_ROLE_PALETTES.leaf.base }} />
            <span>leaf</span>
          </div>
        </div>
      </div>

      {/* Tooltip */}
      {tooltipData && (
        <div
          className="gmv-tooltip"
          style={{
            left: tooltipData.x + 12,
            top: tooltipData.y - 12,
          }}
        >
          <div className="gmv-tooltip-label">{tooltipData.node.label}</div>
          <div className="gmv-tooltip-meta">
            <span
              className="gmv-tooltip-badge"
              style={{ background: getNodeColor(tooltipData.node) + '33', color: getNodeColor(tooltipData.node) }}
            >
              {tooltipData.node.nodeType || 'untyped'}
            </span>
            <span
              className="gmv-tooltip-badge"
              style={{
                background: NODE_ROLE_PALETTES[tooltipData.node.nodeRole]?.base + '33' || '#88888833',
                color: NODE_ROLE_PALETTES[tooltipData.node.nodeRole]?.base || '#888',
              }}
            >
              {tooltipData.node.nodeRole}
            </span>
          </div>
          <div className="gmv-tooltip-info">
            ⚡ {tooltipData.node.activationCount} activations
          </div>
          {tooltipData.node.keywords && (
            <div className="gmv-tooltip-keywords">
              {tooltipData.node.keywords.split(',').slice(0, 5).map((k, i) => (
                <span key={i} className="gmv-tooltip-kw">{k.trim()}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
