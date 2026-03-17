/**
 * SSE Helpers — encoding utilities for Server-Sent Events in the Visual Debug Chat App.
 *
 * Provides functions to format SSE messages for the three event types used
 * by the chat streaming protocol:
 *
 *   - event:trace  — pipeline stage trace data (recall, ingestion, etc.)
 *   - event:chat   — LLM streaming tokens (delta, finish, error)
 *   - event:done   — terminal event with full response + collected trace events
 *
 * SSE Wire Format (per MDN):
 *   event: <name>\ndata: <json>\n\n
 *
 * All data payloads are JSON-serialized with safety guards against:
 *   - Circular references
 *   - BigInt values
 *   - Oversized payloads (truncated at 64 KB)
 *   - Serialization failures (graceful fallback)
 */

import type { TraceEvent as DetailedTraceEvent } from './trace-types.js';

// ─── SSE Wire-Format Types ───────────────────────────────

/**
 * Lightweight trace event for the SSE wire format.
 *
 * This is the shape sent over the wire as `event: trace\ndata: {JSON}\n\n`.
 * It's intentionally simpler than the internal TraceEvent from trace-types.ts:
 *   - Uses `data` for a generic payload (vs separate input/output/error fields)
 *   - `stage` is a plain string (vs the strict TraceStage union)
 *
 * The internal TraceEvent (from trace-types.ts) can be converted to this
 * format using `toSSETraceEvent()`.
 */
export interface SSETraceEvent {
  /** Pipeline stage name */
  stage: string;
  /** Stage lifecycle status */
  status: 'start' | 'complete' | 'error' | 'skipped';
  /** Duration in ms (only on 'complete' or 'error') */
  durationMs?: number;
  /** Stage-specific data payload (input, output, error details, etc.) */
  data?: unknown;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** SSE chat event — emitted for each LLM response chunk. */
export interface SSEChatEvent {
  /** Event type: delta for tokens, finish for completed response, error for failures */
  type: 'delta' | 'finish' | 'error';
  /** Text content (delta text or full response) */
  content?: string;
  /** Error message (only on type: 'error') */
  error?: string;
  /** Token usage stats (only on type: 'finish') */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** SSE done event — signals stream completion. */
export interface SSEDoneEvent {
  /** Full assembled response text */
  fullResponse: string;
  /** Total pipeline duration in ms */
  totalDurationMs: number;
  /** All collected trace events for this pipeline run (for timeline rendering & storage) */
  traceEvents?: SSETraceEvent[];
}

// ─── Constants ───────────────────────────────────────────

/** Maximum size (in bytes) for a single SSE data payload before truncation. */
const MAX_SSE_PAYLOAD_BYTES = 64 * 1024; // 64 KB

// ─── Safe Serialization ──────────────────────────────────

/**
 * Safely serialize a value to JSON, handling circular references,
 * BigInt values, and oversized payloads gracefully.
 *
 * @param data - The value to serialize
 * @returns JSON string, or a fallback string on serialization failure
 */
export function safeSerialize(data: unknown): string {
  if (typeof data === 'string') return data;

  try {
    const seen = new WeakSet();
    const json = JSON.stringify(data, (_key, value) => {
      // Handle circular references
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      // Handle BigInt
      if (typeof value === 'bigint') return value.toString();
      return value;
    });

    // Guard against oversized payloads
    if (json.length > MAX_SSE_PAYLOAD_BYTES) {
      return JSON.stringify({
        _truncated: true,
        _originalSize: json.length,
        _preview: json.slice(0, 512) + '...',
      });
    }

    return json;
  } catch {
    return JSON.stringify({ _serializationError: true, _type: typeof data });
  }
}

// ─── SSE Formatting ──────────────────────────────────────

/**
 * Format a Server-Sent Event string.
 *
 * Uses safe serialization to handle circular references, BigInt, and
 * oversized payloads without crashing the SSE stream.
 *
 * @param event - Event name (e.g. 'trace', 'chat', 'done', 'error')
 * @param data  - JSON-serializable data payload, or a raw string
 * @returns Formatted SSE string ready to write to the stream
 *
 * @example
 * ```ts
 * formatSSE('trace', { stage: 'recall', status: 'start', timestamp: '...' })
 * // => 'event: trace\ndata: {"stage":"recall","status":"start",...}\n\n'
 *
 * formatSSE('done', '[DONE]')
 * // => 'event: done\ndata: [DONE]\n\n'
 * ```
 */
export function formatSSE(event: string, data: unknown): string {
  const payload = safeSerialize(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

/**
 * Format a trace event as an SSE string.
 * Shorthand for `formatSSE('trace', event)`.
 */
export function formatTraceSSE(event: SSETraceEvent): string {
  return formatSSE('trace', event);
}

/**
 * Format a chat event as an SSE string.
 * Shorthand for `formatSSE('chat', event)`.
 */
export function formatChatSSE(event: SSEChatEvent): string {
  return formatSSE('chat', event);
}

/**
 * Format a done event as an SSE string.
 * Shorthand for `formatSSE('done', event)`.
 */
export function formatDoneSSE(event: SSEDoneEvent): string {
  return formatSSE('done', event);
}

// ─── Conversion: Internal TraceEvent → SSE TraceEvent ────

/**
 * Convert a detailed TraceEvent (from TraceCollector) to the simpler
 * SSE wire-format trace event.
 *
 * The conversion merges `input`, `output`, `error`, and `skipReason`
 * into the single `data` field used by the SSE protocol.
 *
 * @param event - Internal TraceEvent from trace-types.ts / TraceCollector
 * @returns SSETraceEvent ready for SSE encoding
 */
export function toSSETraceEvent(event: DetailedTraceEvent): SSETraceEvent {
  // Build the data payload from the separate fields
  let data: Record<string, unknown> | undefined;

  if (event.status === 'start' && event.input !== undefined) {
    data = { input: event.input };
  } else if (event.status === 'complete' && event.output !== undefined) {
    data = { output: event.output };
  } else if (event.status === 'error') {
    data = { error: event.error };
    if (event.output !== undefined) {
      data['output'] = event.output;
    }
  } else if (event.status === 'skipped') {
    data = { reason: event.skipReason };
  }

  // Add parentStage to data if present
  if (event.parentStage && data) {
    data['parentStage'] = event.parentStage;
  } else if (event.parentStage) {
    data = { parentStage: event.parentStage };
  }

  return {
    stage: event.stage,
    status: event.status,
    durationMs: event.durationMs,
    data,
    timestamp: event.timestamp,
  };
}

// ─── SSE Stream Parsing (for clients / tests) ────────────

/**
 * Parse a raw SSE message string into its event name and data.
 *
 * This is the inverse of `formatSSE()` — useful for testing and
 * for the frontend SSE client to parse incoming messages.
 *
 * @param raw - A single SSE message (including trailing \n\n)
 * @returns Parsed event name and data, or null if the input is invalid
 */
export function parseSSE(raw: string): { event: string; data: string } | null {
  const lines = raw.trim().split('\n');
  let event = '';
  let data = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      event = line.slice(7);
    } else if (line.startsWith('data: ')) {
      data = line.slice(6);
    }
  }

  if (!event && !data) return null;
  return { event, data };
}

/**
 * Parse the data field of an SSE trace event.
 *
 * @param raw - Raw SSE message string
 * @returns Parsed SSETraceEvent, or null if not a trace event
 */
export function parseTraceSSE(raw: string): SSETraceEvent | null {
  const parsed = parseSSE(raw);
  if (!parsed || parsed.event !== 'trace') return null;

  try {
    return JSON.parse(parsed.data) as SSETraceEvent;
  } catch {
    return null;
  }
}
