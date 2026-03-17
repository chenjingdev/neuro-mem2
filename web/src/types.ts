/** A chat message in the UI */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /** Whether this message is still being streamed */
  isStreaming?: boolean;
  /** Error flag for failed responses */
  isError?: boolean;
}

/**
 * A trace event from the memory pipeline.
 * Matches the backend's SSE `event:trace` payload from chat-router.ts.
 */
export interface TraceEvent {
  /** Pipeline stage name */
  stage: string;
  /** Stage status */
  status: 'start' | 'complete' | 'error' | 'skipped';
  /** Duration in ms (only on 'complete' or 'error') */
  durationMs?: number;
  /** Stage-specific data payload */
  data?: Record<string, unknown>;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * A chat SSE event from the backend.
 * Matches the backend's SSE `event:chat` payload from chat-router.ts.
 */
export interface ChatSSEEvent {
  type: 'delta' | 'finish' | 'error';
  content?: string;
  error?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * Done event from the backend.
 * Matches the backend's SSE `event:done` payload.
 */
export interface DoneSSEEvent {
  fullResponse: string;
  totalDurationMs: number;
}

// ─── Timeline State Management ──────────────────────────────

/**
 * A trace session groups all trace events from a single chat request.
 * Each user message triggers one pipeline run → one TraceSession.
 */
export interface TraceSession {
  /** The user message ID that triggered this pipeline run */
  messageId: string;
  /** The assistant message ID that was produced */
  assistantMessageId: string;
  /** All trace events collected during this pipeline run */
  traces: TraceEvent[];
  /** Total pipeline duration from done event (ms) */
  totalDurationMs: number | null;
  /** Token usage from the LLM response */
  usage: ChatSSEEvent['usage'] | null;
  /** Whether this session is still streaming */
  isActive: boolean;
  /** Timestamp when the session started */
  startedAt: number;
}

/**
 * Timeline store — maps message IDs to their trace sessions.
 * Both the user message ID and assistant message ID point to the same session.
 */
export type TraceSessionMap = Map<string, TraceSession>;
