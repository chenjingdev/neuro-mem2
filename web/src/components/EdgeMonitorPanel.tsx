/**
 * EdgeMonitorPanel — Real-time edge weight/shield monitoring table.
 *
 * Features:
 *   - Paginated edge list with weight, shield, effective values, decay info
 *   - Column-header sorting (click to toggle asc/desc)
 *   - Filter by edge type, source/target role, weight range
 *   - Visual health indicators (progress bars, color coding)
 *   - Stats summary bar (total edges, avg weight, dead count)
 *   - Auto-refresh support
 */

import { useState, useMemo, useCallback } from 'react';
import {
  useEdgeMonitor,
  type EdgeMonitorSort,
  type EdgeMonitorFilter,
  type EdgeSortField,
  type EdgeMonitorItem,
} from '../hooks/useEdgeMonitor';

// ─── Constants ───────────────────────────────────────────────

const EDGE_TYPES = ['about', 'related', 'caused', 'precedes', 'refines', 'contradicts'] as const;

const EDGE_TYPE_COLORS: Record<string, string> = {
  about: '#4a9eff',
  related: '#00b894',
  caused: '#ff7675',
  precedes: '#fdcb6e',
  refines: '#6c5ce7',
  contradicts: '#e84393',
};

const EDGE_TYPE_LABELS: Record<string, string> = {
  about: 'About',
  related: 'Related',
  caused: 'Caused',
  precedes: 'Precedes',
  refines: 'Refines',
  contradicts: 'Contradicts',
};

// ─── Sub-Components ──────────────────────────────────────────

function WeightBar({ value, maxValue, color, label }: {
  value: number;
  maxValue: number;
  color: string;
  label?: string;
}) {
  const pct = maxValue > 0 ? Math.min(100, (value / maxValue) * 100) : 0;
  return (
    <div className="em-weight-bar" title={label ?? `${value.toFixed(2)} / ${maxValue}`}>
      <div
        className="em-weight-bar-fill"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
      <span className="em-weight-bar-text">{value.toFixed(1)}</span>
    </div>
  );
}

function HealthIndicator({ percent, isDead }: { percent: number; isDead: boolean }) {
  const color = isDead
    ? '#ff4444'
    : percent >= 80
      ? '#00b894'
      : percent >= 50
        ? '#fdcb6e'
        : percent >= 20
          ? '#ff7675'
          : '#e84393';

  return (
    <div
      className="em-health-dot"
      style={{ backgroundColor: color }}
      title={isDead ? 'Dead (0%)' : `${percent}% health`}
    />
  );
}

function EdgeTypeBadge({ type }: { type: string }) {
  const color = EDGE_TYPE_COLORS[type] ?? '#8b8b9e';
  return (
    <span
      className="em-edge-type-badge"
      style={{ borderColor: color, color }}
    >
      {EDGE_TYPE_LABELS[type] ?? type}
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  const isHub = role === 'hub';
  return (
    <span className={`em-role-badge ${isHub ? 'em-role-hub' : 'em-role-leaf'}`}>
      {isHub ? 'H' : 'L'}
    </span>
  );
}

function SortIcon({ active, direction }: { active: boolean; direction: 'asc' | 'desc' }) {
  if (!active) return <span className="em-sort-icon em-sort-inactive">⇅</span>;
  return (
    <span className="em-sort-icon em-sort-active">
      {direction === 'asc' ? '↑' : '↓'}
    </span>
  );
}

// ─── Filter Bar ──────────────────────────────────────────────

function EdgeFilterBar({
  filter,
  onFilterChange,
}: {
  filter: EdgeMonitorFilter;
  onFilterChange: (f: EdgeMonitorFilter) => void;
}) {
  return (
    <div className="em-filter-bar">
      <div className="em-filter-group">
        <label className="em-filter-label">Edge Type</label>
        <select
          className="em-filter-select"
          value={filter.edgeType ?? ''}
          onChange={(e) =>
            onFilterChange({ ...filter, edgeType: e.target.value || undefined })
          }
        >
          <option value="">All</option>
          {EDGE_TYPES.map((t) => (
            <option key={t} value={t}>{EDGE_TYPE_LABELS[t]}</option>
          ))}
        </select>
      </div>

      <div className="em-filter-group">
        <label className="em-filter-label">Source</label>
        <select
          className="em-filter-select"
          value={filter.sourceType ?? ''}
          onChange={(e) =>
            onFilterChange({
              ...filter,
              sourceType: (e.target.value || undefined) as 'hub' | 'leaf' | undefined,
            })
          }
        >
          <option value="">All</option>
          <option value="hub">Hub</option>
          <option value="leaf">Leaf</option>
        </select>
      </div>

      <div className="em-filter-group">
        <label className="em-filter-label">Target</label>
        <select
          className="em-filter-select"
          value={filter.targetType ?? ''}
          onChange={(e) =>
            onFilterChange({
              ...filter,
              targetType: (e.target.value || undefined) as 'hub' | 'leaf' | undefined,
            })
          }
        >
          <option value="">All</option>
          <option value="hub">Hub</option>
          <option value="leaf">Leaf</option>
        </select>
      </div>

      <div className="em-filter-group">
        <label className="em-filter-label">Min Weight</label>
        <input
          type="number"
          className="em-filter-input"
          value={filter.minWeight ?? ''}
          min={0}
          max={100}
          step={1}
          placeholder="0"
          onChange={(e) =>
            onFilterChange({
              ...filter,
              minWeight: e.target.value ? Number(e.target.value) : undefined,
            })
          }
        />
      </div>

      <div className="em-filter-group">
        <label className="em-filter-label">Max Weight</label>
        <input
          type="number"
          className="em-filter-input"
          value={filter.maxWeight ?? ''}
          min={0}
          max={100}
          step={1}
          placeholder="100"
          onChange={(e) =>
            onFilterChange({
              ...filter,
              maxWeight: e.target.value ? Number(e.target.value) : undefined,
            })
          }
        />
      </div>

      <div className="em-filter-group">
        <label className="em-filter-label">Search</label>
        <input
          type="text"
          className="em-filter-input em-filter-search"
          value={filter.searchQuery ?? ''}
          placeholder="node label..."
          onChange={(e) =>
            onFilterChange({ ...filter, searchQuery: e.target.value || undefined })
          }
        />
      </div>
    </div>
  );
}

// ─── Stats Bar ───────────────────────────────────────────────

function StatsBar({
  stats,
  totalEdges,
  currentEvent,
}: {
  stats: { totalEdges: number; avgWeight: number; avgShield: number; deadCount: number; byType: Record<string, number> } | null;
  totalEdges: number;
  currentEvent: number;
}) {
  if (!stats) return null;

  return (
    <div className="em-stats-bar">
      <div className="em-stat-chip">
        <span className="em-stat-label">Total</span>
        <span className="em-stat-value">{totalEdges.toLocaleString()}</span>
      </div>
      <div className="em-stat-chip">
        <span className="em-stat-label">Avg Weight</span>
        <span className="em-stat-value">{stats.avgWeight.toFixed(1)}</span>
      </div>
      <div className="em-stat-chip">
        <span className="em-stat-label">Avg Shield</span>
        <span className="em-stat-value">{stats.avgShield.toFixed(1)}</span>
      </div>
      <div className="em-stat-chip em-stat-dead">
        <span className="em-stat-label">Dead</span>
        <span className="em-stat-value">{stats.deadCount}</span>
      </div>
      <div className="em-stat-chip">
        <span className="em-stat-label">Event#</span>
        <span className="em-stat-value">{currentEvent.toFixed(1)}</span>
      </div>
      {Object.entries(stats.byType).map(([type, count]) => (
        <div key={type} className="em-stat-chip em-stat-type-chip">
          <span
            className="em-stat-type-dot"
            style={{ backgroundColor: EDGE_TYPE_COLORS[type] ?? '#8b8b9e' }}
          />
          <span className="em-stat-label">{type}</span>
          <span className="em-stat-value">{count}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Pagination ──────────────────────────────────────────────

function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;

  const pages: (number | '...')[] = [];
  for (let i = 0; i < totalPages; i++) {
    if (i === 0 || i === totalPages - 1 || Math.abs(i - page) <= 2) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== '...') {
      pages.push('...');
    }
  }

  return (
    <div className="em-pagination">
      <button
        className="em-page-btn"
        disabled={page === 0}
        onClick={() => onPageChange(page - 1)}
      >
        ‹
      </button>
      {pages.map((p, i) =>
        p === '...' ? (
          <span key={`dots-${i}`} className="em-page-dots">…</span>
        ) : (
          <button
            key={p}
            className={`em-page-btn ${p === page ? 'em-page-active' : ''}`}
            onClick={() => onPageChange(p)}
          >
            {p + 1}
          </button>
        ),
      )}
      <button
        className="em-page-btn"
        disabled={page >= totalPages - 1}
        onClick={() => onPageChange(page + 1)}
      >
        ›
      </button>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

interface EdgeMonitorPanelProps {
  onNavigateBack?: () => void;
  onEdgeClick?: (edgeId: string) => void;
  onNodeClick?: (nodeId: string) => void;
  autoRefreshMs?: number;
}

export function EdgeMonitorPanel({
  onNavigateBack,
  onEdgeClick,
  onNodeClick,
  autoRefreshMs = 5000,
}: EdgeMonitorPanelProps) {
  const {
    edges,
    stats,
    isLoading,
    error,
    page,
    totalPages,
    totalEdges,
    sort,
    filter,
    currentEvent,
    setPage,
    setSort,
    setFilter,
    refresh,
  } = useEdgeMonitor({ autoRefreshMs });

  const [expandedEdgeId, setExpandedEdgeId] = useState<string | null>(null);

  const handleSort = useCallback(
    (field: EdgeSortField) => {
      setSort({
        field,
        direction: sort.field === field && sort.direction === 'desc' ? 'asc' : 'desc',
      });
    },
    [sort, setSort],
  );

  const columns: Array<{ field: EdgeSortField; label: string; width: string }> = useMemo(
    () => [
      { field: 'weight', label: 'Weight', width: '110px' },
      { field: 'effectiveWeight', label: 'Eff.Weight', width: '110px' },
      { field: 'shield', label: 'Shield', width: '110px' },
      { field: 'effectiveShield', label: 'Eff.Shield', width: '110px' },
      { field: 'activationCount', label: 'Activations', width: '80px' },
      { field: 'decayRate', label: 'Decay Rate', width: '80px' },
      { field: 'lastActivatedAtEvent', label: 'Last Event', width: '80px' },
    ],
    [],
  );

  return (
    <div className="em-panel">
      {/* Header */}
      <div className="em-header">
        <div className="em-header-left">
          {onNavigateBack && (
            <button className="em-back-btn" onClick={onNavigateBack} title="Back">
              ←
            </button>
          )}
          <h2 className="em-title">Edge Monitor</h2>
          {isLoading && <span className="em-loading-indicator" />}
        </div>
        <div className="em-header-right">
          <button className="em-refresh-btn" onClick={refresh} disabled={isLoading}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Stats Bar */}
      <StatsBar stats={stats} totalEdges={totalEdges} currentEvent={currentEvent} />

      {/* Filter Bar */}
      <EdgeFilterBar filter={filter} onFilterChange={setFilter} />

      {/* Error */}
      {error && <div className="em-error">{error}</div>}

      {/* Table */}
      <div className="em-table-container">
        <table className="em-table">
          <thead>
            <tr>
              <th className="em-th em-th-health" style={{ width: '32px' }}></th>
              <th className="em-th em-th-type" style={{ width: '90px' }}>Type</th>
              <th className="em-th em-th-source" style={{ width: '180px' }}>Source</th>
              <th className="em-th em-th-arrow" style={{ width: '24px' }}></th>
              <th className="em-th em-th-target" style={{ width: '180px' }}>Target</th>
              {columns.map((col) => (
                <th
                  key={col.field}
                  className="em-th em-th-sortable"
                  style={{ width: col.width }}
                  onClick={() => handleSort(col.field)}
                >
                  <span className="em-th-label">{col.label}</span>
                  <SortIcon active={sort.field === col.field} direction={sort.direction} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {edges.length === 0 && !isLoading && (
              <tr>
                <td colSpan={12} className="em-empty">
                  No edges found. Adjust filters or ingest some data first.
                </td>
              </tr>
            )}
            {edges.map((edge) => (
              <EdgeRow
                key={edge.id}
                edge={edge}
                isExpanded={expandedEdgeId === edge.id}
                onToggleExpand={() =>
                  setExpandedEdgeId(expandedEdgeId === edge.id ? null : edge.id)
                }
                onEdgeClick={onEdgeClick}
                onNodeClick={onNodeClick}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}

// ─── Edge Row ────────────────────────────────────────────────

function EdgeRow({
  edge,
  isExpanded,
  onToggleExpand,
  onEdgeClick,
  onNodeClick,
}: {
  edge: EdgeMonitorItem;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onEdgeClick?: (edgeId: string) => void;
  onNodeClick?: (nodeId: string) => void;
}) {
  const weightColor = edge.isDead ? '#ff4444' : '#4a9eff';
  const shieldColor = edge.shield > 0 ? '#6c5ce7' : '#3a3a4a';
  const effWeightColor = edge.isDead ? '#ff4444' : edge.healthPercent >= 80 ? '#00b894' : '#fdcb6e';
  const effShieldColor = edge.effectiveShield > 0 ? '#a29bfe' : '#3a3a4a';

  return (
    <>
      <tr
        className={`em-row ${edge.isDead ? 'em-row-dead' : ''} ${isExpanded ? 'em-row-expanded' : ''}`}
        onClick={onToggleExpand}
      >
        <td className="em-td em-td-health">
          <HealthIndicator percent={edge.healthPercent} isDead={edge.isDead} />
        </td>
        <td className="em-td em-td-type">
          <EdgeTypeBadge type={edge.edgeType} />
        </td>
        <td className="em-td em-td-node">
          <div className="em-node-ref">
            {edge.sourceRole && <RoleBadge role={edge.sourceRole} />}
            <span
              className="em-node-label"
              onClick={(e) => {
                e.stopPropagation();
                onNodeClick?.(edge.sourceId);
              }}
              title={edge.sourceId}
            >
              {edge.sourceLabel || edge.sourceId.slice(0, 12) + '…'}
            </span>
          </div>
        </td>
        <td className="em-td em-td-arrow">→</td>
        <td className="em-td em-td-node">
          <div className="em-node-ref">
            {edge.targetRole && <RoleBadge role={edge.targetRole} />}
            <span
              className="em-node-label"
              onClick={(e) => {
                e.stopPropagation();
                onNodeClick?.(edge.targetId);
              }}
              title={edge.targetId}
            >
              {edge.targetLabel || edge.targetId.slice(0, 12) + '…'}
            </span>
          </div>
        </td>
        <td className="em-td em-td-bar">
          <WeightBar value={edge.weight} maxValue={100} color={weightColor} />
        </td>
        <td className="em-td em-td-bar">
          <WeightBar
            value={edge.effectiveWeight}
            maxValue={100}
            color={effWeightColor}
          />
        </td>
        <td className="em-td em-td-bar">
          <WeightBar value={edge.shield} maxValue={100} color={shieldColor} />
        </td>
        <td className="em-td em-td-bar">
          <WeightBar
            value={edge.effectiveShield}
            maxValue={100}
            color={effShieldColor}
          />
        </td>
        <td className="em-td em-td-num">{edge.activationCount}</td>
        <td className="em-td em-td-num">{edge.decayRate.toFixed(3)}</td>
        <td className="em-td em-td-num">{edge.lastActivatedAtEvent.toFixed(1)}</td>
      </tr>
      {isExpanded && (
        <tr className="em-detail-row">
          <td colSpan={12}>
            <EdgeDetail edge={edge} onEdgeClick={onEdgeClick} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Edge Detail (expanded row) ──────────────────────────────

function EdgeDetail({
  edge,
  onEdgeClick,
}: {
  edge: EdgeMonitorItem;
  onEdgeClick?: (edgeId: string) => void;
}) {
  return (
    <div className="em-detail">
      <div className="em-detail-grid">
        <div className="em-detail-section">
          <h4 className="em-detail-heading">Identity</h4>
          <div className="em-detail-field">
            <span className="em-detail-key">Edge ID</span>
            <span
              className="em-detail-value em-clickable"
              onClick={() => onEdgeClick?.(edge.id)}
            >
              {edge.id}
            </span>
          </div>
          <div className="em-detail-field">
            <span className="em-detail-key">Source</span>
            <span className="em-detail-value">{edge.sourceId}</span>
          </div>
          <div className="em-detail-field">
            <span className="em-detail-key">Target</span>
            <span className="em-detail-value">{edge.targetId}</span>
          </div>
        </div>

        <div className="em-detail-section">
          <h4 className="em-detail-heading">Weight &amp; Shield</h4>
          <div className="em-detail-field">
            <span className="em-detail-key">Stored Weight</span>
            <span className="em-detail-value">{edge.weight.toFixed(4)}</span>
          </div>
          <div className="em-detail-field">
            <span className="em-detail-key">Effective Weight</span>
            <span className="em-detail-value">{edge.effectiveWeight.toFixed(4)}</span>
          </div>
          <div className="em-detail-field">
            <span className="em-detail-key">Initial Weight</span>
            <span className="em-detail-value">{edge.initialWeight.toFixed(4)}</span>
          </div>
          <div className="em-detail-field">
            <span className="em-detail-key">Stored Shield</span>
            <span className="em-detail-value">{edge.shield.toFixed(4)}</span>
          </div>
          <div className="em-detail-field">
            <span className="em-detail-key">Effective Shield</span>
            <span className="em-detail-value">{edge.effectiveShield.toFixed(4)}</span>
          </div>
        </div>

        <div className="em-detail-section">
          <h4 className="em-detail-heading">Decay Parameters</h4>
          <div className="em-detail-field">
            <span className="em-detail-key">Decay Rate</span>
            <span className="em-detail-value">{edge.decayRate.toFixed(4)}</span>
          </div>
          <div className="em-detail-field">
            <span className="em-detail-key">Learning Rate</span>
            <span className="em-detail-value">{edge.learningRate.toFixed(4)}</span>
          </div>
          <div className="em-detail-field">
            <span className="em-detail-key">Event Gap</span>
            <span className="em-detail-value">{edge.decayGap.toFixed(1)}</span>
          </div>
          <div className="em-detail-field">
            <span className="em-detail-key">Health</span>
            <span className={`em-detail-value ${edge.isDead ? 'em-text-dead' : ''}`}>
              {edge.isDead ? 'DEAD' : `${edge.healthPercent}%`}
            </span>
          </div>
        </div>

        <div className="em-detail-section">
          <h4 className="em-detail-heading">Activity</h4>
          <div className="em-detail-field">
            <span className="em-detail-key">Activation Count</span>
            <span className="em-detail-value">{edge.activationCount}</span>
          </div>
          <div className="em-detail-field">
            <span className="em-detail-key">Last Activated Event</span>
            <span className="em-detail-value">{edge.lastActivatedAtEvent.toFixed(1)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
