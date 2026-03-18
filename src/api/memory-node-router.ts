/**
 * Memory Node REST API Router — L0→L1→L2→L3 progressive depth layer loading.
 *
 * Endpoints:
 *   GET  /api/memory-nodes                — List nodes at configurable depth (L0/L1/L2/L3)
 *   GET  /api/memory-nodes/:id            — Get single node at configurable depth
 *   GET  /api/memory-nodes/:id/children   — Lazy-load children (connected via edges) at configurable depth
 *   GET  /api/memory-nodes/hubs           — List hub nodes (for graph root view)
 *   GET  /api/memory-nodes/stats          — Node/edge count statistics
 *   GET  /api/memory-nodes/edges          — Paginated edge list with sorting/filtering/decay (EdgeMonitorPanel)
 *
 * All endpoints accept `?depth=0|1|2|3` to control how much data is returned:
 *   L0 = frontmatter + keywords + activation info (MemoryNodeRef)
 *   L1 = L0 + metadata JSON (MemoryNodeL1)
 *   L2 = L0 + L1 + summary text (MemoryNodeL2)
 *   L3 = full MemoryNode (L2 + sourceMessageIds + conversationId + sourceTurnIndex)
 *
 * Pagination via `?limit=N&offset=N` (default limit=50, max=200).
 */

import { Hono } from 'hono';
import type { MemoryNodeRepository } from '../db/memory-node-repo.js';
import type { WeightedEdgeRepository } from '../db/weighted-edge-repo.js';
import type {
  MemoryNodeTypeNullable,
  MemoryNodeRole,
  MemoryNode,
  MemoryNodeRef,
  MemoryNodeL1,
  MemoryNodeL2,
} from '../models/memory-node.js';
import type { ErrorResponse } from './schemas.js';
import {
  computeEffectiveWeight,
  computeEffectiveShield,
} from '../scoring/lazy-decay-evaluator.js';
import { GLOBAL_EVENT_COUNTER_KEY } from '../services/global-event-counter.js';
import { SystemStateRepository } from '../db/system-state-repo.js';

// ─── Dependencies ────────────────────────────────────────

export interface MemoryNodeRouterDeps {
  nodeRepo: MemoryNodeRepository;
  edgeRepo: WeightedEdgeRepository;
  /** Optional getter for the global event counter (for lazy decay computation).
   *  Falls back to MAX(last_activated_at_event) from weighted_edges if not provided. */
  getEventCounter?: () => number;
}

// ─── Response Types ──────────────────────────────────────

/** Paginated list response wrapper */
interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Children response includes edges info */
interface ChildrenResponse<T> {
  parentId: string;
  children: ChildItem<T>[];
  total: number;
}

interface ChildItem<T> {
  node: T;
  edge: {
    id: string;
    edgeType: string;
    weight: number;
    shield: number;
    direction: 'outgoing' | 'incoming';
  };
}

/** Node stats response */
interface NodeStatsResponse {
  totalNodes: number;
  totalEdges: number;
  byRole: { hub: number; leaf: number };
  byType: Record<string, number>;
}

// ─── Helpers ─────────────────────────────────────────────

type Depth = 0 | 1 | 2 | 3;

function parseDepth(raw: string | undefined): Depth {
  if (raw === undefined) return 0;
  const n = parseInt(raw, 10);
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  return 0;
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return 50;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function parseOffset(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) return 0;
  return n;
}

function parseNodeType(raw: string | undefined): MemoryNodeTypeNullable | undefined {
  if (!raw) return undefined;
  if (raw === 'null') return null;
  const valid = ['semantic', 'episodic', 'procedural', 'prospective', 'emotional'];
  return valid.includes(raw) ? (raw as MemoryNodeTypeNullable) : undefined;
}

function parseNodeRole(raw: string | undefined): MemoryNodeRole | undefined {
  if (!raw) return undefined;
  return (raw === 'hub' || raw === 'leaf') ? raw : undefined;
}

function parseOrderBy(raw: string | undefined): 'activation_desc' | 'recent_first' | 'created_first' | undefined {
  if (raw === 'activation_desc' || raw === 'recent_first' || raw === 'created_first') return raw;
  return undefined;
}

/** Strip embedding from full MemoryNode for JSON serialization */
function sanitizeNode(node: MemoryNode): Omit<MemoryNode, 'embedding' | 'embeddingDim'> & { hasEmbedding: boolean } {
  const { embedding, embeddingDim, ...rest } = node;
  return { ...rest, hasEmbedding: !!embedding };
}

/** Project node to requested depth level */
function projectToDepth(node: MemoryNode, depth: Depth): MemoryNodeRef | MemoryNodeL1 | MemoryNodeL2 | ReturnType<typeof sanitizeNode> {
  switch (depth) {
    case 0:
      return {
        id: node.id,
        nodeType: node.nodeType,
        nodeRole: node.nodeRole,
        frontmatter: node.frontmatter,
        keywords: node.keywords,
        activationCount: node.activationCount,
        lastActivatedAtEvent: node.lastActivatedAtEvent,
      } satisfies MemoryNodeRef;
    case 1:
      return {
        id: node.id,
        nodeType: node.nodeType,
        nodeRole: node.nodeRole,
        frontmatter: node.frontmatter,
        keywords: node.keywords,
        activationCount: node.activationCount,
        lastActivatedAtEvent: node.lastActivatedAtEvent,
        metadata: node.metadata,
      } satisfies MemoryNodeL1;
    case 2:
      return {
        id: node.id,
        nodeType: node.nodeType,
        nodeRole: node.nodeRole,
        frontmatter: node.frontmatter,
        keywords: node.keywords,
        activationCount: node.activationCount,
        lastActivatedAtEvent: node.lastActivatedAtEvent,
        metadata: node.metadata,
        summary: node.summary,
      } satisfies MemoryNodeL2;
    case 3:
      return sanitizeNode(node);
  }
}

// ─── Router Factory ──────────────────────────────────────

export function createMemoryNodeRouter(deps: MemoryNodeRouterDeps): Hono {
  const app = new Hono();
  const { nodeRepo, edgeRepo } = deps;

  // ── GET /edges — Edge monitor: paginated edge list with decay info ──
  // Returns edges with effective weight/shield computed via lazy decay.
  // Supports sorting, filtering, and stats aggregation for EdgeMonitorPanel.
  app.get('/edges', (c) => {
    try {
      const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);
      const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
      const sortField = c.req.query('sortField') ?? 'weight';
      const sortDirection = c.req.query('sortDirection') === 'asc' ? 'asc' : 'desc';
      const edgeType = c.req.query('edgeType') || undefined;
      const sourceType = c.req.query('sourceType') || undefined;
      const targetType = c.req.query('targetType') || undefined;
      const minWeight = c.req.query('minWeight') ? parseFloat(c.req.query('minWeight')!) : undefined;
      const maxWeight = c.req.query('maxWeight') ? parseFloat(c.req.query('maxWeight')!) : undefined;
      const searchQuery = c.req.query('q') || undefined;
      const includeStats = c.req.query('includeStats') === 'true';

      // Get current event counter for lazy decay computation
      let currentEventCounter = 0;
      if (deps.getEventCounter) {
        currentEventCounter = deps.getEventCounter();
      } else {
        try {
          const sysRepo = new SystemStateRepository(
            (edgeRepo as unknown as { db: import('better-sqlite3').Database }).db,
          );
          currentEventCounter = sysRepo.getNumber(GLOBAL_EVENT_COUNTER_KEY);
        } catch {
          currentEventCounter = 0;
        }
      }

      // Build filter for queryEdges
      const queryFilter: import('../models/weighted-edge.js').WeightedEdgeFilter = {
        edgeTypes: edgeType ? [edgeType as import('../models/weighted-edge.js').WeightedEdgeType] : undefined,
        sourceType: sourceType as 'hub' | 'leaf' | undefined,
        targetType: targetType as 'hub' | 'leaf' | undefined,
        minWeight,
        maxWeight,
      };

      // Fetch all matching edges (compute effective values + sort in memory)
      const allEdges = edgeRepo.queryEdges({ ...queryFilter, limit: 10000 });

      // Compute effective weight/shield for each edge
      const enriched = allEdges.map(edge => {
        const gap = Math.max(0, currentEventCounter - edge.lastActivatedAtEvent);
        const effectiveWeight = computeEffectiveWeight(
          edge.weight, edge.shield, gap, edge.decayRate,
        );
        const effectiveShield = computeEffectiveShield(edge.shield, gap);
        const isDead = effectiveWeight <= 0;

        return {
          id: edge.id,
          sourceId: edge.sourceId,
          sourceType: edge.sourceType,
          targetId: edge.targetId,
          targetType: edge.targetType,
          edgeType: edge.edgeType,
          weight: edge.weight,
          initialWeight: edge.initialWeight,
          shield: edge.shield,
          learningRate: edge.learningRate,
          decayRate: edge.decayRate,
          activationCount: edge.activationCount,
          lastActivatedAtEvent: edge.lastActivatedAtEvent,
          effectiveWeight,
          effectiveShield,
          decayGap: gap,
          isDead,
        };
      });

      // Apply search query filter (match against node labels)
      let filtered = enriched;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const allNodeIds = new Set<string>();
        enriched.forEach(e => { allNodeIds.add(e.sourceId); allNodeIds.add(e.targetId); });
        const refs = nodeRepo.getRefsByIds(Array.from(allNodeIds));
        const labelMap = new Map<string, string>();
        refs.forEach(r => labelMap.set(r.id, r.frontmatter.toLowerCase()));

        filtered = enriched.filter(e => {
          const srcLabel = labelMap.get(e.sourceId) ?? '';
          const tgtLabel = labelMap.get(e.targetId) ?? '';
          return srcLabel.includes(q) || tgtLabel.includes(q) || e.edgeType.includes(q);
        });
      }

      // Sort by specified field
      const sortedEdges = [...filtered].sort((a, b) => {
        let av: number, bv: number;
        switch (sortField) {
          case 'effectiveWeight': av = a.effectiveWeight; bv = b.effectiveWeight; break;
          case 'shield': av = a.shield; bv = b.shield; break;
          case 'effectiveShield': av = a.effectiveShield; bv = b.effectiveShield; break;
          case 'activationCount': av = a.activationCount; bv = b.activationCount; break;
          case 'decayRate': av = a.decayRate; bv = b.decayRate; break;
          case 'lastActivatedAtEvent': av = a.lastActivatedAtEvent; bv = b.lastActivatedAtEvent; break;
          default: av = a.weight; bv = b.weight;
        }
        return sortDirection === 'asc' ? av - bv : bv - av;
      });

      const total = sortedEdges.length;
      const paged = sortedEdges.slice(offset, offset + limit);

      // Resolve node labels for paged items
      const pagedNodeIds = new Set<string>();
      paged.forEach(e => { pagedNodeIds.add(e.sourceId); pagedNodeIds.add(e.targetId); });
      const pagedRefs = nodeRepo.getRefsByIds(Array.from(pagedNodeIds));
      const refMap = new Map(pagedRefs.map(r => [r.id, r]));

      const items = paged.map(e => {
        const srcRef = refMap.get(e.sourceId);
        const tgtRef = refMap.get(e.targetId);
        return {
          ...e,
          sourceLabel: srcRef?.frontmatter?.slice(0, 60) ?? undefined,
          targetLabel: tgtRef?.frontmatter?.slice(0, 60) ?? undefined,
        };
      });

      // Compute stats if requested
      let stats: {
        totalEdges: number;
        avgWeight: number;
        avgShield: number;
        deadCount: number;
        byType: Record<string, number>;
      } | undefined;

      if (includeStats && filtered.length > 0) {
        let sumW = 0, sumS = 0, deadCount = 0;
        const byType: Record<string, number> = {};
        for (const e of filtered) {
          sumW += e.effectiveWeight;
          sumS += e.effectiveShield;
          if (e.isDead) deadCount++;
          byType[e.edgeType] = (byType[e.edgeType] ?? 0) + 1;
        }
        stats = {
          totalEdges: filtered.length,
          avgWeight: sumW / filtered.length,
          avgShield: sumS / filtered.length,
          deadCount,
          byType,
        };
      }

      return c.json({
        items,
        total,
        limit,
        offset,
        currentEventCounter,
        ...(stats ? { stats } : {}),
      }, 200);
    } catch (err) {
      return c.json(makeError(err), 500);
    }
  });

  // ── GET /graph — Graph data for sigma.js visualization ──
  // Returns lightweight node+edge data optimized for graphology.
  // For 수십만 nodes: sampling (hubs first, top-activated leaves), LOD (L0 only), pagination.
  app.get('/graph', (c) => {
    try {
      const maxNodes = Math.min(parseInt(c.req.query('maxNodes') ?? '2000', 10), 10000);
      const minWeight = parseFloat(c.req.query('minWeight') ?? '0');
      const hubsOnly = c.req.query('hubsOnly') === 'true';
      const centerNodeId = c.req.query('centerNodeId') ?? undefined;
      const hops = Math.min(parseInt(c.req.query('hops') ?? '2', 10), 4);

      // Local exploration mode: ego-network around a center node
      if (centerNodeId) {
        return c.json(buildLocalGraph(centerNodeId, hops, minWeight, maxNodes), 200);
      }

      // Global map mode: sample hubs + top-activated leaves
      const hubRefs = nodeRepo.listRefs({
        limit: Math.min(maxNodes, 500),
        offset: 0,
        nodeRole: 'hub',
        orderBy: 'activation_desc',
      });

      const remainingSlots = maxNodes - hubRefs.items.length;

      let leafRefs: typeof hubRefs.items = [];
      if (!hubsOnly && remainingSlots > 0) {
        const result = nodeRepo.listRefs({
          limit: remainingSlots,
          offset: 0,
          nodeRole: 'leaf',
          orderBy: 'activation_desc',
        });
        leafRefs = result.items;
      }

      const allNodes = [...hubRefs.items, ...leafRefs];
      const nodeIds = new Set(allNodes.map(n => n.id));

      // Fetch edges between visible nodes only
      const edges = edgeRepo.queryEdges({
        minWeight: minWeight > 0 ? minWeight : undefined,
        limit: maxNodes * 3,
      }).filter(e => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId));

      const graphNodes = allNodes.map(n => ({
        id: n.id,
        nodeType: n.nodeType,
        nodeRole: n.nodeRole,
        label: n.frontmatter.slice(0, 60),
        activationCount: n.activationCount,
        keywords: n.keywords,
      }));

      const graphEdges = edges.map(e => ({
        id: e.id,
        source: e.sourceId,
        target: e.targetId,
        weight: e.weight,
        shield: e.shield,
        edgeType: e.edgeType,
      }));

      return c.json({
        nodes: graphNodes,
        edges: graphEdges,
        totalNodes: hubRefs.total + (hubsOnly ? 0 : nodeRepo.count(undefined, 'leaf')),
        totalEdges: edgeRepo.countEdges(),
        sampled: allNodes.length < (hubRefs.total + nodeRepo.count(undefined, 'leaf')),
      }, 200);
    } catch (err) {
      return c.json(makeError(err), 500);
    }
  });

  // Helper: build ego-network graph centered on a node
  function buildLocalGraph(centerId: string, hops: number, minWeight: number, maxNodes: number) {
    const visited = new Set<string>();
    const edgeSet = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: centerId, depth: 0 }];
    visited.add(centerId);

    const collectedEdges: Array<{
      id: string; source: string; target: string;
      weight: number; shield: number; edgeType: string;
    }> = [];

    while (queue.length > 0 && visited.size < maxNodes) {
      const current = queue.shift()!;
      if (current.depth >= hops) continue;

      const connected = edgeRepo.getConnectedEdges(current.id);
      for (const edge of connected) {
        if (minWeight > 0 && edge.weight < minWeight) continue;
        if (edgeSet.has(edge.id)) continue;
        edgeSet.add(edge.id);

        const neighborId = edge.sourceId === current.id ? edge.targetId : edge.sourceId;
        collectedEdges.push({
          id: edge.id,
          source: edge.sourceId,
          target: edge.targetId,
          weight: edge.weight,
          shield: edge.shield,
          edgeType: edge.edgeType,
        });

        if (!visited.has(neighborId) && visited.size < maxNodes) {
          visited.add(neighborId);
          queue.push({ id: neighborId, depth: current.depth + 1 });
        }
      }
    }

    // Fetch L0 refs for visited nodes
    const nodeIdArr = Array.from(visited);
    const refs = nodeRepo.getRefsByIds(nodeIdArr);
    const graphNodes = refs.map(n => ({
      id: n.id,
      nodeType: n.nodeType,
      nodeRole: n.nodeRole,
      label: n.frontmatter.slice(0, 60),
      activationCount: n.activationCount,
      keywords: n.keywords,
    }));

    const finalEdges = collectedEdges.filter(
      e => visited.has(e.source) && visited.has(e.target)
    );

    return {
      nodes: graphNodes,
      edges: finalEdges,
      centerNodeId: centerId,
      hops,
      totalNodes: visited.size,
      totalEdges: finalEdges.length,
      sampled: false,
    };
  }

  // ── GET /search — FTS5-only text search (lightweight, no embedding required) ──
  // Returns matching nodes ranked by BM25 score with L0 ref data.
  // Useful for quick keyword search when embedding service is unavailable.
  // 한영 혼용 queries fully supported.
  app.get('/search', (c) => {
    try {
      const q = c.req.query('q')?.trim();
      if (!q) {
        return c.json({
          error: 'VALIDATION_ERROR',
          message: 'Query parameter "q" is required and must not be empty',
        } satisfies ErrorResponse, 400);
      }

      const limit = parseLimit(c.req.query('limit'));
      const nodeType = parseNodeType(c.req.query('nodeType'));
      const nodeRole = parseNodeRole(c.req.query('nodeRole'));

      let ftsResults: { id: string; rank: number }[];

      if (nodeType !== undefined || nodeRole) {
        ftsResults = nodeRepo.ftsSearchFiltered(q, {
          nodeType: nodeType ?? undefined,
          nodeRole: nodeRole,
          limit,
        });
      } else {
        ftsResults = nodeRepo.ftsSearch(q, limit);
      }

      if (ftsResults.length === 0) {
        return c.json({
          items: [],
          total: 0,
          query: q,
        }, 200);
      }

      // Normalize ranks to [0, 1] for display
      const ids = ftsResults.map(r => r.id);
      const refs = nodeRepo.getRefsByIds(ids);
      const refMap = new Map(refs.map(r => [r.id, r]));

      // Normalize FTS5 BM25 ranks (more negative = better)
      let minRank = Infinity;
      let maxRank = -Infinity;
      for (const r of ftsResults) {
        if (r.rank < minRank) minRank = r.rank;
        if (r.rank > maxRank) maxRank = r.rank;
      }
      const range = maxRank - minRank;

      const items = ftsResults
        .map(r => {
          const ref = refMap.get(r.id);
          if (!ref) return null;
          const normalizedScore = range === 0 ? 1.0 : (maxRank - r.rank) / range;
          return {
            nodeId: ref.id,
            nodeType: ref.nodeType,
            nodeRole: ref.nodeRole,
            frontmatter: ref.frontmatter,
            keywords: ref.keywords,
            activationCount: ref.activationCount,
            lastActivatedAtEvent: ref.lastActivatedAtEvent,
            score: Math.round(normalizedScore * 10000) / 10000,
            rawBm25Rank: r.rank,
          };
        })
        .filter(Boolean);

      return c.json({
        items,
        total: items.length,
        query: q,
      }, 200);
    } catch (err) {
      return c.json(makeError(err), 500);
    }
  });

  // ── GET /stats — Node/edge statistics ──
  app.get('/stats', (c) => {
    try {
      const totalNodes = nodeRepo.count();
      const totalEdges = edgeRepo.countEdges();
      const hubCount = nodeRepo.count(undefined, 'hub');
      const leafCount = nodeRepo.count(undefined, 'leaf');

      const byType: Record<string, number> = {};
      for (const t of ['semantic', 'episodic', 'procedural', 'prospective', 'emotional'] as const) {
        byType[t] = nodeRepo.count(t);
      }
      byType['null'] = nodeRepo.count(null);

      const response: NodeStatsResponse = {
        totalNodes,
        totalEdges,
        byRole: { hub: hubCount, leaf: leafCount },
        byType,
      };
      return c.json(response, 200);
    } catch (err) {
      return c.json(makeError(err), 500);
    }
  });

  // ── GET /edges — Paginated edge list for EdgeMonitorPanel ──
  // Supports sorting, filtering, effective weight/shield (lazy decay), and aggregated stats.
  app.get('/edges', (c) => {
    try {
      const limit = parseLimit(c.req.query('limit'));
      const offset = parseOffset(c.req.query('offset'));

      // Sorting
      const sortField = c.req.query('sortField') ?? 'weight';
      const sortDirection = c.req.query('sortDirection') === 'asc' ? 'ASC' : 'DESC';

      // Filtering
      const edgeType = c.req.query('edgeType') ?? undefined;
      const sourceType = c.req.query('sourceType') ?? undefined;
      const targetType = c.req.query('targetType') ?? undefined;
      const minWeight = c.req.query('minWeight') ? parseFloat(c.req.query('minWeight')!) : undefined;
      const maxWeight = c.req.query('maxWeight') ? parseFloat(c.req.query('maxWeight')!) : undefined;
      const searchQuery = c.req.query('q') ?? undefined;
      const includeStats = c.req.query('includeStats') === 'true';

      // Get current event counter for lazy decay computation
      let currentEventCounter = 0;
      if (deps.getEventCounter) {
        currentEventCounter = deps.getEventCounter();
      } else {
        // Fallback: use max last_activated_at_event from weighted_edges
        try {
          const row = (edgeRepo as unknown as { db: import('better-sqlite3').Database }).db
            .prepare('SELECT MAX(last_activated_at_event) as maxEvent FROM weighted_edges')
            .get() as { maxEvent: number | null } | undefined;
          currentEventCounter = row?.maxEvent ?? 0;
        } catch { currentEventCounter = 0; }
      }

      // Build SQL query with filters
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (edgeType) {
        conditions.push('e.edge_type = ?');
        params.push(edgeType);
      }
      if (sourceType) {
        conditions.push('e.source_type = ?');
        params.push(sourceType);
      }
      if (targetType) {
        conditions.push('e.target_type = ?');
        params.push(targetType);
      }
      if (minWeight !== undefined) {
        conditions.push('e.weight >= ?');
        params.push(minWeight);
      }
      if (maxWeight !== undefined) {
        conditions.push('e.weight <= ?');
        params.push(maxWeight);
      }
      if (searchQuery) {
        // Search in source/target node frontmatter via JOIN
        conditions.push('(sn.frontmatter LIKE ? OR tn.frontmatter LIKE ?)');
        const like = `%${searchQuery}%`;
        params.push(like, like);
      }

      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

      // Map sortField to SQL column
      const sortColumnMap: Record<string, string> = {
        weight: 'e.weight',
        effectiveWeight: 'e.weight', // sort by stored weight, effective computed post-fetch
        shield: 'e.shield',
        effectiveShield: 'e.shield',
        activationCount: 'e.activation_count',
        decayRate: 'e.decay_rate',
        lastActivatedAtEvent: 'e.last_activated_at_event',
      };
      const sortCol = sortColumnMap[sortField] ?? 'e.weight';

      // Access the underlying database from edgeRepo
      const db = (edgeRepo as unknown as { db: import('better-sqlite3').Database }).db;

      // Count total matching edges
      const countSql = `
        SELECT COUNT(*) as cnt
        FROM weighted_edges e
        LEFT JOIN memory_nodes sn ON sn.id = e.source_id
        LEFT JOIN memory_nodes tn ON tn.id = e.target_id
        ${whereClause}
      `;
      const countRow = db.prepare(countSql).get(...params) as { cnt: number };
      const total = countRow.cnt;

      // Fetch paginated edges with node labels
      const dataSql = `
        SELECT
          e.id, e.source_id, e.source_type, e.target_id, e.target_type,
          e.edge_type, e.weight, e.initial_weight, e.shield,
          e.learning_rate, e.decay_rate, e.activation_count,
          e.last_activated_at_event,
          sn.frontmatter as source_frontmatter,
          tn.frontmatter as target_frontmatter
        FROM weighted_edges e
        LEFT JOIN memory_nodes sn ON sn.id = e.source_id
        LEFT JOIN memory_nodes tn ON tn.id = e.target_id
        ${whereClause}
        ORDER BY ${sortCol} ${sortDirection}
        LIMIT ? OFFSET ?
      `;
      const dataParams = [...params, limit, offset];
      const rows = db.prepare(dataSql).all(...dataParams) as Array<{
        id: string;
        source_id: string;
        source_type: string;
        target_id: string;
        target_type: string;
        edge_type: string;
        weight: number;
        initial_weight: number;
        shield: number;
        learning_rate: number;
        decay_rate: number;
        activation_count: number;
        last_activated_at_event: number;
        source_frontmatter: string | null;
        target_frontmatter: string | null;
      }>;

      // Compute effective weight/shield with lazy decay
      const items = rows.map(r => {
        const eventDelta = Math.max(0, currentEventCounter - r.last_activated_at_event);
        const decayAmount = r.decay_rate * eventDelta;
        let effectiveShield = r.shield;
        let effectiveWeight = r.weight;

        if (decayAmount > 0) {
          if (effectiveShield >= decayAmount) {
            effectiveShield -= decayAmount;
          } else {
            const remaining = decayAmount - effectiveShield;
            effectiveShield = 0;
            effectiveWeight = Math.max(0, effectiveWeight - remaining);
          }
        }

        const decayGap = eventDelta;
        const isDead = effectiveWeight <= 0;

        return {
          id: r.id,
          sourceId: r.source_id,
          sourceType: r.source_type,
          sourceLabel: r.source_frontmatter?.slice(0, 80) ?? undefined,
          targetId: r.target_id,
          targetType: r.target_type,
          targetLabel: r.target_frontmatter?.slice(0, 80) ?? undefined,
          edgeType: r.edge_type,
          weight: r.weight,
          initialWeight: r.initial_weight,
          shield: r.shield,
          learningRate: r.learning_rate,
          decayRate: r.decay_rate,
          activationCount: r.activation_count,
          lastActivatedAtEvent: r.last_activated_at_event,
          effectiveWeight: Math.round(effectiveWeight * 1000) / 1000,
          effectiveShield: Math.round(effectiveShield * 1000) / 1000,
          decayGap,
          isDead,
        };
      });

      // Build stats if requested
      let stats: {
        totalEdges: number;
        avgWeight: number;
        avgShield: number;
        deadCount: number;
        byType: Record<string, number>;
      } | undefined;

      if (includeStats) {
        const statsSql = `
          SELECT
            COUNT(*) as total,
            AVG(weight) as avgWeight,
            AVG(shield) as avgShield
          FROM weighted_edges
        `;
        const statsRow = db.prepare(statsSql).get() as {
          total: number;
          avgWeight: number | null;
          avgShield: number | null;
        };

        // Count dead edges (effective weight <= 0 after decay)
        const deadSql = `
          SELECT COUNT(*) as cnt FROM weighted_edges
          WHERE weight - MAX(0, decay_rate * MAX(0, ? - last_activated_at_event) - shield) <= 0
            AND decay_rate > 0 AND last_activated_at_event < ?
        `;
        const deadRow = db.prepare(deadSql).get(currentEventCounter, currentEventCounter) as { cnt: number };

        // Count by edge type
        const typeSql = `SELECT edge_type, COUNT(*) as cnt FROM weighted_edges GROUP BY edge_type`;
        const typeRows = db.prepare(typeSql).all() as Array<{ edge_type: string; cnt: number }>;
        const byType: Record<string, number> = {};
        for (const tr of typeRows) {
          byType[tr.edge_type] = tr.cnt;
        }

        stats = {
          totalEdges: statsRow.total,
          avgWeight: Math.round((statsRow.avgWeight ?? 0) * 1000) / 1000,
          avgShield: Math.round((statsRow.avgShield ?? 0) * 1000) / 1000,
          deadCount: deadRow.cnt,
          byType,
        };
      }

      return c.json({
        items,
        total,
        limit,
        offset,
        currentEventCounter,
        ...(stats ? { stats } : {}),
      }, 200);
    } catch (err) {
      return c.json(makeError(err), 500);
    }
  });

  // ── GET /hubs — List hub nodes ──
  app.get('/hubs', (c) => {
    try {
      const depth = parseDepth(c.req.query('depth'));
      const nodeType = parseNodeType(c.req.query('nodeType'));
      const limit = parseLimit(c.req.query('limit'));
      const offset = parseOffset(c.req.query('offset'));

      // Use nodeRepo.getHubs for efficient hub-only queries, then paginate in-memory
      // For scalability, use listRefs with nodeRole='hub' filter
      const result = nodeRepo.listRefs({
        limit,
        offset,
        nodeType,
        nodeRole: 'hub',
        orderBy: 'activation_desc',
      });

      if (depth === 0) {
        return c.json({
          items: result.items,
          total: result.total,
          limit,
          offset,
        } satisfies PaginatedResponse<MemoryNodeRef>, 200);
      }

      // For depth > 0, need to fetch full data for each node and project
      const ids = result.items.map(r => r.id);
      const projected = loadAtDepth(ids, depth);

      return c.json({
        items: projected,
        total: result.total,
        limit,
        offset,
      }, 200);
    } catch (err) {
      return c.json(makeError(err), 500);
    }
  });

  // ── GET /:id/children — Lazy-load children at configurable depth ──
  app.get('/:id/children', (c) => {
    try {
      const parentId = c.req.param('id');
      const depth = parseDepth(c.req.query('depth'));
      const limit = parseLimit(c.req.query('limit'));
      const offset = parseOffset(c.req.query('offset'));
      const minWeight = c.req.query('minWeight') ? parseFloat(c.req.query('minWeight')!) : undefined;

      // Verify parent exists
      const parent = nodeRepo.getById(parentId);
      if (!parent) {
        return c.json({
          error: 'NOT_FOUND',
          message: `Memory node ${parentId} not found`,
        } satisfies ErrorResponse, 404);
      }

      // Get all connected edges (both directions)
      const allEdges = edgeRepo.getConnectedEdges(parentId);

      // Apply minWeight filter
      const filteredEdges = minWeight != null
        ? allEdges.filter(e => e.weight >= minWeight)
        : allEdges;

      // Paginate edges
      const total = filteredEdges.length;
      const pagedEdges = filteredEdges.slice(offset, offset + limit);

      // Collect child node IDs (the "other" node in each edge)
      const childIds = pagedEdges.map(e =>
        e.sourceId === parentId ? e.targetId : e.sourceId
      );

      // Load children at requested depth
      const childNodes = loadAtDepthMap(childIds, depth);

      // Build response
      const children: ChildItem<unknown>[] = [];
      for (let i = 0; i < pagedEdges.length; i++) {
        const edge = pagedEdges[i];
        const childId = childIds[i];
        const node = childNodes.get(childId);
        if (!node) continue;

        children.push({
          node,
          edge: {
            id: edge.id,
            edgeType: edge.edgeType,
            weight: edge.weight,
            shield: edge.shield,
            direction: edge.sourceId === parentId ? 'outgoing' : 'incoming',
          },
        });
      }

      return c.json({
        parentId,
        children,
        total,
      } satisfies ChildrenResponse<unknown>, 200);
    } catch (err) {
      return c.json(makeError(err), 500);
    }
  });

  // ── GET /:id/subgraph — N-hop neighbor subgraph for local exploration ──
  app.get('/:id/subgraph', (c) => {
    try {
      const centerId = c.req.param('id');
      const hops = Math.min(5, Math.max(1, parseInt(c.req.query('hops') ?? '2', 10) || 2));
      const maxNodes = Math.min(500, Math.max(10, parseInt(c.req.query('maxNodes') ?? '200', 10) || 200));
      const minWeight = c.req.query('minWeight') ? parseFloat(c.req.query('minWeight')!) : 0;

      // Verify center node exists
      const centerNode = nodeRepo.getById(centerId);
      if (!centerNode) {
        return c.json({
          error: 'NOT_FOUND',
          message: `Memory node ${centerId} not found`,
        } satisfies ErrorResponse, 404);
      }

      // BFS N-hop traversal
      const visitedNodes = new Set<string>([centerId]);
      const collectedEdges: Array<{
        id: string;
        sourceId: string;
        targetId: string;
        edgeType: string;
        weight: number;
        shield: number;
      }> = [];
      let frontier = [centerId];

      for (let hop = 0; hop < hops && frontier.length > 0 && visitedNodes.size < maxNodes; hop++) {
        const nextFrontier: string[] = [];

        for (const nodeId of frontier) {
          if (visitedNodes.size >= maxNodes) break;

          const edges = edgeRepo.getConnectedEdges(nodeId);
          for (const edge of edges) {
            if (edge.weight < minWeight) continue;

            const neighborId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;

            // Add edge (deduplicate by id)
            if (!collectedEdges.some(e => e.id === edge.id)) {
              collectedEdges.push({
                id: edge.id,
                sourceId: edge.sourceId,
                targetId: edge.targetId,
                edgeType: edge.edgeType,
                weight: edge.weight,
                shield: edge.shield,
              });
            }

            if (!visitedNodes.has(neighborId)) {
              visitedNodes.add(neighborId);
              nextFrontier.push(neighborId);
              if (visitedNodes.size >= maxNodes) break;
            }
          }
        }

        frontier = nextFrontier;
      }

      // Load L0 refs for all visited nodes
      const nodeIds = Array.from(visitedNodes);
      const refs = nodeRepo.getRefsById(nodeIds);

      // Filter edges to only include edges where both endpoints are in the subgraph
      const filteredEdges = collectedEdges.filter(
        e => visitedNodes.has(e.sourceId) && visitedNodes.has(e.targetId),
      );

      return c.json({
        centerId,
        hops,
        nodes: refs,
        edges: filteredEdges,
        totalNodes: refs.length,
        totalEdges: filteredEdges.length,
      }, 200);
    } catch (err) {
      return c.json(makeError(err), 500);
    }
  });

  // ── GET /:id — Get single node at configurable depth ──
  app.get('/:id', (c) => {
    try {
      const id = c.req.param('id');
      const depth = parseDepth(c.req.query('depth'));

      // Use depth-specific repo methods for efficiency
      let result: MemoryNodeRef | MemoryNodeL1 | MemoryNodeL2 | ReturnType<typeof sanitizeNode> | null = null;

      switch (depth) {
        case 0: {
          const refs = nodeRepo.getRefsById([id]);
          result = refs.length > 0 ? refs[0] : null;
          break;
        }
        case 1:
          result = nodeRepo.getL1ById(id);
          break;
        case 2:
          result = nodeRepo.getL2ById(id);
          break;
        case 3: {
          const node = nodeRepo.getById(id);
          result = node ? sanitizeNode(node) : null;
          break;
        }
      }

      if (!result) {
        return c.json({
          error: 'NOT_FOUND',
          message: `Memory node ${id} not found`,
        } satisfies ErrorResponse, 404);
      }

      return c.json(result, 200);
    } catch (err) {
      return c.json(makeError(err), 500);
    }
  });

  // ── GET / — List nodes at configurable depth with pagination ──
  app.get('/', (c) => {
    try {
      const depth = parseDepth(c.req.query('depth'));
      const limit = parseLimit(c.req.query('limit'));
      const offset = parseOffset(c.req.query('offset'));
      const nodeType = parseNodeType(c.req.query('nodeType'));
      const nodeRole = parseNodeRole(c.req.query('nodeRole'));
      const orderBy = parseOrderBy(c.req.query('orderBy'));

      const listOpts = { limit, offset, nodeType, nodeRole, orderBy };

      if (depth === 0) {
        const result = nodeRepo.listRefs(listOpts);
        return c.json({
          items: result.items,
          total: result.total,
          limit,
          offset,
        } satisfies PaginatedResponse<MemoryNodeRef>, 200);
      }

      if (depth === 1) {
        const result = nodeRepo.listL1(listOpts);
        return c.json({
          items: result.items,
          total: result.total,
          limit,
          offset,
        } satisfies PaginatedResponse<MemoryNodeL1>, 200);
      }

      // For depth 2 and 3, get IDs first via listRefs, then load at depth
      const refResult = nodeRepo.listRefs(listOpts);
      const ids = refResult.items.map(r => r.id);
      const projected = loadAtDepth(ids, depth);

      return c.json({
        items: projected,
        total: refResult.total,
        limit,
        offset,
      }, 200);
    } catch (err) {
      return c.json(makeError(err), 500);
    }
  });

  // ── Helper: load nodes at specific depth ──

  function loadAtDepth(ids: string[], depth: Depth): unknown[] {
    if (ids.length === 0) return [];
    switch (depth) {
      case 0:
        return nodeRepo.getRefsByIds(ids);
      case 1:
        return nodeRepo.getL1ByIds(ids);
      case 2:
        return nodeRepo.getL2ByIds(ids);
      case 3:
        return nodeRepo.getByIds(ids).map(sanitizeNode);
    }
  }

  function loadAtDepthMap(ids: string[], depth: Depth): Map<string, unknown> {
    if (ids.length === 0) return new Map();
    const items = loadAtDepth(ids, depth) as Array<{ id: string }>;
    return new Map(items.map(item => [item.id, item]));
  }

  return app;
}

// ─── Error Helpers ───────────────────────────────────────

function makeError(err: unknown): ErrorResponse {
  const message = err instanceof Error ? err.message : 'Internal server error';
  console.error('[memory-node-router error]', err);
  return { error: 'INTERNAL_ERROR', message };
}
