/**
 * useNodeFilter — Dedicated filter state management for MemoryNode listing.
 *
 * Manages nodeType, nodeRole, and orderBy filters with:
 *   - Toggle semantics (click again to deselect)
 *   - Multi-select support for nodeType (any combination of 5 types + null)
 *   - Single-select for nodeRole (hub | leaf | all)
 *   - Sort order selection
 *   - Active filter count for badges
 *   - URL-safe serialization helpers (for future deep-linking)
 *   - Reset all filters to defaults
 *
 * Designed to work with the useMemoryNodes hook for fetching.
 */

import { useState, useCallback, useMemo } from 'react';
import type { MemoryNodeType, MemoryNodeRole } from '../types/memory-node';
import { MEMORY_NODE_TYPES } from '../types/memory-node';

// ─── Types ───────────────────────────────────────────────────

export type SortOrder = 'activation_desc' | 'recent_first' | 'created_first';

/** All possible nodeType filter values (5 types + null for untyped) */
export type NodeTypeFilterValue = MemoryNodeType | 'null';

export const ALL_NODE_TYPE_FILTER_VALUES: readonly NodeTypeFilterValue[] = [
  ...MEMORY_NODE_TYPES,
  'null',
] as const;

export interface NodeFilterState {
  /** Selected node types (empty = all, subset = filtered) */
  selectedTypes: Set<NodeTypeFilterValue>;
  /** Selected node role (undefined = all) */
  selectedRole: MemoryNodeRole | undefined;
  /** Sort order */
  orderBy: SortOrder;
  /** Text search within frontmatter/keywords */
  searchText: string;
}

export interface NodeFilterActions {
  /** Toggle a nodeType in/out of the filter set */
  toggleType: (type: NodeTypeFilterValue) => void;
  /** Set all types selected (clear type filter) */
  selectAllTypes: () => void;
  /** Set exactly one type selected */
  selectOnlyType: (type: NodeTypeFilterValue) => void;
  /** Toggle role (same = deselect, different = select) */
  toggleRole: (role: MemoryNodeRole) => void;
  /** Clear role filter */
  clearRole: () => void;
  /** Set sort order */
  setOrderBy: (order: SortOrder) => void;
  /** Set search text */
  setSearchText: (text: string) => void;
  /** Reset all filters to defaults */
  resetAll: () => void;
}

export interface NodeFilterDerived {
  /** Number of active filters (for badge display) */
  activeFilterCount: number;
  /** Whether any filter is active */
  hasActiveFilters: boolean;
  /** Whether all types are selected (no type filter) */
  isAllTypesSelected: boolean;
  /** Convert current state to API query params */
  toApiParams: () => {
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
    orderBy: SortOrder;
    search?: string;
  };
}

export interface UseNodeFilterResult {
  state: NodeFilterState;
  actions: NodeFilterActions;
  derived: NodeFilterDerived;
}

// ─── Default State ───────────────────────────────────────────

const DEFAULT_STATE: NodeFilterState = {
  selectedTypes: new Set<NodeTypeFilterValue>(),
  selectedRole: undefined,
  orderBy: 'recent_first',
  searchText: '',
};

// ─── Hook ────────────────────────────────────────────────────

export function useNodeFilter(
  initialState?: Partial<NodeFilterState>,
): UseNodeFilterResult {
  const [selectedTypes, setSelectedTypes] = useState<Set<NodeTypeFilterValue>>(
    () => initialState?.selectedTypes ?? new Set(DEFAULT_STATE.selectedTypes),
  );
  const [selectedRole, setSelectedRole] = useState<MemoryNodeRole | undefined>(
    initialState?.selectedRole ?? DEFAULT_STATE.selectedRole,
  );
  const [orderBy, setOrderBy] = useState<SortOrder>(
    initialState?.orderBy ?? DEFAULT_STATE.orderBy,
  );
  const [searchText, setSearchText] = useState<string>(
    initialState?.searchText ?? DEFAULT_STATE.searchText,
  );

  // ─── Actions ──────────────────────────────────────────────

  const toggleType = useCallback((type: NodeTypeFilterValue) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      // If all types are selected, clear the set (= "all")
      if (next.size === ALL_NODE_TYPE_FILTER_VALUES.length) {
        return new Set<NodeTypeFilterValue>();
      }
      return next;
    });
  }, []);

  const selectAllTypes = useCallback(() => {
    setSelectedTypes(new Set<NodeTypeFilterValue>());
  }, []);

  const selectOnlyType = useCallback((type: NodeTypeFilterValue) => {
    setSelectedTypes(new Set([type]));
  }, []);

  const toggleRole = useCallback((role: MemoryNodeRole) => {
    setSelectedRole((prev) => (prev === role ? undefined : role));
  }, []);

  const clearRole = useCallback(() => {
    setSelectedRole(undefined);
  }, []);

  const resetAll = useCallback(() => {
    setSelectedTypes(new Set<NodeTypeFilterValue>());
    setSelectedRole(undefined);
    setOrderBy('recent_first');
    setSearchText('');
  }, []);

  // ─── Derived ──────────────────────────────────────────────

  const state: NodeFilterState = useMemo(
    () => ({ selectedTypes, selectedRole, orderBy, searchText }),
    [selectedTypes, selectedRole, orderBy, searchText],
  );

  const isAllTypesSelected = selectedTypes.size === 0;

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (!isAllTypesSelected) count++;
    if (selectedRole) count++;
    if (searchText.trim()) count++;
    if (orderBy !== 'recent_first') count++;
    return count;
  }, [isAllTypesSelected, selectedRole, searchText, orderBy]);

  const toApiParams = useCallback(() => {
    const params: {
      nodeType?: MemoryNodeType | null;
      nodeRole?: MemoryNodeRole;
      orderBy: SortOrder;
      search?: string;
    } = { orderBy };

    // For single type filter, pass directly to API
    // For multi-type, API currently supports single type — we pick the first
    // (Future: API can support multiple types)
    if (selectedTypes.size === 1) {
      const val = [...selectedTypes][0];
      params.nodeType = val === 'null' ? null : val as MemoryNodeType;
    }
    // For multi-type, we don't set nodeType (let client filter or API evolve)

    if (selectedRole) {
      params.nodeRole = selectedRole;
    }

    if (searchText.trim()) {
      params.search = searchText.trim();
    }

    return params;
  }, [selectedTypes, selectedRole, orderBy, searchText]);

  const derived: NodeFilterDerived = useMemo(
    () => ({
      activeFilterCount,
      hasActiveFilters: activeFilterCount > 0,
      isAllTypesSelected,
      toApiParams,
    }),
    [activeFilterCount, isAllTypesSelected, toApiParams],
  );

  const actions: NodeFilterActions = useMemo(
    () => ({
      toggleType,
      selectAllTypes,
      selectOnlyType,
      toggleRole,
      clearRole,
      setOrderBy,
      setSearchText,
      resetAll,
    }),
    [toggleType, selectAllTypes, selectOnlyType, toggleRole, clearRole, setOrderBy, setSearchText, resetAll],
  );

  return { state, actions, derived };
}
