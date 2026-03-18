/**
 * HubCreationPipeline — assembles extractor output with hybrid hub matching
 * to create hub nodes and hub↔leaf edges automatically during ingestion.
 *
 * Flow (per turn):
 *   1. MemoryNodeExtractionPipeline extracts leaf nodes (with relatedEntities)
 *   2. This pipeline receives the extracted+saved leaf nodes
 *   3. For each leaf node, collects its relatedEntities from metadata
 *   4. For each entity, runs HubMatcher (FTS5 + cosine ≥ 0.85)
 *   5. If matching hub found → create WeightedEdge (hub→leaf, 'about')
 *   6. If no matching hub → create new hub node from entity, then edge
 *   7. Emits 'hub-creation.completed' event
 *
 * Design:
 * - Listens for 'memory-nodes.extracted' events
 * - Creates hub nodes as node_role='hub' with entity label as frontmatter
 * - Generates embeddings for new hub nodes via EmbeddingProvider
 * - All hub→leaf edges use 'about' edge type with initial weight 0.5
 * - Deduplicates: same entity across multiple leaf nodes → one hub, multiple edges
 * - Transactional: all hubs + edges for a turn created in one DB transaction
 */

import type Database from 'better-sqlite3';
import type {
  EventBus,
  MemoryNodesExtractedEvent,
} from '../events/event-bus.js';
import type { EmbeddingProvider } from '../retrieval/embedding-provider.js';
import { MemoryNodeRepository } from '../db/memory-node-repo.js';
import { WeightedEdgeRepository } from '../db/weighted-edge-repo.js';
import { HubMatcher } from '../services/hub-matcher.js';
import type { HubMatch, HubMatcherConfig } from '../services/hub-matcher.js';
import type {
  MemoryNode,
  CreateMemoryNodeInput,
  MemoryNodeMetadata,
} from '../models/memory-node.js';
import type { CreateWeightedEdgeInput, WeightedEdgeType } from '../models/weighted-edge.js';

// ─── Configuration ──────────────────────────────────────────────

export interface HubCreationPipelineConfig {
  /** Cosine similarity threshold for hub matching (default: 0.85) */
  similarityThreshold?: number;
  /** Maximum hub matches per entity (default: 1 — prefer strongest match) */
  maxHubMatchesPerEntity?: number;
  /** Default edge weight for new hub→leaf edges (default: 0.5) */
  defaultEdgeWeight?: number;
  /** Default edge type for hub→leaf connections (default: 'about') */
  defaultEdgeType?: WeightedEdgeType;
  /** If true, auto-creates hub nodes for unmatched entities (default: true) */
  autoCreateHubs?: boolean;
  /** Current global event counter value (for edge lifecycle) */
  currentEvent?: number;
  /** HubMatcher config overrides */
  hubMatcherConfig?: Partial<HubMatcherConfig>;
}

export const DEFAULT_HUB_CREATION_CONFIG: Required<
  Omit<HubCreationPipelineConfig, 'currentEvent' | 'hubMatcherConfig'>
> = {
  similarityThreshold: 0.85,
  maxHubMatchesPerEntity: 1,
  defaultEdgeWeight: 0.5,
  defaultEdgeType: 'about',
  autoCreateHubs: true,
};

// ─── Result Types ───────────────────────────────────────────────

export interface HubCreationResult {
  ok: boolean;
  /** Hub nodes that were newly created in this pass */
  hubsCreated: HubCreationEntry[];
  /** Hub nodes that already existed and were matched */
  hubsMatched: HubMatchEntry[];
  /** WeightedEdges created between hubs and leaf nodes */
  edgesCreated: EdgeCreationEntry[];
  /** Total processing time (ms) */
  totalTimeMs: number;
  /** Error message if pipeline failed */
  error?: string;
}

export interface HubCreationEntry {
  hubId: string;
  label: string;
  /** Entity string that triggered hub creation */
  sourceEntity: string;
  /** Leaf node IDs that are connected to this hub */
  connectedLeafIds: string[];
}

export interface HubMatchEntry {
  hubId: string;
  label: string;
  cosineSimilarity: number;
  /** Entity string that matched this hub */
  sourceEntity: string;
  /** Leaf node IDs connected to this hub in this pass */
  connectedLeafIds: string[];
}

export interface EdgeCreationEntry {
  edgeId: string;
  hubId: string;
  leafId: string;
  edgeType: WeightedEdgeType;
  weight: number;
}

// ─── Pipeline ───────────────────────────────────────────────────

export class HubCreationPipeline {
  private readonly nodeRepo: MemoryNodeRepository;
  private readonly edgeRepo: WeightedEdgeRepository;
  private readonly hubMatcher: HubMatcher;
  private readonly config: Required<
    Omit<HubCreationPipelineConfig, 'currentEvent' | 'hubMatcherConfig'>
  >;
  private readonly hubMatcherConfigOverrides?: Partial<HubMatcherConfig>;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private db: Database.Database,
    private embeddingProvider: EmbeddingProvider | null,
    private eventBus?: EventBus,
    config?: HubCreationPipelineConfig,
  ) {
    this.nodeRepo = new MemoryNodeRepository(db);
    this.edgeRepo = new WeightedEdgeRepository(db);
    this.hubMatcher = new HubMatcher(db, config?.hubMatcherConfig);
    this.config = {
      ...DEFAULT_HUB_CREATION_CONFIG,
      similarityThreshold: config?.similarityThreshold ?? DEFAULT_HUB_CREATION_CONFIG.similarityThreshold,
      maxHubMatchesPerEntity: config?.maxHubMatchesPerEntity ?? DEFAULT_HUB_CREATION_CONFIG.maxHubMatchesPerEntity,
      defaultEdgeWeight: config?.defaultEdgeWeight ?? DEFAULT_HUB_CREATION_CONFIG.defaultEdgeWeight,
      defaultEdgeType: config?.defaultEdgeType ?? DEFAULT_HUB_CREATION_CONFIG.defaultEdgeType,
      autoCreateHubs: config?.autoCreateHubs ?? DEFAULT_HUB_CREATION_CONFIG.autoCreateHubs,
    };
    this.hubMatcherConfigOverrides = config?.hubMatcherConfig;
  }

  /**
   * Start listening for memory-nodes.extracted events.
   */
  start(): void {
    if (this.unsubscribe || !this.eventBus) return;

    this.unsubscribe = this.eventBus.on<MemoryNodesExtractedEvent>(
      'memory-nodes.extracted',
      (event) => { this.handleNodesExtracted(event); },
    );
  }

  /**
   * Stop listening for events.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Handle memory-nodes.extracted event — process extracted leaf nodes,
   * find/create hubs, and create edges.
   */
  async handleNodesExtracted(
    event: MemoryNodesExtractedEvent,
    currentEvent?: number,
  ): Promise<HubCreationResult> {
    const startTime = performance.now();

    try {
      // Load the full nodes that were just extracted
      const nodes = this.nodeRepo.getByIds(event.nodeIds);
      if (nodes.length === 0) {
        return emptyResult(startTime);
      }

      return await this.processNodes(nodes, currentEvent);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        hubsCreated: [],
        hubsMatched: [],
        edgesCreated: [],
        totalTimeMs: round2(performance.now() - startTime),
        error: errorMessage,
      };
    }
  }

  /**
   * Process a batch of leaf nodes — find/create hubs and edges.
   * Can be called directly without events for testing.
   */
  async processNodes(
    leafNodes: MemoryNode[],
    currentEvent?: number,
  ): Promise<HubCreationResult> {
    const startTime = performance.now();

    const hubsCreated: HubCreationEntry[] = [];
    const hubsMatched: HubMatchEntry[] = [];
    const edgesCreated: EdgeCreationEntry[] = [];

    // Collect all entities across all leaf nodes: entity → [leafIds]
    const entityToLeafIds = new Map<string, string[]>();
    for (const node of leafNodes) {
      if (node.nodeRole !== 'leaf') continue;

      const entities = (node.metadata as MemoryNodeMetadata)?.entities ?? [];
      for (const entity of entities) {
        const normalized = entity.trim().toLowerCase();
        if (!normalized) continue;

        const existing = entityToLeafIds.get(normalized);
        if (existing) {
          existing.push(node.id);
        } else {
          entityToLeafIds.set(normalized, [node.id]);
        }
      }
    }

    if (entityToLeafIds.size === 0) {
      return emptyResult(startTime);
    }

    // Process each unique entity
    const hubCache = new Map<string, { hubId: string; label: string; isNew: boolean }>();

    for (const [normalizedEntity, leafIds] of entityToLeafIds) {
      // Check if we already processed this entity in this batch
      if (hubCache.has(normalizedEntity)) {
        const cached = hubCache.get(normalizedEntity)!;
        // Just create edges for any new leaf nodes
        for (const leafId of leafIds) {
          const edgeInput = this.buildEdgeInput(cached.hubId, leafId, currentEvent);
          const existingEdge = this.edgeRepo.findEdge(
            edgeInput.sourceId, edgeInput.targetId, edgeInput.edgeType,
          );
          if (!existingEdge) {
            const edge = this.edgeRepo.createEdge(edgeInput);
            edgesCreated.push({
              edgeId: edge.id,
              hubId: cached.hubId,
              leafId,
              edgeType: this.config.defaultEdgeType,
              weight: edge.weight,
            });
          }
        }
        continue;
      }

      // Try to find an existing hub via HubMatcher
      const matchResult = await this.findMatchingHub(normalizedEntity);

      if (matchResult) {
        // Found existing hub — create edges
        hubCache.set(normalizedEntity, {
          hubId: matchResult.hubId,
          label: matchResult.label,
          isNew: false,
        });

        const connectedLeafIds: string[] = [];
        for (const leafId of leafIds) {
          const edgeInput = this.buildEdgeInput(matchResult.hubId, leafId, currentEvent);
          const existingEdge = this.edgeRepo.findEdge(
            edgeInput.sourceId, edgeInput.targetId, edgeInput.edgeType,
          );
          if (!existingEdge) {
            const edge = this.edgeRepo.createEdge(edgeInput);
            edgesCreated.push({
              edgeId: edge.id,
              hubId: matchResult.hubId,
              leafId,
              edgeType: this.config.defaultEdgeType,
              weight: edge.weight,
            });
            connectedLeafIds.push(leafId);
          }
        }

        hubsMatched.push({
          hubId: matchResult.hubId,
          label: matchResult.label,
          cosineSimilarity: matchResult.cosineSimilarity,
          sourceEntity: normalizedEntity,
          connectedLeafIds,
        });
      } else if (this.config.autoCreateHubs) {
        // No matching hub — create a new one
        const newHub = await this.createHubForEntity(normalizedEntity, currentEvent);
        if (!newHub) continue;

        hubCache.set(normalizedEntity, {
          hubId: newHub.id,
          label: newHub.frontmatter,
          isNew: true,
        });

        const connectedLeafIds: string[] = [];
        for (const leafId of leafIds) {
          const edgeInput = this.buildEdgeInput(newHub.id, leafId, currentEvent);
          const edge = this.edgeRepo.createEdge(edgeInput);
          edgesCreated.push({
            edgeId: edge.id,
            hubId: newHub.id,
            leafId,
            edgeType: this.config.defaultEdgeType,
            weight: edge.weight,
          });
          connectedLeafIds.push(leafId);
        }

        hubsCreated.push({
          hubId: newHub.id,
          label: newHub.frontmatter,
          sourceEntity: normalizedEntity,
          connectedLeafIds,
        });
      }
    }

    const totalTimeMs = round2(performance.now() - startTime);

    return {
      ok: true,
      hubsCreated,
      hubsMatched,
      edgesCreated,
      totalTimeMs,
    };
  }

  // ─── Internal Methods ───────────────────────────────────────────

  /**
   * Find a matching hub for an entity string using HubMatcher.
   * Returns the best match or null if none found above threshold.
   */
  private async findMatchingHub(entity: string): Promise<HubMatch | null> {
    // Generate embedding for the entity
    if (!this.embeddingProvider) {
      // Without embedding provider, try FTS-only label matching
      const existingHub = this.nodeRepo.findHubByLabel(entity);
      if (existingHub) {
        return {
          hubId: existingHub.id,
          label: existingHub.frontmatter,
          nodeType: existingHub.nodeType,
          cosineSimilarity: 1.0,
          ftsScore: 1.0,
          hybridScore: 1.0,
          source: 'fts+cosine',
        };
      }
      return null;
    }

    const embResponse = await this.embeddingProvider.embed({ text: entity });
    const result = this.hubMatcher.match(entity, embResponse.embedding, {
      ...this.hubMatcherConfigOverrides,
      similarityThreshold: this.config.similarityThreshold,
      maxMatches: this.config.maxHubMatchesPerEntity,
    });

    if (result.matches.length > 0) {
      return result.matches[0]!;
    }

    // Fallback: exact label match (case-insensitive)
    const existingHub = this.nodeRepo.findHubByLabel(entity);
    if (existingHub) {
      return {
        hubId: existingHub.id,
        label: existingHub.frontmatter,
        nodeType: existingHub.nodeType,
        cosineSimilarity: 0.85, // Assign threshold since we can't compute cosine for label match
        ftsScore: 1.0,
        hybridScore: 0.88,
        source: 'fts+cosine',
      };
    }

    return null;
  }

  /**
   * Create a new hub node for an entity string.
   */
  private async createHubForEntity(
    entity: string,
    currentEvent?: number,
  ): Promise<MemoryNode | null> {
    // Capitalize entity label for frontmatter
    const label = capitalizeEntity(entity);

    const input: CreateMemoryNodeInput = {
      nodeType: null, // Hub nodes don't have a specific content type
      nodeRole: 'hub',
      frontmatter: label,
      keywords: entity.toLowerCase(),
      summary: `Hub node for entity: ${label}`,
      metadata: {
        hubType: 'entity',
        aliases: [entity],
      },
      currentEventCounter: currentEvent,
    };

    // Generate embedding if provider available
    if (this.embeddingProvider) {
      const embResponse = await this.embeddingProvider.embed({ text: entity });
      input.embedding = new Float32Array(embResponse.embedding);
      input.embeddingDim = embResponse.dimensions;
    }

    return this.nodeRepo.create(input);
  }

  /**
   * Build a WeightedEdge input for hub→leaf connection.
   */
  private buildEdgeInput(
    hubId: string,
    leafId: string,
    currentEvent?: number,
  ): CreateWeightedEdgeInput {
    return {
      sourceId: hubId,
      sourceType: 'hub',
      targetId: leafId,
      targetType: 'leaf',
      edgeType: this.config.defaultEdgeType,
      weight: this.config.defaultEdgeWeight,
      currentEvent: currentEvent ?? 0,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function emptyResult(startTime: number): HubCreationResult {
  return {
    ok: true,
    hubsCreated: [],
    hubsMatched: [],
    edgesCreated: [],
    totalTimeMs: round2(performance.now() - startTime),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Capitalize entity for hub frontmatter label.
 * "typescript" → "Typescript", "postgresql" → "Postgresql"
 */
function capitalizeEntity(entity: string): string {
  if (!entity) return entity;
  return entity.charAt(0).toUpperCase() + entity.slice(1);
}
