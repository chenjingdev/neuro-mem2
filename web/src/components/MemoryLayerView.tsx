/**
 * MemoryLayerView — Accordion/tree view for MemoryNode 4-layer progressive depth.
 *
 * Displays memory nodes in an expandable layer-by-layer view:
 *   L0 — Anchor/Keywords/Embedding (always visible as the collapsed row)
 *   L1 — Structured Metadata (first expansion level)
 *   L2 — Summary (second expansion level)
 *   L3 — Source References (deepest expansion)
 *
 * Features:
 *   - Depth indicator bar (colored left border showing current depth)
 *   - Accordion expand/collapse per node
 *   - Layer tabs within each expanded node
 *   - Filter by nodeType, nodeRole, sort order
 *   - Pagination for 수십만 노드 scalability
 *   - Click-to-select for detail panel integration
 *   - Visual node type/role badges
 *   - Activation count & lifecycle info at a glance
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import './MemoryLayerView.css';
import {
  NODE_TYPE_COLORS,
  NODE_ROLE_COLORS,
  NODE_TYPE_ICONS,
  NODE_ROLE_ICONS,
  MEMORY_NODE_TYPES,
  MEMORY_NODE_ROLES,
} from '../types/memory-node';
import type {
  MemoryNodeData,
  MemoryNodeMetadata,
  MemoryNodeType,
  MemoryNodeRole,
} from '../types/memory-node';
import type { MemoryNodeRef } from '../hooks/useMemoryNodes';

// ─── Layer Depth Colors ──────────────────────────────────────

export const LAYER_COLORS = {
  L0: '#ff6b6b',  // flash red
  L1: '#ffa502',  // short orange
  L2: '#2ed573',  // mid green
  L3: '#1e90ff',  // long blue
} as const;

export const LAYER_LABELS = {
  L0: 'Anchor / Keywords',
  L1: 'Metadata',
  L2: 'Summary',
  L3: 'Source References',
} as const;

export const LAYER_DESCRIPTIONS = {
  L0: 'Frontmatter label, FTS5 keywords, embedding status',
  L1: 'Structured metadata: entities, SPO triples, category, confidence',
  L2: 'Human-readable summary text',
  L3: 'Original conversation/turn references',
} as const;

type LayerKey = 'L0' | 'L1' | 'L2' | 'L3';

// ─── Depth Indicator ─────────────────────────────────────────

interface DepthIndicatorProps {
  /** Current expanded depth (0-3) */
  depth: number;
  /** Whether the node is expanded at all */
  isExpanded: boolean;
}

function DepthIndicator({ depth, isExpanded }: DepthIndicatorProps) {
  const layers: LayerKey[] = ['L0', 'L1', 'L2', 'L3'];
  return (
    <div className="mlv-depth-indicator" title={`Depth: ${isExpanded ? `L${depth}` : 'collapsed'}`}>
      {layers.map((layer, i) => (
        <div
          key={layer}
          className={`mlv-depth-segment ${i <= depth && isExpanded ? 'mlv-depth-active' : ''}`}
          style={{
            backgroundColor: i <= depth && isExpanded
              ? LAYER_COLORS[layer]
              : 'rgba(255,255,255,0.06)',
          }}
          title={`${layer}: ${LAYER_LABELS[layer]}`}
        />
      ))}
    </div>
  );
}

// ─── Layer Tab Bar ───────────────────────────────────────────

interface LayerTabBarProps {
  activeLayer: number;
  onSelectLayer: (layer: number) => void;
  maxAvailableLayer: number;
}

function LayerTabBar({ activeLayer, onSelectLayer, maxAvailableLayer }: LayerTabBarProps) {
  const layers: LayerKey[] = ['L0', 'L1', 'L2', 'L3'];
  return (
    <div className="mlv-layer-tabs">
      {layers.map((layer, i) => {
        const isActive = i === activeLayer;
        const isAvailable = i <= maxAvailableLayer;
        return (
          <button
            key={layer}
            className={`mlv-layer-tab ${isActive ? 'mlv-layer-tab-active' : ''} ${!isAvailable ? 'mlv-layer-tab-disabled' : ''}`}
            style={{
              borderBottomColor: isActive ? LAYER_COLORS[layer] : 'transparent',
              color: isActive ? LAYER_COLORS[layer] : undefined,
            }}
            onClick={() => isAvailable && onSelectLayer(i)}
            disabled={!isAvailable}
            title={`${layer}: ${LAYER_DESCRIPTIONS[layer]}`}
          >
            <span className="mlv-tab-dot" style={{ backgroundColor: LAYER_COLORS[layer] }} />
            {layer}
          </button>
        );
      })}
    </div>
  );
}

// ─── L0 Content (always shown in collapsed row) ─────────────

interface L0ContentProps {
  node: MemoryNodeRef;
}

function L0Content({ node }: L0ContentProps) {
  const typeColor = node.nodeType ? NODE_TYPE_COLORS[node.nodeType] ?? '#b2bec3' : '#b2bec3';
  const roleColor = NODE_ROLE_COLORS[node.nodeRole] ?? '#b2bec3';
  const typeIcon = node.nodeType ? NODE_TYPE_ICONS[node.nodeType] ?? '' : '';
  const roleIcon = NODE_ROLE_ICONS[node.nodeRole] ?? '';

  return (
    <div className="mlv-l0-content">
      <div className="mlv-l0-header">
        <span className="mlv-node-frontmatter">{node.frontmatter || 'Untitled'}</span>
        <div className="mlv-node-badges">
          {node.nodeType && (
            <span
              className="mlv-badge mlv-badge-type"
              style={{ backgroundColor: `${typeColor}22`, color: typeColor, borderColor: `${typeColor}44` }}
            >
              {typeIcon} {node.nodeType}
            </span>
          )}
          <span
            className="mlv-badge mlv-badge-role"
            style={{ backgroundColor: `${roleColor}22`, color: roleColor, borderColor: `${roleColor}44` }}
          >
            {roleIcon} {node.nodeRole}
          </span>
        </div>
      </div>
      <div className="mlv-l0-meta">
        <span className="mlv-keywords" title={node.keywords}>
          {node.keywords
            ? node.keywords.split(' ').slice(0, 6).map((kw, i) => (
                <span key={i} className="mlv-keyword-chip">{kw}</span>
              ))
            : <span className="mlv-no-keywords">no keywords</span>}
        </span>
        <span className="mlv-activation" title={`Activation count: ${node.activationCount}`}>
          ⚡ {node.activationCount}
        </span>
      </div>
    </div>
  );
}

// ─── L1 Content (Metadata) ──────────────────────────────────

interface L1ContentProps {
  metadata: MemoryNodeMetadata | null;
  isLoading: boolean;
}

function L1Content({ metadata, isLoading }: L1ContentProps) {
  if (isLoading) {
    return (
      <div className="mlv-layer-loading">
        <span className="mlv-spinner" />
        Loading metadata...
      </div>
    );
  }

  if (!metadata || Object.keys(metadata).length === 0) {
    return <div className="mlv-layer-empty">No structured metadata</div>;
  }

  // Group metadata by category
  const commonFields: [string, unknown][] = [];
  const specificFields: [string, unknown][] = [];

  const commonKeys = new Set(['entities', 'category', 'confidence', 'salience']);

  for (const [key, val] of Object.entries(metadata)) {
    if (val === undefined || val === null) continue;
    if (commonKeys.has(key)) {
      commonFields.push([key, val]);
    } else {
      specificFields.push([key, val]);
    }
  }

  return (
    <div className="mlv-l1-content">
      {commonFields.length > 0 && (
        <div className="mlv-meta-group">
          <span className="mlv-meta-group-label">Common</span>
          <div className="mlv-meta-fields">
            {commonFields.map(([key, val]) => (
              <MetadataField key={key} name={key} value={val} />
            ))}
          </div>
        </div>
      )}
      {specificFields.length > 0 && (
        <div className="mlv-meta-group">
          <span className="mlv-meta-group-label">Type-Specific</span>
          <div className="mlv-meta-fields">
            {specificFields.map(([key, val]) => (
              <MetadataField key={key} name={key} value={val} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MetadataField({ name, value }: { name: string; value: unknown }) {
  const displayValue = useMemo(() => {
    if (Array.isArray(value)) {
      return value.length === 0 ? '[]' : value.join(', ');
    }
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value);
    }
    if (typeof value === 'number') {
      return Number.isInteger(value) ? String(value) : value.toFixed(3);
    }
    return String(value);
  }, [value]);

  return (
    <div className="mlv-meta-field">
      <span className="mlv-meta-key">{name}</span>
      <span className="mlv-meta-value" title={typeof displayValue === 'string' ? displayValue : undefined}>
        {displayValue}
      </span>
    </div>
  );
}

// ─── L2 Content (Summary) ───────────────────────────────────

interface L2ContentProps {
  summary: string | null;
  isLoading: boolean;
}

function L2Content({ summary, isLoading }: L2ContentProps) {
  if (isLoading) {
    return (
      <div className="mlv-layer-loading">
        <span className="mlv-spinner" />
        Loading summary...
      </div>
    );
  }

  if (!summary) {
    return <div className="mlv-layer-empty">No summary available</div>;
  }

  return (
    <div className="mlv-l2-content">
      <p className="mlv-summary-text">{summary}</p>
    </div>
  );
}

// ─── L3 Content (Source References) ─────────────────────────

interface L3ContentProps {
  sourceMessageIds: string[];
  conversationId?: string;
  sourceTurnIndex?: number;
  isLoading: boolean;
}

function L3Content({ sourceMessageIds, conversationId, sourceTurnIndex, isLoading }: L3ContentProps) {
  if (isLoading) {
    return (
      <div className="mlv-layer-loading">
        <span className="mlv-spinner" />
        Loading source references...
      </div>
    );
  }

  if (sourceMessageIds.length === 0 && !conversationId) {
    return <div className="mlv-layer-empty">No source references</div>;
  }

  return (
    <div className="mlv-l3-content">
      {conversationId && (
        <div className="mlv-source-info">
          <span className="mlv-source-label">Conversation</span>
          <span className="mlv-source-value mlv-mono">{conversationId}</span>
        </div>
      )}
      {sourceTurnIndex != null && (
        <div className="mlv-source-info">
          <span className="mlv-source-label">Turn Index</span>
          <span className="mlv-source-value mlv-mono">{sourceTurnIndex}</span>
        </div>
      )}
      {sourceMessageIds.length > 0 && (
        <div className="mlv-source-refs">
          <span className="mlv-source-label">Source Message IDs</span>
          <div className="mlv-ref-list">
            {sourceMessageIds.map((ref, i) => (
              <span key={i} className="mlv-ref-chip" title={ref}>
                {ref}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Single Node Accordion Row ──────────────────────────────

interface NodeAccordionRowProps {
  node: MemoryNodeRef;
  /** Full node data (fetched on expand) */
  fullNode: MemoryNodeData | null;
  isExpanded: boolean;
  activeLayer: number;
  isLoadingDetail: boolean;
  onToggle: () => void;
  onLayerChange: (layer: number) => void;
  onSelect: () => void;
  isSelected: boolean;
}

function NodeAccordionRow({
  node,
  fullNode,
  isExpanded,
  activeLayer,
  isLoadingDetail,
  onToggle,
  onLayerChange,
  onSelect,
  isSelected,
}: NodeAccordionRowProps) {
  // Determine max available layer based on loaded data
  const maxAvailableLayer = fullNode ? 3 : 0;

  const handleRowClick = useCallback((e: React.MouseEvent) => {
    // If clicking the expand toggle, don't also select
    if ((e.target as HTMLElement).closest('.mlv-expand-btn')) return;
    onSelect();
  }, [onSelect]);

  return (
    <div
      className={`mlv-node-row ${isExpanded ? 'mlv-node-expanded' : ''} ${isSelected ? 'mlv-node-selected' : ''}`}
    >
      {/* Depth indicator bar */}
      <DepthIndicator depth={activeLayer} isExpanded={isExpanded} />

      {/* Main row content */}
      <div className="mlv-node-main" onClick={handleRowClick}>
        {/* Expand/collapse toggle */}
        <button
          className="mlv-expand-btn"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          aria-expanded={isExpanded}
          title={isExpanded ? 'Collapse' : 'Expand to see layers'}
        >
          <span className={`mlv-expand-arrow ${isExpanded ? 'mlv-arrow-down' : ''}`}>▶</span>
        </button>

        {/* L0 content (always visible) */}
        <L0Content node={node} />
      </div>

      {/* Expanded layer content */}
      {isExpanded && (
        <div className="mlv-layer-panel">
          {/* Layer tabs */}
          <LayerTabBar
            activeLayer={activeLayer}
            onSelectLayer={onLayerChange}
            maxAvailableLayer={maxAvailableLayer}
          />

          {/* Layer content based on active tab */}
          <div className="mlv-layer-content" style={{ borderLeftColor: LAYER_COLORS[`L${activeLayer}` as LayerKey] }}>
            {activeLayer === 0 && (
              <div className="mlv-l0-detail">
                <div className="mlv-meta-field">
                  <span className="mlv-meta-key">Frontmatter</span>
                  <span className="mlv-meta-value">{node.frontmatter}</span>
                </div>
                <div className="mlv-meta-field">
                  <span className="mlv-meta-key">Keywords</span>
                  <span className="mlv-meta-value mlv-mono">{node.keywords || '(none)'}</span>
                </div>
                <div className="mlv-meta-field">
                  <span className="mlv-meta-key">Embedding</span>
                  <span className="mlv-meta-value">
                    {fullNode?.hasEmbedding
                      ? <span className="mlv-badge-ok">✓ {fullNode.embeddingDim ?? '?'}d</span>
                      : isLoadingDetail
                        ? <span className="mlv-spinner-inline" />
                        : <span className="mlv-badge-missing">—</span>}
                  </span>
                </div>
                <div className="mlv-meta-field">
                  <span className="mlv-meta-key">ID</span>
                  <span className="mlv-meta-value mlv-mono" title={node.id}>
                    {node.id}
                  </span>
                </div>
              </div>
            )}

            {activeLayer === 1 && (
              <L1Content
                metadata={fullNode?.metadata ?? null}
                isLoading={isLoadingDetail}
              />
            )}

            {activeLayer === 2 && (
              <L2Content
                summary={fullNode?.summary ?? null}
                isLoading={isLoadingDetail}
              />
            )}

            {activeLayer === 3 && (
              <L3Content
                sourceMessageIds={fullNode?.sourceMessageIds ?? []}
                conversationId={fullNode?.conversationId}
                sourceTurnIndex={fullNode?.sourceTurnIndex}
                isLoading={isLoadingDetail}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Filter Bar ─────────────────────────────────────────────

interface FilterBarProps {
  total: number;
  activeNodeType: MemoryNodeType | null | undefined;
  activeNodeRole: MemoryNodeRole | undefined;
  activeOrderBy: string | undefined;
  onFilterChange: (filters: {
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
    orderBy?: 'activation_desc' | 'recent_first' | 'created_first';
  }) => void;
}

function FilterBar({ total, activeNodeType, activeNodeRole, activeOrderBy, onFilterChange }: FilterBarProps) {
  return (
    <div className="mlv-filter-bar">
      <span className="mlv-total-count">{total.toLocaleString()} nodes</span>

      <select
        className="mlv-filter-select"
        value={activeNodeType ?? 'all'}
        onChange={(e) => {
          const val = e.target.value;
          onFilterChange({
            nodeType: val === 'all' ? undefined : val === 'null' ? null : val as MemoryNodeType,
            nodeRole: activeNodeRole,
            orderBy: activeOrderBy as 'activation_desc' | 'recent_first' | 'created_first' | undefined,
          });
        }}
        title="Filter by node type"
      >
        <option value="all">All Types</option>
        {MEMORY_NODE_TYPES.map((t) => (
          <option key={t} value={t}>{NODE_TYPE_ICONS[t]} {t}</option>
        ))}
        <option value="null">⬜ untyped</option>
      </select>

      <select
        className="mlv-filter-select"
        value={activeNodeRole ?? 'all'}
        onChange={(e) => {
          const val = e.target.value;
          onFilterChange({
            nodeType: activeNodeType,
            nodeRole: val === 'all' ? undefined : val as MemoryNodeRole,
            orderBy: activeOrderBy as 'activation_desc' | 'recent_first' | 'created_first' | undefined,
          });
        }}
        title="Filter by node role"
      >
        <option value="all">All Roles</option>
        {MEMORY_NODE_ROLES.map((r) => (
          <option key={r} value={r}>{NODE_ROLE_ICONS[r]} {r}</option>
        ))}
      </select>

      <select
        className="mlv-filter-select"
        value={activeOrderBy ?? 'recent_first'}
        onChange={(e) => {
          onFilterChange({
            nodeType: activeNodeType,
            nodeRole: activeNodeRole,
            orderBy: e.target.value as 'activation_desc' | 'recent_first' | 'created_first',
          });
        }}
        title="Sort order"
      >
        <option value="recent_first">Recent First</option>
        <option value="activation_desc">Most Active</option>
        <option value="created_first">Oldest First</option>
      </select>
    </div>
  );
}

// ─── Pagination ─────────────────────────────────────────────

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;

  return (
    <div className="mlv-pagination">
      <button
        className="mlv-page-btn"
        disabled={page === 0}
        onClick={() => onPageChange(page - 1)}
      >
        ◀ Prev
      </button>
      <span className="mlv-page-info">
        Page {page + 1} of {totalPages}
      </span>
      <button
        className="mlv-page-btn"
        disabled={page >= totalPages - 1}
        onClick={() => onPageChange(page + 1)}
      >
        Next ▶
      </button>
    </div>
  );
}

// ─── Layer Legend ────────────────────────────────────────────

function LayerLegend() {
  const layers: LayerKey[] = ['L0', 'L1', 'L2', 'L3'];
  return (
    <div className="mlv-legend">
      {layers.map((layer) => (
        <div key={layer} className="mlv-legend-item" title={LAYER_DESCRIPTIONS[layer]}>
          <span
            className="mlv-legend-dot"
            style={{ backgroundColor: LAYER_COLORS[layer] }}
          />
          <span className="mlv-legend-label">{layer}</span>
          <span className="mlv-legend-desc">{LAYER_LABELS[layer]}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

export interface MemoryLayerViewProps {
  /** Nodes to display (L0 refs) */
  nodes: MemoryNodeRef[];
  /** Total count */
  total: number;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** Current page */
  page: number;
  /** Page size */
  pageSize: number;
  /** Fetch function for node detail */
  onFetchDetail: (id: string) => Promise<{
    node: MemoryNodeData;
    edges?: unknown[];
    decay?: unknown;
  } | null>;
  /** Filter change handler */
  onFilterChange: (filters: {
    page?: number;
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
    orderBy?: 'activation_desc' | 'recent_first' | 'created_first';
  }) => void;
  /** Page change handler */
  onPageChange: (page: number) => void;
  /** Currently selected node ID (for detail panel integration) */
  selectedNodeId?: string | null;
  /** Node selection handler */
  onSelectNode?: (id: string) => void;
  /** Active filters */
  filters?: {
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
    orderBy?: string;
  };
  /** Hide the internal FilterBar (when an external NodeFilterBar is used) */
  hideInternalFilterBar?: boolean;
}

interface ExpandedNodeState {
  activeLayer: number;
  fullNode: MemoryNodeData | null;
  isLoading: boolean;
}

export function MemoryLayerView({
  nodes,
  total,
  isLoading,
  error,
  page,
  pageSize,
  onFetchDetail,
  onFilterChange,
  onPageChange,
  selectedNodeId,
  onSelectNode,
  filters = {},
  hideInternalFilterBar = false,
}: MemoryLayerViewProps) {
  // Track expanded state per node
  const [expandedNodes, setExpandedNodes] = useState<Map<string, ExpandedNodeState>>(new Map());

  // Use a ref to track current expanded state for async operations (avoids stale closure)
  const expandedRef = useRef(expandedNodes);
  expandedRef.current = expandedNodes;

  // Reset expanded state when node list changes
  useEffect(() => {
    setExpandedNodes(new Map());
  }, [nodes]);

  // ─── Toggle expand/collapse for a single node ──────────────
  const handleToggle = useCallback(async (nodeId: string) => {
    // Check current state via ref (avoids stale closure)
    const wasExpanded = expandedRef.current.has(nodeId);

    setExpandedNodes((prev) => {
      const next = new Map(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.set(nodeId, { activeLayer: 0, fullNode: null, isLoading: true });
      }
      return next;
    });

    // If expanding (was NOT expanded before), fetch full detail
    if (!wasExpanded) {
      try {
        const detail = await onFetchDetail(nodeId);
        setExpandedNodes((prev) => {
          const next = new Map(prev);
          const existing = next.get(nodeId);
          if (existing) {
            next.set(nodeId, {
              ...existing,
              fullNode: detail?.node ?? null,
              isLoading: false,
            });
          }
          return next;
        });
      } catch {
        // On error, mark loading as done
        setExpandedNodes((prev) => {
          const next = new Map(prev);
          const existing = next.get(nodeId);
          if (existing) {
            next.set(nodeId, { ...existing, isLoading: false });
          }
          return next;
        });
      }
    }
  }, [onFetchDetail]);

  // ─── Change active layer tab for a node ────────────────────
  const handleLayerChange = useCallback((nodeId: string, layer: number) => {
    setExpandedNodes((prev) => {
      const next = new Map(prev);
      const existing = next.get(nodeId);
      if (existing) {
        next.set(nodeId, { ...existing, activeLayer: layer });
      }
      return next;
    });
  }, []);

  // ─── Bulk expand all visible nodes to a specific depth ─────
  const handleExpandAllToDepth = useCallback(async (depth: number) => {
    const clampedDepth = Math.max(0, Math.min(3, depth));

    // First, set all nodes as expanded with the target depth
    setExpandedNodes((prev) => {
      const next = new Map(prev);
      for (const node of nodes) {
        const existing = next.get(node.id);
        if (existing) {
          // Already expanded, just change layer
          next.set(node.id, { ...existing, activeLayer: clampedDepth });
        } else {
          // Not expanded yet, create entry
          next.set(node.id, { activeLayer: clampedDepth, fullNode: null, isLoading: true });
        }
      }
      return next;
    });

    // Fetch details for nodes that need it (only if depth > 0)
    if (clampedDepth > 0) {
      const nodesToFetch = nodes.filter((n) => !expandedRef.current.get(n.id)?.fullNode);
      const fetchPromises = nodesToFetch.map(async (node) => {
        try {
          const detail = await onFetchDetail(node.id);
          return { nodeId: node.id, detail };
        } catch {
          return { nodeId: node.id, detail: null };
        }
      });

      const results = await Promise.allSettled(fetchPromises);
      setExpandedNodes((prev) => {
        const next = new Map(prev);
        for (const result of results) {
          if (result.status === 'fulfilled') {
            const { nodeId, detail } = result.value;
            const existing = next.get(nodeId);
            if (existing) {
              next.set(nodeId, {
                ...existing,
                fullNode: detail?.node ?? existing.fullNode,
                isLoading: false,
              });
            }
          }
        }
        return next;
      });
    }
  }, [nodes, onFetchDetail]);

  // ─── Collapse all nodes ────────────────────────────────────
  const handleCollapseAll = useCallback(() => {
    setExpandedNodes(new Map());
  }, []);

  const handleFilterChange = useCallback((newFilters: {
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
    orderBy?: 'activation_desc' | 'recent_first' | 'created_first';
  }) => {
    onFilterChange({ ...newFilters, page: 0 });
  }, [onFilterChange]);

  // ─── Derived stats ──────────────────────────────────────────
  const expandedCount = expandedNodes.size;
  const maxActiveLayer = useMemo(() => {
    let max = 0;
    for (const state of expandedNodes.values()) {
      if (state.activeLayer > max) max = state.activeLayer;
    }
    return max;
  }, [expandedNodes]);

  return (
    <div className="mlv-container">
      {/* Header with legend */}
      <div className="mlv-header">
        <h2 className="mlv-title">Memory Nodes</h2>
        <LayerLegend />
      </div>

      {/* Bulk expand/collapse controls */}
      {nodes.length > 0 && (
        <div className="mlv-bulk-controls">
          <span className="mlv-bulk-label">
            {expandedCount > 0
              ? `${expandedCount} expanded`
              : 'Expand to:'}
          </span>
          <div className="mlv-bulk-depth-btns">
            {(['L0', 'L1', 'L2', 'L3'] as LayerKey[]).map((layer, i) => (
              <button
                key={layer}
                className={`mlv-bulk-depth-btn ${maxActiveLayer >= i && expandedCount > 0 ? 'mlv-bulk-depth-active' : ''}`}
                style={{
                  borderColor: LAYER_COLORS[layer],
                  color: maxActiveLayer >= i && expandedCount > 0 ? LAYER_COLORS[layer] : undefined,
                }}
                onClick={() => handleExpandAllToDepth(i)}
                title={`Expand all to ${layer}: ${LAYER_LABELS[layer]}`}
              >
                {layer}
              </button>
            ))}
          </div>
          {expandedCount > 0 && (
            <button
              className="mlv-bulk-collapse-btn"
              onClick={handleCollapseAll}
              title="Collapse all nodes"
            >
              Collapse All
            </button>
          )}
        </div>
      )}

      {/* Filter bar (hidden when external NodeFilterBar is used) */}
      {!hideInternalFilterBar && (
        <FilterBar
          total={total}
          activeNodeType={filters.nodeType}
          activeNodeRole={filters.nodeRole}
          activeOrderBy={filters.orderBy}
          onFilterChange={handleFilterChange}
        />
      )}

      {/* Error */}
      {error && (
        <div className="mlv-error">
          <span className="mlv-error-icon">⚠</span>
          {error}
        </div>
      )}

      {/* Loading state */}
      {isLoading && nodes.length === 0 && (
        <div className="mlv-loading">
          <span className="mlv-spinner" />
          Loading memory nodes...
        </div>
      )}

      {/* Empty state */}
      {!isLoading && nodes.length === 0 && !error && (
        <div className="mlv-empty">
          <span className="mlv-empty-icon">🧠</span>
          <span>No memory nodes found</span>
          <span className="mlv-empty-hint">Nodes are created during conversation ingestion</span>
        </div>
      )}

      {/* Node list */}
      <div className="mlv-node-list">
        {nodes.map((node) => {
          const expandedState = expandedNodes.get(node.id);
          return (
            <NodeAccordionRow
              key={node.id}
              node={node}
              fullNode={expandedState?.fullNode ?? null}
              isExpanded={!!expandedState}
              activeLayer={expandedState?.activeLayer ?? 0}
              isLoadingDetail={expandedState?.isLoading ?? false}
              onToggle={() => handleToggle(node.id)}
              onLayerChange={(layer) => handleLayerChange(node.id, layer)}
              onSelect={() => onSelectNode?.(node.id)}
              isSelected={selectedNodeId === node.id}
            />
          );
        })}
      </div>

      {/* Pagination */}
      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={onPageChange}
      />
    </div>
  );
}
