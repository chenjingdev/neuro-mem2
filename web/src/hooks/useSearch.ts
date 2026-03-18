/**
 * useSearch — hook for FTS5 + vector hybrid search against the backend API.
 *
 * Calls POST /search/hybrid with query text and optional filters.
 * Supports debounced search, loading state, and result display.
 * 한영 혼용 queries fully supported.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { MemoryNodeType, MemoryNodeRole } from '../types/memory-node';

// ─── Search Result Types ──────────────────────────────────

export interface SearchResultItem {
  nodeId: string;
  nodeType: string | null;
  nodeRole: string;
  frontmatter: string;
  score: number;
  scoreBreakdown: {
    ftsScore: number;
    vectorScore: number;
    decayFactor: number;
    combinedBeforeDecay: number;
  };
  source: string;
}

export interface SearchStats {
  ftsTimeMs: number;
  ftsCandidateCount: number;
  embeddingTimeMs: number;
  rerankTimeMs: number;
  totalTimeMs: number;
  usedBruteForceFallback: boolean;
  vectorComparisonCount: number;
  outputCount: number;
  currentEventCounter?: number;
}

export interface SearchResponse {
  items: SearchResultItem[];
  totalItems: number;
  query: string;
  stats?: SearchStats;
}

export interface SearchFilters {
  topK?: number;
  minScore?: number;
  ftsWeight?: number;
  nodeTypeFilter?: MemoryNodeType | MemoryNodeType[];
  nodeRoleFilter?: MemoryNodeRole;
  applyDecay?: boolean;
  includeStats?: boolean;
}

export interface UseSearchOptions {
  /** API base URL (defaults to current origin) */
  apiBaseUrl?: string;
  /** Debounce delay in ms (default: 300) */
  debounceMs?: number;
  /** Default filters applied to every search */
  defaultFilters?: SearchFilters;
}

export interface UseSearchResult {
  /** Current search query */
  query: string;
  /** Set the search query (triggers debounced search) */
  setQuery: (q: string) => void;
  /** Execute search immediately (bypass debounce) */
  executeSearch: (q?: string, filters?: SearchFilters) => Promise<void>;
  /** Search results */
  results: SearchResultItem[];
  /** Total results count */
  totalResults: number;
  /** Whether search is in progress */
  isSearching: boolean;
  /** Error message if search failed */
  error: string | null;
  /** Search performance stats (when includeStats=true) */
  stats: SearchStats | null;
  /** Clear results and query */
  clear: () => void;
  /** Active filters */
  filters: SearchFilters;
  /** Update filters */
  setFilters: (f: SearchFilters) => void;
  /** Whether there are any results to show */
  hasResults: boolean;
}

// ─── Hook ────────────────────────────────────────────────────

export function useSearch(options?: UseSearchOptions): UseSearchResult {
  const apiBase = options?.apiBaseUrl ?? '';
  const debounceMs = options?.debounceMs ?? 300;

  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SearchStats | null>(null);
  const [filters, setFilters] = useState<SearchFilters>(
    options?.defaultFilters ?? { includeStats: true }
  );

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Core search execution */
  const doSearch = useCallback(async (searchQuery: string, searchFilters: SearchFilters) => {
    // Cancel any pending request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setResults([]);
      setTotalResults(0);
      setStats(null);
      setError(null);
      return;
    }

    setIsSearching(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        query: trimmed,
        ...searchFilters,
      };

      const res = await fetch(`${apiBase}/search/hybrid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        const msg = errBody?.message ?? `Search failed: ${res.status} ${res.statusText}`;
        throw new Error(msg);
      }

      const data = (await res.json()) as SearchResponse;
      setResults(data.items);
      setTotalResults(data.totalItems);
      setStats(data.stats ?? null);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message);
      setResults([]);
      setTotalResults(0);
    } finally {
      setIsSearching(false);
    }
  }, [apiBase]);

  /** Set query with debounced search */
  const setQuery = useCallback((q: string) => {
    setQueryState(q);

    // Clear previous debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (!q.trim()) {
      setResults([]);
      setTotalResults(0);
      setStats(null);
      setError(null);
      return;
    }

    debounceRef.current = setTimeout(() => {
      doSearch(q, filters);
    }, debounceMs);
  }, [doSearch, filters, debounceMs]);

  /** Execute search immediately */
  const executeSearch = useCallback(async (q?: string, overrideFilters?: SearchFilters) => {
    const searchQuery = q ?? query;
    const searchFilters = overrideFilters ?? filters;
    setQueryState(searchQuery);
    await doSearch(searchQuery, searchFilters);
  }, [query, filters, doSearch]);

  /** Clear everything */
  const clear = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    abortRef.current?.abort();
    setQueryState('');
    setResults([]);
    setTotalResults(0);
    setStats(null);
    setError(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  return {
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
    hasResults: results.length > 0,
  };
}
