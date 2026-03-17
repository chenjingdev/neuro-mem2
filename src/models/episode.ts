/**
 * Episode models — chronological events/actions/decisions extracted
 * from conversations in batch (post-conversation).
 *
 * Episodes represent structured memories of what happened during
 * a conversation, with full source traceability.
 */

/**
 * The type of episode extracted from a conversation.
 * - action: Something the user or assistant did (e.g., "wrote a function", "deployed code")
 * - decision: A choice made during the conversation (e.g., "chose React over Vue")
 * - event: An external event referenced (e.g., "build failed", "PR was merged")
 * - discovery: New information learned (e.g., "found a bug", "identified root cause")
 */
export type EpisodeType = 'action' | 'decision' | 'event' | 'discovery';

export const EPISODE_TYPES: readonly EpisodeType[] = ['action', 'decision', 'event', 'discovery'] as const;

/**
 * An Episode node stored in the graph DB.
 */
export interface Episode {
  /** Unique episode identifier (UUID v4) */
  id: string;
  /** Source conversation ID */
  conversationId: string;
  /** Type of episode */
  type: EpisodeType;
  /** Human-readable title/summary of the episode */
  title: string;
  /** Detailed description of what happened */
  description: string;
  /** Start turn index in the source conversation (inclusive) */
  startTurnIndex: number;
  /** End turn index in the source conversation (inclusive) */
  endTurnIndex: number;
  /** IDs of source messages this episode was derived from */
  sourceMessageIds: string[];
  /** Actors involved (e.g., "user", "assistant", "CI system") */
  actors: string[];
  /** Outcome or result of this episode, if applicable */
  outcome?: string;
  /** ISO 8601 timestamp of when the episode was extracted */
  createdAt: string;
  /** Optional metadata (extraction model, confidence, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * Raw LLM output for a single extracted episode — before ID/timestamp assignment.
 */
export interface ExtractedEpisodeRaw {
  type: EpisodeType;
  title: string;
  description: string;
  startTurnIndex: number;
  endTurnIndex: number;
  actors: string[];
  outcome?: string;
}

/**
 * Input for batch episode extraction.
 */
export interface EpisodeExtractionInput {
  /** The conversation ID to extract episodes from */
  conversationId: string;
  /** Optional extraction options */
  options?: {
    /** Maximum number of episodes to extract */
    maxEpisodes?: number;
  };
}

/**
 * Result of episode extraction for a conversation.
 */
export interface EpisodeExtractionResult {
  conversationId: string;
  episodes: Episode[];
  /** Total extraction time in milliseconds */
  extractionTimeMs: number;
  /** Whether extraction was successful */
  ok: boolean;
  /** Error message if failed */
  error?: string;
  /** Raw LLM response for debugging */
  rawResponse?: string;
}
