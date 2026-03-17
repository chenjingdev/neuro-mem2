/**
 * Tests for SSE helpers — TraceEvent types, SSE encoding, and parsing utilities.
 *
 * Validates:
 *   - formatSSE produces correct SSE wire format
 *   - safeSerialize handles edge cases (circular refs, BigInt, oversized payloads)
 *   - formatTraceSSE / formatChatSSE / formatDoneSSE convenience helpers
 *   - toSSETraceEvent converts internal TraceEvent → SSE wire format
 *   - parseSSE / parseTraceSSE round-trip SSE encoding ↔ decoding
 */

import { describe, it, expect } from 'vitest';
import {
  formatSSE,
  safeSerialize,
  formatTraceSSE,
  formatChatSSE,
  formatDoneSSE,
  toSSETraceEvent,
  parseSSE,
  parseTraceSSE,
} from '../src/chat/sse-helpers.js';
import type {
  SSETraceEvent,
  SSEChatEvent,
  SSEDoneEvent,
} from '../src/chat/sse-helpers.js';
import type { TraceEvent } from '../src/chat/trace-types.js';

// ─── formatSSE ───────────────────────────────────────────

describe('formatSSE', () => {
  it('formats an event with a JSON object payload', () => {
    const result = formatSSE('trace', { stage: 'recall', status: 'start' });
    expect(result).toBe(
      'event: trace\ndata: {"stage":"recall","status":"start"}\n\n',
    );
  });

  it('formats an event with a raw string payload', () => {
    const result = formatSSE('done', '[DONE]');
    expect(result).toBe('event: done\ndata: [DONE]\n\n');
  });

  it('formats an event with null data', () => {
    const result = formatSSE('test', null);
    expect(result).toBe('event: test\ndata: null\n\n');
  });

  it('formats an event with numeric data', () => {
    const result = formatSSE('test', 42);
    expect(result).toBe('event: test\ndata: 42\n\n');
  });

  it('formats an event with boolean data', () => {
    const result = formatSSE('test', true);
    expect(result).toBe('event: test\ndata: true\n\n');
  });

  it('formats an event with array data', () => {
    const result = formatSSE('test', [1, 2, 3]);
    expect(result).toBe('event: test\ndata: [1,2,3]\n\n');
  });

  it('produces a string ending with double newline', () => {
    const result = formatSSE('chat', { type: 'delta', content: 'hello' });
    expect(result).toMatch(/\n\n$/);
  });

  it('starts with event: prefix', () => {
    const result = formatSSE('trace', {});
    expect(result).toMatch(/^event: trace\n/);
  });
});

// ─── safeSerialize ───────────────────────────────────────

describe('safeSerialize', () => {
  it('returns a string as-is', () => {
    expect(safeSerialize('hello')).toBe('hello');
  });

  it('serializes a plain object', () => {
    const result = safeSerialize({ a: 1, b: 'two' });
    expect(JSON.parse(result)).toEqual({ a: 1, b: 'two' });
  });

  it('handles circular references gracefully', () => {
    const obj: Record<string, unknown> = { name: 'root' };
    obj['self'] = obj;
    const result = safeSerialize(obj);
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe('root');
    expect(parsed.self).toBe('[Circular]');
  });

  it('handles BigInt values', () => {
    const result = safeSerialize({ big: BigInt(9007199254740991) });
    const parsed = JSON.parse(result);
    expect(parsed.big).toBe('9007199254740991');
  });

  it('handles null', () => {
    expect(safeSerialize(null)).toBe('null');
  });

  it('handles undefined (returns JSON serialization)', () => {
    // JSON.stringify(undefined) returns undefined, but we wrap in replacer
    const result = safeSerialize(undefined);
    expect(typeof result).toBe('string');
  });

  it('handles nested objects', () => {
    const data = {
      stage: 'recall',
      data: {
        items: [{ id: 1, content: 'test' }],
        nested: { deep: { value: 42 } },
      },
    };
    const result = safeSerialize(data);
    const parsed = JSON.parse(result);
    expect(parsed.data.nested.deep.value).toBe(42);
  });

  it('truncates oversized payloads', () => {
    const bigArray = Array(100000).fill('x'.repeat(100));
    const result = safeSerialize(bigArray);
    const parsed = JSON.parse(result);
    expect(parsed._truncated).toBe(true);
    expect(parsed._originalSize).toBeGreaterThan(64 * 1024);
    expect(parsed._preview).toBeDefined();
  });

  it('handles empty object', () => {
    expect(safeSerialize({})).toBe('{}');
  });

  it('handles empty array', () => {
    expect(safeSerialize([])).toBe('[]');
  });
});

// ─── formatTraceSSE ──────────────────────────────────────

describe('formatTraceSSE', () => {
  it('formats a trace start event', () => {
    const event: SSETraceEvent = {
      stage: 'recall',
      status: 'start',
      data: { query: 'hello' },
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const result = formatTraceSSE(event);
    expect(result).toMatch(/^event: trace\ndata: /);
    const parsed = parseSSE(result);
    expect(parsed?.event).toBe('trace');
    const data = JSON.parse(parsed!.data);
    expect(data.stage).toBe('recall');
    expect(data.status).toBe('start');
  });

  it('formats a trace complete event with duration', () => {
    const event: SSETraceEvent = {
      stage: 'vector_search',
      status: 'complete',
      durationMs: 42.5,
      data: { itemCount: 5 },
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const result = formatTraceSSE(event);
    const parsed = JSON.parse(parseSSE(result)!.data);
    expect(parsed.durationMs).toBe(42.5);
    expect(parsed.data.itemCount).toBe(5);
  });

  it('formats a trace error event', () => {
    const event: SSETraceEvent = {
      stage: 'llm',
      status: 'error',
      durationMs: 100,
      data: { error: 'timeout' },
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const result = formatTraceSSE(event);
    const parsed = JSON.parse(parseSSE(result)!.data);
    expect(parsed.status).toBe('error');
    expect(parsed.data.error).toBe('timeout');
  });

  it('formats a trace skipped event', () => {
    const event: SSETraceEvent = {
      stage: 'ingestion',
      status: 'skipped',
      data: { reason: 'No extractor configured' },
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const result = formatTraceSSE(event);
    const parsed = JSON.parse(parseSSE(result)!.data);
    expect(parsed.status).toBe('skipped');
  });
});

// ─── formatChatSSE ───────────────────────────────────────

describe('formatChatSSE', () => {
  it('formats a delta event', () => {
    const event: SSEChatEvent = { type: 'delta', content: 'Hello' };
    const result = formatChatSSE(event);
    expect(result).toMatch(/^event: chat\ndata: /);
    const parsed = JSON.parse(parseSSE(result)!.data);
    expect(parsed.type).toBe('delta');
    expect(parsed.content).toBe('Hello');
  });

  it('formats a finish event with usage', () => {
    const event: SSEChatEvent = {
      type: 'finish',
      content: 'Full response',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    };
    const result = formatChatSSE(event);
    const parsed = JSON.parse(parseSSE(result)!.data);
    expect(parsed.type).toBe('finish');
    expect(parsed.usage.totalTokens).toBe(30);
  });

  it('formats an error event', () => {
    const event: SSEChatEvent = { type: 'error', error: 'Rate limited' };
    const result = formatChatSSE(event);
    const parsed = JSON.parse(parseSSE(result)!.data);
    expect(parsed.type).toBe('error');
    expect(parsed.error).toBe('Rate limited');
  });
});

// ─── formatDoneSSE ───────────────────────────────────────

describe('formatDoneSSE', () => {
  it('formats a done event', () => {
    const event: SSEDoneEvent = {
      fullResponse: 'Hello world',
      totalDurationMs: 500,
      traceEvents: [
        { stage: 'recall', status: 'complete', durationMs: 100, timestamp: '2026-01-01T00:00:00Z' },
        { stage: 'llm', status: 'complete', durationMs: 400, timestamp: '2026-01-01T00:00:00Z' },
      ],
    };
    const result = formatDoneSSE(event);
    expect(result).toMatch(/^event: done\ndata: /);
    const parsed = JSON.parse(parseSSE(result)!.data);
    expect(parsed.fullResponse).toBe('Hello world');
    expect(parsed.totalDurationMs).toBe(500);
    expect(parsed.traceEvents).toHaveLength(2);
  });
});

// ─── toSSETraceEvent ─────────────────────────────────────

describe('toSSETraceEvent', () => {
  it('converts a start event with input', () => {
    const internal: TraceEvent = {
      id: 1,
      stage: 'vector_search',
      status: 'start',
      input: { queryText: 'hello', topK: 10 },
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const sse = toSSETraceEvent(internal);
    expect(sse.stage).toBe('vector_search');
    expect(sse.status).toBe('start');
    expect(sse.data).toEqual({ input: { queryText: 'hello', topK: 10 } });
    expect(sse.timestamp).toBe(internal.timestamp);
    expect(sse.durationMs).toBeUndefined();
  });

  it('converts a complete event with output and duration', () => {
    const internal: TraceEvent = {
      id: 2,
      stage: 'merge',
      status: 'complete',
      output: { mergedItemCount: 5 },
      durationMs: 12.34,
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const sse = toSSETraceEvent(internal);
    expect(sse.status).toBe('complete');
    expect(sse.durationMs).toBe(12.34);
    expect(sse.data).toEqual({ output: { mergedItemCount: 5 } });
  });

  it('converts an error event', () => {
    const internal: TraceEvent = {
      id: 3,
      stage: 'llm',
      status: 'error',
      error: 'API timeout',
      durationMs: 5000,
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const sse = toSSETraceEvent(internal);
    expect(sse.status).toBe('error');
    expect(sse.data).toEqual({ error: 'API timeout' });
    expect(sse.durationMs).toBe(5000);
  });

  it('converts a skipped event', () => {
    const internal: TraceEvent = {
      id: 4,
      stage: 'reinforce',
      status: 'skipped',
      skipReason: 'Hebbian disabled',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const sse = toSSETraceEvent(internal);
    expect(sse.status).toBe('skipped');
    expect(sse.data).toEqual({ reason: 'Hebbian disabled' });
  });

  it('includes parentStage in data when present', () => {
    const internal: TraceEvent = {
      id: 5,
      stage: 'vector_search',
      status: 'start',
      input: { queryText: 'test' },
      parentStage: 'recall',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const sse = toSSETraceEvent(internal);
    expect((sse.data as Record<string, unknown>)['parentStage']).toBe('recall');
  });

  it('handles parentStage with no other data fields', () => {
    const internal: TraceEvent = {
      id: 6,
      stage: 'recall',
      status: 'start',
      parentStage: 'pipeline',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const sse = toSSETraceEvent(internal);
    expect(sse.data).toEqual({ parentStage: 'pipeline' });
  });

  it('produces undefined data when no fields are set', () => {
    const internal: TraceEvent = {
      id: 7,
      stage: 'recall',
      status: 'start',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const sse = toSSETraceEvent(internal);
    expect(sse.data).toBeUndefined();
  });
});

// ─── parseSSE ────────────────────────────────────────────

describe('parseSSE', () => {
  it('parses a well-formed SSE message', () => {
    const raw = 'event: trace\ndata: {"stage":"recall"}\n\n';
    const result = parseSSE(raw);
    expect(result).toEqual({ event: 'trace', data: '{"stage":"recall"}' });
  });

  it('parses a message with string data', () => {
    const raw = 'event: done\ndata: [DONE]\n\n';
    const result = parseSSE(raw);
    expect(result).toEqual({ event: 'done', data: '[DONE]' });
  });

  it('returns null for empty input', () => {
    expect(parseSSE('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(parseSSE('   \n\n  ')).toBeNull();
  });

  it('handles event-only (no data)', () => {
    const result = parseSSE('event: ping');
    expect(result).toEqual({ event: 'ping', data: '' });
  });

  it('handles data-only (no event)', () => {
    const result = parseSSE('data: hello');
    expect(result).toEqual({ event: '', data: 'hello' });
  });
});

// ─── parseTraceSSE ───────────────────────────────────────

describe('parseTraceSSE', () => {
  it('parses a valid trace SSE message', () => {
    const raw = formatTraceSSE({
      stage: 'recall',
      status: 'complete',
      durationMs: 50,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const result = parseTraceSSE(raw);
    expect(result).not.toBeNull();
    expect(result!.stage).toBe('recall');
    expect(result!.status).toBe('complete');
    expect(result!.durationMs).toBe(50);
  });

  it('returns null for non-trace events', () => {
    const raw = formatSSE('chat', { type: 'delta', content: 'hi' });
    expect(parseTraceSSE(raw)).toBeNull();
  });

  it('returns null for invalid JSON data', () => {
    const raw = 'event: trace\ndata: not-json\n\n';
    expect(parseTraceSSE(raw)).toBeNull();
  });
});

// ─── Round-trip tests ────────────────────────────────────

describe('round-trip: encode → parse', () => {
  it('round-trips a trace event through formatSSE → parseSSE', () => {
    const original: SSETraceEvent = {
      stage: 'graph_traversal',
      status: 'complete',
      durationMs: 123.45,
      data: { extractedEntities: ['foo', 'bar'], seedCount: 2 },
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const encoded = formatTraceSSE(original);
    const parsed = parseTraceSSE(encoded);
    expect(parsed).toEqual(original);
  });

  it('round-trips an internal TraceEvent through toSSETraceEvent → formatTraceSSE → parseTraceSSE', () => {
    const internal: TraceEvent = {
      id: 10,
      stage: 'vector_search',
      status: 'complete',
      output: { matchedAnchors: [], itemCount: 0, timedOut: false },
      durationMs: 5.67,
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const sseEvent = toSSETraceEvent(internal);
    const encoded = formatTraceSSE(sseEvent);
    const decoded = parseTraceSSE(encoded);
    expect(decoded).toEqual(sseEvent);
  });

  it('round-trips all pipeline stages', () => {
    const stages = ['vector_search', 'graph_traversal', 'merge', 'reinforce', 'format', 'inject', 'recall', 'llm', 'ingestion', 'pipeline'];
    for (const stage of stages) {
      const event: SSETraceEvent = {
        stage,
        status: 'complete',
        durationMs: 10,
        timestamp: '2026-01-01T00:00:00.000Z',
      };
      const encoded = formatTraceSSE(event);
      const decoded = parseTraceSSE(encoded);
      expect(decoded?.stage).toBe(stage);
    }
  });
});
