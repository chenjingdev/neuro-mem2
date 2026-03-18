/**
 * NodeFilterBar — Pill/chip-based toggle filter UI for MemoryNode nodeType + nodeRole.
 *
 * Features:
 *   - Chip toggles for each nodeType (semantic, episodic, procedural, prospective, emotional, untyped)
 *   - Chip toggles for nodeRole (hub, leaf)
 *   - "All" chip to clear type/role filter
 *   - Sort order selector (dropdown)
 *   - Text search input (frontmatter/keywords)
 *   - Active filter count badge
 *   - Reset all button
 *   - Collapsible mode (compact inline summary)
 *   - Total count display
 *
 * Works with useNodeFilter hook for state management.
 */

import { useState, useCallback, useRef, useEffect, type CSSProperties } from 'react';
import './NodeFilterBar.css';
import {
  NODE_TYPE_COLORS,
  NODE_TYPE_ICONS,
  NODE_ROLE_COLORS,
  NODE_ROLE_ICONS,
  MEMORY_NODE_TYPES,
  MEMORY_NODE_ROLES,
} from '../types/memory-node';
import type { MemoryNodeType, MemoryNodeRole } from '../types/memory-node';
import type {
  NodeFilterState,
  NodeFilterActions,
  NodeFilterDerived,
  NodeTypeFilterValue,
  SortOrder,
} from '../hooks/useNodeFilter';

// ─── Props ───────────────────────────────────────────────────

export interface NodeFilterBarProps {
  state: NodeFilterState;
  actions: NodeFilterActions;
  derived: NodeFilterDerived;
  /** Total number of matching nodes (shown as count) */
  total?: number;
  /** Callback when filters change (for triggering fetch) */
  onFiltersChanged?: () => void;
  /** Start in collapsed mode */
  defaultCollapsed?: boolean;
  /** Node type counts (for showing per-type counts on chips) */
  typeCounts?: Partial<Record<NodeTypeFilterValue, number>>;
  /** Node role counts */
  roleCounts?: Partial<Record<MemoryNodeRole, number>>;
}

// ─── Sort Options ─────────────────────────────────────────────

const SORT_OPTIONS: { value: SortOrder; label: string; icon: string }[] = [
  { value: 'recent_first', label: 'Recent First', icon: '🕐' },
  { value: 'activation_desc', label: 'Most Active', icon: '⚡' },
  { value: 'created_first', label: 'Oldest First', icon: '📅' },
];

// ─── Component ───────────────────────────────────────────────

export function NodeFilterBar({
  state,
  actions,
  derived,
  total,
  onFiltersChanged,
  defaultCollapsed = false,
  typeCounts,
  roleCounts,
}: NodeFilterBarProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Notify parent when filters change
  const prevStateRef = useRef(state);
  useEffect(() => {
    if (prevStateRef.current !== state) {
      prevStateRef.current = state;
      onFiltersChanged?.();
    }
  }, [state, onFiltersChanged]);

  // Search input with debounce
  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      // Update immediately for UI responsiveness
      actions.setSearchText(value);
      // Debounce the actual search trigger
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
      searchDebounceRef.current = setTimeout(() => {
        onFiltersChanged?.();
      }, 300);
    },
    [actions, onFiltersChanged],
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, []);

  const handleReset = useCallback(() => {
    actions.resetAll();
  }, [actions]);

  // ─── Collapsed Mode ──────────────────────────────────────

  if (isCollapsed) {
    return (
      <div className="nfb nfb--collapsed">
        <button
          className="nfb__toggle-btn"
          onClick={() => setIsCollapsed(false)}
          title="Expand filters"
        >
          ▶ Filters
        </button>
        <span className="nfb__badge nfb__badge--zero">
          {derived.activeFilterCount}
        </span>

        {/* Inline summary of active filters */}
        {derived.hasActiveFilters && (
          <div className="nfb__inline-summary">
            {/* Show selected types */}
            {!derived.isAllTypesSelected &&
              [...state.selectedTypes].map((type) => {
                const isNull = type === 'null';
                const color = isNull ? '#b2bec3' : NODE_TYPE_COLORS[type as MemoryNodeType] ?? '#b2bec3';
                const icon = isNull ? '⬜' : NODE_TYPE_ICONS[type as MemoryNodeType] ?? '';
                return (
                  <span
                    key={type}
                    className="nfb__inline-chip"
                    style={{ '--chip-color': color } as CSSProperties}
                  >
                    {icon} {type === 'null' ? 'untyped' : type}
                  </span>
                );
              })}
            {/* Show selected role */}
            {state.selectedRole && (
              <span
                className="nfb__inline-chip"
                style={{ '--chip-color': NODE_ROLE_COLORS[state.selectedRole] } as CSSProperties}
              >
                {NODE_ROLE_ICONS[state.selectedRole]} {state.selectedRole}
              </span>
            )}
            {/* Show search */}
            {state.searchText.trim() && (
              <span className="nfb__inline-chip">
                🔍 {state.searchText.slice(0, 20)}{state.searchText.length > 20 ? '…' : ''}
              </span>
            )}
          </div>
        )}

        {total != null && (
          <span className="nfb__total">
            <span className="nfb__total-number">{total.toLocaleString()}</span> nodes
          </span>
        )}
      </div>
    );
  }

  // ─── Expanded Mode ───────────────────────────────────────

  return (
    <div className="nfb">
      {/* Header */}
      <div className="nfb__header">
        <span className="nfb__title">
          Filters
          <span
            className={`nfb__badge ${derived.activeFilterCount === 0 ? 'nfb__badge--zero' : ''}`}
          >
            {derived.activeFilterCount}
          </span>
        </span>

        <div className="nfb__header-actions">
          {derived.hasActiveFilters && (
            <button
              className="nfb__btn nfb__btn--reset"
              onClick={handleReset}
              title="Reset all filters"
            >
              ✕ Reset
            </button>
          )}
          <button
            className="nfb__toggle-btn"
            onClick={() => setIsCollapsed(true)}
            title="Collapse filters"
          >
            ▼
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="nfb__search">
        <span className="nfb__search-icon">🔍</span>
        <input
          type="text"
          className="nfb__search-input"
          placeholder="Search frontmatter / keywords…"
          value={state.searchText}
          onChange={handleSearchChange}
          aria-label="Search memory nodes"
        />
        {state.searchText && (
          <button
            className="nfb__search-clear"
            onClick={() => actions.setSearchText('')}
            title="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      {/* Node Type Chips */}
      <div className="nfb__section">
        <span className="nfb__section-label">Node Type</span>
        <div className="nfb__chips">
          {/* "All" chip */}
          <button
            className={`nfb__chip nfb__chip--all ${derived.isAllTypesSelected ? 'nfb__chip--active' : ''}`}
            onClick={actions.selectAllTypes}
            title="Show all node types"
          >
            All
          </button>

          {/* Individual type chips */}
          {MEMORY_NODE_TYPES.map((type) => {
            const isActive = state.selectedTypes.has(type);
            const color = NODE_TYPE_COLORS[type] ?? '#b2bec3';
            const icon = NODE_TYPE_ICONS[type] ?? '';
            const count = typeCounts?.[type];

            return (
              <button
                key={type}
                className={`nfb__chip ${isActive ? 'nfb__chip--active' : ''}`}
                style={{ '--chip-color': color } as CSSProperties}
                onClick={() => actions.toggleType(type)}
                title={`Filter by ${type}`}
                aria-pressed={isActive}
              >
                <span className="nfb__chip-icon">{icon}</span>
                {type}
                {count != null && (
                  <span className="nfb__chip-count">{count}</span>
                )}
              </button>
            );
          })}

          {/* "Untyped" chip */}
          <button
            className={`nfb__chip ${state.selectedTypes.has('null') ? 'nfb__chip--active' : ''}`}
            style={{ '--chip-color': '#b2bec3' } as CSSProperties}
            onClick={() => actions.toggleType('null')}
            title="Filter by untyped nodes"
            aria-pressed={state.selectedTypes.has('null')}
          >
            <span className="nfb__chip-icon">⬜</span>
            untyped
            {typeCounts?.null != null && (
              <span className="nfb__chip-count">{typeCounts.null}</span>
            )}
          </button>
        </div>
      </div>

      {/* Node Role Chips */}
      <div className="nfb__section">
        <span className="nfb__section-label">Node Role</span>
        <div className="nfb__chips">
          {/* "All" chip */}
          <button
            className={`nfb__chip nfb__chip--all ${!state.selectedRole ? 'nfb__chip--active' : ''}`}
            onClick={actions.clearRole}
            title="Show all roles"
          >
            All
          </button>

          {/* Role chips */}
          {MEMORY_NODE_ROLES.map((role) => {
            const isActive = state.selectedRole === role;
            const color = NODE_ROLE_COLORS[role] ?? '#b2bec3';
            const icon = NODE_ROLE_ICONS[role] ?? '';
            const count = roleCounts?.[role];

            return (
              <button
                key={role}
                className={`nfb__chip ${isActive ? 'nfb__chip--active' : ''}`}
                style={{ '--chip-color': color } as CSSProperties}
                onClick={() => actions.toggleRole(role)}
                title={`Filter by ${role}`}
                aria-pressed={isActive}
              >
                <span className="nfb__chip-icon">{icon}</span>
                {role}
                {count != null && (
                  <span className="nfb__chip-count">{count}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Sort + Total Row */}
      <div className="nfb__sort">
        <span className="nfb__sort-label">Sort</span>
        <select
          className="nfb__sort-select"
          value={state.orderBy}
          onChange={(e) => actions.setOrderBy(e.target.value as SortOrder)}
          aria-label="Sort order"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.icon} {opt.label}
            </option>
          ))}
        </select>

        {total != null && (
          <span className="nfb__total">
            <span className="nfb__total-number">{total.toLocaleString()}</span> nodes
          </span>
        )}
      </div>
    </div>
  );
}
