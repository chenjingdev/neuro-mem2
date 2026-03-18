/**
 * SearchPanel — FTS5 + vector hybrid search UI component.
 *
 * Features:
 *   - Text input with debounced search (한영 혼용 지원)
 *   - Node type & role filter pills
 *   - Ranked result list with score breakdown
 *   - Search performance stats display
 *   - Click-to-select node integration with MemoryExplorer
 *
 * Calls POST /search/hybrid backend endpoint via useSearch hook.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useSearch, type SearchResultItem, type SearchFilters } from '../hooks/useSearch';
import type { MemoryNodeType, MemoryNodeRole } from '../types/memory-node';
import {
  NODE_TYPE_COLORS,
  NODE_TYPE_ICONS,
  NODE_ROLE_COLORS,
  NODE_ROLE_ICONS,
  MEMORY_NODE_TYPES,
} from '../types/memory-node';

// ─── Props ──────────────────────────────────────────────────

interface SearchPanelProps {
  /** Called when a search result is clicked (navigate to node detail) */
  onSelectNode?: (nodeId: string) => void;
  /** Currently selected node ID (for highlighting) */
  selectedNodeId?: string | null;
  /** API base URL override */
  apiBaseUrl?: string;
}

// ─── Component ──────────────────────────────────────────────

export function SearchPanel({ onSelectNode, selectedNodeId, apiBaseUrl }: SearchPanelProps) {
  const {
    query,
    setQuery,
    executeSearch,
    results,
    totalResults,
    isSearching,
    error,
    stats,
    clear,
    filters,
    setFilters,
    hasResults,
  } = useSearch({ apiBaseUrl, debounceMs: 400, defaultFilters: { includeStats: true, topK: 30 } });

  const inputRef = useRef<HTMLInputElement>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showStats, setShowStats] = useState(false);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ─── Handlers ──────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeSearch();
    }
    if (e.key === 'Escape') {
      clear();
      inputRef.current?.blur();
    }
  }, [executeSearch, clear]);

  const handleTypeFilterToggle = useCallback((type: MemoryNodeType) => {
    const current = filters.nodeTypeFilter;
    let next: MemoryNodeType | MemoryNodeType[] | undefined;
    if (!current) {
      next = type;
    } else if (typeof current === 'string') {
      next = current === type ? undefined : [current, type];
    } else {
      // Array
      if (current.includes(type)) {
        const filtered = current.filter(t => t !== type);
        next = filtered.length === 0 ? undefined : filtered.length === 1 ? filtered[0] : filtered;
      } else {
        next = [...current, type];
      }
    }
    setFilters({ ...filters, nodeTypeFilter: next });
  }, [filters, setFilters]);

  const handleRoleFilterToggle = useCallback((role: MemoryNodeRole) => {
    setFilters({
      ...filters,
      nodeRoleFilter: filters.nodeRoleFilter === role ? undefined : role,
    });
  }, [filters, setFilters]);

  // Re-search when filters change
  useEffect(() => {
    if (query.trim()) {
      executeSearch(query, filters);
    }
  }, [filters]);

  const isTypeActive = (type: MemoryNodeType) => {
    const f = filters.nodeTypeFilter;
    if (!f) return false;
    if (typeof f === 'string') return f === type;
    return f.includes(type);
  };

  // ─── Render ────────────────────────────────────────────

  return (
    <div className="search-panel">
      {/* Search Input */}
      <div className="sp-input-row">
        <div className="sp-input-wrap">
          <span className="sp-search-icon">🔍</span>
          <input
            ref={inputRef}
            className="sp-input"
            type="text"
            placeholder="Search memory nodes... (한영 혼용 지원)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Search memory nodes"
          />
          {query && (
            <button
              className="sp-clear-btn"
              onClick={clear}
              title="Clear search"
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>
        <button
          className={`sp-filter-toggle ${showFilters ? 'active' : ''}`}
          onClick={() => setShowFilters(!showFilters)}
          title="Toggle filters"
          aria-label="Toggle search filters"
        >
          ⚙
        </button>
      </div>

      {/* Filter Pills */}
      {showFilters && (
        <div className="sp-filters">
          <div className="sp-filter-section">
            <span className="sp-filter-label">Type:</span>
            <div className="sp-filter-pills">
              {MEMORY_NODE_TYPES.map(type => (
                <button
                  key={type}
                  className={`sp-pill ${isTypeActive(type) ? 'active' : ''}`}
                  style={{
                    borderColor: NODE_TYPE_COLORS[type],
                    ...(isTypeActive(type) ? { background: NODE_TYPE_COLORS[type] + '30' } : {}),
                  }}
                  onClick={() => handleTypeFilterToggle(type)}
                >
                  {NODE_TYPE_ICONS[type]} {type}
                </button>
              ))}
            </div>
          </div>
          <div className="sp-filter-section">
            <span className="sp-filter-label">Role:</span>
            <div className="sp-filter-pills">
              {(['hub', 'leaf'] as const).map(role => (
                <button
                  key={role}
                  className={`sp-pill ${filters.nodeRoleFilter === role ? 'active' : ''}`}
                  style={{
                    borderColor: NODE_ROLE_COLORS[role],
                    ...(filters.nodeRoleFilter === role ? { background: NODE_ROLE_COLORS[role] + '30' } : {}),
                  }}
                  onClick={() => handleRoleFilterToggle(role)}
                >
                  {NODE_ROLE_ICONS[role]} {role}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Loading Indicator */}
      {isSearching && (
        <div className="sp-loading">
          <span className="sp-spinner" />
          Searching...
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="sp-error">
          <span className="sp-error-icon">⚠</span>
          {error}
        </div>
      )}

      {/* Results */}
      {!isSearching && hasResults && (
        <div className="sp-results">
          <div className="sp-results-header">
            <span className="sp-results-count">
              {totalResults} result{totalResults !== 1 ? 's' : ''}
            </span>
            {stats && (
              <button
                className={`sp-stats-toggle ${showStats ? 'active' : ''}`}
                onClick={() => setShowStats(!showStats)}
                title="Toggle search stats"
              >
                ⏱ {stats.totalTimeMs.toFixed(0)}ms
              </button>
            )}
          </div>

          {/* Stats Panel */}
          {showStats && stats && (
            <div className="sp-stats">
              <div className="sp-stat-row">
                <span>FTS5 pre-filter:</span>
                <span>{stats.ftsTimeMs.toFixed(1)}ms ({stats.ftsCandidateCount} candidates)</span>
              </div>
              <div className="sp-stat-row">
                <span>Embedding:</span>
                <span>{stats.embeddingTimeMs.toFixed(1)}ms</span>
              </div>
              <div className="sp-stat-row">
                <span>Vector rerank:</span>
                <span>{stats.rerankTimeMs.toFixed(1)}ms ({stats.vectorComparisonCount} comparisons)</span>
              </div>
              <div className="sp-stat-row">
                <span>Total:</span>
                <span>{stats.totalTimeMs.toFixed(1)}ms</span>
              </div>
              {stats.usedBruteForceFallback && (
                <div className="sp-stat-row sp-stat-warn">
                  <span>⚠ Brute-force fallback used (few FTS matches)</span>
                </div>
              )}
            </div>
          )}

          {/* Result List */}
          <ul className="sp-result-list">
            {results.map((item) => (
              <SearchResultRow
                key={item.nodeId}
                item={item}
                isSelected={selectedNodeId === item.nodeId}
                onClick={() => onSelectNode?.(item.nodeId)}
              />
            ))}
          </ul>
        </div>
      )}

      {/* Empty state */}
      {!isSearching && !error && query.trim() && !hasResults && (
        <div className="sp-empty">
          No results found for "{query}"
        </div>
      )}
    </div>
  );
}

// ─── Search Result Row ──────────────────────────────────────

interface SearchResultRowProps {
  item: SearchResultItem;
  isSelected: boolean;
  onClick: () => void;
}

function SearchResultRow({ item, isSelected, onClick }: SearchResultRowProps) {
  const typeColor = item.nodeType ? NODE_TYPE_COLORS[item.nodeType] ?? '#888' : '#888';
  const typeIcon = item.nodeType ? NODE_TYPE_ICONS[item.nodeType] ?? '❓' : '❓';
  const roleIcon = NODE_ROLE_ICONS[item.nodeRole] ?? '';

  const scorePercent = Math.round(item.score * 100);
  const ftsPercent = Math.round(item.scoreBreakdown.ftsScore * 100);
  const vecPercent = Math.round(item.scoreBreakdown.vectorScore * 100);

  return (
    <li
      className={`sp-result-item ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
    >
      <div className="sp-result-main">
        <div className="sp-result-title-row">
          <span className="sp-result-icon">{typeIcon}</span>
          <span className="sp-result-frontmatter">{item.frontmatter}</span>
          <span className="sp-result-role">{roleIcon}</span>
        </div>
        <div className="sp-result-meta">
          <span
            className="sp-result-type-badge"
            style={{ borderColor: typeColor, color: typeColor }}
          >
            {item.nodeType ?? 'untyped'}
          </span>
          <span className="sp-result-source-badge">{item.source}</span>
        </div>
      </div>
      <div className="sp-result-score">
        <div className="sp-score-bar-container">
          <div
            className="sp-score-bar"
            style={{ width: `${scorePercent}%`, background: scoreBarColor(item.score) }}
          />
        </div>
        <span className="sp-score-value">{scorePercent}%</span>
        <div className="sp-score-breakdown">
          <span title="FTS5 BM25 score">F:{ftsPercent}</span>
          <span title="Vector cosine similarity">V:{vecPercent}</span>
          {item.scoreBreakdown.decayFactor < 1 && (
            <span title="Decay factor" className="sp-decay-indicator">
              D:{Math.round(item.scoreBreakdown.decayFactor * 100)}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

// ─── Helpers ────────────────────────────────────────────────

function scoreBarColor(score: number): string {
  if (score >= 0.7) return '#00b894';
  if (score >= 0.4) return '#fdcb6e';
  return '#e17055';
}
