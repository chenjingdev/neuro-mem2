/**
 * MemoryNode — unified memory model replacing Fact/Episode/Concept/Anchor.
 *
 * Each MemoryNode carries 4 layers of progressive depth:
 *   L0 — anchor/embedding/keywords: frontmatter label + FTS5 keywords + embedding vector
 *   L1 — JSON metadata: structured details (entities, category, confidence, SPO triples, etc.)
 *   L2 — summary: human-readable summary text
 *   L3 — raw_messages (conversation_id, turn_index) reference: link back to original source turns
 *
 * Retrieval starts at L0 (cheapest), then deepens to L1/L2/L3 as needed (progressive depth).
 */

// ─── Node Type Classification ─────────────────────────────────────

/**
 * nodeType distinguishes the *kind* of memory content.
 * null is allowed for hub/index nodes that don't have a specific content type.
 */
export type MemoryNodeType =
  | 'semantic'      // Declarative knowledge (facts, definitions, relationships)
  | 'episodic'      // Chronological event/experience memory
  | 'procedural'    // How-to knowledge, workflows, processes
  | 'prospective'   // Future plans, goals, intentions, reminders
  | 'emotional';    // Emotional context, sentiment, feelings

export const MEMORY_NODE_TYPES: readonly MemoryNodeType[] = [
  'semantic', 'episodic', 'procedural', 'prospective', 'emotional',
] as const;

/**
 * Nullable variant — allows null for nodes that don't have a specific type.
 */
export type MemoryNodeTypeNullable = MemoryNodeType | null;

/**
 * nodeRole distinguishes the *function* of the node in the graph.
 */
export type MemoryNodeRole =
  | 'hub'    // High-connectivity semantic anchor (replaces old Anchor entity)
  | 'leaf';  // Terminal content node (most individual memories)

export const MEMORY_NODE_ROLES: readonly MemoryNodeRole[] = [
  'hub', 'leaf',
] as const;

// ─── L1 Metadata Structure ────────────────────────────────────────

/**
 * Structured metadata stored as JSON in the L1 layer.
 * Fields are type-dependent; not all nodes populate all fields.
 */
export interface MemoryNodeMetadata {
  // ── Common ──
  /** Named entities mentioned */
  entities?: string[];
  /** Semantic category (fact: 'preference'|'technical'|...; concept: 'technology'|...; etc.) */
  category?: string;
  /** Extraction confidence [0.0 – 1.0] */
  confidence?: number;
  /** Salience score for decay resistance */
  salience?: number;

  // ── Semantic-specific (SPO triple) ──
  subject?: string;
  predicate?: string;
  object?: string;

  // ── Episodic-specific ──
  episodeType?: 'action' | 'decision' | 'event' | 'discovery';
  actors?: string[];
  outcome?: string;
  startTurnIndex?: number;
  endTurnIndex?: number;

  // ── Procedural-specific ──
  steps?: string[];
  prerequisites?: string[];

  // ── Prospective-specific ──
  dueDate?: string;
  priority?: 'low' | 'medium' | 'high';
  status?: 'pending' | 'in-progress' | 'done';

  // ── Emotional-specific ──
  emotion?: string;
  intensity?: number;
  trigger?: string;

  // ── Hub-specific ──
  /** Hub type (replaces old anchor_type) */
  hubType?: 'entity' | 'topic' | 'temporal' | 'composite';
  aliases?: string[];
  relevance?: number;

  // ── Extensible ──
  [key: string]: unknown;
}

// ─── Core MemoryNode Interface ────────────────────────────────────

/**
 * The unified memory node — replaces Fact, Episode, Concept, and Anchor.
 */
export interface MemoryNode {
  /** Unique identifier (UUID v4) */
  id: string;

  // ── Classification ──
  /** Content type of this node (null for untyped hub/grouping nodes) */
  nodeType: MemoryNodeTypeNullable;
  /** Graph role of this node */
  nodeRole: MemoryNodeRole;

  // ── L0: Anchor / Embedding / Keywords ──
  /** One-line frontmatter label (used in L0 retrieval context injection) */
  frontmatter: string;
  /** FTS5-indexed keywords for full-text search (space-separated, 한영 혼용) */
  keywords: string;
  /** Embedding vector (Float32Array serialized as BLOB) */
  embedding?: Float32Array;
  /** Dimensionality of the embedding vector */
  embeddingDim?: number;

  // ── L1: JSON Metadata ──
  /** Structured metadata (entities, category, confidence, SPO, etc.) */
  metadata: MemoryNodeMetadata;

  // ── L2: Summary ──
  /** Human-readable summary of this node's content */
  summary: string;

  // ── L3: Source Turn References ──
  /** JSON array of "conversationId:turnIndex" refs linking to original source turns */
  sourceMessageIds: string[];
  /** Conversation ID this node was extracted from */
  conversationId?: string;
  /** Turn index for per-turn extractions (facts) */
  sourceTurnIndex?: number;

  // ── Lifecycle (event-based) ──
  /** Global event counter value at creation */
  createdAtEvent: number;
  /** Global event counter value at last activation/access */
  lastActivatedAtEvent: number;
  /** Number of times this node has been activated (retrieved, reinforced) */
  activationCount: number;

  // ── Timestamps ──
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last-update timestamp */
  updatedAt: string;
}

// ─── Input Types ──────────────────────────────────────────────────

/**
 * Input for creating a new MemoryNode.
 */
export interface CreateMemoryNodeInput {
  /** Content type (null for untyped hub/grouping nodes) */
  nodeType: MemoryNodeTypeNullable;
  /** Graph role (default: 'leaf') */
  nodeRole?: MemoryNodeRole;

  // L0
  frontmatter: string;
  keywords: string;
  embedding?: Float32Array;
  embeddingDim?: number;

  // L1
  metadata?: MemoryNodeMetadata;

  // L2
  summary: string;

  // L3
  sourceMessageIds?: string[];
  conversationId?: string;
  sourceTurnIndex?: number;

  // Lifecycle
  /** Current global event counter value */
  currentEventCounter?: number;
}

/**
 * Input for updating an existing MemoryNode.
 */
export interface UpdateMemoryNodeInput {
  // L0 (partial)
  frontmatter?: string;
  keywords?: string;
  embedding?: Float32Array;
  embeddingDim?: number;

  // L1
  metadata?: Partial<MemoryNodeMetadata>;

  // L2
  summary?: string;

  // L3
  sourceMessageIds?: string[];

  // Role change (e.g., leaf → hub promotion)
  nodeRole?: MemoryNodeRole;
}

/**
 * Compact reference for retrieval results (L0 only).
 */
export interface MemoryNodeRef {
  id: string;
  nodeType: MemoryNodeTypeNullable;
  nodeRole: MemoryNodeRole;
  frontmatter: string;
  keywords: string;
  activationCount: number;
  lastActivatedAtEvent: number;
}

/**
 * L0+L1 retrieval result (frontmatter + metadata, no summary or raw refs).
 */
export interface MemoryNodeL1 extends MemoryNodeRef {
  metadata: MemoryNodeMetadata;
}

/**
 * Full retrieval result including L2 summary.
 */
export interface MemoryNodeL2 extends MemoryNodeL1 {
  summary: string;
}

/**
 * Output from the unified MemoryNodeExtractor (LLM extraction result).
 *
 * The LLM extracts searchKeywords + relatedEntities in one call.
 * - searchKeywords → mapped to L0 `keywords` (FTS5-indexed, 한영 혼용)
 * - relatedEntities → mapped to L1 `metadata.entities` + used for hub matching
 */
export interface ExtractedMemoryNode {
  nodeType: MemoryNodeTypeNullable;
  nodeRole?: MemoryNodeRole;
  frontmatter: string;
  /** FTS5-indexed search keywords (한영 혼용, space-separated) — extracted by LLM */
  keywords: string;
  /** LLM-extracted search keywords as raw array before normalization */
  searchKeywords: string[];
  /** LLM-extracted related entities for hub matching and edge creation */
  relatedEntities: string[];
  summary: string;
  metadata: MemoryNodeMetadata;
  /** Optional: extractor may suggest source message IDs */
  sourceMessageIds?: string[];
}

/**
 * Filter for querying memory nodes.
 */
export interface MemoryNodeFilter {
  nodeType?: MemoryNodeTypeNullable | MemoryNodeTypeNullable[];
  nodeRole?: MemoryNodeRole | MemoryNodeRole[];
  conversationId?: string;
  /** Minimum activation count */
  minActivationCount?: number;
  /** Maximum number of results */
  limit?: number;
  /** Sort order */
  orderBy?: 'activation_desc' | 'recent_first' | 'created_first';
}
