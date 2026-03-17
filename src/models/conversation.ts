/**
 * Raw Conversation models — immutable records of original conversation data.
 *
 * Design principles:
 * - Original conversation data is ALWAYS preserved immutably
 * - Each message has a unique ID for referencing from memory layers
 * - Conversations are append-only; messages cannot be modified or deleted
 */

export type Role = 'user' | 'assistant' | 'system';

export interface RawMessage {
  /** Unique message identifier (UUID v4) */
  id: string;
  /** Parent conversation ID */
  conversationId: string;
  /** Message role */
  role: Role;
  /** Raw message content (preserved exactly as received) */
  content: string;
  /** Zero-based turn index within the conversation */
  turnIndex: number;
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
