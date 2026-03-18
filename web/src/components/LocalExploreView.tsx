/**
 * LocalExploreView — sigma.js local graph exploration centered on a selected node.
 *
 * Displays an N-hop neighbor subgraph using sigma.js + graphology with:
 * - ForceAtlas2 layout for organic positioning
 * - Node size/color encoding by nodeType/nodeRole/activationCount
 * - Edge thickness by weight, opacity by shield
 * - Click-to-navigate: double-click a neighbor to re-center
 * - Hop depth slider (1-5)
 * - Navigation history (back button)
 * - Hover tooltips with node details
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import Graph from 'graphology';
import { SigmaContainer, useRegisterEvents, useSigma } from '@react-sigma/core';
import '@react-sigma/core/lib/style.css';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { useLocalGraph, type GraphNodeRef, type GraphEdge } from '../hooks/useLocalGraph';
import {
  NODE_TYPE_COLORS,
  NODE_ROLE_COLORS,
  type MemoryNodeType,
  type MemoryNodeRole,
} from '../types/memory-node';
import './LocalExploreView.css';

// ─── Props ──────────────────────────────────────────────

export interface LocalExploreViewProps {
  /** Initial center node ID (if provided, auto-fetches on mount) */
  initialNodeId?: string;
  /** Callback when a node is selected for detail viewing */
  onNodeSelect?: (nodeId: string) => void;
  /** Callback to navigate back (e.g., to memory explorer) */
  onBack?: () => void;
  /** API base URL */
  apiBaseUrl?: string;
}

// ─── Color Helpers ──────────────────────────────────────

function getNodeColor(nodeType: MemoryNodeType | null, nodeRole: MemoryNodeRole): string {
  if (nodeRole === 'hub') return NODE_ROLE_COLORS.hub ?? '#6c5ce7';
  if (nodeType && NODE_TYPE_COLORS[nodeType]) return NODE_TYPE_COLORS[nodeType];
  return '#00cec9';
}

function getNodeSize(activationCount: number, isCenter: boolean): number {
  if (isCenter) return 16;
  // Scale: base 6, +1 per activation, max 14
  return Math.min(14, 6 + Math.log2(1 + activationCount));
}

function getEdgeColor(weight: number): string {
  // Higher weight = more opaque accent color
  const opacity = Math.max(0.15, Math.min(0.9, weight / 100));
  return `rgba(74, 158, 255, ${opacity})`;
}

function getEdgeSize(weight: number): number {
  return Math.max(0.5, Math.min(4, weight / 25));
}

// ─── Build Graphology Graph ─────────────────────────────

function buildGraph(
  nodes: GraphNodeRef[],
  edges: GraphEdge[],
  centerId: string,
): Graph {
  // Use undirected graph — memory edges are bidirectional
  const graph = new Graph({ multi: false, type: 'undirected' });
  const spread = Math.sqrt(nodes.length) * 12;

  for (const node of nodes) {
    const isCenter = node.id === centerId;
    graph.addNode(node.id, {
      label: node.frontmatter.length > 40
        ? node.frontmatter.slice(0, 37) + '...'
        : node.frontmatter,
      size: getNodeSize(node.activationCount, isCenter),
      color: getNodeColor(node.nodeType, node.nodeRole),
      // Store metadata for tooltips
      nodeType: node.nodeType,
      nodeRole: node.nodeRole,
      frontmatter: node.frontmatter,
      keywords: node.keywords,
      activationCount: node.activationCount,
      isCenter,
      // Center node at origin, others random — ForceAtlas2 will settle positions
      x: isCenter ? 0 : (Math.random() - 0.5) * spread,
      y: isCenter ? 0 : (Math.random() - 0.5) * spread,
    });
  }

  for (const edge of edges) {
    // Skip self-loops and edges where nodes don't exist
    if (edge.sourceId === edge.targetId) continue;
    if (!graph.hasNode(edge.sourceId) || !graph.hasNode(edge.targetId)) continue;

    // Undirected graph: hasEdge(source, target) checks both directions
    if (graph.hasEdge(edge.sourceId, edge.targetId)) continue;

    try {
      graph.addEdge(edge.sourceId, edge.targetId, {
        size: getEdgeSize(edge.weight),
        color: getEdgeColor(edge.weight),
        weight: edge.weight,
        shield: edge.shield,
        edgeType: edge.edgeType,
      });
    } catch {
      // Skip duplicate edges
    }
  }

  // Apply ForceAtlas2 layout with center node pinned at origin
  if (graph.order > 1) {
    // Pin center node so ForceAtlas2 doesn't move it
    if (graph.hasNode(centerId)) {
      graph.setNodeAttribute(centerId, 'fixed', true);
    }

    forceAtlas2.assign(graph, {
      iterations: graph.order > 200 ? 80 : 120,
      settings: {
        gravity: 2.5,
        scalingRatio: Math.max(2, Math.sqrt(graph.order) * 0.6),
        barnesHutOptimize: graph.order > 100,
        strongGravityMode: true,
        slowDown: 2,
        edgeWeightInfluence: 1,
      },
      getEdgeWeight: 'weight',
    });

    // Restore center node at origin and unpin
    if (graph.hasNode(centerId)) {
      graph.setNodeAttribute(centerId, 'x', 0);
      graph.setNodeAttribute(centerId, 'y', 0);
      graph.removeNodeAttribute(centerId, 'fixed');
    }
  }

  return graph;
}

// ─── Sigma Event Handler ────────────────────────────────

interface GraphEventsProps {
  onNodeClick?: (nodeId: string) => void;
  onNodeDoubleClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  centerId?: string;
}

function GraphEvents({ onNodeClick, onNodeDoubleClick, onNodeHover, centerId }: GraphEventsProps) {
  const registerEvents = useRegisterEvents();
  const sigma = useSigma();
  const doubleClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClickedNode = useRef<string | null>(null);

  useEffect(() => {
    registerEvents({
      clickNode: (event) => {
        const nodeId = event.node;

        // Double-click detection
        if (lastClickedNode.current === nodeId && doubleClickTimer.current) {
          clearTimeout(doubleClickTimer.current);
          doubleClickTimer.current = null;
          lastClickedNode.current = null;
          onNodeDoubleClick?.(nodeId);
          return;
        }

        lastClickedNode.current = nodeId;
        doubleClickTimer.current = setTimeout(() => {
          doubleClickTimer.current = null;
          lastClickedNode.current = null;
          onNodeClick?.(nodeId);
        }, 300);
      },
      enterNode: (event) => {
        onNodeHover?.(event.node);
        // Highlight connected nodes
        const graph = sigma.getGraph();
        const neighbors = new Set(graph.neighbors(event.node));
        neighbors.add(event.node);

        graph.forEachNode((node) => {
          if (neighbors.has(node)) {
            graph.setNodeAttribute(node, 'highlighted', true);
            graph.removeNodeAttribute(node, 'dimmed');
          } else {
            graph.setNodeAttribute(node, 'dimmed', true);
            graph.removeNodeAttribute(node, 'highlighted');
          }
        });

        graph.forEachEdge((edge, _attrs, source, target) => {
          if (neighbors.has(source) && neighbors.has(target)) {
            graph.setEdgeAttribute(edge, 'highlighted', true);
            graph.removeEdgeAttribute(edge, 'dimmed');
          } else {
            graph.setEdgeAttribute(edge, 'dimmed', true);
            graph.removeEdgeAttribute(edge, 'highlighted');
          }
        });

        sigma.refresh();
      },
      leaveNode: () => {
        onNodeHover?.(null);
        const graph = sigma.getGraph();
        graph.forEachNode((node) => {
          graph.removeNodeAttribute(node, 'highlighted');
          graph.removeNodeAttribute(node, 'dimmed');
        });
        graph.forEachEdge((edge) => {
          graph.removeEdgeAttribute(edge, 'highlighted');
          graph.removeEdgeAttribute(edge, 'dimmed');
        });
        sigma.refresh();
      },
    });
  }, [registerEvents, sigma, onNodeClick, onNodeDoubleClick, onNodeHover, centerId]);

  return null;
}

// ─── Tooltip Component ──────────────────────────────────

interface TooltipProps {
  nodeId: string | null;
  graph: Graph | null;
}

function NodeTooltip({ nodeId, graph }: TooltipProps) {
  const sigma = useSigma();

  if (!nodeId || !graph || !graph.hasNode(nodeId)) return null;

  const attrs = graph.getNodeAttributes(nodeId);
  const viewport = sigma.graphToViewport({ x: attrs.x, y: attrs.y });

  return (
    <div
      className="lev-tooltip"
      style={{
        left: viewport.x + 15,
        top: viewport.y - 10,
      }}
    >
      <div className="lev-tooltip-title">{attrs.frontmatter}</div>
      <div className="lev-tooltip-meta">
        <span className="lev-tooltip-badge" style={{ background: attrs.color }}>
          {attrs.nodeRole}
        </span>
        {attrs.nodeType && (
          <span className="lev-tooltip-type">{attrs.nodeType}</span>
        )}
      </div>
      {attrs.keywords && (
        <div className="lev-tooltip-keywords">
          {attrs.keywords}
        </div>
      )}
      <div className="lev-tooltip-stats">
        Activations: {attrs.activationCount}
      </div>
      {attrs.isCenter && (
        <div className="lev-tooltip-center">Center node</div>
      )}
    </div>
  );
}

// ─── Node Search Panel ──────────────────────────────────

interface NodeSearchProps {
  graph: Graph | null;
  onSelect: (nodeId: string) => void;
}

function NodeSearchPanel({ graph, onSelect }: NodeSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ id: string; label: string }>>([]);

  useEffect(() => {
    if (!graph || !query.trim()) {
      setResults([]);
      return;
    }

    const q = query.toLowerCase();
    const matches: Array<{ id: string; label: string }> = [];

    graph.forEachNode((nodeId, attrs) => {
      if (
        attrs.frontmatter?.toLowerCase().includes(q) ||
        attrs.keywords?.toLowerCase().includes(q) ||
        nodeId.toLowerCase().includes(q)
      ) {
        matches.push({ id: nodeId, label: attrs.frontmatter ?? nodeId });
      }
      if (matches.length >= 10) return; // limit results
    });

    setResults(matches);
  }, [graph, query]);

  return (
    <div className="lev-search">
      <input
        className="lev-search-input"
        type="text"
        placeholder="Search nodes in graph..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length > 0 && (
        <ul className="lev-search-results">
          {results.map((r) => (
            <li
              key={r.id}
              className="lev-search-item"
              onClick={() => {
                onSelect(r.id);
                setQuery('');
                setResults([]);
              }}
            >
              {r.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────

export function LocalExploreView({
  initialNodeId,
  onNodeSelect,
  onBack,
  apiBaseUrl,
}: LocalExploreViewProps) {
  const {
    subgraph,
    isLoading,
    error,
    centerId,
    hops,
    fetchSubgraph,
    navigateTo,
    setHops,
    clear,
    history,
    goBack,
  } = useLocalGraph({ apiBaseUrl });

  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const graphVersionRef = useRef(0);

  // Fetch on mount if initialNodeId provided
  useEffect(() => {
    if (initialNodeId) {
      fetchSubgraph(initialNodeId);
    }
  }, [initialNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build graphology graph when subgraph data changes
  useEffect(() => {
    if (!subgraph || subgraph.nodes.length === 0) {
      setGraph(null);
      return;
    }
    const g = buildGraph(subgraph.nodes, subgraph.edges, subgraph.centerId);
    graphVersionRef.current += 1;
    setGraph(g);
  }, [subgraph]);

  const handleNodeClick = useCallback((nodeId: string) => {
    onNodeSelect?.(nodeId);
  }, [onNodeSelect]);

  const handleNodeDoubleClick = useCallback((nodeId: string) => {
    navigateTo(nodeId);
  }, [navigateTo]);

  const handleSearchSelect = useCallback((nodeId: string) => {
    navigateTo(nodeId);
  }, [navigateTo]);

  // Sigma settings for rendering
  const sigmaSettings = useMemo(() => ({
    renderLabels: true,
    labelSize: 12,
    labelColor: { color: '#e0e0e0' },
    labelRenderedSizeThreshold: 4,
    defaultEdgeType: 'line' as const,
    defaultNodeColor: '#00cec9',
    defaultEdgeColor: 'rgba(74, 158, 255, 0.3)',
    nodeProgramClasses: {},
    nodeReducer: (node: string, data: Record<string, unknown>) => {
      const res = { ...data };
      if (data.dimmed) {
        res.color = '#333';
        res.label = '';
      }
      if (data.highlighted) {
        res.zIndex = 1;
      }
      return res;
    },
    edgeReducer: (_edge: string, data: Record<string, unknown>) => {
      const res = { ...data };
      if (data.dimmed) {
        res.color = 'rgba(50,50,50,0.2)';
      }
      if (data.highlighted) {
        res.zIndex = 1;
      }
      return res;
    },
  }), []);

  // ─── Render ─────────────────────────────────────────────

  // Empty state: no node selected
  if (!initialNodeId && !centerId) {
    return (
      <div className="lev-container lev-empty">
        <div className="lev-empty-msg">
          <h3>Local Graph Explorer</h3>
          <p>Select a node from the Memory Explorer to visualize its neighborhood graph.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="lev-container">
      {/* Toolbar */}
      <div className="lev-toolbar">
        <div className="lev-toolbar-left">
          {onBack && (
            <button className="lev-btn lev-btn-back" onClick={onBack} title="Back">
              ◀
            </button>
          )}
          {history.length > 0 && (
            <button
              className="lev-btn lev-btn-history"
              onClick={goBack}
              title="Go back in navigation"
            >
              ↩ Back ({history.length})
            </button>
          )}
        </div>

        <div className="lev-toolbar-center">
          {centerId && subgraph && (
            <span className="lev-info">
              <strong>{subgraph.totalNodes}</strong> nodes, <strong>{subgraph.totalEdges}</strong> edges
            </span>
          )}
        </div>

        <div className="lev-toolbar-right">
          <label className="lev-hops-label">
            Hops:
            <input
              className="lev-hops-input"
              type="range"
              min={1}
              max={5}
              value={hops}
              onChange={(e) => setHops(parseInt(e.target.value, 10))}
            />
            <span className="lev-hops-value">{hops}</span>
          </label>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="lev-error">
          {error}
          <button className="lev-btn" onClick={clear}>Dismiss</button>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="lev-loading">
          <span className="lev-spinner" />
          Loading subgraph...
        </div>
      )}

      {/* Graph container */}
      {graph && graph.order > 0 && (
        <div className="lev-graph-wrapper">
          <SigmaContainer
            key={graphVersionRef.current}
            graph={graph}
            settings={sigmaSettings}
            style={{ width: '100%', height: '100%', background: '#12122a' }}
          >
            <GraphEvents
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              onNodeHover={setHoveredNode}
              centerId={centerId ?? undefined}
            />
            <NodeTooltip nodeId={hoveredNode} graph={graph} />
          </SigmaContainer>

          {/* Overlay search */}
          <NodeSearchPanel graph={graph} onSelect={handleSearchSelect} />

          {/* Legend */}
          <div className="lev-legend">
            <div className="lev-legend-title">Legend</div>
            <div className="lev-legend-item">
              <span className="lev-legend-dot" style={{ background: NODE_ROLE_COLORS.hub }} />
              Hub
            </div>
            {Object.entries(NODE_TYPE_COLORS).map(([type, color]) => (
              <div key={type} className="lev-legend-item">
                <span className="lev-legend-dot" style={{ background: color }} />
                {type}
              </div>
            ))}
            <div className="lev-legend-hint">
              Click: select | Double-click: navigate
            </div>
          </div>
        </div>
      )}

      {/* No results */}
      {!isLoading && subgraph && subgraph.nodes.length === 0 && (
        <div className="lev-empty-msg">
          <p>No neighbors found for this node.</p>
        </div>
      )}
    </div>
  );
}
