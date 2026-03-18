/**
 * GraphExplorerPage — Dual-mode graph visualization page.
 *
 * Two interconnected views:
 *   1. Global Map — sigma.js WebGL rendering of sampled entire graph
 *      - Hubs prioritized, top-activated leaves fill remainder
 *      - Server-side sampling for 수십만 nodes support
 *      - Click node → enters local explorer centered on that node
 *
 *   2. Local Explorer — ego-network BFS around a center node
 *      - Click neighbor → re-centers on that node
 *      - "Back to Map" → returns to global view
 *      - Navigation history with back button
 *
 * Performance (LOD/Virtualization):
 *   - sigma.js WebGL handles 10k+ nodes natively
 *   - Server-side sampling: maxNodes cap with priority ranking
 *   - LOD labels: labelRenderedSizeThreshold controls label visibility on zoom
 *   - Edge filtering by minimum weight
 *   - Barnes-Hut ForceAtlas2 for large graphs (>500 nodes)
 *   - Progressive detail: L0 only for graph display, full detail on click
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import Graph from 'graphology';
import {
  SigmaContainer,
  useRegisterEvents,
  useSigma,
  useSetSettings,
  useCamera,
} from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import { useGraphData, type GraphData, type GraphNode } from '../hooks/useGraphData';
import { NODE_TYPE_COLORS, NODE_ROLE_COLORS } from '../types/memory-node';
import { applyLayout, getLayoutParams, type FA2LayoutOptions } from '../components/graph/graphUtils';
import { LayoutControls } from '../components/graph/LayoutControls';
import { DeepKGraphView } from '../components/graph/DeepKGraphView';
import type { MemoryNodeType, MemoryNodeRole } from '../types/memory-node';

// ─── Types & Constants ────────────────────────────────────

type ViewMode = 'global' | 'local' | 'deepk';

interface GraphExplorerPageProps {
  onNavigateToChat?: () => void;
  onNavigateToExplorer?: () => void;
  initialNodeId?: string;
}

// ─── Graph Building Utilities ─────────────────────────────

function getNodeColor(nodeType: string | null, nodeRole: string): string {
  if (nodeRole === 'hub') return NODE_ROLE_COLORS.hub ?? '#6c5ce7';
  if (nodeType && NODE_TYPE_COLORS[nodeType]) return NODE_TYPE_COLORS[nodeType];
  return '#00cec9';
}

function getNodeSize(activationCount: number, isHub: boolean, isCenter: boolean): number {
  if (isCenter) return 18;
  const base = isHub ? 10 : 5;
  return Math.min(20, base + Math.log2(1 + activationCount) * 1.5);
}

function buildGraphology(data: GraphData, centerNodeId?: string): Graph {
  const graph = new Graph({ multi: false, type: 'undirected' });
  const n = data.nodes.length;
  const spread = Math.sqrt(n) * 12;

  for (const node of data.nodes) {
    const isCenter = node.id === centerNodeId;
    graph.addNode(node.id, {
      x: isCenter ? 0 : (Math.random() - 0.5) * spread,
      y: isCenter ? 0 : (Math.random() - 0.5) * spread,
      size: getNodeSize(node.activationCount, node.nodeRole === 'hub', isCenter),
      color: getNodeColor(node.nodeType, node.nodeRole),
      label: node.label.length > 50 ? node.label.slice(0, 47) + '...' : node.label,
      // Custom attrs for tooltip
      nodeType: node.nodeType,
      nodeRole: node.nodeRole,
      activationCount: node.activationCount,
      keywords: node.keywords,
      isCenter,
    });
  }

  for (const edge of data.edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    if (edge.source === edge.target) continue;
    try {
      if (!graph.hasEdge(edge.source, edge.target)) {
        graph.addEdge(edge.source, edge.target, {
          size: Math.max(0.5, Math.min(4, edge.weight / 25)),
          color: `rgba(74, 158, 255, ${Math.max(0.15, Math.min(0.85, edge.weight / 100))})`,
          weight: edge.weight,
        });
      }
    } catch { /* skip duplicate */ }
  }

  // Apply ForceAtlas2 layout with adaptive parameter tuning
  if (graph.order > 1) {
    applyLayout(graph, {
      viewMode: centerNodeId ? 'local' : 'global',
      centerNodeId,
    });
  }

  return graph;
}

// ─── Camera Controller ───────────────────────────────────
// Centers camera on center node in local view after graph load

function CameraController({ centerNodeId, isLocalView }: { centerNodeId?: string; isLocalView: boolean }) {
  const sigma = useSigma();
  const { gotoNode, reset } = useCamera();

  useEffect(() => {
    if (isLocalView && centerNodeId) {
      const graph = sigma.getGraph();
      if (graph.hasNode(centerNodeId)) {
        // Delay to let sigma render the new graph
        requestAnimationFrame(() => {
          gotoNode(centerNodeId, { duration: 300 });
        });
      }
    } else {
      // Global view: reset camera to show all nodes
      requestAnimationFrame(() => {
        reset({ duration: 300 });
      });
    }
  }, [centerNodeId, isLocalView, sigma, gotoNode, reset]);

  return null;
}

// ─── Sigma Events Component ──────────────────────────────

interface SigmaEventsProps {
  centerNodeId?: string;
  onNodeClick: (nodeId: string) => void;
  onTooltipUpdate: (info: TooltipInfo | null) => void;
  isLocalView: boolean;
}

function SigmaEvents({ centerNodeId, onNodeClick, onTooltipUpdate, isLocalView }: SigmaEventsProps) {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const setSettings = useSetSettings();
  const hoveredRef = useRef<string | null>(null);

  // Compute center-node reducers once for reuse
  const makeCenterReducers = useCallback(() => {
    if (!isLocalView || !centerNodeId) return { nodeReducer: undefined, edgeReducer: undefined };
    return {
      nodeReducer: (node: string, attrs: Record<string, unknown>) => {
        if (node === centerNodeId) {
          return { ...attrs, size: (attrs.size as number) * 1.3, zIndex: 2, forceLabel: true };
        }
        return attrs;
      },
      edgeReducer: (edge: string, attrs: Record<string, unknown>) => {
        const graph = sigma.getGraph();
        const [src, tgt] = graph.extremities(edge);
        if (src === centerNodeId || tgt === centerNodeId) {
          return { ...attrs, color: '#6c5ce7', size: Math.max(attrs.size as number, 1.5) };
        }
        return attrs;
      },
    };
  }, [isLocalView, centerNodeId, sigma]);

  useEffect(() => {
    registerEvents({
      clickNode: (event) => {
        onNodeClick(event.node);
      },
      enterNode: (event) => {
        hoveredRef.current = event.node;

        // Update tooltip with position from sigma
        const graph = sigma.getGraph();
        if (graph.hasNode(event.node)) {
          const attrs = graph.getNodeAttributes(event.node);
          const displayData = sigma.getNodeDisplayData(event.node);
          if (displayData) {
            const viewPos = sigma.graphToViewport({ x: displayData.x, y: displayData.y });
            onTooltipUpdate({
              nodeId: event.node,
              attrs,
              x: viewPos.x,
              y: viewPos.y,
            });
          }
        }

        // Highlight: dim non-neighbors
        const hovered = event.node;
        setSettings({
          nodeReducer: (node, attrs) => {
            const g = sigma.getGraph();
            if (node === hovered || g.areNeighbors(node, hovered)) {
              // Also boost center node in local view
              if (node === centerNodeId && isLocalView) {
                return { ...attrs, size: (attrs.size as number) * 1.3, zIndex: 2 };
              }
              return { ...attrs, zIndex: 1 };
            }
            return { ...attrs, color: '#2a2a4a', label: '', zIndex: 0 };
          },
          edgeReducer: (edge, attrs) => {
            const g = sigma.getGraph();
            const [src, tgt] = g.extremities(edge);
            if (src === hovered || tgt === hovered) {
              return { ...attrs, color: '#4a9eff', size: Math.max(attrs.size as number, 2), zIndex: 1 };
            }
            return { ...attrs, color: 'rgba(40,40,70,0.15)', zIndex: 0 };
          },
        });
      },
      leaveNode: () => {
        hoveredRef.current = null;
        onTooltipUpdate(null);

        // Restore: center-node highlighting in local view, or clear in global
        const reducers = makeCenterReducers();
        setSettings({
          nodeReducer: reducers.nodeReducer as any,
          edgeReducer: reducers.edgeReducer as any,
        });
      },
    });
  }, [registerEvents, sigma, setSettings, onNodeClick, onTooltipUpdate, centerNodeId, isLocalView, makeCenterReducers]);

  // Apply center-node styling on mount for local view
  useEffect(() => {
    const reducers = makeCenterReducers();
    setSettings({
      nodeReducer: reducers.nodeReducer as any,
      edgeReducer: reducers.edgeReducer as any,
    });
  }, [isLocalView, centerNodeId, makeCenterReducers, setSettings]);

  return null;
}

// ─── Tooltip Component ───────────────────────────────────

interface TooltipInfo {
  nodeId: string;
  attrs: Record<string, unknown>;
  x: number;
  y: number;
}

function GraphTooltip({ info }: { info: TooltipInfo | null }) {
  if (!info) return null;
  const { attrs, x, y } = info;
  const keywords = ((attrs.keywords as string) ?? '').split(' ').filter(Boolean).slice(0, 5);

  return (
    <div className="gep-tooltip" style={{ left: x + 15, top: y - 10 }}>
      <div className="gep-tooltip-label">{attrs.label as string}</div>
      <div className="gep-tooltip-meta">
        <span className={`gep-badge gep-badge-${attrs.nodeRole}`}>{attrs.nodeRole as string}</span>
        <span className={`gep-badge gep-badge-type-${attrs.nodeType ?? 'null'}`}>
          {(attrs.nodeType as string) ?? 'untyped'}
        </span>
        <span className="gep-tooltip-act">{attrs.activationCount as number} act</span>
      </div>
      {keywords.length > 0 && (
        <div className="gep-tooltip-kw">
          {keywords.map((kw, i) => <span key={i} className="gep-kw-tag">{kw}</span>)}
        </div>
      )}
      {Boolean(attrs.isCenter) && <div className="gep-tooltip-center">Center node</div>}
    </div>
  );
}

// ─── Controls Sidebar ────────────────────────────────────

interface ControlsProps {
  viewMode: ViewMode;
  maxNodes: number;
  minWeight: number;
  hops: number;
  hubsOnly: boolean;
  onMaxNodesChange: (v: number) => void;
  onMinWeightChange: (v: number) => void;
  onHopsChange: (v: number) => void;
  onHubsOnlyChange: (v: boolean) => void;
  onApply: () => void;
  stats: { totalNodes: number; totalEdges: number; byRole: { hub: number; leaf: number }; byType: Record<string, number> } | null;
  graphNodeCount: number;
  graphEdgeCount: number;
  sampled: boolean;
}

function GraphControls({
  viewMode, maxNodes, minWeight, hops, hubsOnly,
  onMaxNodesChange, onMinWeightChange, onHopsChange, onHubsOnlyChange,
  onApply, stats, graphNodeCount, graphEdgeCount, sampled,
}: ControlsProps) {
  return (
    <div className="gep-controls">
      <h3 className="gep-controls-title">Controls</h3>

      {/* View-specific controls */}
      {viewMode === 'global' && (
        <div className="gep-control-group">
          <label>
            Max Nodes <span className="gep-control-val">{maxNodes.toLocaleString()}</span>
          </label>
          <input type="range" min={100} max={10000} step={100} value={maxNodes}
            onChange={e => onMaxNodesChange(+e.target.value)} />
        </div>
      )}

      {viewMode === 'local' && (
        <div className="gep-control-group">
          <label>
            BFS Hops <span className="gep-control-val">{hops}</span>
          </label>
          <input type="range" min={1} max={4} step={1} value={hops}
            onChange={e => onHopsChange(+e.target.value)} />
        </div>
      )}

      <div className="gep-control-group">
        <label>
          Min Edge Weight <span className="gep-control-val">{minWeight}</span>
        </label>
        <input type="range" min={0} max={100} step={1} value={minWeight}
          onChange={e => onMinWeightChange(+e.target.value)} />
      </div>

      {viewMode === 'global' && (
        <div className="gep-control-group">
          <label className="gep-checkbox">
            <input type="checkbox" checked={hubsOnly} onChange={e => onHubsOnlyChange(e.target.checked)} />
            Hubs only
          </label>
        </div>
      )}

      <button className="gep-btn gep-btn-apply" onClick={onApply}>Apply</button>

      {/* Graph info */}
      <div className="gep-graph-info">
        <div className="gep-info-row">
          <span>Displayed</span>
          <span>{graphNodeCount} nodes / {graphEdgeCount} edges</span>
        </div>
        {sampled && <div className="gep-sampled-badge">Sampled view</div>}
      </div>

      {/* ForceAtlas2 Layout Info */}
      {graphNodeCount > 0 && (() => {
        const lp = getLayoutParams(graphNodeCount, viewMode === 'deepk' ? 'local' : viewMode);
        return (
          <div className="gep-layout-info">
            <h4>Layout (FA2)</h4>
            <div className="gep-info-row">
              <span>Tier</span>
              <span className="gep-tier-badge">{lp.tier}</span>
            </div>
            <div className="gep-info-row"><span>Iterations</span><span>{lp.iterations}</span></div>
            <div className="gep-info-row"><span>Gravity</span><span>{lp.gravity.toFixed(1)}</span></div>
            <div className="gep-info-row"><span>Scaling</span><span>{lp.scalingRatio.toFixed(1)}</span></div>
            <div className="gep-info-row"><span>Barnes-Hut</span><span>{lp.barnesHutOptimize ? `θ=${lp.barnesHutTheta}` : 'off'}</span></div>
            <div className="gep-info-row"><span>LinLog</span><span>{lp.linLogMode ? 'on' : 'off'}</span></div>
            <div className="gep-info-row"><span>Strong Gravity</span><span>{lp.strongGravityMode ? 'on' : 'off'}</span></div>
            <div className="gep-info-row"><span>Slow Down</span><span>{lp.slowDown.toFixed(1)}</span></div>
          </div>
        );
      })()}

      {/* DB Stats */}
      {stats && (
        <div className="gep-stats">
          <h4>Database</h4>
          <div className="gep-info-row"><span>Total Nodes</span><span>{stats.totalNodes.toLocaleString()}</span></div>
          <div className="gep-info-row"><span>Total Edges</span><span>{stats.totalEdges.toLocaleString()}</span></div>
          <div className="gep-info-row"><span>Hubs</span><span>{stats.byRole.hub}</span></div>
          <div className="gep-info-row"><span>Leaves</span><span>{stats.byRole.leaf}</span></div>
          <hr />
          {Object.entries(stats.byType).filter(([,c]) => c > 0).map(([t, c]) => (
            <div className="gep-info-row" key={t}>
              <span style={{ color: NODE_TYPE_COLORS[t] ?? '#8b8b9e' }}>{t === 'null' ? 'untyped' : t}</span>
              <span>{c}</span>
            </div>
          ))}
        </div>
      )}

      {/* Legend */}
      <div className="gep-legend">
        <h4>Legend</h4>
        {Object.entries(NODE_TYPE_COLORS).map(([type, color]) => (
          <div className="gep-legend-item" key={type}>
            <span className="gep-legend-dot" style={{ background: color }} />
            <span>{type}</span>
          </div>
        ))}
        <div className="gep-legend-item">
          <span className="gep-legend-dot" style={{ background: NODE_ROLE_COLORS.hub, width: 12, height: 12 }} />
          <span>Hub (larger)</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page Component ────────────────────────────────

export function GraphExplorerPage({
  onNavigateToChat,
  onNavigateToExplorer,
  initialNodeId,
}: GraphExplorerPageProps) {
  const {
    graphData,
    stats,
    isLoading,
    error,
    fetchGlobalMap,
    fetchLocalGraph,
    fetchStats,
  } = useGraphData();

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>(initialNodeId ? 'local' : 'global');
  const [centerNodeId, setCenterNodeId] = useState<string | null>(initialNodeId ?? null);

  // Controls state
  const [maxNodes, setMaxNodes] = useState(2000);
  const [minWeight, setMinWeight] = useState(0);
  const [hops, setHops] = useState(2);
  const [hubsOnly, setHubsOnly] = useState(false);
  const [deepKDepth, setDeepKDepth] = useState(3);

  // Tooltip state
  const [tooltipInfo, setTooltipInfo] = useState<TooltipInfo | null>(null);

  // Navigation history for local view
  const historyRef = useRef<string[]>([]);

  // Graph version key — forces SigmaContainer to remount on graph changes
  const graphKeyRef = useRef(0);

  // Sigma ref for tooltip position lookup
  const sigmaContainerRef = useRef<HTMLDivElement>(null);

  // ─── Build graphology from API data ───

  const graph = useMemo(() => {
    if (!graphData || graphData.nodes.length === 0) return null;
    graphKeyRef.current += 1;
    return buildGraphology(graphData, centerNodeId ?? undefined);
  }, [graphData, centerNodeId]);

  // ─── Initial fetch ───

  useEffect(() => {
    if (initialNodeId) {
      fetchLocalGraph(initialNodeId, { hops, maxNodes, minWeight });
    } else {
      fetchGlobalMap({ maxNodes, minWeight, hubsOnly });
    }
    fetchStats();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Handlers ───

  const handleApply = useCallback(() => {
    if (viewMode === 'global') {
      fetchGlobalMap({ maxNodes, minWeight, hubsOnly });
    } else if (centerNodeId) {
      fetchLocalGraph(centerNodeId, { hops: viewMode === 'deepk' ? deepKDepth : hops, maxNodes, minWeight });
    }
    fetchStats();
  }, [viewMode, centerNodeId, maxNodes, minWeight, hubsOnly, hops, deepKDepth, fetchGlobalMap, fetchLocalGraph, fetchStats]);

  /** Click on a node: in global view → switch to local; in local view → re-center */
  const handleNodeClick = useCallback((nodeId: string) => {
    if (viewMode === 'global') {
      // Transition: global → local
      historyRef.current = [];
      setCenterNodeId(nodeId);
      setViewMode('local');
      fetchLocalGraph(nodeId, { hops, maxNodes, minWeight });
    } else {
      // Re-center local view
      if (centerNodeId && centerNodeId !== nodeId) {
        historyRef.current.push(centerNodeId);
      }
      setCenterNodeId(nodeId);
      fetchLocalGraph(nodeId, { hops, maxNodes, minWeight });
    }
    setTooltipInfo(null);
  }, [viewMode, centerNodeId, hops, maxNodes, minWeight, fetchLocalGraph]);

  /** Back to global map */
  const handleBackToGlobal = useCallback(() => {
    setViewMode('global');
    setCenterNodeId(null);
    historyRef.current = [];
    setTooltipInfo(null);
    fetchGlobalMap({ maxNodes, minWeight, hubsOnly });
  }, [maxNodes, minWeight, hubsOnly, fetchGlobalMap]);

  /** Go back in local navigation history */
  const handleGoBack = useCallback(() => {
    if (historyRef.current.length === 0) {
      handleBackToGlobal();
      return;
    }
    const prev = historyRef.current.pop()!;
    setCenterNodeId(prev);
    setTooltipInfo(null);
    fetchLocalGraph(prev, { hops, maxNodes, minWeight });
  }, [hops, maxNodes, minWeight, fetchLocalGraph, handleBackToGlobal]);

  /** Tooltip update — called directly from SigmaEvents with proper position */
  const handleTooltipUpdate = useCallback((info: TooltipInfo | null) => {
    setTooltipInfo(info);
  }, []);

  /** Switch to deepK concentric view for the current center node */
  const handleSwitchToDeepK = useCallback(() => {
    if (!centerNodeId) return;
    setViewMode('deepk');
    setTooltipInfo(null);
    fetchLocalGraph(centerNodeId, { hops: deepKDepth, maxNodes, minWeight });
  }, [centerNodeId, deepKDepth, maxNodes, minWeight, fetchLocalGraph]);

  /** Handle node click inside DeepK view — re-center */
  const handleDeepKNodeClick = useCallback((nodeId: string) => {
    if (centerNodeId && centerNodeId !== nodeId) {
      historyRef.current.push(centerNodeId);
    }
    setCenterNodeId(nodeId);
    fetchLocalGraph(nodeId, { hops: deepKDepth, maxNodes, minWeight });
  }, [centerNodeId, deepKDepth, maxNodes, minWeight, fetchLocalGraph]);

  // ─── Sigma settings (LOD for performance) ───

  const sigmaSettings = useMemo(() => ({
    labelRenderedSizeThreshold: viewMode === 'global' ? 8 : 4,
    labelDensity: viewMode === 'global' ? 0.07 : 0.15,
    labelGridCellSize: viewMode === 'global' ? 60 : 40,
    renderEdgeLabels: false,
    enableEdgeEvents: false,
    defaultNodeType: 'circle' as const,
    minCameraRatio: 0.02,
    maxCameraRatio: 10,
    zIndex: true,
    labelFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
    labelSize: viewMode === 'global' ? 12 : 13,
    labelColor: { color: '#e0e0e0' },
    defaultEdgeType: 'line' as const,
    stagePadding: 40,
  }), [viewMode]);

  // ─── Center label for local view ───
  const centerLabel = useMemo(() => {
    if (!centerNodeId || !graphData) return null;
    return graphData.nodes.find(n => n.id === centerNodeId)?.label ?? centerNodeId.slice(0, 12);
  }, [centerNodeId, graphData]);

  // ─── Render ───

  return (
    <div className="gep-page">
      {/* Header */}
      <header className="gep-header">
        <div className="header-left">
          {onNavigateToChat && (
            <button className="btn-back-to-chat" onClick={onNavigateToChat} title="Back to Chat">
              ◀ Chat
            </button>
          )}
          {onNavigateToExplorer && (
            <button className="btn-back-to-chat" onClick={onNavigateToExplorer} title="Memory Explorer">
              📋 Explorer
            </button>
          )}
          <h1 className="app-title">
            {viewMode === 'global' ? '🕸 Graph Explorer — Global Map'
              : viewMode === 'deepk' ? '🎯 Graph Explorer — DeepK View'
              : '🔍 Graph Explorer — Local View'}
          </h1>
        </div>

        <div className="header-center">
          {/* View mode toggle */}
          <div className="gep-view-toggle">
            <button
              className={`gep-toggle-btn ${viewMode === 'global' ? 'active' : ''}`}
              onClick={handleBackToGlobal}
            >
              🗺️ Global
            </button>
            <button
              className={`gep-toggle-btn ${viewMode === 'local' ? 'active' : ''}`}
              disabled={!centerNodeId && viewMode !== 'local'}
              onClick={() => { if (centerNodeId) { setViewMode('local'); } }}
            >
              🔍 Local
            </button>
            <button
              className={`gep-toggle-btn ${viewMode === 'deepk' ? 'active' : ''}`}
              disabled={!centerNodeId}
              onClick={handleSwitchToDeepK}
              title="Concentric depth rings view"
            >
              🎯 DeepK
            </button>
          </div>

          {/* Local/DeepK view navigation */}
          {(viewMode === 'local' || viewMode === 'deepk') && (
            <div className="gep-local-nav">
              <button className="gep-btn gep-btn-sm" onClick={handleGoBack} title="Go back">
                ← Back
              </button>
              {centerLabel && (
                <span className="gep-center-label" title={centerNodeId ?? ''}>
                  Center: {centerLabel}
                </span>
              )}
              {viewMode === 'deepk' && (
                <label className="deepk-depth-control" style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 12, fontSize: 12, color: '#a0a0c0' }}>
                  Depth:
                  <input
                    type="range"
                    min={1}
                    max={6}
                    step={1}
                    value={deepKDepth}
                    onChange={e => setDeepKDepth(+e.target.value)}
                    style={{ width: 80, accentColor: '#4a9eff' }}
                  />
                  <span style={{ fontWeight: 600, color: '#4a9eff', minWidth: 18 }}>{deepKDepth}</span>
                </label>
              )}
            </div>
          )}
        </div>

        <div className="header-right">
          {stats && (
            <span className="gep-stats-badge">
              {stats.totalNodes.toLocaleString()} nodes
            </span>
          )}
          <button className="btn btn-refresh" onClick={handleApply} disabled={isLoading}>
            {isLoading ? '⏳' : '↻'} Refresh
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="gep-body">
        {/* Controls sidebar */}
        <GraphControls
          viewMode={viewMode}
          maxNodes={maxNodes}
          minWeight={minWeight}
          hops={hops}
          hubsOnly={hubsOnly}
          onMaxNodesChange={setMaxNodes}
          onMinWeightChange={setMinWeight}
          onHopsChange={setHops}
          onHubsOnlyChange={setHubsOnly}
          onApply={handleApply}
          stats={stats}
          graphNodeCount={graphData?.nodes.length ?? 0}
          graphEdgeCount={graphData?.edges.length ?? 0}
          sampled={graphData?.sampled ?? false}
        />

        {/* Main graph area */}
        <div className="gep-graph-area" ref={sigmaContainerRef}>
          {/* Error */}
          {error && (
            <div className="gep-error">
              ⚠️ {error}
              <button className="gep-btn" onClick={handleApply}>Retry</button>
            </div>
          )}

          {/* Loading */}
          {isLoading && !graph && (
            <div className="gep-loading-overlay">
              <span className="gep-spinner" />
              Loading graph data...
            </div>
          )}

          {/* Empty state */}
          {!isLoading && !graph && !error && (
            <div className="gep-empty">
              <div className="gep-empty-icon">🕸️</div>
              <p>No memory nodes yet. Start a conversation to build the memory graph.</p>
            </div>
          )}

          {/* Sigma graph — key forces remount on graph data change */}
          {viewMode !== 'deepk' && graph && graph.order > 0 && (
            <SigmaContainer
              key={graphKeyRef.current}
              graph={graph}
              settings={sigmaSettings}
              style={{ width: '100%', height: '100%', background: '#12122a' }}
            >
              <SigmaEvents
                centerNodeId={centerNodeId ?? undefined}
                onNodeClick={handleNodeClick}
                onTooltipUpdate={handleTooltipUpdate}
                isLocalView={viewMode === 'local'}
              />
              <LayoutControls
                viewMode={viewMode as 'global' | 'local'}
                centerNodeId={centerNodeId ?? undefined}
              />
              <CameraController
                centerNodeId={centerNodeId ?? undefined}
                isLocalView={viewMode === 'local'}
              />
            </SigmaContainer>
          )}

          {/* DeepK concentric circle graph view */}
          {viewMode === 'deepk' && graphData && centerNodeId && (
            <DeepKGraphView
              key={`deepk-${centerNodeId}-${deepKDepth}`}
              data={graphData}
              centerNodeId={centerNodeId}
              maxDepth={deepKDepth}
              onNodeClick={handleDeepKNodeClick}
            />
          )}

          {/* Tooltip overlay */}
          <GraphTooltip info={tooltipInfo} />

          {/* Loading indicator during transitions */}
          {isLoading && graph && (
            <div className="gep-loading-badge">Loading...</div>
          )}
        </div>
      </div>
    </div>
  );
}

