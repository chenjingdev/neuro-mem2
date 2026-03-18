/**
 * Raw Conversation models — immutable records of original conversation data.
 *
 * Design principles:
 * - Original conversation data is ALWAYS preserved immutably
 * - Each message is uniquely identified by (conversationId, turnIndex) composite key
 * - Conversations are append-only; messages cannot be modified or deleted
 * - Turn-based PK enables efficient range queries and progressive depth retrieval
 */

export type Role = 'user' | 'assistant' | 'system';

export interface RawMessage {
  /** Parent conversation ID (part of composite PK) */
  conversationId: string;
  /** Zero-based turn index within the conversation (part of composite PK) */
  turnIndex: number;
  /** Message role */
  role: Role;
  /** Raw message content (preserved exactly as received) */
  content: string;
  /** ISO 8601 timestamp of when the message was created */
  createdAt: string;
  /** Optional metadata (model info, token counts, etc.) */
  metadata?: Record<string, unknown>;
}

export interface RawConversation {
  /** Unique conversation identifier (UUID v4) */
  id: string;
  /** Optional human-readable title */
  title?: string;
  /** Source application (e.g., 'claude-code', 'codex', 'api') */
  source: string;
  /** ISO 8601 timestamp of conversation creation */
  createdAt: string;
  /** ISO 8601 timestamp of last message addition */
  updatedAt: string;
  /** Optional metadata (session info, user preferences, etc.) */
  metadata?: Record<string, unknown>;
  /** Messages in this conversation (ordered by turnIndex) */
  messages: RawMessage[];
}

/**
 * Input types for ingestion — what callers provide.
 * IDs and timestamps are generated internally.
 */
export interface IngestMessageInput {
  role: Role;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface IngestConversationInput {
  /** Optional conversation ID (generated if not provided) */
  id?: string;
  title?: string;
  source: string;
  messages: IngestMessageInput[];
  metadata?: Record<string, unknown>;
}

export interface AppendMessageInput {
  conversationId: string;
  role: Role;
  content: string;
  metadata?: Record<string, unknown>;
}
