/**
 * Fact models — structured knowledge extracted from conversation turns.
 *
 * A Fact is an atomic piece of information extracted from a user+assistant
 * message pair. Facts are the real-time memory layer, extracted per-turn.
 *
 * Design principles:
 * - Each Fact is a self-contained, atomic piece of information
 * - Facts trace back to immutable raw_messages via sourceMessageIds
 * - Confidence scores reflect extraction reliability
 * - Supersession chain tracks fact evolution over time
 * - Entities + subject/predicate/object enable graph-based retrieval
 */

export interface Fact {
  /** Unique fact identifier (UUID v4) */
  id: string;
  /** Source conversation ID (references raw_conversations.id) */
  conversationId: string;
  /** Source message ID(s) this fact was extracted from (references raw_messages.id) */
  sourceMessageIds: string[];
  /** Turn index of the source turn within the conversation */
  sourceTurnIndex: number;
  /** The factual statement in canonical form */
  content: string;
  /** Semantic category of the fact */
  category: FactCategory;
  /** Confidence score from extraction [0.0, 1.0] */
  confidence: number;
  /** Named entities referenced in this fact */
  entities: string[];
  /** Optional subject entity (who/what the fact is about) */
  subject?: string;
  /** Optional predicate (the relationship or property) */
  predicate?: string;
  /** Optional object entity (the value or target) */
  object?: string;
  /** Whether this fact has been superseded by a newer fact */
  superseded: boolean;
  /** ID of the fact that supersedes this one, if any */
  supersededBy?: string;
  /** ISO 8601 timestamp of extraction */
  createdAt: string;
  /** ISO 8601 timestamp of last update (e.g., confidence adjustment, supersession) */
  updatedAt: string;
  /** Optional metadata (model used, extraction details, etc.) */
  metadata?: Record<string, unknown>;
}

export type FactCategory =
  | 'preference'      // User preferences, likes/dislikes
  | 'technical'       // Technical decisions, stack choices, patterns
  | 'requirement'     // Project requirements, constraints
  | 'decision'        // Decisions made during conversation
  | 'context'         // Background context, project info
  | 'instruction'     // Standing instructions, conventions
  | 'knowledge'       // Domain knowledge shared or confirmed
  | 'relationship'    // Relationships between entities/concepts
  | 'other';          // Uncategorized facts

export const FACT_CATEGORIES: readonly FactCategory[] = [
  'preference',
  'technical',
  'requirement',
  'decision',
  'context',
  'instruction',
  'knowledge',
  'relationship',
  'other',
] as const;

/**
 * Raw extraction result before ID assignment and persistence.
 */
export interface ExtractedFact {
  content: string;
  category: FactCategory;
  confidence: number;
  entities: string[];
  /** Optional subject/predicate/object triple */
  subject?: string;
  predicate?: string;
  object?: string;
}

/**
 * Input for creating a Fact — IDs and timestamps are generated internally.
 */
export interface CreateFactInput {
  /** The factual content in natural language */
  content: string;
  /** Source conversation ID */
  conversationId: string;
  /** Source message IDs this fact was extracted from */
  sourceMessageIds: string[];
  /** Turn index within the conversation */
  sourceTurnIndex: number;
  /** Confidence score [0.0, 1.0] */
  confidence: number;
  /** Semantic category */
  category: FactCategory;
  /** Named entities */
  entities: string[];
  /** Optional subject/predicate/object triple */
  subject?: string;
  predicate?: string;
  object?: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Input for updating an existing Fact.
 */
export interface UpdateFactInput {
  /** Updated confidence score */
  confidence?: number;
  /** Updated category */
  category?: FactCategory;
  /** Mark as superseded */
  superseded?: boolean;
  /** ID of the superseding fact */
  supersededBy?: string;
  /** Additional metadata (merged with existing) */
  metadata?: Record<string, unknown>;
}

/**
 * Input to the fact extractor: a conversation turn (user + assistant pair).
 */
export interface FactExtractionInput {
  conversationId: string;
  /** The user message */
  userMessage: {
    id: string;
    content: string;
    turnIndex: number;
  };
  /** The assistant response */
  assistantMessage: {
    id: string;
    content: string;
    turnIndex: number;
  };
  /** Optional prior context for better extraction */
  priorContext?: string;
}
