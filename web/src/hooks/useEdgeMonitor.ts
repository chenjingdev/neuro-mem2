/**
 * useEdgeMonitor — hook for fetching and monitoring edge weight/shield states.
 *
 * Fetches paginated edge data from the API with:
 *   - Sorting (weight, shield, activation count, etc.)
 *   - Filtering (edge type, min/max weight, source/target type)
 *   - Effective weight/shield computation via lazy decay
 *   - Auto-refresh on interval
 *
 * Designed for the EdgeMonitorPanel real-time monitoring table.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { WeightedEdgeData } from '../types/memory-node';

// ─── Types ───────────────────────────────────────────────────

export type EdgeSortField =
  | 'weight'
  | 'effectiveWeight'
  | 'shield'
  | 'effectiveShield'
  | 'activationCount'
  | 'decayRate'
  | 'lastActivatedAtEvent';

export type SortDirection = 'asc' | 'desc';

export interface EdgeMonitorFilter {
  edgeType?: string;
  sourceType?: 'hub' | 'leaf';
  targetType?: 'hub' | 'leaf';
  minWeight?: number;
  maxWeight?: number;
  minShield?: number;
  searchQuery?: string;
}

export interface EdgeMonitorSort {
  field: EdgeSortField;
  direction: SortDirection;
}

export interface EdgeMonitorItem extends WeightedEdgeData {
  sourceLabel?: string;
  sourceRole?: 'hub' | 'leaf';
  targetLabel?: string;
  targetRole?: 'hub' | 'leaf';
  effectiveWeight: number;
  effectiveShield: number;
  decayGap: number;
  isDead: boolean;
  healthPercent: number;
}

export interface EdgeMonitorStats {
  totalEdges: number;
  avgWeight: number;
  avgShield: number;
  deadCount: number;
  byType: Record<string, number>;
}

export interface UseEdgeMonitorOptions {
  apiBaseUrl?: string;
  pageSize?: number;
  autoRefreshMs?: number;
}

export interface UseEdgeMonitorResult {
  edges: EdgeMonitorItem[];
  stats: EdgeMonitorStats | null;
  isLoading: boolean;
  error: string | null;
  page: number;
  totalPages: number;
  totalEdges: number;
  sort: EdgeMonitorSort;
  filter: EdgeMonitorFilter;
  currentEvent: number;

  setPage: (page: number) => void;
  setSort: (sort: EdgeMonitorSort) => void;
  setFilter: (filter: EdgeMonitorFilter) => void;
  refresh: () => Promise<void>;
}

// ─── API Response Types ──────────────────────────────────────

interface EdgeMonitorApiResponse {
  items: EdgeMonitorApiItem[];
  total: number;
  limit: number;
  offset: number;
  currentEventCounter: number;
  stats?: EdgeMonitorStats;
}

interface EdgeMonitorApiItem {
  id: string;
  sourceId: string;
  sourceType: string;
  sourceLabel?: string;
  targetId: string;
  targetType: string;
  targetLabel?: string;
  edgeType: string;
  weight: number;
  initialWeight: number;
  shield: number;
  learningRate: number;
  decayRate: number;
  activationCount: number;
  lastActivatedAtEvent: number;
  effectiveWeight: number;
  effectiveShield: number;
  decayGap: number;
  isDead: boolean;
}

// ─── Hook ────────────────────────────────────────────────────

export function useEdgeMonitor(options?: UseEdgeMonitorOptions): UseEdgeMonitorResult {
  const apiBase = options?.apiBaseUrl ?? '';
  const pageSize = options?.pageSize ?? 50;

  const [edges, setEdges] = useState<EdgeMonitorItem[]>([]);
  const [stats, setStats] = useState<EdgeMonitorStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [totalEdges, setTotalEdges] = useState(0);
  const [currentEvent, setCurrentEvent] = useState(0);
  const [sort, setSort] = useState<EdgeMonitorSort>({
    field: 'weight',
    direction: 'desc',
  });
  const [filter, setFilter] = useState<EdgeMonitorFilter>({});

  const abortRef = useRef<AbortController | null>(null);

  const fetchEdges = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set('limit', String(pageSize));
      params.set('offset', String(page * pageSize));
      params.set('sortField', sort.field);
      params.set('sortDirection', sort.direction);
      params.set('includeStats', 'true');

      if (filter.edgeType) params.set('edgeType', filter.edgeType);
      if (filter.sourceType) params.set('sourceType', filter.sourceType);
      if (filter.targetType) params.set('targetType', filter.targetType);
      if (filter.minWeight !== undefined) params.set('minWeight', String(filter.minWeight));
      if (filter.maxWeight !== undefined) params.set('maxWeight', String(filter.maxWeight));
      if (filter.searchQuery) params.set('q', filter.searchQuery);

      const res = await fetch(`${apiBase}/api/memory-nodes/edges?${params}`, {
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Failed to fetch edges: ${res.status}`);

      const data = await res.json() as EdgeMonitorApiResponse;

      const items: EdgeMonitorItem[] = data.items.map(item => ({
        id: item.id,
        sourceId: item.sourceId,
        targetId: item.targetId,
        edgeType: item.edgeType,
        weight: item.weight,
        initialWeight: item.initialWeight,
        shield: item.shield,
        learningRate: item.learningRate,
        decayRate: item.decayRate,
        activationCount: item.activationCount,
        lastActivatedAtEvent: item.lastActivatedAtEvent,
        effectiveWeight: item.effectiveWeight,
        effectiveShield: item.effectiveShield,
        decayGap: item.decayGap,
        isDead: item.isDead,
        sourceLabel: item.sourceLabel,
        sourceRole: item.sourceType as 'hub' | 'leaf',
        targetLabel: item.targetLabel,
        targetRole: item.targetType as 'hub' | 'leaf',
        healthPercent: item.weight > 0
          ? Math.round((item.effectiveWeight / item.weight) * 100)
          : 0,
      }));

      setEdges(items);
      setTotalEdges(data.total);
      setCurrentEvent(data.currentEventCounter);
      if (data.stats) setStats(data.stats);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [apiBase, pageSize, page, sort, filter]);

  // Auto-fetch on param changes
  useEffect(() => {
    fetchEdges();
  }, [fetchEdges]);

  // Auto-refresh
  useEffect(() => {
    if (!options?.autoRefreshMs) return;
    const interval = setInterval(fetchEdges, options.autoRefreshMs);
    return () => clearInterval(interval);
  }, [fetchEdges, options?.autoRefreshMs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const totalPages = Math.max(1, Math.ceil(totalEdges / pageSize));

  return {
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
    setFilter: useCallback((f: EdgeMonitorFilter) => {
      setFilter(f);
      setPage(0); // Reset to first page on filter change
    }, []),
    refresh: fetchEdges,
  };
}
