/**
 * useGraphData — hook for fetching graph visualization data from the API.
 *
 * Supports two modes:
 *   1. Global map: sampled overview of all nodes (hubs prioritized)
 *   2. Local explorer: ego-network BFS around a center node
 *
 * Designed for sigma.js + graphology rendering with LOD support.
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// ─── Types ───────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  nodeType: string | null;
  nodeRole: 'hub' | 'leaf';
  label: string;
  activationCount: number;
  keywords: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  shield: number;
  edgeType: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalNodes: number;
  totalEdges: number;
  sampled: boolean;
  centerNodeId?: string;
  hops?: number;
}

export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  byRole: { hub: number; leaf: number };
  byType: Record<string, number>;
}

export interface UseGraphDataOptions {
  apiBaseUrl?: string;
}

export interface UseGraphDataResult {
  /** Current graph data */
  graphData: GraphData | null;
  /** Graph stats */
  stats: GraphStats | null;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;

  /** Fetch global map (sampled overview) */
  fetchGlobalMap: (opts?: {
    maxNodes?: number;
    minWeight?: number;
    hubsOnly?: boolean;
  }) => Promise<GraphData | null>;

  /** Fetch local ego-network around a center node */
  fetchLocalGraph: (centerNodeId: string, opts?: {
    hops?: number;
    maxNodes?: number;
    minWeight?: number;
  }) => Promise<GraphData | null>;

  /** Fetch stats */
  fetchStats: () => Promise<void>;
}

// ─── Hook ────────────────────────────────────────────────────

export function useGraphData(options?: UseGraphDataOptions): UseGraphDataResult {
  const apiBase = options?.apiBaseUrl ?? '';

  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const fetchGlobalMap = useCallback(async (opts?: {
    maxNodes?: number;
    minWeight?: number;
    hubsOnly?: boolean;
  }): Promise<GraphData | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (opts?.maxNodes) params.set('maxNodes', String(opts.maxNodes));
      if (opts?.minWeight) params.set('minWeight', String(opts.minWeight));
      if (opts?.hubsOnly) params.set('hubsOnly', 'true');

      const res = await fetch(`${apiBase}/api/memory-nodes/graph?${params}`, {
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Failed to fetch graph: ${res.status}`);

      const data = await res.json() as GraphData;
      setGraphData(data);
      return data;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null;
      setError((err as Error).message);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [apiBase]);

  const fetchLocalGraph = useCallback(async (
    centerNodeId: string,
    opts?: { hops?: number; maxNodes?: number; minWeight?: number },
  ): Promise<GraphData | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set('centerNodeId', centerNodeId);
      if (opts?.hops) params.set('hops', String(opts.hops));
      if (opts?.maxNodes) params.set('maxNodes', String(opts.maxNodes));
      if (opts?.minWeight) params.set('minWeight', String(opts.minWeight));

      const res = await fetch(`${apiBase}/api/memory-nodes/graph?${params}`, {
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Failed to fetch local graph: ${res.status}`);

      const data = await res.json() as GraphData;
      setGraphData(data);
      return data;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null;
      setError((err as Error).message);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [apiBase]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/memory-nodes/stats`);
      if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`);
      const data = await res.json() as GraphStats;
      setStats(data);
    } catch (err) {
      console.error('[useGraphData] stats error:', err);
    }
  }, [apiBase]);

  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  return {
    graphData,
    stats,
    isLoading,
    error,
    fetchGlobalMap,
    fetchLocalGraph,
    fetchStats,
  };
}
