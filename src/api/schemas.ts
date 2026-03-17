/**
 * Request/Response schemas for the REST API.
 *
 * Defines TypeScript interfaces for API payloads and runtime
 * validation functions (equivalent to Pydantic schemas in FastAPI).
 */

import type { Role, IngestConversationInput, AppendMessageInput } from '../models/conversation.js';
import type { RecallResult, RecallDiagnostics } from '../retrieval/dual-path-retriever.js';
import type { MergedMemoryItem } from '../retrieval/types.js';
import type { DualPathRetrieverConfig } from '../retrieval/dual-path-retriever.js';

// ─── Ingest Schemas ──────────────────────────────────────

/** POST /ingest — ingest a full conversation */
export interface IngestConversationRequest {
  /** Optional conversation ID (auto-generated if omitted) */
  id?: string;
  /** Optional human-readable title */
  title?: string;
  /** Source application identifier (e.g., 'claude-code', 'codex', 'api') */
  source: string;
  /** Messages in the conversation */
  messages: IngestMessageSchema[];
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/** Single message within an ingest request */
export interface IngestMessageSchema {
  role: Role;
  content: string;
  metadata?: Record<string, unknown>;
}

/** POST /ingest/append — append a message to an existing conversation */
export interface AppendMessageRequest {
  /** Target conversation ID */
  conversationId: string;
  /** Message role */
  role: Role;
  /** Message content */
  content: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/** Response for ingest endpoints */
export interface IngestResponse {
  /** Conversation ID */
  conversationId: string;
  /** Number of messages stored */
  messageCount: number;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last update timestamp */
  updatedAt: string;
}

/** Response for append message endpoint */
export interface AppendMessageResponse {
  /** Message ID */
  messageId: string;
  /** Conversation ID */
  conversationId: string;
  /** Turn index of the appended message */
  turnIndex: number;
  /** ISO 8601 timestamp */
  createdAt: string;
}

// ─── Recall Schemas ──────────────────────────────────────

/** POST /recall — retrieve relevant memories for a query */
export interface RecallRequest {
  /** Query text for memory retrieval */
  query: string;
  /** Maximum number of results (default: 20) */
  maxResults?: number;
  /** Minimum relevance score threshold [0, 1] (default: 0.05) */
  minScore?: number;
  /** Weight for vector path [0, 1] (default: 0.5) */
  vectorWeight?: number;
  /** Whether to include diagnostics in response (default: false) */
  includeDiagnostics?: boolean;
  /** Full config override for advanced usage */
  config?: Partial<DualPathRetrieverConfig>;
}

/** Response for recall endpoint */
export interface RecallResponse {
  /** Ranked list of relevant memory items */
  items: RecallItemSchema[];
  /** Total number of results */
  totalItems: number;
  /** Query that was executed */
  query: string;
  /** Optional diagnostics (only if includeDiagnostics=true) */
  diagnostics?: RecallDiagnostics;
}

/** Single memory item in recall response */
export interface RecallItemSchema {
  /** Memory node ID */
  nodeId: string;
  /** Node type (fact, episode, concept, anchor) */
  nodeType: string;
  /** Relevance score [0, 1] */
  score: number;
  /** Text content of the memory */
  content: string;
  /** Which retrieval paths found this item */
  sources: string[];
  /** Individual scores from each path */
  sourceScores: {
    vector?: number;
    graph?: number;
  };
}

// ─── Error Schema ────────────────────────────────────────

/** Standard error response */
export interface ErrorResponse {
  /** Error code */
  error: string;
  /** Human-readable error message */
  message: string;
  /** Optional field-level validation errors */
  details?: ValidationError[];
}

/** Single field validation error */
export interface ValidationError {
  field: string;
  message: string;
}

// ─── Validation Functions ────────────────────────────────

const VALID_ROLES: Role[] = ['user', 'assistant', 'system'];

/**
 * Validate an IngestConversationRequest body.
 * Returns an array of validation errors (empty if valid).
 */
export function validateIngestConversation(body: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!body || typeof body !== 'object') {
    errors.push({ field: 'body', message: 'Request body must be a JSON object' });
    return errors;
  }

  const data = body as Record<string, unknown>;

  if (!data.source || typeof data.source !== 'string') {
    errors.push({ field: 'source', message: 'source is required and must be a string' });
  }

  if (!Array.isArray(data.messages)) {
    errors.push({ field: 'messages', message: 'messages is required and must be an array' });
    return errors;
  }

  if (data.messages.length === 0) {
    errors.push({ field: 'messages', message: 'At least one message is required' });
    return errors;
  }

  for (let i = 0; i < data.messages.length; i++) {
    const msg = data.messages[i] as Record<string, unknown>;
    if (!msg || typeof msg !== 'object') {
      errors.push({ field: `messages[${i}]`, message: 'Each message must be an object' });
      continue;
    }
    if (!msg.role || !VALID_ROLES.includes(msg.role as Role)) {
      errors.push({ field: `messages[${i}].role`, message: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }
    if (!msg.content || typeof msg.content !== 'string') {
      errors.push({ field: `messages[${i}].content`, message: 'content is required and must be a string' });
    }
  }

  if (data.id !== undefined && typeof data.id !== 'string') {
    errors.push({ field: 'id', message: 'id must be a string if provided' });
  }

  if (data.title !== undefined && typeof data.title !== 'string') {
    errors.push({ field: 'title', message: 'title must be a string if provided' });
  }

  return errors;
}

/**
 * Validate an AppendMessageRequest body.
 */
export function validateAppendMessage(body: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!body || typeof body !== 'object') {
    errors.push({ field: 'body', message: 'Request body must be a JSON object' });
    return errors;
  }

  const data = body as Record<string, unknown>;

  if (!data.conversationId || typeof data.conversationId !== 'string') {
    errors.push({ field: 'conversationId', message: 'conversationId is required and must be a string' });
  }

  if (!data.role || !VALID_ROLES.includes(data.role as Role)) {
    errors.push({ field: 'role', message: `role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  if (!data.content || typeof data.content !== 'string') {
    errors.push({ field: 'content', message: 'content is required and must be a string' });
  }

  return errors;
}

/**
 * Validate a RecallRequest body.
 */
export function validateRecallRequest(body: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!body || typeof body !== 'object') {
    errors.push({ field: 'body', message: 'Request body must be a JSON object' });
    return errors;
  }

  const data = body as Record<string, unknown>;

  if (!data.query || typeof data.query !== 'string') {
    errors.push({ field: 'query', message: 'query is required and must be a string' });
  } else if (data.query.trim().length === 0) {
    errors.push({ field: 'query', message: 'query must not be empty' });
  }

  if (data.maxResults !== undefined) {
    if (typeof data.maxResults !== 'number' || data.maxResults < 1 || data.maxResults > 100) {
      errors.push({ field: 'maxResults', message: 'maxResults must be a number between 1 and 100' });
    }
  }

  if (data.minScore !== undefined) {
    if (typeof data.minScore !== 'number' || data.minScore < 0 || data.minScore > 1) {
      errors.push({ field: 'minScore', message: 'minScore must be a number between 0 and 1' });
    }
  }

  if (data.vectorWeight !== undefined) {
    if (typeof data.vectorWeight !== 'number' || data.vectorWeight < 0 || data.vectorWeight > 1) {
      errors.push({ field: 'vectorWeight', message: 'vectorWeight must be a number between 0 and 1' });
    }
  }

  return errors;
}

// ─── Converters ──────────────────────────────────────────

/**
 * Convert validated request body to IngestConversationInput.
 */
export function toIngestInput(body: IngestConversationRequest): IngestConversationInput {
  return {
    id: body.id,
    title: body.title,
    source: body.source,
    messages: body.messages.map(m => ({
      role: m.role,
      content: m.content,
      metadata: m.metadata,
    })),
    metadata: body.metadata,
  };
}

/**
 * Convert validated request body to AppendMessageInput.
 */
export function toAppendInput(body: AppendMessageRequest): AppendMessageInput {
  return {
    conversationId: body.conversationId,
    role: body.role,
    content: body.content,
    metadata: body.metadata,
  };
}

/**
 * Convert RecallResult to RecallResponse.
 */
export function toRecallResponse(
  query: string,
  result: RecallResult,
  includeDiagnostics: boolean,
): RecallResponse {
  return {
    items: result.items.map(toRecallItemSchema),
    totalItems: result.items.length,
    query,
    diagnostics: includeDiagnostics ? result.diagnostics : undefined,
  };
}

function toRecallItemSchema(item: MergedMemoryItem): RecallItemSchema {
  return {
    nodeId: item.nodeId,
    nodeType: item.nodeType,
    score: item.score,
    content: item.content,
    sources: item.sources,
    sourceScores: item.sourceScores,
  };
}
