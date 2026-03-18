/**
 * MemoryExplorerPage — Page for exploring MemoryNodes with layer-by-layer depth.
 *
 * Composes NodeFilterBar + MemoryLayerView + DetailPanel for a full memory
 * exploration experience. Uses useNodeFilter for dedicated filter state management
 * and useMemoryNodes for data fetching.
 */

import { useState, useCallback, useEffect } from 'react';
import { MemoryLayerView } from '../components/MemoryLayerView';
import { MemoryNodeListView } from '../components/MemoryNodeListView';
import { NodeFilterBar } from '../components/NodeFilterBar';
import { DetailPanel } from '../components/DetailPanel';
import { SearchPanel } from '../components/SearchPanel';
import { useMemoryNodes } from '../hooks/useMemoryNodes';
import { useNodeFilter } from '../hooks/useNodeFilter';
import type { MemoryNodeType, MemoryNodeRole } from '../types/memory-node';

type ExplorerViewMode = 'accordion' | 'table';

interface MemoryExplorerPageProps {
  /** Navigate back to chat */
  onNavigateToChat?: () => void;
}

export function MemoryExplorerPage({ onNavigateToChat }: MemoryExplorerPageProps) {
  const {
    nodes,
    total,
    isLoading,
    error,
    page,
    pageSize,
    fetchNodes,
    fetchNodeDetail,
    selectedNode,
    isLoadingDetail,
    selectNode,
    clearSelection,
  } = useMemoryNodes();

  // View mode toggle
  const [viewMode, setViewMode] = useState<ExplorerViewMode>('accordion');

  // Dedicated filter state
  const { state: filterState, actions: filterActions, derived: filterDerived } = useNodeFilter();

  // Fetch nodes using the filter state
  const doFetch = useCallback(
    (pageOverride?: number) => {
      const params = filterDerived.toApiParams();
      fetchNodes({
        page: pageOverride ?? 0,
        nodeType: params.nodeType,
        nodeRole: params.nodeRole,
        orderBy: params.orderBy,
      });
    },
    [fetchNodes, filterDerived],
  );

  // Fetch on mount
  useEffect(() => {
    doFetch(0);
  }, []);

  // Re-fetch when filters change (triggered by NodeFilterBar callback)
  const handleFiltersChanged = useCallback(() => {
    doFetch(0);
  }, [doFetch]);

  // Legacy handler for MemoryLayerView's internal filter bar
  const handleFilterChange = useCallback(
    (newFilters: {
      page?: number;
      nodeType?: MemoryNodeType | null;
      nodeRole?: MemoryNodeRole;
      orderBy?: 'activation_desc' | 'recent_first' | 'created_first';
    }) => {
      // Sync MemoryLayerView's filter changes to useNodeFilter state
      if (newFilters.nodeType !== undefined) {
        if (newFilters.nodeType === null) {
          filterActions.selectOnlyType('null');
        } else if (newFilters.nodeType) {
          filterActions.selectOnlyType(newFilters.nodeType);
        } else {
          filterActions.selectAllTypes();
        }
      }
      if (newFilters.nodeRole !== undefined) {
        if (newFilters.nodeRole) {
          if (filterState.selectedRole !== newFilters.nodeRole) {
            filterActions.toggleRole(newFilters.nodeRole);
          }
        } else {
          filterActions.clearRole();
        }
      }
      if (newFilters.orderBy) {
        filterActions.setOrderBy(newFilters.orderBy);
      }

      // Do the fetch
      fetchNodes({
        page: newFilters.page ?? 0,
        nodeType: newFilters.nodeType,
        nodeRole: newFilters.nodeRole,
        orderBy: newFilters.orderBy,
      });
    },
    [fetchNodes, filterActions, filterState.selectedRole],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      doFetch(newPage);
    },
    [doFetch],
  );

  const handleSelectNode = useCallback(
    (id: string) => {
      selectNode(id);
    },
    [selectNode],
  );

  // Build legacy filters object for MemoryLayerView compatibility
  const legacyFilters = {
    nodeType: filterState.selectedTypes.size === 1
      ? ([...filterState.selectedTypes][0] === 'null'
        ? null
        : [...filterState.selectedTypes][0] as MemoryNodeType)
      : undefined,
    nodeRole: filterState.selectedRole,
    orderBy: filterState.orderBy,
  };

  return (
    <div className="memory-explorer-page">
      {/* Header */}
      <header className="mep-header">
        <div className="header-left">
          {onNavigateToChat && (
            <button
              className="btn-back-to-chat"
              onClick={onNavigateToChat}
              title="Back to Chat"
            >
              ◀ Chat
            </button>
          )}
          <h1 className="app-title">🧠 Memory Explorer</h1>
        </div>
        <div className="header-right">
          <div className="mep-view-toggle">
            <button
              className={`mep-view-btn ${viewMode === 'accordion' ? 'mep-view-btn-active' : ''}`}
              onClick={() => setViewMode('accordion')}
              title="Accordion view (expandable layers)"
            >
              ☰ Layers
            </button>
            <button
              className={`mep-view-btn ${viewMode === 'table' ? 'mep-view-btn-active' : ''}`}
              onClick={() => setViewMode('table')}
              title="Table view (sortable columns)"
            >
              ▤ Table
            </button>
          </div>
          <button
            className="btn btn-refresh"
            onClick={() => doFetch(page)}
            title="Refresh node list"
          >
            ↻ Refresh
          </button>
        </div>
      </header>

      {/* Search Panel — FTS5 + vector hybrid search */}
      <SearchPanel
        onSelectNode={handleSelectNode}
        selectedNodeId={selectedNode?.node?.id ?? null}
      />

      {/* Main content */}
      <div className="mep-body">
        {/* Left panel: Filter bar + Layer view */}
        <div className={`mep-list-panel ${selectedNode ? 'mep-list-with-detail' : ''}`}>
          {/* New NodeFilterBar */}
          <NodeFilterBar
            state={filterState}
            actions={filterActions}
            derived={filterDerived}
            total={total}
            onFiltersChanged={handleFiltersChanged}
          />

          {/* View mode: Accordion (layers) or Table */}
          {viewMode === 'accordion' ? (
            <MemoryLayerView
              nodes={nodes}
              total={total}
              isLoading={isLoading}
              error={error}
              page={page}
              pageSize={pageSize}
              onFetchDetail={fetchNodeDetail}
              onFilterChange={handleFilterChange}
              onPageChange={handlePageChange}
              selectedNodeId={selectedNode?.node?.id ?? null}
              onSelectNode={handleSelectNode}
              filters={legacyFilters}
              hideInternalFilterBar
            />
          ) : (
            <MemoryNodeListView
              nodes={nodes}
              total={total}
              isLoading={isLoading}
              error={error}
              page={page}
              pageSize={pageSize}
              onFilterChange={handleFilterChange}
              onPageChange={handlePageChange}
              selectedNodeId={selectedNode?.node?.id ?? null}
              onSelectNode={handleSelectNode}
              filters={legacyFilters}
            />
          )}
        </div>

        {/* Right: Detail panel */}
        {selectedNode && (
          <div className="mep-detail-panel">
            <DetailPanel
              memoryNode={selectedNode.node}
              edges={selectedNode.edges}
              decay={selectedNode.decay}
              onClose={clearSelection}
            />
          </div>
        )}

        {/* Loading overlay for detail */}
        {isLoadingDetail && !selectedNode && (
          <div className="mep-detail-panel mep-detail-loading">
            <div className="mlv-loading">
              <span className="mlv-spinner" />
              Loading node details...
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
