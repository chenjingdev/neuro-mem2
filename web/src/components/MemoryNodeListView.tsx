/**
 * MemoryNodeListView — Table/list view for MemoryNodes with pagination and column sorting.
 *
 * Provides a tabular alternative to the MemoryLayerView accordion.
 * Features:
 *   - Sortable columns (frontmatter, type, role, activation, event)
 *   - Paginated table with configurable page size
 *   - Filter by nodeType, nodeRole
 *   - Row click → select for detail panel
 *   - Color-coded type/role badges
 *   - Compact keyword chips
 *   - Responsive: gracefully hides columns on narrow widths
 */

import { useState, useCallback, useMemo } from 'react';
import {
  NODE_TYPE_COLORS,
  NODE_ROLE_COLORS,
  NODE_TYPE_ICONS,
  NODE_ROLE_ICONS,
  MEMORY_NODE_TYPES,
  MEMORY_NODE_ROLES,
} from '../types/memory-node';
import type {
  MemoryNodeType,
  MemoryNodeRole,
} from '../types/memory-node';
import type { MemoryNodeRef } from '../hooks/useMemoryNodes';

// ─── Sort State ──────────────────────────────────────────────

export type SortField = 'frontmatter' | 'nodeType' | 'nodeRole' | 'activationCount' | 'lastActivatedAtEvent' | 'keywords';
export type SortDirection = 'asc' | 'desc';

export interface SortState {
  field: SortField;
  direction: SortDirection;
}

// ─── Column Definition ───────────────────────────────────────

interface ColumnDef {
  key: SortField;
  label: string;
  width?: string;
  minWidth?: string;
  sortable: boolean;
  hiddenOnNarrow?: boolean;
}

const COLUMNS: ColumnDef[] = [
  { key: 'frontmatter', label: 'Frontmatter', minWidth: '200px', sortable: true },
  { key: 'nodeType', label: 'Type', width: '110px', sortable: true },
  { key: 'nodeRole', label: 'Role', width: '80px', sortable: true },
  { key: 'keywords', label: 'Keywords', minWidth: '160px', sortable: false, hiddenOnNarrow: true },
  { key: 'activationCount', label: '⚡ Act.', width: '70px', sortable: true },
  { key: 'lastActivatedAtEvent', label: 'Last Event', width: '90px', sortable: true, hiddenOnNarrow: true },
];

// ─── Sort Header Cell ────────────────────────────────────────

interface SortHeaderProps {
  column: ColumnDef;
  currentSort: SortState;
  onSort: (field: SortField) => void;
}

function SortHeader({ column, currentSort, onSort }: SortHeaderProps) {
  const isActive = currentSort.field === column.key;
  const arrow = isActive
    ? currentSort.direction === 'asc' ? ' ▲' : ' ▼'
    : '';

  return (
    <th
      className={`mnl-th ${column.sortable ? 'mnl-th-sortable' : ''} ${isActive ? 'mnl-th-active' : ''} ${column.hiddenOnNarrow ? 'mnl-hide-narrow' : ''}`}
      style={{ width: column.width, minWidth: column.minWidth }}
      onClick={() => column.sortable && onSort(column.key)}
      title={column.sortable ? `Sort by ${column.label}` : column.label}
    >
      {column.label}{arrow}
    </th>
  );
}

// ─── Table Row ───────────────────────────────────────────────

interface NodeRowProps {
  node: MemoryNodeRef;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

function NodeRow({ node, isSelected, onSelect }: NodeRowProps) {
  const typeColor = node.nodeType ? NODE_TYPE_COLORS[node.nodeType] ?? '#b2bec3' : '#b2bec3';
  const roleColor = NODE_ROLE_COLORS[node.nodeRole] ?? '#b2bec3';
  const typeIcon = node.nodeType ? NODE_TYPE_ICONS[node.nodeType] ?? '' : '';
  const roleIcon = NODE_ROLE_ICONS[node.nodeRole] ?? '';

  const keywordChips = useMemo(() => {
    if (!node.keywords) return null;
    const kws = node.keywords.split(' ').filter(Boolean).slice(0, 4);
    return kws.map((kw, i) => (
      <span key={i} className="mnl-keyword-chip">{kw}</span>
    ));
  }, [node.keywords]);

  return (
    <tr
      className={`mnl-row ${isSelected ? 'mnl-row-selected' : ''}`}
      onClick={() => onSelect(node.id)}
      title={`ID: ${node.id}`}
    >
      <td className="mnl-td mnl-td-frontmatter">
        <span className="mnl-frontmatter-text">{node.frontmatter || 'Untitled'}</span>
      </td>
      <td className="mnl-td mnl-td-type">
        {node.nodeType ? (
          <span
            className="mnl-badge mnl-badge-type"
            style={{ backgroundColor: `${typeColor}22`, color: typeColor, borderColor: `${typeColor}44` }}
          >
            {typeIcon} {node.nodeType}
          </span>
        ) : (
          <span className="mnl-badge mnl-badge-untyped">—</span>
        )}
      </td>
      <td className="mnl-td mnl-td-role">
        <span
          className="mnl-badge mnl-badge-role"
          style={{ backgroundColor: `${roleColor}22`, color: roleColor, borderColor: `${roleColor}44` }}
        >
          {roleIcon} {node.nodeRole}
        </span>
      </td>
      <td className="mnl-td mnl-td-keywords mnl-hide-narrow">
        <div className="mnl-keywords-cell">
          {keywordChips ?? <span className="mnl-no-keywords">—</span>}
        </div>
      </td>
      <td className="mnl-td mnl-td-activation">
        <span className="mnl-activation-count">{node.activationCount}</span>
      </td>
      <td className="mnl-td mnl-td-event mnl-hide-narrow">
        <span className="mnl-event-value">{node.lastActivatedAtEvent}</span>
      </td>
    </tr>
  );
}

// ─── Pagination ──────────────────────────────────────────────

interface PaginationBarProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

function PaginationBar({ page, pageSize, total, onPageChange }: PaginationBarProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startItem = page * pageSize + 1;
  const endItem = Math.min((page + 1) * pageSize, total);

  // Generate visible page numbers (show max 7 page buttons)
  const pageNumbers = useMemo(() => {
    const pages: (number | 'ellipsis')[] = [];
    if (totalPages <= 7) {
      for (let i = 0; i < totalPages; i++) pages.push(i);
    } else {
      pages.push(0);
      if (page > 3) pages.push('ellipsis');
      const start = Math.max(1, page - 1);
      const end = Math.min(totalPages - 2, page + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (page < totalPages - 4) pages.push('ellipsis');
      pages.push(totalPages - 1);
    }
    return pages;
  }, [page, totalPages]);

  if (total === 0) return null;

  return (
    <div className="mnl-pagination">
      <span className="mnl-page-info">
        {startItem}–{endItem} of {total.toLocaleString()}
      </span>
      <div className="mnl-page-buttons">
        <button
          className="mnl-page-btn"
          disabled={page === 0}
          onClick={() => onPageChange(0)}
          title="First page"
        >
          ⟪
        </button>
        <button
          className="mnl-page-btn"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
          title="Previous page"
        >
          ◀
        </button>
        {pageNumbers.map((p, i) =>
          p === 'ellipsis' ? (
            <span key={`e${i}`} className="mnl-page-ellipsis">…</span>
          ) : (
            <button
              key={p}
              className={`mnl-page-btn mnl-page-num ${p === page ? 'mnl-page-current' : ''}`}
              onClick={() => onPageChange(p)}
            >
              {p + 1}
            </button>
          )
        )}
        <button
          className="mnl-page-btn"
          disabled={page >= totalPages - 1}
          onClick={() => onPageChange(page + 1)}
          title="Next page"
        >
          ▶
        </button>
        <button
          className="mnl-page-btn"
          disabled={page >= totalPages - 1}
          onClick={() => onPageChange(totalPages - 1)}
          title="Last page"
        >
          ⟫
        </button>
      </div>
    </div>
  );
}

// ─── Filter Bar ──────────────────────────────────────────────

interface ListFilterBarProps {
  total: number;
  activeNodeType: MemoryNodeType | null | undefined;
  activeNodeRole: MemoryNodeRole | undefined;
  onFilterChange: (filters: {
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
  }) => void;
}

function ListFilterBar({ total, activeNodeType, activeNodeRole, onFilterChange }: ListFilterBarProps) {
  return (
    <div className="mnl-filter-bar">
      <span className="mnl-total-count">{total.toLocaleString()} nodes</span>

      <select
        className="mnl-filter-select"
        value={activeNodeType === null ? 'null' : activeNodeType ?? 'all'}
        onChange={(e) => {
          const val = e.target.value;
          onFilterChange({
            nodeType: val === 'all' ? undefined : val === 'null' ? null : val as MemoryNodeType,
            nodeRole: activeNodeRole,
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
        className="mnl-filter-select"
        value={activeNodeRole ?? 'all'}
        onChange={(e) => {
          const val = e.target.value;
          onFilterChange({
            nodeType: activeNodeType,
            nodeRole: val === 'all' ? undefined : val as MemoryNodeRole,
          });
        }}
        title="Filter by node role"
      >
        <option value="all">All Roles</option>
        {MEMORY_NODE_ROLES.map((r) => (
          <option key={r} value={r}>{NODE_ROLE_ICONS[r]} {r}</option>
        ))}
      </select>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

export interface MemoryNodeListViewProps {
  /** Nodes to display (L0 refs) */
  nodes: MemoryNodeRef[];
  /** Total count from backend */
  total: number;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** Current page (0-based) */
  page: number;
  /** Page size */
  pageSize: number;
  /** Page change handler */
  onPageChange: (page: number) => void;
  /** Filter change handler */
  onFilterChange: (filters: {
    page?: number;
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
    orderBy?: 'activation_desc' | 'recent_first' | 'created_first';
  }) => void;
  /** Currently selected node ID */
  selectedNodeId?: string | null;
  /** Node selection handler */
  onSelectNode?: (id: string) => void;
  /** Active filters */
  filters?: {
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
    orderBy?: string;
  };
}

export function MemoryNodeListView({
  nodes,
  total,
  isLoading,
  error,
  page,
  pageSize,
  onPageChange,
  onFilterChange,
  selectedNodeId,
  onSelectNode,
  filters = {},
}: MemoryNodeListViewProps) {
  // Local sort state (client-side sorting within the current page)
  const [sort, setSort] = useState<SortState>({
    field: 'activationCount',
    direction: 'desc',
  });

  const handleSort = useCallback((field: SortField) => {
    setSort((prev) => {
      if (prev.field === field) {
        return { field, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { field, direction: 'desc' };
    });
  }, []);

  // Map sort field → API orderBy parameter
  const mapSortToOrderBy = useCallback((s: SortState): 'activation_desc' | 'recent_first' | 'created_first' | undefined => {
    if (s.field === 'activationCount' && s.direction === 'desc') return 'activation_desc';
    if (s.field === 'lastActivatedAtEvent' && s.direction === 'desc') return 'recent_first';
    if (s.field === 'lastActivatedAtEvent' && s.direction === 'asc') return 'created_first';
    return undefined;
  }, []);

  // Sort nodes client-side for columns not mapped to API sort
  const sortedNodes = useMemo(() => {
    const apiOrderBy = mapSortToOrderBy(sort);
    // If the sort maps to an API orderBy, the backend already sorted. Skip client sort.
    if (apiOrderBy) return nodes;

    // Client-side sort for frontmatter/nodeType/nodeRole/keywords
    const sorted = [...nodes];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sort.field) {
        case 'frontmatter':
          cmp = (a.frontmatter || '').localeCompare(b.frontmatter || '');
          break;
        case 'nodeType':
          cmp = (a.nodeType || '').localeCompare(b.nodeType || '');
          break;
        case 'nodeRole':
          cmp = a.nodeRole.localeCompare(b.nodeRole);
          break;
        case 'keywords':
          cmp = (a.keywords || '').localeCompare(b.keywords || '');
          break;
        default:
          break;
      }
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [nodes, sort, mapSortToOrderBy]);

  // When sort changes and maps to API orderBy, trigger server-side fetch
  const handleSortWithServerSync = useCallback((field: SortField) => {
    const newDirection = sort.field === field
      ? (sort.direction === 'asc' ? 'desc' : 'asc')
      : 'desc';
    const newSort: SortState = { field, direction: newDirection };
    setSort(newSort);

    const apiOrderBy = mapSortToOrderBy(newSort);
    if (apiOrderBy) {
      onFilterChange({
        page: 0,
        nodeType: filters.nodeType,
        nodeRole: filters.nodeRole,
        orderBy: apiOrderBy,
      });
    }
  }, [sort, filters, onFilterChange, mapSortToOrderBy]);

  const handleFilterChange = useCallback((newFilters: {
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
  }) => {
    onFilterChange({
      ...newFilters,
      page: 0,
      orderBy: mapSortToOrderBy(sort) ?? (filters.orderBy as 'activation_desc' | 'recent_first' | 'created_first' | undefined),
    });
  }, [onFilterChange, sort, filters.orderBy, mapSortToOrderBy]);

  const handleSelect = useCallback((id: string) => {
    onSelectNode?.(id);
  }, [onSelectNode]);

  return (
    <div className="mnl-container">
      {/* Filter bar */}
      <ListFilterBar
        total={total}
        activeNodeType={filters.nodeType}
        activeNodeRole={filters.nodeRole}
        onFilterChange={handleFilterChange}
      />

      {/* Error */}
      {error && (
        <div className="mnl-error">
          <span className="mnl-error-icon">⚠</span>
          {error}
        </div>
      )}

      {/* Loading state */}
      {isLoading && nodes.length === 0 && (
        <div className="mnl-loading">
          <span className="mnl-spinner" />
          Loading memory nodes...
        </div>
      )}

      {/* Empty state */}
      {!isLoading && nodes.length === 0 && !error && (
        <div className="mnl-empty">
          <span className="mnl-empty-icon">🧠</span>
          <span>No memory nodes found</span>
          <span className="mnl-empty-hint">Nodes are created during conversation ingestion</span>
        </div>
      )}

      {/* Table */}
      {nodes.length > 0 && (
        <div className="mnl-table-wrapper">
          <table className="mnl-table">
            <thead className="mnl-thead">
              <tr>
                {COLUMNS.map((col) => (
                  <SortHeader
                    key={col.key}
                    column={col}
                    currentSort={sort}
                    onSort={handleSortWithServerSync}
                  />
                ))}
              </tr>
            </thead>
            <tbody className="mnl-tbody">
              {sortedNodes.map((node) => (
                <NodeRow
                  key={node.id}
                  node={node}
                  isSelected={selectedNodeId === node.id}
                  onSelect={handleSelect}
                />
              ))}
            </tbody>
          </table>

          {/* Loading overlay for page transitions */}
          {isLoading && (
            <div className="mnl-loading-overlay">
              <span className="mnl-spinner" />
            </div>
          )}
        </div>
      )}

      {/* Pagination */}
      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={onPageChange}
      />
    </div>
  );
}
