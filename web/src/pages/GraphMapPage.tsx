/**
 * GraphMapPage — Full-page graph visualization of the memory knowledge graph.
 *
 * Uses @react-sigma/core for proper React lifecycle management with sigma.js v3:
 *   - SigmaContainer manages WebGL renderer lifecycle
 *   - graphology Graph built in useMemo, passed to SigmaContainer
 *   - ForceAtlas2 applied at build time (synchronous)
 *   - Zoom/label/relayout controls via sigma camera API
 *   - Filter sidebar: maxNodes, minWeight, hubsOnly
 *   - Click-to-select → node detail sidebar
 *   - Hover → floating tooltip
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  SigmaContainer,
  useRegisterEvents,
  useSigma,
  useSetSettings,
  useCamera,
} from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';

import { useGraphData, type GraphNode } from '../hooks/useGraphData';
import { buildGraph, applyLayout, extractNodeData } from '../components/graph/graphUtils';
import { LayoutControls } from '../components/graph/LayoutControls';
import {
  NODE_TYPE_COLORS,
  NODE_TYPE_PALETTES,
  NODE_ROLE_PALETTES,
  EDGE_HIGHLIGHT_COLOR,
  EDGE_DIM_COLOR,
} from '../config/node-colors';
import { NodeTooltip } from '../components/graph/NodeTooltip';

// ─── Props ──────────────────────────────────────────────────

interface GraphMapPageProps {
  /** Navigate back to chat */
  onNavigateToChat?: () => void;
  /** Navigate to memory explorer */
  onNavigateToExplorer?: () => void;
}

// ─── Sigma Events Inner Component ───────────────────────────
// Must be rendered inside SigmaContainer to access sigma context

interface SigmaEventsProps {
  onNodeClick: (nodeId: string) => void;
  onNodeHover: (node: GraphNode | null, position?: { x: number; y: number }) => void;
}

function SigmaEvents({ onNodeClick, onNodeHover }: SigmaEventsProps) {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const setSettings = useSetSettings();

  useEffect(() => {
    registerEvents({
      clickNode: (event) => {
        onNodeClick(event.node);
      },
      clickStage: () => {
        onNodeClick('');
      },
      enterNode: (event) => {
        const nodeData = extractNodeData(sigma.getGraph(), event.node);
        const displayData = sigma.getNodeDisplayData(event.node);
        if (displayData && nodeData) {
          const viewPos = sigma.graphToViewport({ x: displayData.x, y: displayData.y });
          onNodeHover(nodeData, { x: viewPos.x, y: viewPos.y });
        } else {
          onNodeHover(nodeData);
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
        onNodeHover(null);
        setSettings({
          nodeReducer: undefined,
          edgeReducer: undefined,
        });
      },
    });
  }, [registerEvents, sigma, setSettings, onNodeClick, onNodeHover]);

  return null;
}

// ─── Zoom/Camera Controls (inside SigmaContainer) ───────────

function CameraControls({
  showLabels,
  onToggleLabels,
}: {
  showLabels: boolean;
  onToggleLabels: () => void;
}) {
  const sigma = useSigma();
  const setSettings = useSetSettings();

  const handleZoomIn = useCallback(() => {
    const camera = sigma.getCamera();
    camera.animatedZoom({ duration: 300 });
  }, [sigma]);

  const handleZoomOut = useCallback(() => {
    const camera = sigma.getCamera();
    camera.animatedUnzoom({ duration: 300 });
  }, [sigma]);

  const handleReset = useCallback(() => {
    const camera = sigma.getCamera();
    camera.animatedReset({ duration: 300 });
  }, [sigma]);

  // Sync label visibility
  useEffect(() => {
    setSettings({ renderLabels: showLabels });
  }, [showLabels, setSettings]);

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

// ─── Highlighted Node Focus (inside SigmaContainer) ─────────

function NodeFocuser({ nodeId }: { nodeId: string | null }) {
  const sigma = useSigma();

  useEffect(() => {
    if (!nodeId) return;
    const graph = sigma.getGraph();
    if (!graph.hasNode(nodeId)) return;

    const attrs = graph.getNodeAttributes(nodeId);
    const camera = sigma.getCamera();
    camera.animate({ x: attrs.x, y: attrs.y, ratio: 0.2 }, { duration: 500 });
  }, [nodeId, sigma]);

  return null;
}

// ─── Main Page Component ─────────────────────────────────────

export function GraphMapPage({ onNavigateToChat, onNavigateToExplorer }: GraphMapPageProps) {
  const { graphData, stats, isLoading, error, fetchGlobalMap, fetchStats } = useGraphData();

  const [maxNodes, setMaxNodes] = useState(2000);
  const [minWeight, setMinWeight] = useState(0);
  const [hubsOnly, setHubsOnly] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeInfo, setSelectedNodeInfo] = useState<{
    label: string;
    nodeType: string | null;
    nodeRole: string;
    activationCount: number;
    keywords: string;
    edgeCount: number;
  } | null>(null);
  const [tooltipData, setTooltipData] = useState<{
    node: GraphNode;
    position: { x: number; y: number };
  } | null>(null);

  // Build graphology Graph from API data
  const graph = useMemo(() => {
    if (!graphData || graphData.nodes.length === 0) return null;
    const g = buildGraph(graphData);
    applyLayout(g, { viewMode: 'global' });
    return g;
  }, [graphData]);

  // Fetch on mount
  useEffect(() => {
    fetchGlobalMap({ maxNodes, minWeight, hubsOnly });
    fetchStats();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = useCallback(() => {
    fetchGlobalMap({ maxNodes, minWeight, hubsOnly });
    fetchStats();
  }, [fetchGlobalMap, fetchStats, maxNodes, minWeight, hubsOnly]);

  const handleApplyFilters = useCallback(() => {
    fetchGlobalMap({ maxNodes, minWeight, hubsOnly });
  }, [fetchGlobalMap, maxNodes, minWeight, hubsOnly]);

  const handleNodeClick = useCallback((nodeId: string) => {
    if (!nodeId) {
      setSelectedNodeId(null);
      setSelectedNodeInfo(null);
      return;
    }
    setSelectedNodeId(nodeId);

    if (graphData) {
      const node = graphData.nodes.find(n => n.id === nodeId);
      if (node) {
        const edgeCount = graphData.edges.filter(
          e => e.source === nodeId || e.target === nodeId
        ).length;
        setSelectedNodeInfo({
          label: node.label,
          nodeType: node.nodeType,
          nodeRole: node.nodeRole,
          activationCount: node.activationCount,
          keywords: node.keywords,
          edgeCount,
        });
      }
    }
  }, [graphData]);

  const handleNodeHover = useCallback((node: GraphNode | null, position?: { x: number; y: number }) => {
    if (!node || !position) {
      setTooltipData(null);
      return;
    }
    setTooltipData({ node, position });
  }, []);

  const handleToggleLabels = useCallback(() => {
    setShowLabels(prev => !prev);
  }, []);

  const nodeCount = graphData?.nodes.length ?? 0;
  const edgeCount = graphData?.edges.length ?? 0;
  const isSampled = graphData?.sampled ?? false;
  const totalNodes = graphData?.totalNodes ?? 0;

  // Sigma settings
  const sigmaSettings = useMemo(() => ({
    renderLabels: showLabels,
    renderEdgeLabels: false,
    enableEdgeEvents: false,
    labelFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
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
    stagePadding: 40,
    allowInvalidContainer: true,
  }), [showLabels]);

  return (
    <div className="gmp-container">
      {/* Header */}
      <header className="gmp-header">
        <div className="gmp-header-left">
          {onNavigateToChat && (
            <button className="btn-back-to-chat" onClick={onNavigateToChat} title="Back to Chat">
              ◀ Chat
            </button>
          )}
          <h1 className="app-title">🕸️ Knowledge Graph</h1>
          {stats && (
            <span className="gmp-header-stats">
              {stats.totalNodes.toLocaleString()} nodes · {stats.totalEdges.toLocaleString()} edges
            </span>
          )}
        </div>
        <div className="gmp-header-right">
          {onNavigateToExplorer && (
            <button className="btn btn-nav" onClick={onNavigateToExplorer} title="Memory Explorer">
              📋 Explorer
            </button>
          )}
          <button className="btn btn-refresh" onClick={handleRefresh} title="Refresh Graph">
            ↻ Refresh
          </button>
        </div>
      </header>

      {/* Main body */}
      <div className="gmp-body">
        {/* Filter sidebar */}
        <div className="gmp-sidebar">
          <div className="gmp-filter-section">
            <h3 className="gmp-filter-title">Display</h3>

            <label className="gmp-filter-label">
              Max Nodes
              <span className="gmp-filter-value">{maxNodes.toLocaleString()}</span>
            </label>
            <input
              type="range"
              min={100}
              max={10000}
              step={100}
              value={maxNodes}
              onChange={e => setMaxNodes(Number(e.target.value))}
              className="gmp-slider"
            />

            <label className="gmp-filter-label">
              Min Weight
              <span className="gmp-filter-value">{minWeight}</span>
            </label>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={minWeight}
              onChange={e => setMinWeight(Number(e.target.value))}
              className="gmp-slider"
            />

            <label className="gmp-filter-checkbox">
              <input
                type="checkbox"
                checked={hubsOnly}
                onChange={e => setHubsOnly(e.target.checked)}
              />
              Hubs only
            </label>

            <button className="btn btn-apply" onClick={handleApplyFilters}>
              Apply Filters
            </button>
          </div>

          {/* Type distribution from stats */}
          {stats && (
            <div className="gmp-filter-section">
              <h3 className="gmp-filter-title">Distribution</h3>
              <div className="gmp-dist-list">
                {Object.entries(stats.byType).map(([type, count]) => (
                  <div key={type} className="gmp-dist-item">
                    <span
                      className="gmp-dist-dot"
                      style={{ background: NODE_TYPE_COLORS[type] || '#888' }}
                    />
                    <span className="gmp-dist-label">{type === 'null' ? 'untyped' : type}</span>
                    <span className="gmp-dist-count">{count}</span>
                  </div>
                ))}
                <div className="gmp-dist-divider" />
                <div className="gmp-dist-item">
                  <span className="gmp-dist-dot" style={{ background: '#6c5ce7' }} />
                  <span className="gmp-dist-label">hub</span>
                  <span className="gmp-dist-count">{stats.byRole.hub}</span>
                </div>
                <div className="gmp-dist-item">
                  <span className="gmp-dist-dot" style={{ background: '#00cec9' }} />
                  <span className="gmp-dist-label">leaf</span>
                  <span className="gmp-dist-count">{stats.byRole.leaf}</span>
                </div>
              </div>
            </div>
          )}

          {/* Legend */}
          <div className="gmp-filter-section">
            <h3 className="gmp-filter-title">Legend</h3>
            <div className="gmp-dist-list">
              {Object.entries(NODE_TYPE_PALETTES)
                .filter(([key]) => key !== 'null')
                .map(([type, palette]) => (
                  <div key={type} className="gmp-dist-item">
                    <span className="gmp-dist-dot" style={{ background: palette.base }} />
                    <span className="gmp-dist-label">{palette.icon} {type}</span>
                  </div>
                ))}
              <div className="gmp-dist-divider" />
              <div className="gmp-dist-item">
                <span className="gmp-dist-dot" style={{ background: NODE_ROLE_PALETTES.hub.base, border: `2px solid ${NODE_ROLE_PALETTES.hub.border}` }} />
                <span className="gmp-dist-label">{NODE_ROLE_PALETTES.hub.icon} hub (larger)</span>
              </div>
              <div className="gmp-dist-item">
                <span className="gmp-dist-dot" style={{ background: NODE_ROLE_PALETTES.leaf.base }} />
                <span className="gmp-dist-label">{NODE_ROLE_PALETTES.leaf.icon} leaf</span>
              </div>
            </div>
          </div>

          {/* Selected node info */}
          {selectedNodeInfo && (
            <div className="gmp-filter-section gmp-selection">
              <h3 className="gmp-filter-title">Selected Node</h3>
              <div className="gmp-sel-label">{selectedNodeInfo.label}</div>
              <div className="gmp-sel-meta">
                <span className="gmp-sel-badge" style={{
                  background: (NODE_TYPE_COLORS[selectedNodeInfo.nodeType || ''] || '#888') + '33',
                  color: NODE_TYPE_COLORS[selectedNodeInfo.nodeType || ''] || '#888',
                }}>
                  {selectedNodeInfo.nodeType || 'untyped'}
                </span>
                <span className="gmp-sel-badge" style={{
                  background: selectedNodeInfo.nodeRole === 'hub' ? '#6c5ce733' : '#00cec933',
                  color: selectedNodeInfo.nodeRole === 'hub' ? '#6c5ce7' : '#00cec9',
                }}>
                  {selectedNodeInfo.nodeRole}
                </span>
              </div>
              <div className="gmp-sel-stats">
                <div>⚡ {selectedNodeInfo.activationCount} activations</div>
                <div>🔗 {selectedNodeInfo.edgeCount} connections</div>
              </div>
              {selectedNodeInfo.keywords && (
                <div className="gmp-sel-keywords">
                  {selectedNodeInfo.keywords.split(',').slice(0, 8).map((k, i) => (
                    <span key={i} className="gmp-sel-kw">{k.trim()}</span>
                  ))}
                </div>
              )}
              <button
                className="btn btn-clear-selection"
                onClick={() => { setSelectedNodeId(null); setSelectedNodeInfo(null); }}
              >
                Clear Selection
              </button>
            </div>
          )}
        </div>

        {/* Graph view area */}
        <div className="gmp-graph-area">
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

          {/* Sigma graph (only render when we have a valid graph) */}
          {graph && graph.order > 0 && (
            <SigmaContainer
              graph={graph}
              settings={sigmaSettings}
              style={{ width: '100%', height: '100%', background: '#0d0d1a' }}
              className="sigma-container"
            >
              <SigmaEvents
                onNodeClick={handleNodeClick}
                onNodeHover={handleNodeHover}
              />
              <CameraControls
                showLabels={showLabels}
                onToggleLabels={handleToggleLabels}
              />
              <LayoutControls viewMode="global" />
              <NodeFocuser nodeId={selectedNodeId} />
            </SigmaContainer>
          )}

          {/* Stats bar */}
          {nodeCount > 0 && (
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
          )}

          {/* Tooltip */}
          {tooltipData && (
            <NodeTooltip
              node={tooltipData.node}
              position={tooltipData.position}
            />
          )}
        </div>
      </div>
    </div>
  );
}
