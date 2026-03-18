/**
 * useLocalGraph — hook for fetching N-hop neighbor subgraph data from the API.
 *
 * Used by the LocalExploreView component to display a sigma.js graph
 * centered on a selected node.
 */

import { useState, useCallback, useRef } from 'react';
import type { MemoryNodeType, MemoryNodeRole } from '../types/memory-node';

// ─── Types ───────────────────────────────────────────────

/** Lightweight node ref (L0) for graph display */
export interface GraphNodeRef {
  id: string;
  nodeType: MemoryNodeType | null;
  nodeRole: MemoryNodeRole;
  /** frontmatter or label (from /graph endpoint) */
  frontmatter: string;
  /** May come as 'label' from /graph endpoint */
  label?: string;
  keywords: string;
  activationCount: number;
  lastActivatedAtEvent?: number;
}

/** Edge in the subgraph */
export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType: string;
  weight: number;
  shield: number;
}

/** Subgraph API response */
export interface SubgraphResponse {
  centerId: string;
  hops: number;
  nodes: GraphNodeRef[];
  edges: GraphEdge[];
  totalNodes: number;
  totalEdges: number;
}

export interface UseLocalGraphOptions {
  apiBaseUrl?: string;
}

export interface UseLocalGraphResult {
  /** Current subgraph data */
  subgraph: SubgraphResponse | null;
  /** Whether data is loading */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Center node ID */
  centerId: string | null;
  /** Current hop count */
  hops: number;

  /** Fetch subgraph centered on a node */
  fetchSubgraph: (nodeId: string, opts?: {
    hops?: number;
    maxNodes?: number;
    minWeight?: number;
  }) => Promise<SubgraphResponse | null>;

  /** Navigate to a new center node (re-fetch subgraph) */
  navigateTo: (nodeId: string) => Promise<void>;

  /** Update hop count and re-fetch */
  setHops: (hops: number) => Promise<void>;

  /** Clear current subgraph */
  clear: () => void;

  /** Navigation history */
  history: string[];

  /** Go back in navigation history */
  goBack: () => Promise<void>;
}

// ─── Hook ────────────────────────────────────────────────

export function useLocalGraph(options?: UseLocalGraphOptions): UseLocalGraphResult {
  const apiBase = options?.apiBaseUrl ?? '';

  const [subgraph, setSubgraph] = useState<SubgraphResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [centerId, setCenterId] = useState<string | null>(null);
  const [hops, setHopsState] = useState(2);
  const [history, setHistory] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const currentHopsRef = useRef(2);

  const fetchSubgraph = useCallback(async (
    nodeId: string,
    opts?: { hops?: number; maxNodes?: number; minWeight?: number },
  ): Promise<SubgraphResponse | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    const hopCount = opts?.hops ?? currentHopsRef.current;

    try {
      const params = new URLSearchParams();
      params.set('hops', String(hopCount));
      if (opts?.maxNodes) params.set('maxNodes', String(opts.maxNodes));
      if (opts?.minWeight) params.set('minWeight', String(opts.minWeight));

      // Use the /graph endpoint with centerNodeId for BFS ego-network
      params.set('centerNodeId', nodeId);
      const res = await fetch(
        `${apiBase}/api/memory-nodes/graph?${params}`,
        { signal: controller.signal },
      );

      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(`Node ${nodeId} not found`);
        }
        throw new Error(`Failed to fetch subgraph: ${res.status}`);
      }

      const raw = await res.json() as {
        nodes: Array<{ id: string; nodeType: MemoryNodeType | null; nodeRole: MemoryNodeRole; label?: string; frontmatter?: string; keywords: string; activationCount: number; lastActivatedAtEvent?: number }>;
        edges: Array<{ id: string; source: string; target: string; weight: number; shield: number; edgeType: string }>;
        centerNodeId?: string;
        hops?: number;
        totalNodes: number;
        totalEdges: number;
      };
      // Map graph API response to SubgraphResponse format
      const data: SubgraphResponse = {
        centerId: raw.centerNodeId ?? nodeId,
        hops: raw.hops ?? hopCount,
        nodes: raw.nodes.map(n => ({
          id: n.id,
          nodeType: n.nodeType,
          nodeRole: n.nodeRole,
          frontmatter: n.frontmatter ?? n.label ?? n.id,
          keywords: n.keywords ?? '',
          activationCount: n.activationCount ?? 0,
          lastActivatedAtEvent: n.lastActivatedAtEvent,
        })),
        edges: raw.edges.map(e => ({
          id: e.id,
          sourceId: e.source,
          targetId: e.target,
          edgeType: e.edgeType,
          weight: e.weight,
          shield: e.shield,
        })),
        totalNodes: raw.totalNodes,
        totalEdges: raw.totalEdges,
      };
      setSubgraph(data);
      setCenterId(nodeId);
      return data;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null;
      setError((err as Error).message);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [apiBase]);

  const navigateTo = useCallback(async (nodeId: string) => {
    if (centerId && centerId !== nodeId) {
      setHistory(prev => [...prev, centerId!]);
    }
    await fetchSubgraph(nodeId);
  }, [centerId, fetchSubgraph]);

  const setHops = useCallback(async (newHops: number) => {
    const clamped = Math.min(5, Math.max(1, newHops));
    setHopsState(clamped);
    currentHopsRef.current = clamped;
    if (centerId) {
      await fetchSubgraph(centerId, { hops: clamped });
    }
  }, [centerId, fetchSubgraph]);

  const goBack = useCallback(async () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    await fetchSubgraph(prev);
  }, [history, fetchSubgraph]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setSubgraph(null);
    setCenterId(null);
    setError(null);
    setHistory([]);
  }, []);

  return {
    subgraph,
    isLoading,
    error,
    centerId,
    hops,
    fetchSubgraph,
    navigateTo,
    setHops,
    clear,
    history,
    goBack,
  };
}
