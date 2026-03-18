/**
 * SearchResultGraphView — sigma.js graph visualization of search results.
 *
 * Converts search result items into a graph where:
 * - Each result is a node, sized by score and colored by nodeType
 * - The query is shown as a central "query node"
 * - Edges connect query → results weighted by score
 * - deepK threshold differentiates L2 (top-K) vs L1 (remaining) items
 *
 * Features:
 * - Toggle between list and graph views
 * - Node click shows detail popover
 * - deepK ring indicator on L2-enriched nodes
 * - Score-based edge thickness
 * - ForceAtlas2 layout for organic positioning
 */

import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import {
  SigmaContainer,
  useRegisterEvents,
  useSigma,
  useSetSettings,
} from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';

import type { SearchResultItem } from '../hooks/useSearch';
import {
  NODE_TYPE_PALETTES,
  NODE_ROLE_PALETTES,
  resolveNodeColor,
  EDGE_HIGHLIGHT_COLOR,
  EDGE_DIM_COLOR,
} from '../config/node-colors';

// ─── Types ──────────────────────────────────────────────

export interface SearchResultGraphViewProps {
  /** Search results to visualize */
  results: SearchResultItem[];
  /** The search query string (shown as center node label) */
  query: string;
  /** deepK threshold — top K results get L2 enrichment ring */
  deepK?: number;
  /** Called when a result node is clicked */
  onNodeClick?: (nodeId: string) => void;
  /** Currently selected node ID */
  selectedNodeId?: string | null;
  /** Height of the graph container */
  height?: number;
}

interface NodeDetail {
  nodeId: string;
  frontmatter: string;
  nodeType: string | null;
  nodeRole: string;
  score: number;
  ftsScore: number;
  vectorScore: number;
  decayFactor: number;
  source: string;
  isDeepK: boolean;
  position: { x: number; y: number };
}

// ─── Constants ──────────────────────────────────────────

const QUERY_NODE_ID = '__query__';
const QUERY_NODE_COLOR = '#a29bfe';
const L2_RING_COLOR = '#2ed573';
const L1_RING_COLOR = '#ffa502';
const DEFAULT_DEEP_K = 5;

// ─── Graph Events Handler ───────────────────────────────

function GraphEventsHandler({
  results,
  deepK,
  onNodeClick,
  selectedNodeId,
  onNodeDetail,
}: {
  results: SearchResultItem[];
  deepK: number;
  onNodeClick?: (nodeId: string) => void;
  selectedNodeId?: string | null;
  onNodeDetail: (detail: NodeDetail | null) => void;
}) {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const setSettings = useSetSettings();
  const hoveredRef = useRef<string | null>(null);

  // Results lookup for detail extraction
  const resultsMap = useMemo(() => {
    const map = new Map<string, { item: SearchResultItem; isDeepK: boolean }>();
    results.forEach((item, idx) => {
      map.set(item.nodeId, { item, isDeepK: idx < deepK });
    });
    return map;
  }, [results, deepK]);

  // Node reducer for highlighting
  useEffect(() => {
    setSettings({
      nodeReducer: (node, attrs) => {
        const res = { ...attrs };

        // Selected node highlight
        if (node === selectedNodeId) {
          res.borderColor = '#ffffff';
          res.borderSize = 3;
          res.zIndex = 3;
        }

        // Hover dimming: dim non-related nodes
        if (hoveredRef.current && hoveredRef.current !== node) {
          const graph = sigma.getGraph();
          const hasEdge = graph.hasEdge(hoveredRef.current, node) ||
                          graph.hasEdge(node, hoveredRef.current);
          if (!hasEdge) {
            res.color = '#2a2a4a';
            res.label = '';
            res.zIndex = 0;
          }
        }

        if (hoveredRef.current === node) {
          res.zIndex = 2;
          res.highlighted = true;
        }

        return res;
      },
      edgeReducer: (edge, attrs) => {
        if (!hoveredRef.current) return attrs;

        const graph = sigma.getGraph();
        const src = graph.source(edge);
        const tgt = graph.target(edge);

        if (src === hoveredRef.current || tgt === hoveredRef.current) {
          return { ...attrs, color: EDGE_HIGHLIGHT_COLOR, size: Math.max(attrs.size as number, 2), zIndex: 1 };
        }
        return { ...attrs, color: EDGE_DIM_COLOR, zIndex: 0 };
      },
    });
  }, [selectedNodeId, sigma, setSettings]);

  useEffect(() => {
    registerEvents({
      clickNode: (event) => {
        const nodeId = event.node;
        if (nodeId === QUERY_NODE_ID) return;
        onNodeClick?.(nodeId);

        // Show detail
        const entry = resultsMap.get(nodeId);
        if (entry) {
          const displayData = sigma.getNodeDisplayData(nodeId);
          const viewPos = displayData
            ? sigma.graphToViewport({ x: displayData.x, y: displayData.y })
            : { x: 0, y: 0 };

          onNodeDetail({
            nodeId,
            frontmatter: entry.item.frontmatter,
            nodeType: entry.item.nodeType,
            nodeRole: entry.item.nodeRole,
            score: entry.item.score,
            ftsScore: entry.item.scoreBreakdown.ftsScore,
            vectorScore: entry.item.scoreBreakdown.vectorScore,
            decayFactor: entry.item.scoreBreakdown.decayFactor,
            source: entry.item.source,
            isDeepK: entry.isDeepK,
            position: viewPos,
          });
        }
      },
      enterNode: (event) => {
        hoveredRef.current = event.node;
        sigma.refresh();
      },
      leaveNode: () => {
        hoveredRef.current = null;
        sigma.refresh();
      },
    });
  }, [registerEvents, sigma, onNodeClick, resultsMap, onNodeDetail]);

  return null;
}

// ─── Build Graph ────────────────────────────────────────

function buildSearchGraph(
  results: SearchResultItem[],
  query: string,
  deepK: number,
): Graph {
  const graph = new Graph({ multi: false, type: 'undirected' });

  // Add central query node
  graph.addNode(QUERY_NODE_ID, {
    x: 0,
    y: 0,
    size: 14,
    color: QUERY_NODE_COLOR,
    label: `🔍 "${query.length > 20 ? query.slice(0, 20) + '…' : query}"`,
    forceLabel: true,
    zIndex: 10,
    nodeType: null,
    nodeRole: 'query',
    borderColor: '#ffffff',
    borderSize: 2,
  });

  // Add result nodes arranged in a circle
  const n = results.length;
  const radius = Math.max(5, n * 2);

  results.forEach((item, idx) => {
    const angle = (2 * Math.PI * idx) / n - Math.PI / 2;
    const isDeepK = idx < deepK;
    const nodeColor = resolveNodeColor(item.nodeType, item.nodeRole);

    // Size based on score (higher score = bigger)
    const baseSize = 4 + item.score * 12;

    graph.addNode(item.nodeId, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: baseSize,
      color: nodeColor,
      label: item.frontmatter,
      // deepK ring: L2-enriched nodes get green ring, L1 get orange
      borderColor: isDeepK ? L2_RING_COLOR : L1_RING_COLOR,
      borderSize: isDeepK ? 3 : 1,
      zIndex: isDeepK ? 2 : 1,
      forceLabel: isDeepK || item.score >= 0.5,
      // Custom attrs
      nodeType: item.nodeType,
      nodeRole: item.nodeRole,
      activationCount: 0,
      keywords: '',
      score: item.score,
      isDeepK,
    });

    // Edge from query → result, weighted by score
    const edgeSize = 0.5 + item.score * 3;
    const edgeAlpha = 0.2 + item.score * 0.6;
    graph.addEdge(QUERY_NODE_ID, item.nodeId, {
      size: edgeSize,
      color: `rgba(162, 155, 254, ${edgeAlpha})`,
      weight: item.score * 100,
    });
  });

  // Run ForceAtlas2 layout
  if (n > 0) {
    // Pin query node at center
    graph.setNodeAttribute(QUERY_NODE_ID, 'fixed', true);

    const iterations = n < 20 ? 150 : n < 50 ? 80 : 40;
    forceAtlas2.assign(graph, {
      iterations,
      settings: {
        gravity: 2.5,
        scalingRatio: 4,
        barnesHutOptimize: n > 50,
        barnesHutTheta: 0.5,
        strongGravityMode: true,
        slowDown: 2,
        edgeWeightInfluence: 1,
        linLogMode: false,
        adjustSizes: false,
      },
      getEdgeWeight: 'weight',
    });

    // Restore query node to center
    graph.setNodeAttribute(QUERY_NODE_ID, 'x', 0);
    graph.setNodeAttribute(QUERY_NODE_ID, 'y', 0);
    graph.removeNodeAttribute(QUERY_NODE_ID, 'fixed');
  }

  return graph;
}

// ─── Node Detail Popover ────────────────────────────────

function NodeDetailPopover({
  detail,
  onClose,
  onNavigate,
}: {
  detail: NodeDetail;
  onClose: () => void;
  onNavigate?: (nodeId: string) => void;
}) {
  const typeColor = detail.nodeType
    ? (NODE_TYPE_PALETTES[detail.nodeType]?.base ?? '#888')
    : '#888';
  const typeIcon = detail.nodeType
    ? (NODE_TYPE_PALETTES[detail.nodeType]?.icon ?? '❓')
    : '❓';
  const roleIcon = NODE_ROLE_PALETTES[detail.nodeRole]?.icon ?? '';

  return (
    <div
      className="srg-detail-popover"
      style={{
        left: Math.min(detail.position.x + 15, window.innerWidth - 300),
        top: Math.min(detail.position.y - 10, window.innerHeight - 250),
      }}
    >
      <div className="srg-detail-header">
        <span className="srg-detail-title">
          {typeIcon} {detail.frontmatter}
        </span>
        <button className="srg-detail-close" onClick={onClose} title="Close">✕</button>
      </div>
      <div className="srg-detail-body">
        <div className="srg-detail-badges">
          <span
            className="srg-detail-type-badge"
            style={{ borderColor: typeColor, color: typeColor }}
          >
            {detail.nodeType ?? 'untyped'}
          </span>
          <span className="srg-detail-role-badge">
            {roleIcon} {detail.nodeRole}
          </span>
          {detail.isDeepK && (
            <span className="srg-detail-deepk-badge">L2 deepK</span>
          )}
          {!detail.isDeepK && (
            <span className="srg-detail-l1-badge">L1</span>
          )}
        </div>

        <div className="srg-detail-scores">
          <div className="srg-detail-score-main">
            <span>Score</span>
            <span className="srg-score-value">{Math.round(detail.score * 100)}%</span>
          </div>
          <div className="srg-detail-score-row">
            <span>FTS5</span>
            <div className="srg-score-bar-wrap">
              <div
                className="srg-score-bar srg-score-fts"
                style={{ width: `${detail.ftsScore * 100}%` }}
              />
            </div>
            <span>{Math.round(detail.ftsScore * 100)}</span>
          </div>
          <div className="srg-detail-score-row">
            <span>Vector</span>
            <div className="srg-score-bar-wrap">
              <div
                className="srg-score-bar srg-score-vec"
                style={{ width: `${detail.vectorScore * 100}%` }}
              />
            </div>
            <span>{Math.round(detail.vectorScore * 100)}</span>
          </div>
          {detail.decayFactor < 1 && (
            <div className="srg-detail-score-row srg-decay-row">
              <span>Decay</span>
              <div className="srg-score-bar-wrap">
                <div
                  className="srg-score-bar srg-score-decay"
                  style={{ width: `${detail.decayFactor * 100}%` }}
                />
              </div>
              <span>{Math.round(detail.decayFactor * 100)}</span>
            </div>
          )}
        </div>

        <div className="srg-detail-source">
          Source: <span>{detail.source}</span>
        </div>

        {onNavigate && (
          <button
            className="srg-detail-navigate-btn"
            onClick={() => onNavigate(detail.nodeId)}
          >
            🔍 Explore in Graph
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────

export function SearchResultGraphView({
  results,
  query,
  deepK = DEFAULT_DEEP_K,
  onNodeClick,
  selectedNodeId,
  height = 350,
}: SearchResultGraphViewProps) {
  const [nodeDetail, setNodeDetail] = useState<NodeDetail | null>(null);

  const graph = useMemo(() => {
    if (results.length === 0) return null;
    return buildSearchGraph(results, query, deepK);
  }, [results, query, deepK]);

  const handleNodeDetail = useCallback((detail: NodeDetail | null) => {
    setNodeDetail(detail);
  }, []);

  const handleNodeClick = useCallback((nodeId: string) => {
    onNodeClick?.(nodeId);
  }, [onNodeClick]);

  // Close detail on outside click
  const containerRef = useRef<HTMLDivElement>(null);

  if (!graph || graph.order === 0) {
    return (
      <div className="srg-empty">
        <span>No results to visualize</span>
      </div>
    );
  }

  return (
    <div className="srg-container" ref={containerRef} style={{ height }}>
      {/* deepK legend */}
      <div className="srg-legend">
        <div className="srg-legend-item">
          <span className="srg-legend-dot" style={{ background: QUERY_NODE_COLOR, border: '2px solid #fff' }} />
          <span>Query</span>
        </div>
        <div className="srg-legend-item">
          <span className="srg-legend-dot" style={{ border: `3px solid ${L2_RING_COLOR}` }} />
          <span>Top-K (L2)</span>
        </div>
        <div className="srg-legend-item">
          <span className="srg-legend-dot" style={{ border: `1px solid ${L1_RING_COLOR}` }} />
          <span>Rest (L1)</span>
        </div>
      </div>

      <SigmaContainer
        graph={graph}
        className="sigma-container srg-sigma"
        style={{ height: '100%' }}
        settings={{
          labelRenderedSizeThreshold: 4,
          labelDensity: 0.12,
          labelGridCellSize: 60,
          renderEdgeLabels: false,
          enableEdgeEvents: false,
          defaultNodeType: 'circle',
          minCameraRatio: 0.3,
          maxCameraRatio: 3,
          zIndex: true,
          labelFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
          labelSize: 12,
          labelColor: { color: '#e0e0e0' },
          defaultEdgeType: 'line',
          stagePadding: 40,
        }}
      >
        <GraphEventsHandler
          results={results}
          deepK={deepK}
          onNodeClick={handleNodeClick}
          selectedNodeId={selectedNodeId}
          onNodeDetail={handleNodeDetail}
        />
      </SigmaContainer>

      {/* Node detail popover */}
      {nodeDetail && (
        <NodeDetailPopover
          detail={nodeDetail}
          onClose={() => setNodeDetail(null)}
          onNavigate={onNodeClick}
        />
      )}
    </div>
  );
}
