/**
 * MemoryNode types for the web UI — mirrors the backend MemoryNode model.
 *
 * These types are used by the DetailPanel and graph visualization components
 * to display and edit MemoryNode data fetched from the API.
 */

// ─── Node Classification ─────────────────────────────────────

export type MemoryNodeType =
  | 'semantic'
  | 'episodic'
  | 'procedural'
  | 'prospective'
  | 'emotional';

export const MEMORY_NODE_TYPES: readonly MemoryNodeType[] = [
  'semantic', 'episodic', 'procedural', 'prospective', 'emotional',
] as const;

export type MemoryNodeTypeNullable = MemoryNodeType | null;

export type MemoryNodeRole = 'hub' | 'leaf';

export const MEMORY_NODE_ROLES: readonly MemoryNodeRole[] = ['hub', 'leaf'] as const;

// ─── L1 Metadata ─────────────────────────────────────────────

export interface MemoryNodeMetadata {
  // Common
  entities?: string[];
  category?: string;
  confidence?: number;
  salience?: number;

  // Semantic-specific (SPO triple)
  subject?: string;
  predicate?: string;
  object?: string;

  // Episodic-specific
  episodeType?: 'action' | 'decision' | 'event' | 'discovery';
  actors?: string[];
  outcome?: string;
  startTurnIndex?: number;
  endTurnIndex?: number;

  // Procedural-specific
  steps?: string[];
  prerequisites?: string[];

  // Prospective-specific
  dueDate?: string;
  priority?: 'low' | 'medium' | 'high';
  status?: 'pending' | 'in-progress' | 'done';

  // Emotional-specific
  emotion?: string;
  intensity?: number;
  trigger?: string;

  // Hub-specific
  hubType?: 'entity' | 'topic' | 'temporal' | 'composite';
  aliases?: string[];
  relevance?: number;

  // Extensible
  [key: string]: unknown;
}

// ─── Core MemoryNode (API response) ──────────────────────────

export interface MemoryNodeData {
  id: string;

  // Classification
  nodeType: MemoryNodeTypeNullable;
  nodeRole: MemoryNodeRole;

  // L0: Anchor / Embedding / Keywords
  frontmatter: string;
  keywords: string;
  hasEmbedding: boolean;
  embeddingDim?: number;

  // L1: JSON Metadata
  metadata: MemoryNodeMetadata;

  // L2: Summary
  summary: string;

  // L3: Source Turn References
  sourceMessageIds: string[];
  conversationId?: string;
  sourceTurnIndex?: number;

  // Lifecycle (event-based)
  createdAtEvent: number;
  lastActivatedAtEvent: number;
  activationCount: number;

  // Timestamps
  createdAt: string;
  updatedAt: string;
}

// ─── WeightedEdge (connected edges) ─────────────────────────

export interface WeightedEdgeData {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType: string;
  weight: number;
  initialWeight: number;
  shield: number;
  learningRate: number;
  decayRate: number;
  activationCount: number;
  lastActivatedAtEvent: number;
  /** Computed effective weight after decay */
  effectiveWeight?: number;
  /** Computed decay amount */
  decayAmount?: number;
  /** Connected node frontmatter (for display) */
  connectedNodeLabel?: string;
  connectedNodeId?: string;
  connectedNodeRole?: MemoryNodeRole;
}

// ─── Decay Info ─────────────────────────────────────────────

export interface DecayInfo {
  /** Current global event counter */
  currentEventCounter: number;
  /** Events since last activation */
  eventsSinceActivation: number;
  /** Computed decay factor [0, 1] */
  decayFactor: number;
  /** Whether the node is at risk of being forgotten */
  isAtRisk: boolean;
}

// ─── Update Input ───────────────────────────────────────────

export interface UpdateMemoryNodeInput {
  frontmatter?: string;
  keywords?: string;
  summary?: string;
  metadata?: Partial<MemoryNodeMetadata>;
  nodeRole?: MemoryNodeRole;
}

// ─── Display Helpers (re-exported from centralized config) ────

export {
  NODE_TYPE_COLORS,
  NODE_ROLE_COLORS,
  NODE_TYPE_ICONS,
  NODE_ROLE_ICONS,
  NODE_TYPE_PALETTES,
  NODE_ROLE_PALETTES,
  getNodeTypePalette,
  getNodeRolePalette,
  resolveNodeColor,
} from '../config/node-colors';
