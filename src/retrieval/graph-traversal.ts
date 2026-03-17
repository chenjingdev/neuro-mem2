/**
 * Graph Traversal Module — traverses the knowledge graph from seed entities
 * to find related memory nodes (facts, episodes, concepts).
 *
 * This is the "graph path" of the dual-path (vector + graph) retrieval system.
 * Given a query, it:
 * 1. Extracts key entities from the query text
 * 2. Finds seed nodes (facts, concepts, anchors) matching those entities
 * 3. Performs weighted BFS traversal through edges
 * 4. Returns ranked, deduplicated results
 */

import type Database from 'better-sqlite3';
import type { MemoryNodeType, MemoryEdge, EdgeType } from '../models/memory-edge.js';
import type { Fact } from '../models/fact.js';
import type { Episode } from '../models/episode.js';
import type { Concept } from '../models/concept.js';
import type { Anchor } from '../models/anchor.js';
import { FactRepository } from '../db/fact-repo.js';
import { EpisodeRepository } from '../db/episode-repo.js';
import { ConceptRepository } from '../db/concept-repo.js';
import { AnchorRepository } from '../db/anchor-repo.js';
import { EdgeRepository } from '../db/edge-repo.js';

// ─── Types ──────────────────────────────────────────────────────────

/** A memory node of any type, with its type discriminator */
export interface GraphNode {
  id: string;
  nodeType: MemoryNodeType;
  /** The underlying data (Fact | Episode | Concept | Anchor) */
  data: Fact | Episode | Concept | Anchor;
}

/** A traversal result: a graph node with its relevance score and path info */
export interface TraversalResult {
  node: GraphNode;
  /** Aggregated relevance score (0-1) combining edge weights and hop distance */
  score: number;
  /** Number of hops from the nearest seed node */
  hops: number;
  /** The path of edge IDs from seed to this node */
  path: string[];
  /** The seed entity that led to this node */
  seedEntity: string;
}

/** Configuration for graph traversal */
export interface GraphTraversalOptions {
  /** Maximum BFS depth (default: 2) */
  maxHops?: number;
  /** Minimum edge weight to traverse (default: 0.1) */
  minEdgeWeight?: number;
  /** Maximum total results to return (default: 20) */
  maxResults?: number;
  /** Weight decay per hop: score *= hopDecay^hop (default: 0.7) */
  hopDecay?: number;
  /** Edge types to traverse (default: all) */
  edgeTypes?: EdgeType[];
  /** Node types to include in results (default: all) */
  nodeTypes?: MemoryNodeType[];
  /** Minimum score threshold for results (default: 0.05) */
  minScore?: number;
}

/** Result of entity extraction from a query */
export interface ExtractedEntities {
  /** Named entities found in the query */
  entities: string[];
  /** Key terms/phrases that might match concept names or anchor labels */
  keyTerms: string[];
}

/** Result of the full graph traversal pipeline */
export interface GraphTraversalResult {
  /** Ranked list of related memory nodes */
  results: TraversalResult[];
  /** Entities extracted from the query */
  extractedEntities: ExtractedEntities;
  /** Seed node IDs used as starting points */
  seedNodeIds: string[];
  /** Traversal statistics */
  stats: {
    nodesVisited: number;
    edgesTraversed: number;
    timeMs: number;
  };
}

const DEFAULT_OPTIONS: Required<GraphTraversalOptions> = {
  maxHops: 2,
  minEdgeWeight: 0.1,
  maxResults: 20,
  hopDecay: 0.7,
  edgeTypes: [],
  nodeTypes: [],
  minScore: 0.05,
};

// ─── Entity Extraction ──────────────────────────────────────────────

/**
 * Extract key entities and terms from a query string.
 *
 * This is a lightweight, rule-based extraction for immediate graph seeding.
 * It extracts:
 * - Quoted phrases ("like this")
 * - CamelCase/PascalCase identifiers (e.g., TypeScript, SQLite)
 * - Technical terms with special characters (e.g., Node.js, C++)
 * - Capitalized words likely to be proper nouns
 * - Significant lowercase terms (length >= 4, not stopwords)
 */
export function extractEntitiesFromQuery(query: string): ExtractedEntities {
  const entities: string[] = [];
  const keyTerms: string[] = [];

  // 1. Extract quoted phrases
  const quotedPattern = /["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = quotedPattern.exec(query)) !== null) {
    const phrase = match[1]!.trim();
    if (phrase.length > 0) {
      entities.push(phrase);
    }
  }

  // Remove quoted content for further processing
  const unquoted = query.replace(/["'][^"']+["']/g, ' ');

  // 2. Extract technical terms with dots/plus (e.g., Node.js, C++, vue.js)
  const techTermPattern = /\b([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z]+|\+\+))\b/g;
  while ((match = techTermPattern.exec(unquoted)) !== null) {
    const term = match[1]!;
    if (term.includes('.') || term.includes('+')) {
      entities.push(term);
    }
  }

  // 3. Extract CamelCase/PascalCase identifiers
  const camelCasePattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
  while ((match = camelCasePattern.exec(unquoted)) !== null) {
    entities.push(match[1]!);
  }

  // 4. Split remaining into words
  const words = unquoted
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);

  for (const word of words) {
    // Capitalized words (potential proper nouns/technologies)
    if (/^[A-Z][a-zA-Z0-9]+$/.test(word) && word.length >= 2) {
      entities.push(word);
    }
    // Significant lowercase terms
    else if (word.length >= 4 && !STOP_WORDS.has(word.toLowerCase())) {
      keyTerms.push(word.toLowerCase());
    }
  }

  // Deduplicate while preserving order
  const uniqueEntities = [...new Set(entities)];
  const uniqueKeyTerms = [...new Set(keyTerms.filter(t => !uniqueEntities.some(
    e => e.toLowerCase() === t.toLowerCase()
  )))];

  return {
    entities: uniqueEntities,
    keyTerms: uniqueKeyTerms,
  };
}

/** Common English stop words to filter out during entity extraction */
const STOP_WORDS = new Set([
  'about', 'above', 'after', 'again', 'against', 'also', 'been', 'before',
  'being', 'below', 'between', 'both', 'cannot', 'could', 'does', 'doing',
  'down', 'during', 'each', 'from', 'further', 'have', 'having', 'here',
  'into', 'itself', 'just', 'more', 'most', 'myself', 'once', 'only',
  'other', 'over', 'same', 'should', 'some', 'such', 'than', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'under', 'until', 'very', 'want', 'were', 'what', 'when',
  'where', 'which', 'while', 'whom', 'will', 'with', 'would', 'your',
  'about', 'above', 'because', 'before', 'between', 'during',
  'how', 'many', 'much', 'need', 'the', 'and', 'for', 'are',
  'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her',
  'was', 'one', 'our', 'out', 'has', 'his', 'how', 'its',
  'let', 'may', 'new', 'now', 'old', 'see', 'way', 'who',
  'did', 'got', 'use', 'used', 'using', 'like', 'make', 'made',
  'know', 'tell', 'work', 'take', 'come', 'help', 'think', 'look',
]);

// ─── Seed Node Discovery ────────────────────────────────────────────

/**
 * Find seed nodes in the knowledge graph that match the extracted entities.
 * Searches across facts (by entity), concepts (by name/alias), and anchors (by label/alias).
 */
export function findSeedNodes(
  db: Database.Database,
  extractedEntities: ExtractedEntities,
): Map<string, { nodeType: MemoryNodeType; matchedEntity: string }> {
  const seeds = new Map<string, { nodeType: MemoryNodeType; matchedEntity: string }>();
  const allTerms = [...extractedEntities.entities, ...extractedEntities.keyTerms];

  if (allTerms.length === 0) return seeds;

  // 1. Search facts by entity overlap
  for (const term of allTerms) {
    const lowerTerm = term.toLowerCase();

    // Search facts whose entities array contains a matching term
    const factRows = db.prepare(`
      SELECT id, entities FROM facts
      WHERE superseded = 0 AND (
        LOWER(entities) LIKE ? OR
        LOWER(content) LIKE ? OR
        LOWER(subject) LIKE ? OR
        LOWER(object) LIKE ?
      )
    `).all(
      `%${lowerTerm}%`,
      `%${lowerTerm}%`,
      `%${lowerTerm}%`,
      `%${lowerTerm}%`
    ) as Array<{ id: string; entities: string }>;

    for (const row of factRows) {
      // Verify actual entity match (not just substring in JSON)
      const entities: string[] = JSON.parse(row.entities);
      const hasMatch = entities.some(e => e.toLowerCase().includes(lowerTerm)) ||
        lowerTerm.length >= 4; // Allow content/subject/object matches for longer terms

      if (hasMatch && !seeds.has(row.id)) {
        seeds.set(row.id, { nodeType: 'fact', matchedEntity: term });
      }
    }

    // 2. Search concepts by name or alias
    const conceptRows = db.prepare(`
      SELECT id, name, aliases FROM concepts
      WHERE LOWER(name) LIKE ? OR LOWER(aliases) LIKE ?
    `).all(`%${lowerTerm}%`, `%${lowerTerm}%`) as Array<{ id: string; name: string; aliases: string }>;

    for (const row of conceptRows) {
      if (!seeds.has(row.id)) {
        seeds.set(row.id, { nodeType: 'concept', matchedEntity: term });
      }
    }

    // 3. Search anchors by label or alias
    const anchorRows = db.prepare(`
      SELECT id, label, aliases FROM anchors
      WHERE LOWER(label) LIKE ? OR LOWER(aliases) LIKE ?
    `).all(`%${lowerTerm}%`, `%${lowerTerm}%`) as Array<{ id: string; label: string; aliases: string }>;

    for (const row of anchorRows) {
      if (!seeds.has(row.id)) {
        seeds.set(row.id, { nodeType: 'anchor', matchedEntity: term });
      }
    }
  }

  return seeds;
}

// ─── Graph Traversal ────────────────────────────────────────────────

/**
 * Perform weighted BFS traversal from seed nodes through the knowledge graph.
 *
 * At each hop, the traversal:
 * 1. Follows edges from current nodes (both directions)
 * 2. Filters by edge weight and type constraints
 * 3. Accumulates score with hop-distance decay
 * 4. Stops at maxHops depth
 *
 * For anchor seeds, the initial score is the anchor's decay-affected
 * `currentWeight` instead of 1.0. This ensures that stale/decayed anchors
 * produce lower-scored results throughout the entire traversal chain,
 * while recently-used anchors retain their scoring influence.
 *
 * Returns deduplicated results sorted by score.
 */
export function traverseGraph(
  db: Database.Database,
  seeds: Map<string, { nodeType: MemoryNodeType; matchedEntity: string }>,
  options: GraphTraversalOptions = {},
): { results: Map<string, TraversalResult>; stats: { nodesVisited: number; edgesTraversed: number } } {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const edgeRepo = new EdgeRepository(db);
  const anchorRepo = new AnchorRepository(db);

  // Track visited nodes and their best scores
  const visited = new Map<string, TraversalResult>();
  let edgesTraversed = 0;

  // Initialize BFS queue with seed nodes at hop 0
  // Anchor seeds use their decay-affected currentWeight as the initial score;
  // non-anchor seeds start at 1.0 (they don't have a decay mechanism)
  interface QueueItem {
    nodeId: string;
    nodeType: MemoryNodeType;
    score: number;
    hops: number;
    path: string[];
    seedEntity: string;
  }

  const queue: QueueItem[] = [];
  for (const [nodeId, { nodeType, matchedEntity }] of seeds) {
    let seedScore = 1.0;

    // For anchor seeds, use dynamically-computed effective weight
    // (which applies time + usage decay at retrieval time)
    if (nodeType === 'anchor') {
      const anchor = anchorRepo.getAnchor(nodeId);
      if (anchor) {
        seedScore = anchor.effectiveWeight;
      }
    }

    queue.push({
      nodeId,
      nodeType,
      score: seedScore,
      hops: 0,
      path: [],
      seedEntity: matchedEntity,
    });
  }

  while (queue.length > 0) {
    const item = queue.shift()!;
    const { nodeId, nodeType, score, hops, path, seedEntity } = item;

    // Skip if we already found this node with a better score
    const existing = visited.get(nodeId);
    if (existing && existing.score >= score) continue;

    // Skip if score is below threshold
    if (score < opts.minScore) continue;

    // Record visit (lazy — data resolved later)
    visited.set(nodeId, {
      node: { id: nodeId, nodeType, data: null as unknown as Fact },
      score,
      hops,
      path,
      seedEntity,
    });

    // Stop expanding if we've reached max depth
    if (hops >= opts.maxHops) continue;

    // Get all connected edges
    const edges = edgeRepo.getConnectedEdges(nodeId);
    edgesTraversed += edges.length;

    for (const edge of edges) {
      // Filter by edge weight
      if (edge.weight < opts.minEdgeWeight) continue;

      // Filter by edge type
      if (opts.edgeTypes.length > 0 && !opts.edgeTypes.includes(edge.edgeType)) continue;

      // Determine the neighbor node
      const isSource = edge.sourceId === nodeId;
      const neighborId = isSource ? edge.targetId : edge.sourceId;
      const neighborType = isSource ? edge.targetType : edge.sourceType;

      // Filter by node type
      if (opts.nodeTypes.length > 0 && !opts.nodeTypes.includes(neighborType)) continue;

      // Calculate decayed score
      const newScore = score * edge.weight * opts.hopDecay;

      // Only queue if score is worthwhile
      if (newScore >= opts.minScore) {
        queue.push({
          nodeId: neighborId,
          nodeType: neighborType,
          score: newScore,
          hops: hops + 1,
          path: [...path, edge.id],
          seedEntity,
        });
      }
    }
  }

  return {
    results: visited,
    stats: { nodesVisited: visited.size, edgesTraversed },
  };
}

// ─── Node Resolution ────────────────────────────────────────────────

/**
 * Resolve node data for traversal results.
 * Fetches the actual Fact/Episode/Concept/Anchor records from their repositories.
 */
export function resolveNodes(
  db: Database.Database,
  results: Map<string, TraversalResult>,
): TraversalResult[] {
  const factRepo = new FactRepository(db);
  const episodeRepo = new EpisodeRepository(db);
  const conceptRepo = new ConceptRepository(db);
  const anchorRepo = new AnchorRepository(db);

  const resolved: TraversalResult[] = [];

  for (const [nodeId, result] of results) {
    let data: Fact | Episode | Concept | Anchor | null = null;

    switch (result.node.nodeType) {
      case 'fact':
        data = factRepo.getById(nodeId);
        break;
      case 'episode':
        data = episodeRepo.getEpisode(nodeId);
        break;
      case 'concept':
        data = conceptRepo.getConcept(nodeId);
        break;
      case 'anchor':
        data = anchorRepo.getAnchor(nodeId);
        break;
    }

    if (data) {
      resolved.push({
        ...result,
        node: { id: nodeId, nodeType: result.node.nodeType, data },
      });
    }
  }

  // Sort by score descending
  resolved.sort((a, b) => b.score - a.score);

  return resolved;
}

// ─── Main Pipeline ──────────────────────────────────────────────────

/**
 * GraphTraverser — the main class for graph-path retrieval.
 *
 * Given a query string, it:
 * 1. Extracts entities from the query
 * 2. Finds seed nodes matching those entities
 * 3. Performs weighted BFS traversal
 * 4. Resolves and ranks results
 */
export class QueryGraphTraverser {
  constructor(
    private db: Database.Database,
    private defaultOptions: GraphTraversalOptions = {},
  ) {}

  /**
   * Perform a full graph traversal for a query.
   *
   * @param query - The search query text
   * @param options - Override traversal options
   * @returns Ranked traversal results with metadata
   */
  traverse(query: string, options?: GraphTraversalOptions): GraphTraversalResult {
    const startTime = performance.now();
    const opts = { ...this.defaultOptions, ...options };

    // Step 1: Extract entities from query
    const extractedEntities = extractEntitiesFromQuery(query);

    // Step 2: Find seed nodes
    const seeds = findSeedNodes(this.db, extractedEntities);

    // Step 3: Traverse the graph
    const { results, stats } = traverseGraph(this.db, seeds, opts);

    // Step 4: Resolve node data and rank
    const resolved = resolveNodes(this.db, results);

    // Apply maxResults limit
    const maxResults = opts.maxResults ?? DEFAULT_OPTIONS.maxResults;
    const limited = resolved.slice(0, maxResults);

    const endTime = performance.now();

    return {
      results: limited,
      extractedEntities,
      seedNodeIds: [...seeds.keys()],
      stats: {
        nodesVisited: stats.nodesVisited,
        edgesTraversed: stats.edgesTraversed,
        timeMs: Math.round(endTime - startTime),
      },
    };
  }

  /**
   * Traverse from specific seed node IDs (bypassing entity extraction).
   * Useful when seeds are already known (e.g., from vector search).
   *
   * @param seedIds - Map of nodeId -> nodeType
   * @param options - Override traversal options
   */
  traverseFromSeeds(
    seedIds: Map<string, MemoryNodeType>,
    options?: GraphTraversalOptions,
  ): GraphTraversalResult {
    const startTime = performance.now();
    const opts = { ...this.defaultOptions, ...options };

    const seeds = new Map<string, { nodeType: MemoryNodeType; matchedEntity: string }>();
    for (const [id, nodeType] of seedIds) {
      seeds.set(id, { nodeType, matchedEntity: 'direct-seed' });
    }

    const { results, stats } = traverseGraph(this.db, seeds, opts);
    const resolved = resolveNodes(this.db, results);

    const maxResults = opts.maxResults ?? DEFAULT_OPTIONS.maxResults;
    const limited = resolved.slice(0, maxResults);

    const endTime = performance.now();

    return {
      results: limited,
      extractedEntities: { entities: [], keyTerms: [] },
      seedNodeIds: [...seeds.keys()],
      stats: {
        nodesVisited: stats.nodesVisited,
        edgesTraversed: stats.edgesTraversed,
        timeMs: Math.round(endTime - startTime),
      },
    };
  }
}
