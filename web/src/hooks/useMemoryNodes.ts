/**
 * useMemoryNodes — hook for fetching MemoryNode data from the API.
 *
 * Supports progressive depth loading:
 *   - L0 (refs): lightweight listing for initial view
 *   - L1 (refs + metadata): expanded detail with structured fields
 *   - L2 (refs + metadata + summary): full content view
 *   - Full: complete node including source refs
 *
 * Designed for the MemoryLayerView accordion/tree component.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  MemoryNodeData,
  MemoryNodeType,
  MemoryNodeRole,
  WeightedEdgeData,
  DecayInfo,
} from '../types/memory-node';

// ─── Types ───────────────────────────────────────────────────

/** Lightweight L0 ref for list display */
export interface MemoryNodeRef {
  id: string;
  nodeType: MemoryNodeType | null;
  nodeRole: MemoryNodeRole;
  frontmatter: string;
  keywords: string;
  activationCount: number;
  lastActivatedAtEvent: number;
}

/** L1: ref + metadata */
export interface MemoryNodeL1 extends MemoryNodeRef {
  metadata: Record<string, unknown>;
}

export interface NodeListResponse {
  items: MemoryNodeRef[];
  total: number;
}

export interface NodeDetailResponse {
  node: MemoryNodeData;
  edges?: WeightedEdgeData[];
  decay?: DecayInfo;
}

export type DepthLevel = 'L0' | 'L1' | 'L2' | 'full';

export interface UseMemoryNodesOptions {
  /** API base URL (defaults to current origin) */
  apiBaseUrl?: string;
  /** Initial page size */
  pageSize?: number;
}

export interface UseMemoryNodesResult {
  /** Current list of nodes (L0 refs) */
  nodes: MemoryNodeRef[];
  /** Total node count from backend */
  total: number;
  /** Whether initial list is loading */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Current page (0-based) */
  page: number;
  /** Page size */
  pageSize: number;

  /** Fetch/refresh the node list */
  fetchNodes: (opts?: {
    page?: number;
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
    orderBy?: 'activation_desc' | 'recent_first' | 'created_first';
  }) => Promise<void>;

  /** Load full detail for a specific node (progressive depth) */
  fetchNodeDetail: (id: string) => Promise<NodeDetailResponse | null>;

  /** Currently selected node detail */
  selectedNode: NodeDetailResponse | null;
  /** Whether detail is loading */
  isLoadingDetail: boolean;

  /** Select a node by ID (triggers detail fetch) */
  selectNode: (id: string | null) => void;

  /** Clear selection */
  clearSelection: () => void;

  /** Active filters */
  filters: {
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
    orderBy?: string;
  };
}

// ─── Hook ────────────────────────────────────────────────────

export function useMemoryNodes(options?: UseMemoryNodesOptions): UseMemoryNodesResult {
  const apiBase = options?.apiBaseUrl ?? '';
  const defaultPageSize = options?.pageSize ?? 50;

  const [nodes, setNodes] = useState<MemoryNodeRef[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize] = useState(defaultPageSize);

  const [selectedNode, setSelectedNode] = useState<NodeDetailResponse | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  const [filters, setFilters] = useState<{
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
    orderBy?: string;
  }>({});

  const abortRef = useRef<AbortController | null>(null);

  const fetchNodes = useCallback(async (opts?: {
    page?: number;
    nodeType?: MemoryNodeType | null;
    nodeRole?: MemoryNodeRole;
    orderBy?: 'activation_desc' | 'recent_first' | 'created_first';
  }) => {
    // Cancel any pending request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    const p = opts?.page ?? 0;
    setPage(p);

    if (opts?.nodeType !== undefined || opts?.nodeRole || opts?.orderBy) {
      setFilters({
        nodeType: opts?.nodeType,
        nodeRole: opts?.nodeRole,
        orderBy: opts?.orderBy,
      });
    }

    try {
      const params = new URLSearchParams();
      params.set('limit', String(pageSize));
      params.set('offset', String(p * pageSize));
      if (opts?.nodeType) params.set('nodeType', opts.nodeType);
      if (opts?.nodeType === null) params.set('nodeType', 'null');
      if (opts?.nodeRole) params.set('nodeRole', opts.nodeRole);
      if (opts?.orderBy) params.set('orderBy', opts.orderBy);
      params.set('depth', '1');

      const res = await fetch(`${apiBase}/api/memory-nodes?${params}`, {
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch nodes: ${res.status} ${res.statusText}`);
      }

      const data = await res.json() as NodeListResponse;
      setNodes(data.items);
      setTotal(data.total);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [apiBase, pageSize]);

  const fetchNodeDetail = useCallback(async (id: string): Promise<NodeDetailResponse | null> => {
    try {
      const res = await fetch(`${apiBase}/api/memory-nodes/${id}?depth=3`);
      if (!res.ok) {
        throw new Error(`Failed to fetch node: ${res.status}`);
      }
      return await res.json() as NodeDetailResponse;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, [apiBase]);

  const selectNode = useCallback(async (id: string | null) => {
    if (!id) {
      setSelectedNode(null);
      return;
    }

    setIsLoadingDetail(true);
    const detail = await fetchNodeDetail(id);
    setSelectedNode(detail);
    setIsLoadingDetail(false);
  }, [fetchNodeDetail]);

  const clearSelection = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return {
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
    filters,
  };
}
