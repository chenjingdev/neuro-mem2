/**
 * EntityHubLinker — Post-processing entity matching and hub linking for ingested MemoryNodes.
 *
 * After the MemoryNodeExtractor produces leaf nodes with relatedEntities,
 * this service resolves each entity to an existing Hub or creates a new one,
 * then links the leaf node to the Hub via WeightedEdge.
 *
 * Pipeline:
 *   1. Collect all unique entity labels from ExtractedMemoryNode.relatedEntities
 *   2. For each entity label:
 *      a. Check exact-match hub lookup (case-insensitive findHubByLabel)
 *      b. If no exact match, use HubMatcher (FTS5 + cosine >= 0.85) with entity embedding
 *      c. If match found → reuse existing Hub
 *      d. If no match → create new Hub node with entity label
 *   3. Create 'about' edges from each leaf node to its matched/new hubs
 *   4. Return linking results with stats
 *
 * Design:
 * - Deduplicates entities across nodes within the same batch
 * - Caches resolved entities to avoid redundant FTS5/cosine searches
 * - Uses batch edge creation for performance at scale
 * - No additional LLM calls (pure FTS5 + cosine matching)
 */

import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../retrieval/embedding-provider.js';
import { MemoryNodeRepository } from '../db/memory-node-repo.js';
import { WeightedEdgeRepository } from '../db/weighted-edge-repo.js';
import { HubMatcher, type HubMatch, type HubMatcherConfig } from './hub-matcher.js';
import type {
  ExtractedMemoryNode,
  MemoryNode,
  CreateMemoryNodeInput,
} from '../models/memory-node.js';
import type { CreateWeightedEdgeInput, WeightedEdge } from '../models/weighted-edge.js';
import { normalizeKeywords } from '../utils/keyword-normalizer.js';

// ─── Configuration ─────────────────────────────────────────────

export interface EntityHubLinkerConfig {
  /**
   * Cosine similarity threshold for entity-to-hub matching [0, 1].
   * Default: 0.85 (matches HubMatcher default)
   */
  similarityThreshold: number;

  /**
   * Default weight for leaf→hub 'about' edges.
   * Default: 50 (midpoint on 0-100 scale)
   */
  defaultEdgeWeight: number;

  /**
   * Maximum hub matches to consider per entity.
   * Default: 1 (best match only — deterministic linking)
   */
  maxHubMatchesPerEntity: number;

  /**
   * Whether to embed new hub nodes (required for future cosine matching).
   * Default: true
   */
  embedNewHubs: boolean;

  /**
   * Maximum entities to process per batch (prevents runaway on noisy LLM output).
   * Default: 50
   */
  maxEntitiesPerBatch: number;

  /**
   * HubMatcher config overrides.
   */
  hubMatcherConfig?: Partial<HubMatcherConfig>;
}

export const DEFAULT_ENTITY_HUB_LINKER_CONFIG: EntityHubLinkerConfig = {
  similarityThreshold: 0.85,
  defaultEdgeWeight: 50,
  maxHubMatchesPerEntity: 1,
  embedNewHubs: true,
  maxEntitiesPerBatch: 50,
};

// ─── Result Types ──────────────────────────────────────────────

/**
 * Result of resolving a single entity to a hub.
 */
export interface EntityResolution {
  /** The entity label from relatedEntities */
  entityLabel: string;
  /** The resolved Hub node ID */
  hubId: string;
  /** The Hub's frontmatter label */
  hubLabel: string;
  /** How the hub was resolved */
  resolution: 'exact-match' | 'cosine-match' | 'new-hub';
  /** Cosine similarity score (only for cosine-match) */
  cosineSimilarity?: number;
}

/**
 * Result of linking a single leaf node to its entity hubs.
 */
export interface NodeLinkResult {
  /** The leaf node ID */
  leafNodeId: string;
  /** Entities that were resolved and linked */
  linkedEntities: EntityResolution[];
  /** Edges created for this node */
  edgesCreated: number;
}

/**
 * Full result of an entity hub linking batch.
 */
export interface EntityHubLinkResult {
  /** Per-node linking results */
  nodeResults: NodeLinkResult[];
  /** All entity resolutions (deduplicated across nodes) */
  resolutions: EntityResolution[];
  /** Hub nodes that were newly created */
  newHubIds: string[];
  /** Hub nodes that were reused (existing) */
  reusedHubIds: string[];
  /** Total edges created */
  totalEdgesCreated: number;
  /** Performance stats */
  stats: EntityHubLinkStats;
}

export interface EntityHubLinkStats {
  /** Total unique entities processed */
  uniqueEntitiesProcessed: number;
  /** Entities matched to existing hubs by exact label */
  exactMatches: number;
  /** Entities matched to existing hubs by cosine similarity */
  cosineMatches: number;
  /** New hubs created */
  newHubsCreated: number;
  /** Total embedding calls made */
  embeddingCallsMade: number;
  /** Total time (ms) */
  totalTimeMs: number;
}

// ─── EntityHubLinker Class ─────────────────────────────────────

export class EntityHubLinker {
  readonly config: EntityHubLinkerConfig;
  private nodeRepo: MemoryNodeRepository;
  private edgeRepo: WeightedEdgeRepository;
  private hubMatcher: HubMatcher;

  constructor(
    private db: Database.Database,
    private embeddingProvider: EmbeddingProvider,
    config?: Partial<EntityHubLinkerConfig>,
  ) {
    this.config = { ...DEFAULT_ENTITY_HUB_LINKER_CONFIG, ...config };
    this.nodeRepo = new MemoryNodeRepository(db);
    this.edgeRepo = new WeightedEdgeRepository(db);
    this.hubMatcher = new HubMatcher(db, {
      similarityThreshold: this.config.similarityThreshold,
      maxMatches: this.config.maxHubMatchesPerEntity,
      ...this.config.hubMatcherConfig,
    });
  }

  /**
   * Link extracted nodes to entity hubs.
   *
   * For each node's relatedEntities, resolves to existing or new Hubs,
   * then creates 'about' edges from the leaf node to each Hub.
   *
   * @param nodes - Extracted nodes with their relatedEntities
   * @param createdNodeIds - IDs of the created leaf nodes (parallel to nodes array)
   * @param currentEventCounter - Current global event counter for edge creation
   * @returns Linking results with all resolutions and stats
   */
  async linkEntitiesToHubs(
    nodes: ExtractedMemoryNode[],
    createdNodeIds: string[],
    currentEventCounter: number = 0,
  ): Promise<EntityHubLinkResult> {
    const totalStart = performance.now();
    const stats: EntityHubLinkStats = {
      uniqueEntitiesProcessed: 0,
      exactMatches: 0,
      cosineMatches: 0,
      newHubsCreated: 0,
      embeddingCallsMade: 0,
      totalTimeMs: 0,
    };

    // ═════════════════════════════════════════════════════════════
    // Step 1: Collect and deduplicate all entity labels
    // ═════════════════════════════════════════════════════════════

    const entityToNodeIndices = new Map<string, number[]>();
    for (let i = 0; i < nodes.length; i++) {
      const entities = nodes[i].relatedEntities ?? [];
      for (const entity of entities) {
        const normalizedLabel = entity.trim().toLowerCase();
        if (!normalizedLabel) continue;
        const indices = entityToNodeIndices.get(normalizedLabel) ?? [];
        indices.push(i);
        entityToNodeIndices.set(normalizedLabel, indices);
      }
    }

    // Limit entities per batch
    const uniqueEntities = Array.from(entityToNodeIndices.keys())
      .slice(0, this.config.maxEntitiesPerBatch);
    stats.uniqueEntitiesProcessed = uniqueEntities.length;

    // ═════════════════════════════════════════════════════════════
    // Step 2: Resolve each entity to a hub (cached within batch)
    // ═════════════════════════════════════════════════════════════

    const resolutionCache = new Map<string, EntityResolution>();
    const newHubIds: string[] = [];
    const reusedHubIds: string[] = [];

    for (const entityLabel of uniqueEntities) {
      const resolution = await this.resolveEntity(
        entityLabel,
        currentEventCounter,
        stats,
      );
      resolutionCache.set(entityLabel, resolution);

      if (resolution.resolution === 'new-hub') {
        newHubIds.push(resolution.hubId);
      } else {
        if (!reusedHubIds.includes(resolution.hubId)) {
          reusedHubIds.push(resolution.hubId);
        }
      }
    }

    // ═════════════════════════════════════════════════════════════
    // Step 3: Create 'about' edges from leaf nodes to resolved hubs
    // ═════════════════════════════════════════════════════════════

    const edgeInputs: CreateWeightedEdgeInput[] = [];
    const nodeResults: NodeLinkResult[] = [];

    // Track existing edges to avoid duplicates
    const existingEdgePairs = new Set<string>();

    for (let i = 0; i < nodes.length; i++) {
      const leafNodeId = createdNodeIds[i];
      if (!leafNodeId) continue;

      const linkedEntities: EntityResolution[] = [];
      const nodeEntities = (nodes[i].relatedEntities ?? [])
        .map(e => e.trim().toLowerCase())
        .filter(e => e.length > 0);

      for (const entityLabel of nodeEntities) {
        const resolution = resolutionCache.get(entityLabel);
        if (!resolution) continue;

        // Avoid duplicate edges (same leaf → same hub)
        const edgeKey = `${leafNodeId}:${resolution.hubId}`;
        if (existingEdgePairs.has(edgeKey)) continue;
        existingEdgePairs.add(edgeKey);

        linkedEntities.push(resolution);

        edgeInputs.push({
          sourceId: leafNodeId,
          sourceType: 'leaf',
          targetId: resolution.hubId,
          targetType: 'hub',
          edgeType: 'about',
          weight: this.config.defaultEdgeWeight,
          currentEvent: currentEventCounter,
          metadata: {
            entityLabel: resolution.entityLabel,
            resolution: resolution.resolution,
            cosineSimilarity: resolution.cosineSimilarity,
          },
        });
      }

      nodeResults.push({
        leafNodeId,
        linkedEntities,
        edgesCreated: linkedEntities.length,
      });
    }

    // Batch-create all edges in a single transaction
    if (edgeInputs.length > 0) {
      this.edgeRepo.saveEdges(edgeInputs);
    }

    stats.totalTimeMs = round2(performance.now() - totalStart);

    return {
      nodeResults,
      resolutions: Array.from(resolutionCache.values()),
      newHubIds,
      reusedHubIds,
      totalEdgesCreated: edgeInputs.length,
      stats,
    };
  }

  // ─── Internal: Resolve a single entity to a hub ─────────────

  /**
   * Resolve an entity label to an existing or new Hub node.
   *
   * Resolution order:
   *   1. Exact-match by label (case-insensitive) — no embedding needed
   *   2. HubMatcher hybrid (FTS5 + cosine >= threshold) — needs embedding
   *   3. Create new Hub — needs embedding
   */
  private async resolveEntity(
    entityLabel: string,
    currentEventCounter: number,
    stats: EntityHubLinkStats,
  ): Promise<EntityResolution> {
    // ── Step 1: Exact-match by label ──
    const exactMatch = this.nodeRepo.findHubByLabel(entityLabel);
    if (exactMatch) {
      stats.exactMatches++;
      return {
        entityLabel,
        hubId: exactMatch.id,
        hubLabel: exactMatch.frontmatter,
        resolution: 'exact-match',
      };
    }

    // ── Step 2: Generate embedding for similarity matching ──
    let embedding: number[];
    try {
      const embResult = await this.embeddingProvider.embed({ text: entityLabel });
      embedding = embResult.embedding;
      stats.embeddingCallsMade++;
    } catch {
      // If embedding fails, fall through to create new hub without embedding
      return this.createNewHub(entityLabel, undefined, currentEventCounter, stats);
    }

    // ── Step 3: HubMatcher hybrid search ──
    const matchResult = this.hubMatcher.match(entityLabel, embedding);

    if (matchResult.matches.length > 0) {
      const bestMatch = matchResult.matches[0];
      stats.cosineMatches++;
      return {
        entityLabel,
        hubId: bestMatch.hubId,
        hubLabel: bestMatch.label,
        resolution: 'cosine-match',
        cosineSimilarity: bestMatch.cosineSimilarity,
      };
    }

    // ── Step 4: No match found — create new Hub ──
    return this.createNewHub(entityLabel, embedding, currentEventCounter, stats);
  }

  // ─── Internal: Create a new Hub node ────────────────────────

  private createNewHub(
    entityLabel: string,
    embedding: number[] | undefined,
    currentEventCounter: number,
    stats: EntityHubLinkStats,
  ): EntityResolution {
    const normalizedLabel = entityLabel.charAt(0).toUpperCase() + entityLabel.slice(1);

    const input: CreateMemoryNodeInput = {
      nodeType: null, // Untyped hub — will be typed by connected leaves
      nodeRole: 'hub',
      frontmatter: normalizedLabel,
      keywords: normalizeKeywords(entityLabel),
      embedding: embedding ? new Float32Array(embedding) : undefined,
      embeddingDim: embedding ? embedding.length : undefined,
      summary: `Hub node for entity: ${normalizedLabel}`,
      metadata: {
        hubType: 'entity',
        aliases: [entityLabel],
      },
      currentEventCounter,
    };

    const newHub = this.nodeRepo.create(input);
    stats.newHubsCreated++;

    return {
      entityLabel,
      hubId: newHub.id,
      hubLabel: newHub.frontmatter,
      resolution: 'new-hub',
    };
  }

  // ─── Utility: Resolve entities only (no edge creation) ──────

  /**
   * Resolve entities to hubs without creating edges.
   * Useful for preview/dry-run of entity matching.
   */
  async resolveEntitiesOnly(
    entityLabels: string[],
    currentEventCounter: number = 0,
  ): Promise<{
    resolutions: EntityResolution[];
    stats: Pick<EntityHubLinkStats, 'uniqueEntitiesProcessed' | 'exactMatches' | 'cosineMatches' | 'newHubsCreated' | 'embeddingCallsMade'>;
  }> {
    const stats: EntityHubLinkStats = {
      uniqueEntitiesProcessed: 0,
      exactMatches: 0,
      cosineMatches: 0,
      newHubsCreated: 0,
      embeddingCallsMade: 0,
      totalTimeMs: 0,
    };

    const unique = [...new Set(entityLabels.map(e => e.trim().toLowerCase()).filter(e => e.length > 0))];
    stats.uniqueEntitiesProcessed = unique.length;

    const resolutions: EntityResolution[] = [];
    for (const label of unique) {
      const resolution = await this.resolveEntity(label, currentEventCounter, stats);
      resolutions.push(resolution);
    }

    return { resolutions, stats };
  }

  /**
   * Find matching hubs for a single entity (synchronous, no creation).
   * Returns the best matching hub or null.
   */
  findMatchingHub(
    entityLabel: string,
    entityEmbedding: number[] | Float32Array,
  ): HubMatch | null {
    // Exact match first
    const exact = this.nodeRepo.findHubByLabel(entityLabel);
    if (exact) {
      return {
        hubId: exact.id,
        label: exact.frontmatter,
        nodeType: exact.nodeType,
        cosineSimilarity: 1.0,
        ftsScore: 1.0,
        hybridScore: 1.0,
        source: 'fts+cosine',
      };
    }

    // Hybrid match
    const result = this.hubMatcher.match(entityLabel, entityEmbedding);
    return result.matches.length > 0 ? result.matches[0] : null;
  }
}

// ─── Utilities ────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
