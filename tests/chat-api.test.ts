/**
 * Integration tests for POST /chat SSE streaming endpoint.
 *
 * Validates:
 * - Correct SSE headers (Content-Type, Cache-Control, Connection, X-Accel-Buffering)
 * - Stream event format (event:trace, event:chat, event:done)
 * - Error cases: empty message, missing message, invalid JSON, invalid body types
 * - Validation of optional fields (provider, sessionId, temperature, model)
 * - Chat health endpoint
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createChatRouter,
  validateChatRequest,
  formatSSE,
  type TraceEvent,
  type ChatEvent,
  type DoneEvent,
  type ChatRouterDependencies,
} from '../src/chat/chat-router.js';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamRequest,
  LLMStreamEvent,
} from '../src/extraction/llm-provider.js';
import type { Hono } from 'hono';

// ─── Mock LLM Provider ──────────────────────────────────────

class MockStreamProvider implements LLMProvider {
  readonly name = 'mock';

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    return { content: `Echo: ${request.prompt}` };
  }

  async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
    const msg = request.messages[request.messages.length - 1]?.content ?? '';
    yield { type: 'delta', content: msg };
    yield { type: 'finish', content: msg };
  }
}

// ─── Helpers ──────────────────────────────────────────────

let mockProvider: MockStreamProvider;
let app: Hono;

function makeDeps(overrides?: Partial<ChatRouterDependencies>): ChatRouterDependencies {
  return {
    llmProvider: mockProvider,
    ...overrides,
  };
}

/** Make a request to the Hono app. */
async function request(hono: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return hono.request(path, init);
}

/** Make a request with raw string body (for invalid JSON tests). */
async function rawRequest(hono: Hono, method: string, path: string, rawBody: string) {
  return hono.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
}

/** Parse SSE text into structured events. */
function parseSSEStream(text: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  // Split on double-newline boundaries to get individual SSE messages
  const blocks = text.split('\n\n').filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split('\n');
    let event = '';
    let data = '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        event = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        data = line.slice(6);
      }
    }

    if (event && data) {
      try {
        events.push({ event, data: JSON.parse(data) });
      } catch {
        events.push({ event, data });
      }
    }
  }

  return events;
}

// ─── Setup ───────────────────────────────────────────────

beforeEach(() => {
  mockProvider = new MockStreamProvider();
  app = createChatRouter(makeDeps());
});

// ─── Tests ────────────────────────────────────────────────

describe('Chat API — POST /chat', () => {

  // ── SSE Headers ──

  describe('SSE Response Headers', () => {
    it('returns Content-Type: text/event-stream', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'hello' });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    });

    it('returns Cache-Control: no-cache, no-transform', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'hello' });
      expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    });

    it('returns Connection: keep-alive', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'hello' });
      expect(res.headers.get('Connection')).toBe('keep-alive');
    });

    it('returns X-Accel-Buffering: no (for nginx proxy)', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'hello' });
      expect(res.headers.get('X-Accel-Buffering')).toBe('no');
    });
  });

  // ── SSE Stream Event Format ──

  describe('SSE Stream Event Format', () => {
    it('emits events in correct SSE format (event: + data:)', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'test' });
      const text = await res.text();

      // Each SSE message should have "event: <name>\ndata: <json>\n\n"
      expect(text).toContain('event: trace');
      expect(text).toContain('event: chat');
      expect(text).toContain('event: done');
      expect(text).toContain('data: ');
    });

    it('emits trace events with correct structure', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'test' });
      const text = await res.text();
      const events = parseSSEStream(text);

      const traceEvents = events.filter((e) => e.event === 'trace');
      expect(traceEvents.length).toBeGreaterThanOrEqual(1);

      // Each trace event should have stage, status, timestamp
      for (const te of traceEvents) {
        const data = te.data as TraceEvent;
        expect(data.stage).toBeDefined();
        expect(typeof data.stage).toBe('string');
        expect(['start', 'complete', 'error', 'skipped']).toContain(data.status);
        expect(data.timestamp).toBeDefined();
        expect(typeof data.timestamp).toBe('string');
      }
    });

    it('emits recall trace as one of the first events', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'hello' });
      const text = await res.text();
      const events = parseSSEStream(text);

      expect(events.length).toBeGreaterThan(0);
      // First event should be a trace (recall skipped since no retriever)
      const firstTrace = events[0].data as TraceEvent;
      expect(events[0].event).toBe('trace');
      expect(firstTrace.stage).toBe('recall');
    });

    it('emits recall skipped when no retriever configured', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'hello' });
      const text = await res.text();
      const events = parseSSEStream(text);

      const recallEvents = events.filter(
        (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'recall',
      );
      expect(recallEvents.length).toBeGreaterThanOrEqual(1);

      const statuses = recallEvents.map((e) => (e.data as TraceEvent).status);
      expect(statuses).toContain('skipped');
    });

    it('emits chat event with content', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'hello' });
      const text = await res.text();
      const events = parseSSEStream(text);

      const chatEvents = events.filter((e) => e.event === 'chat');
      expect(chatEvents.length).toBeGreaterThanOrEqual(1);

      // Should have at least a delta event with the message content
      const deltaEvent = chatEvents.find((e) => (e.data as ChatEvent).type === 'delta');
      expect(deltaEvent).toBeDefined();
      expect((deltaEvent!.data as ChatEvent).content).toBeDefined();
      expect(typeof (deltaEvent!.data as ChatEvent).content).toBe('string');
    });

    it('emits done event as the last event', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'hello' });
      const text = await res.text();
      const events = parseSSEStream(text);

      const lastEvent = events[events.length - 1];
      expect(lastEvent.event).toBe('done');

      const doneData = lastEvent.data as DoneEvent;
      expect(doneData.fullResponse).toBeDefined();
      expect(typeof doneData.fullResponse).toBe('string');
      expect(typeof doneData.totalDurationMs).toBe('number');
    });

    it('echoes the user message in chat events', async () => {
      const msg = 'Can you explain TypeScript?';
      const res = await request(app, 'POST', '/chat', { message: msg });
      const text = await res.text();
      const events = parseSSEStream(text);

      const chatEvents = events.filter((e) => e.event === 'chat');
      const chatContents = chatEvents
        .filter((e) => (e.data as ChatEvent).type === 'delta')
        .map((e) => (e.data as ChatEvent).content)
        .join('');
      expect(chatContents).toContain(msg);
    });

    it('includes userId "debug-user" in pipeline complete trace', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'hello' });
      const text = await res.text();
      const events = parseSSEStream(text);

      const pipelineComplete = events.find(
        (e) => e.event === 'trace' && (e.data as TraceEvent).stage === 'pipeline' && (e.data as TraceEvent).status === 'complete',
      );
      expect(pipelineComplete).toBeDefined();
      const data = (pipelineComplete!.data as TraceEvent).data as { userId: string };
      expect(data.userId).toBe('debug-user');
    });

    it('all SSE data payloads are parseable', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'test' });
      const text = await res.text();
      const events = parseSSEStream(text);

      // All events should have been parsed successfully
      expect(events.length).toBeGreaterThan(0);
      for (const evt of events) {
        expect(evt.event).toBeTruthy();
        expect(evt.data).toBeDefined();
      }
    });
  });

  // ── Error Cases ──

  describe('Error Handling', () => {
    it('returns 400 for empty message', async () => {
      const res = await request(app, 'POST', '/chat', { message: '' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('VALIDATION_ERROR');
      expect(body.details).toBeDefined();
    });

    it('returns 400 for whitespace-only message', async () => {
      const res = await request(app, 'POST', '/chat', { message: '   ' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for missing message field', async () => {
      const res = await request(app, 'POST', '/chat', { provider: 'openai' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for non-string message', async () => {
      const res = await request(app, 'POST', '/chat', { message: 123 });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid JSON body', async () => {
      const res = await rawRequest(app, 'POST', '/chat', '{invalid json}}');
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('INVALID_JSON');
    });

    it('returns 400 for array body', async () => {
      const res = await request(app, 'POST', '/chat', [{ message: 'hello' }]);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid provider value', async () => {
      const res = await request(app, 'POST', '/chat', {
        message: 'hello',
        provider: 'invalid-provider',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('VALIDATION_ERROR');
      expect((body.details as string[]).some((d) => d.includes('provider'))).toBe(true);
    });

    it('returns 400 for non-string sessionId', async () => {
      const res = await request(app, 'POST', '/chat', {
        message: 'hello',
        sessionId: 123,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for out-of-range temperature', async () => {
      const res = await request(app, 'POST', '/chat', {
        message: 'hello',
        temperature: 5.0,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for non-number temperature', async () => {
      const res = await request(app, 'POST', '/chat', {
        message: 'hello',
        temperature: 'hot',
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for non-string model', async () => {
      const res = await request(app, 'POST', '/chat', {
        message: 'hello',
        model: 42,
      });
      expect(res.status).toBe(400);
    });

    it('error response includes structured details array', async () => {
      const res = await request(app, 'POST', '/chat', { message: '', provider: 'bad' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('VALIDATION_ERROR');
      expect(body.message).toBe('Request validation failed');
      expect(Array.isArray(body.details)).toBe(true);
      expect((body.details as string[]).length).toBeGreaterThan(0);
    });
  });

  // ── Successful Requests with Optional Fields ──

  describe('Valid Requests with Optional Fields', () => {
    it('accepts valid request with only message', async () => {
      const res = await request(app, 'POST', '/chat', { message: 'hello' });
      expect(res.status).toBe(200);
    });

    it('accepts valid request with sessionId', async () => {
      const res = await request(app, 'POST', '/chat', {
        message: 'hello',
        sessionId: 'session-123',
      });
      expect(res.status).toBe(200);
    });

    it('accepts valid request with provider openai', async () => {
      const res = await request(app, 'POST', '/chat', {
        message: 'hello',
        provider: 'openai',
      });
      expect(res.status).toBe(200);
    });

    it('accepts valid request with provider anthropic', async () => {
      const res = await request(app, 'POST', '/chat', {
        message: 'hello',
        provider: 'anthropic',
      });
      expect(res.status).toBe(200);
    });

    it('accepts valid request with temperature', async () => {
      const res = await request(app, 'POST', '/chat', {
        message: 'hello',
        temperature: 0.7,
      });
      expect(res.status).toBe(200);
    });

    it('accepts valid request with model', async () => {
      const res = await request(app, 'POST', '/chat', {
        message: 'hello',
        model: 'gpt-4o-mini',
      });
      expect(res.status).toBe(200);
    });

    it('accepts valid request with all optional fields', async () => {
      const res = await request(app, 'POST', '/chat', {
        message: 'hello',
        sessionId: 'sess-1',
        provider: 'openai',
        model: 'gpt-4o',
        temperature: 1.0,
      });
      expect(res.status).toBe(200);
    });
  });
});

// ─── Validation function unit tests ───────────────────────

describe('validateChatRequest', () => {
  it('returns empty array for valid request', () => {
    expect(validateChatRequest({ message: 'hello' })).toEqual([]);
  });

  it('rejects null body', () => {
    const errors = validateChatRequest(null);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects undefined body', () => {
    const errors = validateChatRequest(undefined);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects array body', () => {
    const errors = validateChatRequest([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects string body', () => {
    const errors = validateChatRequest('hello');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects missing message', () => {
    const errors = validateChatRequest({});
    expect(errors.some((e) => e.includes('message'))).toBe(true);
  });

  it('rejects empty string message', () => {
    const errors = validateChatRequest({ message: '' });
    expect(errors.some((e) => e.includes('message'))).toBe(true);
  });

  it('rejects whitespace-only message', () => {
    const errors = validateChatRequest({ message: '   \t\n  ' });
    expect(errors.some((e) => e.includes('message'))).toBe(true);
  });

  it('rejects numeric message', () => {
    const errors = validateChatRequest({ message: 42 });
    expect(errors.some((e) => e.includes('message'))).toBe(true);
  });

  it('rejects invalid provider', () => {
    const errors = validateChatRequest({ message: 'hi', provider: 'gpt' });
    expect(errors.some((e) => e.includes('provider'))).toBe(true);
  });

  it('accepts valid provider openai', () => {
    expect(validateChatRequest({ message: 'hi', provider: 'openai' })).toEqual([]);
  });

  it('accepts valid provider anthropic', () => {
    expect(validateChatRequest({ message: 'hi', provider: 'anthropic' })).toEqual([]);
  });

  it('rejects non-string sessionId', () => {
    const errors = validateChatRequest({ message: 'hi', sessionId: 123 });
    expect(errors.some((e) => e.includes('sessionId'))).toBe(true);
  });

  it('rejects negative temperature', () => {
    const errors = validateChatRequest({ message: 'hi', temperature: -0.1 });
    expect(errors.some((e) => e.includes('temperature'))).toBe(true);
  });

  it('rejects temperature > 2', () => {
    const errors = validateChatRequest({ message: 'hi', temperature: 2.1 });
    expect(errors.some((e) => e.includes('temperature'))).toBe(true);
  });

  it('accepts temperature at boundary 0', () => {
    expect(validateChatRequest({ message: 'hi', temperature: 0 })).toEqual([]);
  });

  it('accepts temperature at boundary 2', () => {
    expect(validateChatRequest({ message: 'hi', temperature: 2 })).toEqual([]);
  });

  it('collects multiple errors at once', () => {
    const errors = validateChatRequest({
      message: '',
      provider: 'bad',
      temperature: -1,
      sessionId: 42,
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── formatSSE unit tests ─────────────────────────────────

describe('formatSSE', () => {
  it('formats event with JSON data', () => {
    const result = formatSSE('chat', { type: 'delta', content: 'hello' });
    expect(result).toBe('event: chat\ndata: {"type":"delta","content":"hello"}\n\n');
  });

  it('formats event with string data (raw passthrough)', () => {
    const result = formatSSE('done', '[DONE]');
    // String data is passed through as-is (not JSON-stringified)
    expect(result).toBe('event: done\ndata: [DONE]\n\n');
  });

  it('formats event with complex nested data', () => {
    const data = { stage: 'recall', status: 'complete', data: { items: [1, 2, 3] } };
    const result = formatSSE('trace', data);
    expect(result).toContain('event: trace\n');
    expect(result).toContain('data: ');
    expect(result.endsWith('\n\n')).toBe(true);

    // The data portion should be valid JSON
    const dataLine = result.split('\n').find((l) => l.startsWith('data: '))!;
    const parsed = JSON.parse(dataLine.slice(6));
    expect(parsed.stage).toBe('recall');
    expect(parsed.data.items).toEqual([1, 2, 3]);
  });

  it('ends with double newline', () => {
    const result = formatSSE('done', {});
    expect(result.endsWith('\n\n')).toBe(true);
  });
});

// ─── Chat Health Endpoint ──────────────────────────────────

describe('GET /chat/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await app.request('/chat/health', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.subsystem).toBe('chat');
    expect(body.userId).toBe('debug-user');
    expect(body.provider).toBe('mock');
    expect(body.hasRetriever).toBe(false);
    expect(body.timestamp).toBeDefined();
  });
});
