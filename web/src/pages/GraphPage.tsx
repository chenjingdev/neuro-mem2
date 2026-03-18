/**
 * GraphPage — Main page for memory graph visualization.
 *
 * Two interconnected views:
 *   1. Global Map View — sigma.js WebGL rendering of entire graph (sampled for 수십만 nodes)
 *   2. Local Explorer View — ego-network BFS around a selected node
 *
 * View interconnection:
 *   - Click any node in global map → enters local explorer centered on that node
 *   - "Back to Map" button → returns to global view
 *   - Click neighbor in local view → re-centers local view on that node
 *
 * Performance (LOD/virtualization):
 *   - sigma.js WebGL handles 10k+ nodes natively
 *   - Server-side sampling: hubs prioritized, top-activated leaves fill remainder
 *   - Edge filtering by minimum weight
 *   - Progressive detail: L0 only for graph, full detail on click
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useGraphData } from '../hooks/useGraphData';
import { GlobalMapView } from '../components/graph/GlobalMapView';
import { LocalExplorerView } from '../components/graph/LocalExplorerView';
import { GraphControls } from '../components/graph/GraphControls';
import { NodeTooltip } from '../components/graph/NodeTooltip';
import type { GraphNode, GraphData } from '../hooks/useGraphData';

// ─── Types ───────────────────────────────────────────────

type GraphViewMode = 'global' | 'local';

interface GraphPageProps {
  onNavigateToChat?: () => void;
  onNavigateToExplorer?: () => void;
}

// ─── Component ───────────────────────────────────────────

export function GraphPage({ onNavigateToChat, onNavigateToExplorer }: GraphPageProps) {
  const {
    graphData,
    stats,
    isLoading,
    error,
    fetchGlobalMap,
    fetchLocalGraph,
    fetchStats,
  } = useGraphData();

  const [viewMode, setViewMode] = useState<GraphViewMode>('global');
  const [centerNodeId, setCenterNodeId] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedNodeDetail, setSelectedNodeDetail] = useState<GraphNode | null>(null);

  // Graph controls state
  const [maxNodes, setMaxNodes] = useState(2000);
  const [minWeight, setMinWeight] = useState(0);
  const [hops, setHops] = useState(2);
  const [hubsOnly, setHubsOnly] = useState(false);

  // Navigation history for local view
  const historyRef = useRef<string[]>([]);

  // ── Initial load ──
  useEffect(() => {
    fetchGlobalMap({ maxNodes, minWeight, hubsOnly });
    fetchStats();
  }, []);

  // ── Handlers ──

  const handleRefresh = useCallback(() => {
    if (viewMode === 'global') {
      fetchGlobalMap({ maxNodes, minWeight, hubsOnly });
    } else if (centerNodeId) {
      fetchLocalGraph(centerNodeId, { hops, maxNodes, minWeight });
    }
    fetchStats();
  }, [viewMode, centerNodeId, maxNodes, minWeight, hubsOnly, hops, fetchGlobalMap, fetchLocalGraph, fetchStats]);

  const handleNodeClick = useCallback((nodeId: string) => {
    if (viewMode === 'global') {
      // Transition to local view centered on clicked node
      historyRef.current = [nodeId];
      setCenterNodeId(nodeId);
      setViewMode('local');
      fetchLocalGraph(nodeId, { hops, maxNodes, minWeight });
    } else {
      // In local view: re-center on clicked node
      historyRef.current.push(nodeId);
      setCenterNodeId(nodeId);
      fetchLocalGraph(nodeId, { hops, maxNodes, minWeight });
    }
    setSelectedNodeDetail(
      graphData?.nodes.find(n => n.id === nodeId) ?? null,
    );
  }, [viewMode, hops, maxNodes, minWeight, fetchLocalGraph, graphData]);

  const handleBackToGlobal = useCallback(() => {
    setViewMode('global');
    setCenterNodeId(null);
    historyRef.current = [];
    setSelectedNodeDetail(null);
    fetchGlobalMap({ maxNodes, minWeight, hubsOnly });
  }, [maxNodes, minWeight, hubsOnly, fetchGlobalMap]);

  const handleBackInHistory = useCallback(() => {
    if (historyRef.current.length <= 1) {
      handleBackToGlobal();
      return;
    }
    historyRef.current.pop(); // remove current
    const prevId = historyRef.current[historyRef.current.length - 1];
    setCenterNodeId(prevId);
    fetchLocalGraph(prevId, { hops, maxNodes, minWeight });
  }, [hops, maxNodes, minWeight, fetchLocalGraph, handleBackToGlobal]);

  const handleNodeHover = useCallback((node: GraphNode | null, position?: { x: number; y: number }) => {
    setHoveredNode(node);
    setTooltipPos(position ?? null);
  }, []);

  const handleControlsChange = useCallback((changes: {
    maxNodes?: number;
    minWeight?: number;
    hops?: number;
    hubsOnly?: boolean;
  }) => {
    if (changes.maxNodes !== undefined) setMaxNodes(changes.maxNodes);
    if (changes.minWeight !== undefined) setMinWeight(changes.minWeight);
    if (changes.hops !== undefined) setHops(changes.hops);
    if (changes.hubsOnly !== undefined) setHubsOnly(changes.hubsOnly);
  }, []);

  return (
    <div className="graph-page">
      {/* Header */}
      <header className="graph-header">
        <div className="header-left">
          {onNavigateToChat && (
            <button className="btn-back-to-chat" onClick={onNavigateToChat} title="Back to Chat">
              ◀ Chat
            </button>
          )}
          {onNavigateToExplorer && (
            <button className="btn-nav" onClick={onNavigateToExplorer} title="Memory Explorer">
              📋 Explorer
            </button>
          )}
          <h1 className="app-title">
            {viewMode === 'global' ? '🕸️ Memory Graph — Global Map' : '🔍 Memory Graph — Local Explorer'}
          </h1>
        </div>
        <div className="header-center">
          {viewMode === 'local' && (
            <div className="local-nav">
              <button className="btn btn-ghost" onClick={handleBackInHistory} title="Go back">
                ← Back
              </button>
              <button className="btn btn-ghost" onClick={handleBackToGlobal} title="Return to global map">
                🗺️ Global Map
              </button>
              {centerNodeId && (
                <span className="center-label">
                  Center: {graphData?.nodes.find(n => n.id === centerNodeId)?.label ?? centerNodeId.slice(0, 8)}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="header-right">
          {stats && (
            <span className="graph-stats-badge">
              {stats.totalNodes.toLocaleString()} nodes · {stats.totalEdges.toLocaleString()} edges
              {graphData?.sampled && ` (showing ${graphData.nodes.length})`}
            </span>
          )}
          <button className="btn btn-refresh" onClick={handleRefresh} disabled={isLoading}>
            {isLoading ? '⏳' : '↻'} Refresh
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="graph-body">
        {/* Controls sidebar */}
        <GraphControls
          viewMode={viewMode}
          maxNodes={maxNodes}
          minWeight={minWeight}
          hops={hops}
          hubsOnly={hubsOnly}
          stats={stats}
          onChange={handleControlsChange}
          onApply={handleRefresh}
        />

        {/* Graph canvas */}
        <div className="graph-canvas-container">
          {error && (
            <div className="graph-error">
              <span>⚠️ {error}</span>
              <button className="btn btn-ghost" onClick={handleRefresh}>Retry</button>
            </div>
          )}

          {isLoading && !graphData && (
            <div className="graph-loading">
              <span className="mlv-spinner" />
              Loading graph data...
            </div>
          )}

          {graphData && viewMode === 'global' && (
            <GlobalMapView
              data={graphData}
              onNodeClick={handleNodeClick}
              onNodeHover={handleNodeHover}
            />
          )}

          {graphData && viewMode === 'local' && centerNodeId && (
            <LocalExplorerView
              data={graphData}
              centerNodeId={centerNodeId}
              onNodeClick={handleNodeClick}
              onNodeHover={handleNodeHover}
            />
          )}

          {/* Tooltip overlay */}
          {hoveredNode && tooltipPos && (
            <NodeTooltip node={hoveredNode} position={tooltipPos} />
          )}
        </div>

        {/* Detail sidebar */}
        {selectedNodeDetail && (
          <div className="graph-detail-sidebar">
            <div className="graph-detail-header">
              <h3>{selectedNodeDetail.label}</h3>
              <button className="btn-close" onClick={() => setSelectedNodeDetail(null)}>×</button>
            </div>
            <div className="graph-detail-body">
              <div className="detail-field">
                <span className="detail-label">Type</span>
                <span className={`badge badge-type-${selectedNodeDetail.nodeType ?? 'null'}`}>
                  {selectedNodeDetail.nodeType ?? 'untyped'}
                </span>
              </div>
              <div className="detail-field">
                <span className="detail-label">Role</span>
                <span className={`badge badge-role-${selectedNodeDetail.nodeRole}`}>
                  {selectedNodeDetail.nodeRole}
                </span>
              </div>
              <div className="detail-field">
                <span className="detail-label">Activations</span>
                <span>{selectedNodeDetail.activationCount}</span>
              </div>
              {selectedNodeDetail.keywords && (
                <div className="detail-field">
                  <span className="detail-label">Keywords</span>
                  <div className="keyword-tags">
                    {selectedNodeDetail.keywords.split(' ').filter(Boolean).map((kw, i) => (
                      <span key={i} className="keyword-tag">{kw}</span>
                    ))}
                  </div>
                </div>
              )}
              <div className="detail-actions">
                <button
                  className="btn btn-accent"
                  onClick={() => handleNodeClick(selectedNodeDetail.id)}
                >
                  🔍 Explore neighborhood
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
