/**
 * Concept node models — abstract topics, technologies, and themes
 * extracted from conversations in batch (post-conversation).
 *
 * Concepts are deduplicated by canonical name and accumulate
 * source conversation references over time.
 */

import type { ConceptCategory } from '../extraction/concept-prompt.js';

export type { ConceptCategory } from '../extraction/concept-prompt.js';

/**
 * A Concept node — an abstract topic/theme persisted in the graph DB.
 */
export interface Concept {
  /** Unique concept identifier (UUID v4) */
  id: string;
  /** Canonical name of the concept */
  name: string;
  /** Description of the concept in context */
  description: string;
  /** Alternative names, abbreviations, or synonyms */
  aliases: string[];
  /** Category/domain classification */
  category: ConceptCategory;
  /** Relevance score (0-1), updated as concept recurs */
  relevance: number;
  /** IDs of conversations where this concept was found */
  sourceConversationIds: string[];
  /** ISO 8601 timestamp of when the concept was first extracted */
  createdAt: string;
  /** ISO 8601 timestamp of last update */
  updatedAt: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating a new concept.
 */
export interface CreateConceptInput {
  name: string;
  description: string;
  aliases?: string[];
  category: ConceptCategory;
  relevance?: number;
  sourceConversationId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for updating an existing concept (e.g., adding a new source conversation).
 */
export interface UpdateConceptInput {
  /** Add a new source conversation ID */
  addSourceConversationId?: string;
  /** Update relevance score */
  relevance?: number;
  /** Merge new aliases */
  addAliases?: string[];
  /** Update description */
  description?: string;
  /** Additional metadata (merged with existing) */
  metadata?: Record<string, unknown>;
}
